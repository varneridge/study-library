// Assessment & essay: a module's essay studio, laid out for an LSE history student.
// The workspace has three columns so that the writing stays front and centre: the brief,
// the essay's own papers and its sources on the left, the essay itself in the centre (the
// page preview or the plan), and its references and outline on the right. Below 1280px
// the right column becomes a drawer, and below 900px one pane shows at a time, chosen by
// tabs. On the module page it is a card under Course materials & assessments, opened like
// a week.

import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DndContext, DragOverlay, useDraggable, useDroppable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useLiveQuery, useSuspendingLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import { navigate } from "../lib/router";
import {
  assessmentNotesKey,
  deleteDraftSnapshot,
  deleteModuleEssay,
  downloadDocxFile,
  formatChicagoFootnote,
  importAssessmentDocxFile,
  renameModuleEssay,
  restoreDraftSnapshot,
  saveDraftSnapshot,
  saveModuleAssessment,
  useModuleAssessment,
  type CustomSource,
} from "../lib/assessment";
import { shortDate } from "../lib/dates";
import { db } from "../lib/db";
import { countDocxWords, type DocxDocument, type DocxFootnote, type DocxBlock, type DocxRun } from "../lib/docx";
import { HANDLE_STYLE, listCollision, swallowClickAfterDrag, useDragSensors } from "../lib/drag";
import {
  effectiveWordCount,
  findCitationContext,
  formatCustomBibliography,
  formatCustomFootnote,
  numberedFootnotes,
  safeExternalUrl,
} from "../lib/essaySources";
import { countdown } from "../lib/sections";
import { api, newId } from "../lib/sync";
import { chicagoBibliography, fullTitle } from "../lib/titles";
import { clampZoom, stepZoom, ZOOM_STEPS } from "../lib/zoom";
import type { AttachmentRef, ItemRow, ModuleRow } from "../lib/types";
import { confirmAction, showToast, useTitle } from "../lib/ui";
import { mimeFor, sha256 } from "../lib/uploads";
import { DatePicker } from "./DatePicker";
import { NotesLoading } from "./ErrorBoundary";
import { Icon, IconButton } from "./icons";
import { Menu } from "./Menu";
import { PageZoomViewport } from "./PageZoomViewport";
import { Sheet } from "./Sheet";
import "./AssessmentPage.css";

const NoteEditor = lazy(() => import("./NoteEditor"));

const dayOf = (iso: string) => new Date(`${iso}T00:00:00`);

// The essay preview zooms through the same steps as the reader, up to twice its size.
const PREVIEW_MAX_ZOOM = 2;
// The preview opens a little below full size, so that a whole page width and more of its
// length fit in the centre column before any zooming.
const PREVIEW_DEFAULT_ZOOM = 0.9;
// A reference typed into saves once the typing has paused for this long, as well as on blur.
const REFERENCE_SAVE_DELAY = 600;
// How long a sentence or heading reached from the side columns stays highlighted.
const JUMP_HIGHLIGHT_MS = 3200;
// Admin documents go up in one request, so they are held under the size that needs parts.
const ADMIN_DOCUMENT_LIMIT = 50 * 1024 * 1024;

// A stored Word file counts as present once it holds more than a bare header.
const hasDocxBytes = (assessment: object): boolean => {
  const stored = (assessment as { docx?: { byteLength: number } | null }).docx;
  return Boolean(stored && stored.byteLength > 4);
};

const fileSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type SaveState = "saved" | "saving" | "error";

// Which pane shows below 900px; between 900px and 1280px "aside" means the drawer is open.
type Pane = "rail" | "centre" | "aside";

type CentreView = "preview" | "plan";

// A place in the draft to scroll the preview to, and the cited sentence to mark there.
interface JumpTarget {
  blockId: string;
  footnoteId?: string;
  sentence?: string;
  token: number;
}

// A module reading chosen for the essay or a source added by hand, as the rail lists them.
interface ResearchItem {
  id: string;
  title: string;
  isModule: boolean;
  moduleItem?: ItemRow;
  customSource?: CustomSource;
}

// Puts an admin document into storage by the same route as a note's picture, and returns
// its key. Files are stored by their contents, so the same brief is only ever kept once.
async function uploadAdminDocument(file: File, mime: string): Promise<string> {
  const sha = await sha256(file);
  const response = await api(`/api/files/${sha}`, { method: "PUT", headers: { "content-type": mime }, body: file });
  const { key } = (await response.json()) as { key?: unknown };
  if (typeof key !== "string" || !key) throw new Error("The upload did not return a file.");
  return key;
}

// The card on the module page, in the Course materials & assessments grid.
export function AssessmentCard({
  module,
  essayId = "default",
  title,
  onStartRename,
  renaming,
  onEndRename,
}: {
  module: ModuleRow;
  essayId?: string;
  title?: string;
  onStartRename?: () => void;
  renaming?: boolean;
  onEndRename?: () => void;
}) {
  const assessment = useModuleAssessment(module.id, module.code, essayId);
  const due = assessment.dueDate ? countdown(assessment.dueDate) : null;
  const to = {
    view: "assessment" as const,
    id: module.id,
    ...(essayId && essayId !== "default" ? { essay: essayId } : {}),
  };
  const wpTo = {
    view: "essay" as const,
    id: module.id,
    ...(essayId && essayId !== "default" ? { essay: essayId } : {}),
  };
  const displayTitle = (assessment.title || title || (module.code ? `${module.code} Essay` : "Essay")).trim();
  const cancelRename = useRef(false);

  const handleDelete = async () => {
    const ok = await confirmAction({
      title: `Delete "${displayTitle}"?`,
      body: "This essay and its draft will be deleted. This cannot be undone.",
      confirm: "Delete essay",
      danger: true,
    });
    if (!ok) return;
    await deleteModuleEssay(module.id, essayId);
    showToast("Essay removed.");
  };

  return (
    <article className={`essay-card week-card${due && (due.state === "soon" || due.state === "today") ? " due-soon" : ""}`}>
      <div className="week-card-actions">
        <Menu
          label={`More actions for ${displayTitle}`}
          items={[
            { label: "Open word processor", onSelect: () => navigate(wpTo) },
            ...(onStartRename ? [{ label: "Rename essay", onSelect: onStartRename }] : []),
            { label: "Delete essay", danger: true, onSelect: () => void handleDelete() },
          ]}
        />
      </div>
      <Link to={to} className="essay-card-cover" tabIndex={-1} ariaHidden={true}>
        <span className={`essay-card-question${displayTitle ? "" : " is-empty"}`}>{displayTitle}</span>
      </Link>
      <div className="week-card-body">
        <div className="week-card-meta">
          <span className="week-card-code">Essay</span>
          {assessment.dueDate && (
            <span className="week-card-dates">
              Due {shortDate(dayOf(assessment.dueDate))}{due ? ` (${due.words})` : ""}
            </span>
          )}
        </div>
        {renaming ? (
          <input
            className="title-input section-name"
            type="text"
            defaultValue={displayTitle}
            autoFocus
            aria-label="Essay title"
            enterKeyHint="done"
            onBlur={(e) => {
              if (!cancelRename.current) void renameModuleEssay(module.id, essayId, e.target.value);
              cancelRename.current = false;
              onEndRename?.();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                cancelRename.current = true;
                onEndRename?.();
              }
            }}
          />
        ) : (
          <Link to={to} className="week-card-title-link essay-card-title">
            {displayTitle}
          </Link>
        )}
      </div>
    </article>
  );
}

interface PreviewPageData {
  pageNumber: number;
  blocks: DocxBlock[];
  footnoteIds: string[];
}

function paginateDocxBlocks(blocks: DocxBlock[], wordsPerPage = 320): PreviewPageData[] {
  const pages: PreviewPageData[] = [];
  let currentPageBlocks: DocxBlock[] = [];
  let currentFootnoteIds: string[] = [];
  let currentWords = 0;

  function pushPage() {
    if (currentPageBlocks.length > 0 || pages.length === 0) {
      pages.push({
        pageNumber: pages.length + 1,
        blocks: currentPageBlocks,
        footnoteIds: currentFootnoteIds,
      });
      currentPageBlocks = [];
      currentFootnoteIds = [];
      currentWords = 0;
    }
  }

  for (const block of blocks) {
    if (block.type === "page_break") {
      pushPage();
      continue;
    }

    let blockWords = 0;
    const blockFootnotes: string[] = [];
    for (const run of block.runs) {
      if (run.type === "text" && run.text) {
        blockWords += run.text.trim().split(/\s+/).filter(Boolean).length;
      } else if (run.type === "footnote_ref" && run.footnoteId) {
        blockFootnotes.push(run.footnoteId);
      }
    }

    const visualWeight = block.type.startsWith("heading") ? Math.max(blockWords, 40) : blockWords;

    if (currentPageBlocks.length > 0 && currentWords + visualWeight > wordsPerPage) {
      pushPage();
    }

    currentPageBlocks.push(block);
    currentWords += visualWeight;
    currentFootnoteIds.push(...blockFootnotes);
  }

  pushPage();
  return pages;
}

// Where the cited sentence sits in a block's text, counted over its text runs as
// findCitationContext counts them. The sentence comes back with its spacing collapsed,
// so it is matched with any run of whitespace between its words, and the last match
// before the note wins because that is the one the note follows.
function sentenceRange(block: DocxBlock, footnoteId: string, sentence: string): [number, number] | null {
  let text = "";
  for (const run of block.runs) {
    if (run.type === "footnote_ref" && run.footnoteId === footnoteId) break;
    if (run.type === "text") text += run.text ?? "";
  }
  const words = sentence.split(" ").filter(Boolean);
  if (!words.length) return null;
  let found: [number, number] | null = null;
  for (const match of text.matchAll(new RegExp(words.map(escapeRegExp).join("\\s+"), "g"))) {
    const start = match.index ?? 0;
    found = [start, start + match[0].length];
  }
  return found;
}

// A run's text with the part that falls inside the range marked, since a sentence can
// begin and end part way through differently formatted runs.
function markRange(text: string, start: number, [from, to]: [number, number]): ReactNode {
  const a = Math.max(from - start, 0);
  const b = Math.min(to - start, text.length);
  if (a >= b) return text;
  return (
    <>
      {text.slice(0, a)}
      <mark className="essay-sheet-cited">{text.slice(a, b)}</mark>
      {text.slice(b)}
    </>
  );
}

// Authentic paper sheet rendering the essay page by page in Times New Roman with genuine margins.
function EssayDocumentSheet({ doc, jump }: { doc: DocxDocument; jump?: JumpTarget | null }) {
  const orderedFootnotes = useMemo(() => numberedFootnotes(doc), [doc]);
  const fnMap = useMemo(() => {
    const map = new Map<string, { number: number; text: string }>();
    orderedFootnotes.forEach((fn) => {
      map.set(fn.id, { number: fn.number, text: fn.text });
    });
    return map;
  }, [orderedFootnotes]);

  const hasAnyText = doc.blocks.some((b) => b.runs.some((r) => r.type === "text" && r.text?.trim()));
  const pages = useMemo(() => paginateDocxBlocks(doc.blocks), [doc.blocks]);

  const renderBlock = (block: DocxBlock) => {
    if (block.type === "page_break") return null;

    const target = jump && jump.blockId === block.id ? jump : null;
    const range = target?.footnoteId && target.sentence ? sentenceRange(block, target.footnoteId, target.sentence) : null;
    // A block reached from the outline, or whose sentence could not be found, is marked whole.
    const jumped = target && !range ? " is-jumped" : "";
    let offset = 0;

    const runs = block.runs.map((run: DocxRun, i: number) => {
      if (run.type === "footnote_ref" && run.footnoteId) {
        const fn = fnMap.get(run.footnoteId);
        const cited = target?.footnoteId === run.footnoteId;
        return (
          <sup key={i} className={`essay-sheet-fn-ref${cited ? " is-cited" : ""}`} title={fn?.text || "Footnote"}>
            [{fn?.number ?? "?"}]
          </sup>
        );
      }
      const cls = [
        run.bold && "bold",
        run.italic && "italic",
        run.underline && "underline",
        run.strike && "strike",
      ]
        .filter(Boolean)
        .join(" ");
      const text = run.text ?? "";
      const start = offset;
      if (run.type === "text") offset += text.length;

      return (
        <span key={i} className={cls || undefined}>
          {range && run.type === "text" ? markRange(text, start, range) : text}
        </span>
      );
    });

    if (block.type === "heading1") return <h2 key={block.id} data-block-id={block.id} className={`essay-sheet-h1${jumped}`}>{runs}</h2>;
    if (block.type === "heading2") return <h3 key={block.id} data-block-id={block.id} className={`essay-sheet-h2${jumped}`}>{runs}</h3>;
    if (block.type === "heading3") return <h4 key={block.id} data-block-id={block.id} className={`essay-sheet-h3${jumped}`}>{runs}</h4>;
    if (block.type === "blockquote") return <blockquote key={block.id} data-block-id={block.id} className={`essay-sheet-quote${jumped}`}>{runs}</blockquote>;
    if (block.type === "bullet") return <ul key={block.id} data-block-id={block.id} className={`essay-sheet-list${jumped}`}><li className="essay-sheet-bullet">{runs}</li></ul>;
    if (block.type === "ordered") return <ol key={block.id} data-block-id={block.id} className={`essay-sheet-list${jumped}`}><li className="essay-sheet-ordered">{runs}</li></ol>;
    return (
      <p
        key={block.id}
        data-block-id={block.id}
        className={`essay-sheet-p${jumped}`}
        style={block.align ? { textAlign: block.align === "both" ? "justify" : block.align } : undefined}
      >
        {runs}
      </p>
    );
  };

  if (!hasAnyText) {
    return (
      <div className="essay-sheet-container">
        <article className="essay-preview-page">
          <div className="essay-sheet-empty">
            <p><strong>Nothing written yet.</strong></p>
            <p className="small muted">Use Open in word processor to start writing, or import a Word document.</p>
          </div>
        </article>
      </div>
    );
  }

  return (
    <div className="essay-sheet-container">
      {pages.map((p) => {
        const pageFootnotes = p.footnoteIds
          .map((id) => (fnMap.get(id) ? { id, ...fnMap.get(id)! } : null))
          .filter(Boolean) as { id: string; number: number; text: string }[];

        return (
          <article key={p.pageNumber} className="essay-preview-page">
            <div className="essay-page-content">
              {p.blocks.map(renderBlock)}
            </div>

            <footer className="essay-page-footer">
              {pageFootnotes.length > 0 && (
                <div className="essay-page-footnotes">
                  <hr className="essay-page-fn-rule" />
                  <ol className="essay-page-fn-list">
                    {pageFootnotes.map((fn) => (
                      <li key={fn.id} value={fn.number}>
                        {fn.text}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
              <div className="essay-page-number">{p.pageNumber}</div>
            </footer>
          </article>
        );
      })}
    </div>
  );
}

// The sliding segmented control the essay page has always used, shared by the centre's
// view switch and the pane tabs on a small screen. The indicator is measured again
// whenever the track changes size, which also covers a track that has just been shown.
function SegmentedTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; id: string; controls: string }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const active = track.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
      if (active) setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div className={`essay-tabs-track${className ? ` ${className}` : ""}`} ref={trackRef} role="tablist" aria-label={label}>
      <div
        className="essay-tab-indicator"
        style={{ transform: `translateX(${indicator.left}px)`, width: `${indicator.width}px` }}
        aria-hidden="true"
      />
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          id={option.id}
          aria-selected={value === option.value}
          aria-controls={option.controls}
          className="essay-tab-btn"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// A region a source can be dropped on. Each column registers as a list, so that
// listCollision finds whichever column is under the pointer and only a drop that
// lands on the references list cites anything.
function DropZone({ list, id, className, children }: { list: string; id?: string; className: string; children: ReactNode }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `list:${list}`, data: { list } });
  return (
    <div ref={setNodeRef} id={id} className={`${className}${active && isOver ? " is-over" : ""}`}>
      {children}
    </div>
  );
}

// A source in the rail. A mouse picks it up from anywhere outside its controls and a finger
// from its "#" handle, by the rules in drag.ts, and the "+ Cite" button is the way to cite
// it from the keyboard.
function SourceRow({
  item,
  cited,
  onCite,
  onRemove,
}: {
  item: ResearchItem;
  cited: boolean;
  onCite: () => void;
  onRemove: () => void;
}) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: `source:${item.id}`, data: { sourceId: item.id } });
  const url = item.customSource ? safeExternalUrl(item.customSource.url) : null;

  return (
    <li ref={setNodeRef} className={`essay-ws-source${isDragging ? " is-dragging" : ""}`} {...listeners}>
      <button
        type="button"
        className="essay-ws-handle"
        data-drag-handle="true"
        style={HANDLE_STYLE}
        title="Drag into References"
        aria-label={`Drag ${item.title} into References`}
        onTouchStart={(event) => event.stopPropagation()}
      >
        #
      </button>
      <div className="essay-ws-source-body">
        {item.moduleItem ? (
          <Link to={{ view: "reader", id: item.id }} title={item.title}>
            {item.title}
          </Link>
        ) : item.customSource ? (
          <span className="essay-ws-source-title">{formatCustomBibliography(item.customSource)}</span>
        ) : null}
        <span className="essay-ws-source-meta">
          <span className="badge small">{item.isModule ? "Module" : "External"}</span>
          {cited && <span className="badge small essay-ws-cited">Cited</span>}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="small muted">
              Link &rarr;
            </a>
          )}
        </span>
      </div>
      {!cited && (
        <button type="button" className="button quiet small" onClick={onCite}>
          + Cite
        </button>
      )}
      <Menu
        label={`Actions for ${item.title}`}
        items={[
          ...(!cited ? [{ label: "Add footnote citing it", onSelect: onCite }] : []),
          item.isModule
            ? { label: "Remove from essay", onSelect: onRemove }
            : { label: "Remove source", danger: true, onSelect: onRemove },
        ]}
      />
    </li>
  );
}

// One reference, edited directly as free text. It saves when the typing pauses and on blur,
// Escape puts back what it said when focus arrived (saving that again if a pause had already
// saved the edit), and an emptied reference returns to its saved text rather than vanishing.
function ReferenceRow({
  number,
  footnoteId,
  text,
  doc,
  readingId,
  onCommit,
  onJump,
}: {
  number: number;
  footnoteId: string;
  text: string;
  doc: DocxDocument;
  readingId?: string;
  onCommit: (footnoteId: string, text: string) => void;
  onJump: (target: { blockId: string; footnoteId: string; sentence: string }) => void;
}) {
  const [value, setValue] = useState(text);
  const [showContext, setShowContext] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Refs as well as state, because blur and the timer must see the newest text, not the
  // text of the render that created them.
  const valueRef = useRef(text);
  const savedRef = useRef(text);
  const baselineRef = useRef(text);
  const focusedRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const update = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };

  const commit = () => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const next = valueRef.current.trim();
    if (!next || next === savedRef.current.trim()) return;
    savedRef.current = next;
    commitRef.current(footnoteId, next);
  };

  // A change from elsewhere, such as the word processor on another device, shows here
  // unless this reference is being typed into.
  useEffect(() => {
    savedRef.current = text;
    if (!focusedRef.current) update(text);
  }, [text]);

  // A pending save is kept rather than lost when the row goes, as it does on a tab change.
  useEffect(() => () => {
    if (timerRef.current !== undefined) commit();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Grows the box to its text. A hidden pane measures nothing, so it is left alone until shown.
  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = "auto";
    if (area.scrollHeight) area.style.height = `${area.scrollHeight}px`;
  }, [value]);

  const context = useMemo(
    () => (showContext ? findCitationContext(doc, footnoteId) : null),
    [showContext, doc, footnoteId],
  );

  return (
    <li className="essay-ws-ref">
      <span className="essay-ref-badge">[{number}]</span>
      <div className="essay-ws-ref-body">
        <textarea
          ref={areaRef}
          className="essay-ws-ref-text"
          rows={1}
          value={value}
          spellCheck
          aria-label={`Footnote ${number}`}
          onFocus={() => {
            focusedRef.current = true;
            baselineRef.current = valueRef.current;
          }}
          onChange={(event) => {
            update(event.target.value);
            window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(commit, REFERENCE_SAVE_DELAY);
          }}
          onBlur={() => {
            focusedRef.current = false;
            if (!valueRef.current.trim()) update(savedRef.current);
            commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              update(baselineRef.current);
              event.currentTarget.blur();
            } else if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
        <div className="essay-ws-ref-tools">
          <button
            type="button"
            className="button quiet small"
            aria-expanded={showContext}
            onClick={() => setShowContext((current) => !current)}
          >
            Cited where?
          </button>
          {readingId && (
            <Link to={{ view: "reader", id: readingId }} className="small muted">
              Open reading &rarr;
            </Link>
          )}
        </div>
        {showContext && (
          <div className="essay-ws-ref-context" role="status">
            {context ? (
              <button
                type="button"
                className="essay-ws-ref-sentence"
                title="Show this sentence in the preview"
                onClick={() => onJump({ blockId: context.blockId, footnoteId, sentence: context.sentence })}
              >
                {context.sentence ? `\u201c${context.sentence}\u201d` : "The note opens its paragraph."}
              </button>
            ) : (
              <p className="small muted">Not cited in the essay yet.</p>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function AssessmentPage({ id, essayId }: { id: string; essayId?: string }) {
  const module = useSuspendingLiveQuery(async () => {
    const found = await db.modules.get(id);
    return found && !found.deleted ? found : null;
  }, ["assessment-module", id]);
  useTitle(module ? `${module.code} essay` : undefined);
  if (module === null) return <div className="page"><p className="muted">This module no longer exists.</p></div>;
  return <AssessmentBody module={module} essayId={essayId} />;
}

function AssessmentBody({ module, essayId }: { module: ModuleRow; essayId?: string }) {
  const assessment = useModuleAssessment(module.id, module.code, essayId);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const inflightSaves = useRef(0);
  const failedSave = useRef(false);
  // Every field save goes through here so the status beside the title stays truthful. A counter
  // holds the status at "Saving" while any save is running, and a failure is remembered until the
  // last overlapping save settles, so a later success cannot report "Saved" over a lost change.
  const save = async (patch: Parameters<typeof saveModuleAssessment>[1]) => {
    if (inflightSaves.current === 0) failedSave.current = false;
    inflightSaves.current += 1;
    setSaveState("saving");
    try {
      await saveModuleAssessment(module.id, patch, { moduleCode: module.code, essayId });
    } catch (err) {
      console.error("Saving the essay failed", err);
      failedSave.current = true;
    } finally {
      inflightSaves.current -= 1;
      if (inflightSaves.current === 0) setSaveState(failedSave.current ? "error" : "saved");
    }
  };

  const [pane, setPane] = useState<Pane>("centre");
  const [centreView, setCentreView] = useState<CentreView>("preview");
  const [question, setQuestion] = useState(assessment.title);
  const [target, setTarget] = useState(assessment.wordTarget ? String(assessment.wordTarget) : "");
  const typingQuestion = useRef(false);
  const typingTarget = useRef(false);
  const [zoom, setZoom] = useState(PREVIEW_DEFAULT_ZOOM);
  const cancelTarget = useRef(false);
  const [jump, setJump] = useState<JumpTarget | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [uploadingIds, setUploadingIds] = useState<string[]>([]);
  const previewRef = useRef<HTMLDivElement>(null);
  const sensors = useDragSensors();

  useEffect(() => {
    if (!typingQuestion.current) setQuestion(assessment.title);
  }, [assessment.title]);

  useEffect(() => {
    if (!typingTarget.current) setTarget(assessment.wordTarget ? String(assessment.wordTarget) : "");
  }, [assessment.wordTarget]);

  // Scrolls the preview to the place chosen in a side column once it has rendered, and lets
  // the highlight go after a moment so the page reads normally again.
  useEffect(() => {
    if (!jump) return;
    const frame = window.requestAnimationFrame(() => {
      previewRef.current
        ?.querySelector(`[data-block-id="${CSS.escape(jump.blockId)}"]`)
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const clear = window.setTimeout(() => setJump(null), JUMP_HIGHLIGHT_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [jump]);

  const [choosing, setChoosing] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [addingCustom, setAddingCustom] = useState(false);
  const [newSourceKind, setNewSourceKind] = useState<"primary" | "secondary">("secondary");
  const [newSourceAuthor, setNewSourceAuthor] = useState("");
  const [newSourceTitle, setNewSourceTitle] = useState("");
  const [newSourceYear, setNewSourceYear] = useState("");
  const [newSourcePublisher, setNewSourcePublisher] = useState("");
  const [newSourceUrl, setNewSourceUrl] = useState("");
  const [newSourceNotes, setNewSourceNotes] = useState("");

  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const importer = useRef<HTMLInputElement>(null);
  const adminInput = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => countDocxWords(assessment.draft), [assessment.draft]);
  const includeFootnotes = assessment.includeFootnotes !== false;
  const effectiveWords = effectiveWordCount(counts, assessment.draft, includeFootnotes);
  const due = assessment.dueDate ? countdown(assessment.dueDate) : null;
  const hasContent = hasDocxBytes(assessment) || counts.body + counts.quotes + counts.footnotes > 0;
  const unsavedTitle = question.trim() !== (assessment.title ?? "").trim();
  const saveLabel = unsavedTitle
    ? "Unsaved"
    : saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Not saved"
        : "Saved";
  const saveStatus = unsavedTitle ? "unsaved" : saveState;
  const adminDocuments = assessment.adminDocuments ?? [];

  const zoomBy = (direction: 1 | -1) => {
    const next = Math.min(PREVIEW_MAX_ZOOM, clampZoom(stepZoom(zoom, direction)));
    // At either end there is no further step, so nothing changes.
    if (direction > 0 ? next <= zoom + 0.001 : next >= zoom - 0.001) return;
    setZoom(next);
  };

  const commitTarget = () => {
    typingTarget.current = false;
    if (cancelTarget.current) {
      cancelTarget.current = false;
      setTarget(assessment.wordTarget ? String(assessment.wordTarget) : "");
      return;
    }
    const raw = target.trim();
    const parsed = raw === "" ? null : Math.round(Number(raw));
    const next = parsed !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    setTarget(next ? String(next) : "");
    if (next !== (assessment.wordTarget ?? null)) void save({ wordTarget: next });
  };

  const handleImportClick = async () => {
    if (hasContent) {
      const ok = await confirmAction({
        title: "Replace the Word document?",
        body: "The current draft will be replaced by the file you choose. Save a snapshot first if you may want it back.",
        confirm: "Choose file",
      });
      if (!ok) return;
    }
    importer.current?.click();
  };

  // Module readings
  const refIds = assessment.referenceItemIds.join(",");
  const readings = useLiveQuery(
    async () => {
      const weeks = (await db.weeks.where("module_id").equals(module.id).toArray()).filter((w) => !w.deleted);
      const weekIds = new Set(weeks.map((w) => w.id));
      const links = (await db.week_items.toArray()).filter((wi) => !wi.deleted && weekIds.has(wi.week_id));
      const ids = new Set(links.map((wi) => wi.item_id));
      for (const chosen of assessment.referenceItemIds) ids.add(chosen);
      const rows = (await db.items.toArray()).filter(
        (i) => !i.deleted && i.kind !== "slides" && (ids.has(i.id) || i.tray_module_id === module.id),
      );
      return rows.sort((a, b) => fullTitle(a).localeCompare(fullTitle(b)));
    },
    [module.id, refIds],
    [] as ItemRow[],
  );

  const chosenModuleItems = useMemo(() => {
    const set = new Set(assessment.referenceItemIds);
    return readings.filter((i) => set.has(i.id));
  }, [readings, assessment.referenceItemIds]);

  const primaryModuleItems = chosenModuleItems.filter((i) => i.kind === "primary");
  const secondaryModuleItems = chosenModuleItems.filter((i) => i.kind !== "primary");

  const customSources = assessment.customSources ?? [];
  const primaryCustomSources = customSources.filter((s) => s.kind === "primary");
  const secondaryCustomSources = customSources.filter((s) => s.kind !== "primary");

  const hasSources = chosenModuleItems.length > 0 || customSources.length > 0;

  const orderedFootnotes = useMemo(() => numberedFootnotes(assessment.draft), [assessment.draft]);

  const allResearchItems = useMemo(() => {
    const list: ResearchItem[] = [];
    chosenModuleItems.forEach((item) => {
      list.push({ id: item.id, title: fullTitle(item), isModule: true, moduleItem: item });
    });
    customSources.forEach((src) => {
      list.push({ id: src.id, title: src.title, isModule: false, customSource: src });
    });
    return list;
  }, [chosenModuleItems, customSources]);

  const citedIds = useMemo(() => {
    const set = new Set<string>();
    orderedFootnotes.forEach((fn) => {
      if (fn.text) {
        const rawFn = assessment.draft.footnotes.find((f) => f.id === fn.id);
        if (rawFn?.citationItemId) set.add(rawFn.citationItemId);
        allResearchItems.forEach((ri) => {
          if (ri.title.length > 4 && fn.text.toLowerCase().includes(ri.title.toLowerCase())) {
            set.add(ri.id);
          }
        });
      }
    });
    return set;
  }, [orderedFootnotes, assessment.draft.footnotes, allResearchItems]);

  // The draft's headings, for the outline in the right column.
  const outline = useMemo(
    () =>
      assessment.draft.blocks
        .filter((block) => block.type.startsWith("heading"))
        .map((block) => ({
          id: block.id,
          level: block.type === "heading1" ? 1 : block.type === "heading2" ? 2 : 3,
          text: block.runs.map((run) => (run.type === "text" ? run.text ?? "" : "")).join("").trim(),
        }))
        .filter((heading) => heading.text),
    [assessment.draft.blocks],
  );

  const handleSaveFootnote = (fnId: string, newText: string) => {
    void save((prev) => ({
      ...prev,
      draft: {
        ...prev.draft,
        footnotes: prev.draft.footnotes.map((f) => (f.id === fnId ? { ...f, text: newText } : f)),
      },
    }));
  };

  const toggleModuleSource = async (itemId: string) => {
    await save((prev) => ({
      ...prev,
      referenceItemIds: prev.referenceItemIds.includes(itemId)
        ? prev.referenceItemIds.filter((x) => x !== itemId)
        : [...prev.referenceItemIds, itemId],
    }));
  };

  const handleCreateCustomSource = async () => {
    if (!newSourceTitle.trim()) {
      showToast("Please enter a title for the source.");
      return;
    }
    const source: CustomSource = {
      id: newId(),
      author: newSourceAuthor.trim() || undefined,
      title: newSourceTitle.trim(),
      year: newSourceYear.trim() || undefined,
      kind: newSourceKind,
      publisher: newSourcePublisher.trim() || undefined,
      url: newSourceUrl.trim() || undefined,
      notes: newSourceNotes.trim() || undefined,
    };
    await save((prev) => ({
      ...prev,
      customSources: [...(prev.customSources ?? []), source],
    }));
    setNewSourceAuthor("");
    setNewSourceTitle("");
    setNewSourceYear("");
    setNewSourcePublisher("");
    setNewSourceUrl("");
    setNewSourceNotes("");
    setAddingCustom(false);
    showToast("External source added.");
  };

  const handleDeleteCustomSource = async (sourceId: string) => {
    await save((prev) => ({
      ...prev,
      customSources: (prev.customSources ?? []).filter((s) => s.id !== sourceId),
    }));
    showToast("Source removed.");
  };

  const copyBibliography = async () => {
    const lines: string[] = [];
    const allPrimary = [
      ...primaryModuleItems.map(chicagoBibliography),
      ...primaryCustomSources.map(formatCustomBibliography),
    ].sort();
    const allSecondary = [
      ...secondaryModuleItems.map(chicagoBibliography),
      ...secondaryCustomSources.map(formatCustomBibliography),
    ].sort();

    if (allPrimary.length) {
      lines.push("Primary sources", ...allPrimary, "");
    }
    if (allSecondary.length) {
      lines.push("Secondary sources", ...allSecondary);
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n").trim());
      showToast("Bibliography copied to clipboard.");
    } catch {
      showToast("Could not copy the bibliography.");
    }
  };

  // Cites a source with a footnote at the end of the draft, for the "+ Cite" button and for a
  // drop on the references. The draft is checked again inside the save, so two quick drops of
  // the same source still leave a single footnote.
  const citeInDraft = async (item: ResearchItem) => {
    const already = "That source is already cited in the references.";
    if (citedIds.has(item.id)) {
      showToast(already);
      return;
    }
    const text = item.moduleItem
      ? formatChicagoFootnote(item.moduleItem)
      : item.customSource
        ? formatCustomFootnote(item.customSource)
        : null;
    if (!text) return;
    const footnoteId = `fn-${newId()}`;
    let added = false;
    await save((prev) => {
      if (prev.draft.footnotes.some((f) => f.citationItemId === item.id)) return prev;
      added = true;
      const blocks = [...prev.draft.blocks];
      const last = blocks.length - 1;
      if (last >= 0) {
        blocks[last] = {
          ...blocks[last],
          runs: [...blocks[last].runs, { type: "footnote_ref", footnoteId }],
        };
      }
      const note: DocxFootnote = { id: footnoteId, text, citationItemId: item.id };
      return {
        ...prev,
        draft: { ...prev.draft, blocks, footnotes: [...prev.draft.footnotes, note] },
      };
    });
    showToast(added ? "Footnote added at the end of the draft." : already);
  };

  const removeSource = (item: ResearchItem) => {
    if (item.isModule) void toggleModuleSource(item.id);
    else void handleDeleteCustomSource(item.id);
  };

  // An admin document is listed straight away and gains its storage key once uploaded, which
  // is how the attachment type marks one still on its way. Rows without a key that this page
  // is not uploading were cut short, for instance by a reload, and can only be removed.
  const addAdminDocuments = async (files: File[]) => {
    if (!files.length) return;
    if (!navigator.onLine) {
      showToast("Connect to the internet to add a document.");
      return;
    }
    for (const file of files) {
      if (file.size > ADMIN_DOCUMENT_LIMIT) {
        showToast(`${file.name} is over 50 MB.`);
        continue;
      }
      const ref: AttachmentRef = {
        id: newId(),
        name: file.name,
        size: file.size,
        mime: mimeFor(file) ?? (file.type || "application/octet-stream"),
      };
      setUploadingIds((ids) => [...ids, ref.id]);
      await save((prev) => ({ ...prev, adminDocuments: [...(prev.adminDocuments ?? []), ref] }));
      try {
        const r2Key = await uploadAdminDocument(file, ref.mime);
        await save((prev) => ({
          ...prev,
          adminDocuments: (prev.adminDocuments ?? []).map((d) => (d.id === ref.id ? { ...d, r2Key } : d)),
        }));
      } catch (err) {
        console.error("Uploading the document failed", err);
        await save((prev) => ({
          ...prev,
          adminDocuments: (prev.adminDocuments ?? []).filter((d) => d.id !== ref.id),
        }));
        showToast(`Could not upload ${file.name}.`);
      } finally {
        setUploadingIds((ids) => ids.filter((x) => x !== ref.id));
      }
    }
  };

  const removeAdminDocument = async (doc: AttachmentRef) => {
    const ok = await confirmAction({
      title: `Remove "${doc.name}"?`,
      body: "The document will no longer be listed with this essay.",
      confirm: "Remove document",
      danger: true,
    });
    if (!ok) return;
    await save((prev) => ({
      ...prev,
      adminDocuments: (prev.adminDocuments ?? []).filter((d) => d.id !== doc.id),
    }));
    showToast("Document removed.");
  };

  const saveSnapshot = async () => {
    if (savingSnapshot) return;
    setSavingSnapshot(true);
    try {
      await saveDraftSnapshot(module.id, snapshotName, module.code, essayId);
      setSnapshotName("");
      showToast("Snapshot saved.");
    } finally {
      setSavingSnapshot(false);
    }
  };

  const handleDeleteAssessment = async () => {
    const ok = await confirmAction({
      title: `Delete "${assessment.title || "Essay"}"?`,
      body: "This essay, its draft and plan will be removed. This cannot be undone.",
      confirm: "Delete essay",
      danger: true,
    });
    if (!ok) return;
    await deleteModuleEssay(module.id, essayId ?? "default");
    showToast("Essay removed.");
    navigate({ view: "module", id: module.id });
  };

  // Shows a place in the draft from either side column, bringing the preview forward first
  // and closing the drawer or pane that covered it on a smaller screen.
  const jumpTo = (next: Omit<JumpTarget, "token">) => {
    setCentreView("preview");
    setPane("centre");
    setJump({ ...next, token: Date.now() });
  };

  const sourceIdOf = (data: unknown): string | null => {
    const id = (data as { sourceId?: unknown } | undefined)?.sourceId;
    return typeof id === "string" ? id : null;
  };

  const handleDragStart = (event: DragStartEvent) => setDragId(sourceIdOf(event.active.data.current));

  // A source is copied, never moved: it stays in the rail and the references gain a footnote.
  const handleDragEnd = (event: DragEndEvent) => {
    setDragId(null);
    swallowClickAfterDrag();
    const list = (event.over?.data.current as { list?: unknown } | undefined)?.list;
    const id = sourceIdOf(event.active.data.current);
    if (list !== "references" || !id) return;
    const item = allResearchItems.find((r) => r.id === id);
    if (item) void citeInDraft(item);
  };

  const draggedItem = dragId ? allResearchItems.find((r) => r.id === dragId) ?? null : null;

  const wordProcessorRoute = {
    view: "essay" as const,
    id: module.id,
    ...(essayId && essayId !== "default" ? { essay: essayId } : {}),
  };

  return (
    <div className="page wide essay-page essay-ws-page">
      <div className="crumbs" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <Link to={{ view: "module", id: module.id }}>{module.code}</Link> <span aria-hidden="true">/</span> Essay
        </div>
        <Menu
          label="Essay actions"
          items={[
            {
              label: "Delete essay",
              danger: true,
              onSelect: () => void handleDeleteAssessment(),
            },
          ]}
        />
      </div>

      <div className="section-head essay-head essay-ws-head">
        <input
          className="title-input essay-title-input"
          type="text"
          value={question}
          placeholder="Essay title or question as set"
          aria-label="Essay question"
          onChange={(e) => setQuestion(e.target.value)}
          onBlur={(e) => void save({ title: e.target.value.trim() })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          style={{
            fontFamily: "var(--serif)",
            fontSize: "var(--fs-2xl)",
            fontWeight: 700,
            border: "none",
            background: "transparent",
            padding: 0,
            width: "100%",
            maxWidth: "42rem",
            color: "var(--ink)",
          }}
        />
        <span className="spacer" />
        <span className="save-status" data-status={saveStatus} role="status" aria-live="polite">
          <span className="save-status-dot" aria-hidden="true" />
          {saveLabel}
        </span>
        <button type="button" className="button small" onClick={() => setSnapshotsOpen(true)}>
          Snapshots{assessment.previousDrafts.length > 0 ? ` (${assessment.previousDrafts.length})` : ""}
        </button>
      </div>

      <SegmentedTabs
        className="essay-ws-tabs"
        label="Essay workspace"
        value={pane}
        onChange={setPane}
        options={[
          { value: "rail", label: "Brief & sources", id: "essay-pane-tab-rail", controls: "essay-pane-rail" },
          { value: "centre", label: "Essay", id: "essay-pane-tab-centre", controls: "essay-pane-centre" },
          {
            value: "aside",
            label: `References${orderedFootnotes.length ? ` (${orderedFootnotes.length})` : ""}`,
            id: "essay-pane-tab-aside",
            controls: "essay-pane-aside",
          },
        ]}
      />

      <DndContext
        sensors={sensors}
        collisionDetection={listCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setDragId(null)}
      >
        <div className="essay-ws" data-pane={pane}>
          {/* Left rail: the brief, the essay's own papers and its sources */}
          <DropZone list="sources" id="essay-pane-rail" className="essay-ws-rail">
            <section className="essay-panel essay-ws-card" aria-labelledby="essay-brief-head">
              <h2 id="essay-brief-head" className="essay-ws-card-title">Brief</h2>
              <div className="essay-ws-brief-count">
                <strong>{effectiveWords.toLocaleString("en-GB")}</strong>{" "}
                <span className="muted">{effectiveWords === 1 ? "word" : "words"}</span>{" "}
                <span className="essay-inline-target">
                  {editingTarget ? (
                    <>
                      <span className="muted">of </span>
                      <input
                        type="number"
                        autoFocus
                        inputMode="numeric"
                        min={0}
                        step={100}
                        value={target}
                        placeholder="2500"
                        aria-label="Word target"
                        title="Word target"
                        style={{ width: `${Math.max(target.length, 4) + 1}ch` }}
                        onFocus={() => {
                          typingTarget.current = true;
                        }}
                        onChange={(e) => setTarget(e.target.value)}
                        onBlur={() => {
                          setEditingTarget(false);
                          commitTarget();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            setEditingTarget(false);
                            commitTarget();
                          }
                          if (e.key === "Escape") {
                            cancelTarget.current = true;
                            setEditingTarget(false);
                            commitTarget();
                          }
                        }}
                      />
                      <span className="muted"> target</span>
                    </>
                  ) : assessment.wordTarget ? (
                    <>
                      <span className="muted">of </span>
                      <button
                        type="button"
                        className="essay-target-btn"
                        onClick={() => {
                          setTarget(String(assessment.wordTarget));
                          setEditingTarget(true);
                        }}
                        title="Click to edit target word count"
                      >
                        {assessment.wordTarget.toLocaleString("en-GB")}
                      </button>
                      <span className="muted"> target</span>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="essay-target-btn muted"
                      onClick={() => {
                        setTarget("");
                        setEditingTarget(true);
                      }}
                      title="Click to set target word count"
                    >
                      Set target
                    </button>
                  )}
                </span>
              </div>
              <p className="small muted essay-ws-breakdown">
                Body {counts.body.toLocaleString("en-GB")}, block quotations {counts.quotes.toLocaleString("en-GB")}, footnotes {counts.footnotes.toLocaleString("en-GB")}.
              </p>
              <label className="essay-footnote-toggle">
                <input
                  type="checkbox"
                  checked={includeFootnotes}
                  onChange={(e) => void save({ includeFootnotes: e.target.checked })}
                />
                <span>Include footnotes in word count</span>
              </label>
              <div className="essay-ws-brief-row">
                <DatePicker
                  value={assessment.dueDate ?? null}
                  onChange={(d) => void save({ dueDate: d })}
                  label="Assessment due date"
                  title={`Due date for ${assessment.title || "the essay"}`}
                  placeholder="Set due date"
                  clearable
                  className={`essay-due-chip${due && (due.state === "soon" || due.state === "today") ? " is-soon" : ""}`}
                />
                {due && assessment.dueDate ? <span className="muted small essay-due-words">{due.words}</span> : null}
              </div>
            </section>

            <section className="essay-panel essay-ws-card" aria-labelledby="essay-admin-head">
              <div className="essay-ws-card-head">
                <h2 id="essay-admin-head" className="essay-ws-card-title">Admin documents</h2>
                <button type="button" className="button quiet small" onClick={() => adminInput.current?.click()}>
                  Add
                </button>
              </div>
              {adminDocuments.length === 0 ? (
                <p className="small muted">Add the brief, the marking criteria or any other papers for this essay.</p>
              ) : (
                <ul className="essay-ws-docs">
                  {adminDocuments.map((doc) => (
                    <li key={doc.id}>
                      {doc.r2Key ? (
                        <a
                          className="essay-ws-doc-name"
                          href={`/api/objects/${doc.r2Key}`}
                          target="_blank"
                          rel="noreferrer"
                          title={`Open ${doc.name}`}
                        >
                          {doc.name}
                        </a>
                      ) : (
                        <span className="essay-ws-doc-name">{doc.name}</span>
                      )}
                      <span className="small muted">
                        {doc.r2Key ? fileSize(doc.size) : uploadingIds.includes(doc.id) ? "Uploading…" : "Upload interrupted"}
                      </span>
                      <button
                        type="button"
                        className="button quiet small"
                        aria-label={`Remove ${doc.name}`}
                        onClick={() => void removeAdminDocument(doc)}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="essay-panel essay-ws-card" aria-labelledby="essay-sources-head">
              <div className="essay-ws-card-head">
                <h2 id="essay-sources-head" className="essay-ws-card-title">Sources</h2>
                <button type="button" className="button quiet small" onClick={() => setChoosing(true)}>
                  Readings
                </button>
                <button type="button" className="button quiet small" onClick={() => setAddingCustom(true)}>
                  Add
                </button>
              </div>
              {allResearchItems.length === 0 ? (
                <p className="small muted">Choose readings from this module or add external sources.</p>
              ) : (
                <>
                  <p className="small muted">Drag a source into References to cite it, or use + Cite.</p>
                  <ul className="essay-ws-sources">
                    {allResearchItems.map((item) => (
                      <SourceRow
                        key={item.id}
                        item={item}
                        cited={citedIds.has(item.id)}
                        onCite={() => void citeInDraft(item)}
                        onRemove={() => removeSource(item)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </section>
          </DropZone>

          {/* Centre: the essay itself */}
          <DropZone list="draft" id="essay-pane-centre" className="essay-ws-centre">
            <div className="essay-ws-toolbar">
              <SegmentedTabs
                label="Essay view"
                value={centreView}
                onChange={setCentreView}
                options={[
                  { value: "preview", label: "Preview", id: "essay-view-preview", controls: "essay-centre-preview" },
                  { value: "plan", label: "Plan & argument", id: "essay-view-plan", controls: "essay-centre-plan" },
                ]}
              />
              <span className="spacer" />
              <Link to={wordProcessorRoute} className="button primary essay-open-button">
                <Icon name="notes" size={16} />
                <span>Open in word processor</span>
              </Link>
              <button
                type="button"
                className="button small essay-ws-drawer-toggle"
                aria-expanded={pane === "aside"}
                aria-controls="essay-pane-aside"
                onClick={() => setPane((current) => (current === "aside" ? "centre" : "aside"))}
              >
                References{orderedFootnotes.length ? ` (${orderedFootnotes.length})` : ""}
              </button>
            </div>

            {centreView === "preview" ? (
              <div
                id="essay-centre-preview"
                role="tabpanel"
                aria-labelledby="essay-view-preview"
                className="essay-ws-preview"
                ref={previewRef}
              >
                <div className="essay-ws-preview-bar">
                  <div className="essay-zoom-controls" role="group" aria-label="Zoom">
                    <IconButton icon="zoomOut" label="Zoom out" disabled={zoom <= ZOOM_STEPS[0] + 0.001} onClick={() => zoomBy(-1)} />
                    <button
                      type="button"
                      className="essay-zoom-percent"
                      title="Reset zoom to 100%"
                      aria-label={`Zoom ${Math.round(zoom * 100)} per cent. Reset to 100 per cent`}
                      onClick={() => setZoom(1)}
                    >
                      {Math.round(zoom * 100)}%
                    </button>
                    <IconButton icon="zoomIn" label="Zoom in" disabled={zoom >= PREVIEW_MAX_ZOOM - 0.001} onClick={() => zoomBy(1)} />
                  </div>
                  <div className="row essay-preview-actions">
                    <button
                      type="button"
                      className="button small"
                      onClick={() => {
                        downloadDocxFile(assessment.draft, assessment.title);
                        showToast("Word document downloaded.");
                      }}
                    >
                      Export .docx
                    </button>
                    <button type="button" className="button quiet small" onClick={() => void handleImportClick()}>
                      {hasContent ? "Replace Word document" : "Import Word document"}
                    </button>
                  </div>
                </div>
                <PageZoomViewport zoom={zoom} label="Essay preview">
                  <EssayDocumentSheet doc={assessment.draft} jump={jump} />
                </PageZoomViewport>
              </div>
            ) : (
              <div id="essay-centre-plan" role="tabpanel" aria-labelledby="essay-view-plan" className="essay-plan">
                <p className="small muted essay-hint">
                  Structure your thesis and argument. Use headings for sections, bullet points for evidence, and @ to cite readings directly.
                </p>
                <Suspense fallback={<NotesLoading />}>
                  <NoteEditor
                    target={{ week_id: assessmentNotesKey(module.id, essayId) }}
                    label="Plan and argument"
                    placeholder="Your central thesis statement in a sentence, followed by section headings and arguments..."
                  />
                </Suspense>
              </div>
            )}
          </DropZone>

          {/* Right column: references and outline, a drawer below 1280px */}
          <aside id="essay-pane-aside" className="essay-ws-aside" aria-label="References and outline">
            <DropZone list="references" className="essay-panel essay-ws-card essay-ws-refs">
              <div className="essay-ws-card-head">
                <h2 className="essay-ws-card-title">References ({orderedFootnotes.length})</h2>
                {(orderedFootnotes.length > 0 || hasSources) && (
                  <button type="button" className="button quiet small" onClick={() => void copyBibliography()}>
                    Copy bibliography
                  </button>
                )}
                <button
                  type="button"
                  className="button quiet small essay-ws-drawer-close"
                  aria-label="Close references"
                  onClick={() => setPane("centre")}
                >
                  Close
                </button>
              </div>
              {orderedFootnotes.length === 0 ? (
                <p className="small muted essay-ws-drop-hint">Drag a source here to cite it at the end of the draft.</p>
              ) : (
                <ol className="essay-ws-ref-list">
                  {orderedFootnotes.map((fn) => {
                    const rawFn = assessment.draft.footnotes.find((f) => f.id === fn.id);
                    const linked = rawFn?.citationItemId
                      ? allResearchItems.find((r) => r.id === rawFn.citationItemId)
                      : undefined;
                    return (
                      <ReferenceRow
                        key={fn.id}
                        number={fn.number}
                        footnoteId={fn.id}
                        text={fn.text}
                        doc={assessment.draft}
                        readingId={linked?.moduleItem ? linked.id : undefined}
                        onCommit={handleSaveFootnote}
                        onJump={jumpTo}
                      />
                    );
                  })}
                </ol>
              )}
            </DropZone>

            <section className="essay-panel essay-ws-card" aria-labelledby="essay-outline-head">
              <h2 id="essay-outline-head" className="essay-ws-card-title">Outline</h2>
              {outline.length === 0 ? (
                <p className="small muted">Headings in the draft appear here, so that you can move between its sections.</p>
              ) : (
                <ul className="essay-ws-outline">
                  {outline.map((heading) => (
                    <li key={heading.id}>
                      <button type="button" data-level={heading.level} onClick={() => jumpTo({ blockId: heading.id })}>
                        {heading.text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </aside>
        </div>

        <DragOverlay dropAnimation={null}>
          {draggedItem ? <div className="essay-ws-drag-chip">{draggedItem.title}</div> : null}
        </DragOverlay>
      </DndContext>

      {/* Revision snapshots */}
      <Sheet
        open={snapshotsOpen}
        onClose={() => setSnapshotsOpen(false)}
        title="Revision snapshots"
        subtitle="Save named snapshots before major revisions to preserve your work and compare changes."
        footer={<button type="button" className="button primary" onClick={() => setSnapshotsOpen(false)}>Done</button>}
      >
        <div className="essay-snapshot-form">
          <input
            type="text"
            aria-label="Snapshot name"
            placeholder="First full draft, pre-supervision feedback..."
            value={snapshotName}
            enterKeyHint="done"
            onChange={(e) => setSnapshotName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveSnapshot();
            }}
          />
          <button
            type="button"
            className="button primary"
            disabled={savingSnapshot}
            onClick={() => void saveSnapshot()}
          >
            {savingSnapshot ? "Saving..." : "Save snapshot"}
          </button>
        </div>

        {assessment.previousDrafts.length > 0 ? (
          <ul className="essay-snapshot-list" style={{ marginTop: "1rem" }}>
            {assessment.previousDrafts.map((snap) => (
              <li key={snap.id}>
                <span className="name">
                  <strong>{snap.name}</strong>
                  <span className="when">
                    {snap.word_count.toLocaleString("en-GB")} {snap.word_count === 1 ? "word" : "words"},{" "}
                    {shortDate(new Date(snap.created_at))},{" "}
                    {new Date(snap.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </span>
                <Menu
                  label={`Actions for ${snap.name}`}
                  items={[
                    {
                      label: "Restore snapshot",
                      onSelect: async () => {
                        const ok = await confirmAction({
                          title: `Restore "${snap.name}"?`,
                          body: "This replaces the current draft. Save a snapshot first if you wish to keep current changes.",
                          confirm: "Restore snapshot",
                        });
                        if (!ok) return;
                        await restoreDraftSnapshot(module.id, snap.id, module.code, essayId);
                        showToast(`"${snap.name}" restored.`);
                      },
                    },
                    {
                      label: "Download .docx",
                      onSelect: () => downloadDocxFile(snap.doc, snap.name),
                    },
                    {
                      label: "Delete snapshot",
                      danger: true,
                      onSelect: async () => {
                        const ok = await confirmAction({
                          title: `Delete "${snap.name}"?`,
                          body: "The snapshot cannot be retrieved once deleted. The current draft is not affected.",
                          confirm: "Delete snapshot",
                          danger: true,
                        });
                        if (!ok) return;
                        await deleteDraftSnapshot(module.id, snap.id, module.code, essayId);
                        showToast("Snapshot deleted.");
                      },
                    },
                  ]}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted" style={{ marginTop: "1rem" }}>No snapshots saved yet.</p>
        )}
      </Sheet>

      {/* Module reading selection sheet */}
      <Sheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title="Choose module readings"
        subtitle={`Readings assigned in ${module.code}`}
        className="essay-sources-sheet"
        footer={<button type="button" className="button primary" onClick={() => setChoosing(false)}>Done</button>}
      >
        {readings.length === 0 ? (
          <p className="small muted">No readings in this module yet. Add them to its weeks first.</p>
        ) : (
          (["primary", "secondary"] as const).map((group) => {
            const rows = readings.filter((i) => (group === "primary" ? i.kind === "primary" : i.kind !== "primary"));
            if (!rows.length) return null;
            return (
              <div key={group} className="essay-source-group" style={{ marginBottom: "1rem" }}>
                <h3 style={{ fontSize: "var(--fs-sm)", color: "var(--muted)", textTransform: "uppercase" }}>
                  {group === "primary" ? "Primary sources" : "Secondary reading"}
                </h3>
                <ul className="citation-list">
                  {rows.map((item) => (
                    <li key={item.id}>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={assessment.referenceItemIds.includes(item.id)}
                          onChange={() => void toggleModuleSource(item.id)}
                        />
                        <span>{fullTitle(item)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </Sheet>

      {/* Add external source sheet */}
      <Sheet
        open={addingCustom}
        onClose={() => setAddingCustom(false)}
        title="Add external source"
        subtitle="Archival documents, journal articles, books, or web resources"
        footer={
          <div className="row" style={{ gap: "0.5rem", justifyContent: "flex-end" }}>
            <button type="button" className="button quiet" onClick={() => setAddingCustom(false)}>
              Cancel
            </button>
            <button type="button" className="button primary" onClick={() => void handleCreateCustomSource()}>
              Add source
            </button>
          </div>
        }
      >
        <div style={{ display: "grid", gap: "0.9rem" }}>
          <label className="field">
            <span>Source type</span>
            <select
              value={newSourceKind}
              onChange={(e) => setNewSourceKind(e.target.value as "primary" | "secondary")}
            >
              <option value="secondary">Secondary reading (Book, journal article, chapter)</option>
              <option value="primary">Primary source (Archive, treaty, pamphlet, speech, paper)</option>
            </select>
          </label>
          <label className="field">
            <span>Title (required)</span>
            <input
              type="text"
              placeholder="The title of the book, paper, or article"
              value={newSourceTitle}
              onChange={(e) => setNewSourceTitle(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Author(s) / Creator</span>
            <input
              type="text"
              placeholder="e.g. Hobsbawm, Eric or Foreign Office"
              value={newSourceAuthor}
              onChange={(e) => setNewSourceAuthor(e.target.value)}
            />
          </label>
          <div className="row" style={{ gap: "0.75rem" }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Publication year / Date</span>
              <input
                type="text"
                placeholder="e.g. 1962 or 14 July 1789"
                value={newSourceYear}
                onChange={(e) => setNewSourceYear(e.target.value)}
              />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span>Publisher / Archive reference</span>
              <input
                type="text"
                placeholder="e.g. Weidenfeld & Nicolson or TNA FO 371/..."
                value={newSourcePublisher}
                onChange={(e) => setNewSourcePublisher(e.target.value)}
              />
            </label>
          </div>
          <label className="field">
            <span>URL / Archive locator</span>
            <input
              type="url"
              placeholder="https://..."
              value={newSourceUrl}
              onChange={(e) => setNewSourceUrl(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Research notes / Call number</span>
            <input
              type="text"
              placeholder="Shelfmark, call number, or key themes"
              value={newSourceNotes}
              onChange={(e) => setNewSourceNotes(e.target.value)}
            />
          </label>
        </div>
      </Sheet>

      <input
        ref={importer}
        type="file"
        hidden
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            await importAssessmentDocxFile(module.id, file, module.code, essayId);
            showToast(`${file.name} imported as the draft.`);
          } catch (err) {
            showToast(err instanceof Error ? err.message : "Could not import that Word document.");
          }
        }}
      />

      <input
        ref={adminInput}
        type="file"
        hidden
        multiple
        accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.rtf,.odt"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void addAdminDocuments(files);
        }}
      />
    </div>
  );
}
