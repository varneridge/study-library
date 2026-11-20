// Assessment & essay: a module's essay studio, laid out for an LSE history student.
// The workspace has three flush columns so that the writing stays front and centre: the brief
// with its admin documents, the module readings and the essay's sources on the left, the
// essay itself in the centre (the page preview or the plan), and its references on the
// right. The essay's pages scroll with the window, as one long document,
// while the two side columns and the mode bar stay in view. Below 1280px the right column
// becomes a drawer, and below 900px one pane shows at a time, chosen by tabs. On the module
// page it is a card under Course materials & assessments, opened like a week.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DndContext, DragOverlay, useDroppable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
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
  type EssaySource,
} from "../lib/assessment";
import { shortDate } from "../lib/dates";
import { db } from "../lib/db";
import { countDocxWords, type DocxDocument, type DocxFootnote, type DocxBlock, type DocxRun } from "../lib/docx";
import { listCollision, swallowClickAfterDrag, useDragSensors } from "../lib/drag";
import {
  effectiveWordCount,
  findCitationContext,
  formatCustomBibliography,
  formatCustomFootnote,
  numberedFootnotes,
  safeExternalUrl,
  sourceLinkLocator,
  type SourceLink,
} from "../lib/essaySources";
import { countdown } from "../lib/sections";
import { api, commit, newId } from "../lib/sync";
import { resolveExistingFile } from "../lib/importing";
import { stripExtension } from "../lib/parse";
import { moduleReadings } from "../lib/library";
import { chicagoBibliography, fullTitle } from "../lib/titles";
import type { AttachmentRef, ItemRow, ModuleRow } from "../lib/types";
import { confirmAction, showToast, useTitle } from "../lib/ui";
import { mimeFor, queueUpload, sha256 } from "../lib/uploads";
import { DatePicker } from "./DatePicker";
import { NotesLoading } from "./ErrorBoundary";
import { clampEssayZoom, EssayPreviewCorner } from "./EssayPreviewCorner";
import { EssayPdfPages, useCtrlWheelZoom, useEssayFitScale } from "./EssayPreviewPages";
import { EssaySourcesPanel, type EssaySourceUpload } from "./EssaySourcesPanel";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import { PdfPages } from "./reader/PdfPages";
import { Sheet } from "./Sheet";
// The splitters borrow the session page's hairline, which turns to the accent when pointed at.
// Its sheet comes first, so that the essay's own rules can adjust it.
import "./SplitHandle.css";
import "./AssessmentPage.css";

const NoteEditor = lazy(() => import("./NoteEditor"));

const dayOf = (iso: string) => new Date(`${iso}T00:00:00`);

// A reference typed into saves once the typing has paused for this long, as well as on blur.
const REFERENCE_SAVE_DELAY = 600;
// How long a sentence or heading reached from the side columns stays highlighted.
const JUMP_HIGHLIGHT_MS = 3200;
// Admin documents and uploaded sources go up in one request, so they are held under the
// size that would need the upload to be sent in parts.
const ADMIN_DOCUMENT_LIMIT = 50 * 1024 * 1024;

// A stored Word file counts as present once it holds more than a bare header.
const hasDocxBytes = (assessment: object): boolean => {
  const stored = (assessment as { docx?: { byteLength: number } | null }).docx;
  return Boolean(stored && stored.byteLength > 4);
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Reads one field from a stored record whose shape varies by kind, such as the file key an
// uploaded source carries and a source added by hand lacks, without widening its type.
const storedField = (value: object, key: string): unknown => (value as { [name: string]: unknown })[key];

const textField = (value: object, key: string): string | undefined => {
  const field = storedField(value, key);
  return typeof field === "string" && field ? field : undefined;
};

// A PDF kept with the essay is read from its stored bytes, so that the preview can draw its
// true pages, and anything else leaves the preview showing the Word sheet instead.
const pdfBytesOf = (stored: unknown): Uint8Array | null => {
  if (stored instanceof Uint8Array) return stored.byteLength ? stored : null;
  if (stored instanceof ArrayBuffer) return stored.byteLength ? new Uint8Array(stored) : null;
  return null;
};

const safeFileName = (name: string): string => name.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Essay";

function downloadBytes(bytes: Uint8Array, name: string, type: string) {
  // The Blob is given a copy, so that the stored bytes are never detached or shared with it.
  const url = URL.createObjectURL(new Blob([bytes.slice()], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Prints the drawn pages from a hidden frame that holds only them and the app's styles, so
// that neither the zoom nor the workspace around the preview ever reaches the PDF.
function printEssayPages(pages: HTMLElement, title: string): boolean {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(frame);
  const view = frame.contentWindow;
  const sheet = frame.contentDocument;
  if (!view || !sheet) {
    frame.remove();
    return false;
  }
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"], style'))
    .map((node) => node.outerHTML)
    .join("");
  sheet.open();
  sheet.write(
    `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>${styles}` +
      `<style>@page { size: A4; margin: 0; }</style></head><body class="essay-print-body">${pages.outerHTML}</body></html>`,
  );
  sheet.close();
  let printed = false;
  const print = () => {
    if (printed) return;
    printed = true;
    view.addEventListener("afterprint", () => frame.remove(), { once: true });
    view.focus();
    view.print();
    // Safari returns from print() at once, so the frame is cleared away only well afterwards.
    window.setTimeout(() => frame.remove(), 60000);
  };
  view.addEventListener("load", print, { once: true });
  // A written frame may already have fired its load event, so a short wait covers that case.
  window.setTimeout(print, 1500);
  return true;
}

// A source opened inside the essay, together with the page a reference cites when it cites one.
interface ViewedDocument {
  title: string;
  url: string;
  mime?: string;
  name?: string;
  page?: number;
  locator?: string;
}

const isPdfDocument = (file: ViewedDocument): boolean =>
  file.mime === "application/pdf" || /\.pdf$/i.test(file.name ?? file.url);

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

// Puts an uploaded source into storage by the same route as a note's
// picture, and returns its key. Files are stored by their contents, so the same paper is
// only ever kept once however many essays use it.
async function uploadEssayFile(file: File, mime: string): Promise<string> {
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
            <p className="small muted">Use Edit in Word to start writing, or import a Word document.</p>
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
  onDelete,
}: {
  number: number;
  footnoteId: string;
  text: string;
  doc: DocxDocument;
  readingId?: string;
  onCommit: (footnoteId: string, text: string) => void;
  onJump: (target: { blockId: string; footnoteId: string; sentence: string }) => void;
  onDelete: (footnoteId: string) => void;
}) {
  const [value, setValue] = useState(text);
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

  // The right column's width follows the window, so the box is refitted whenever its own width
  // changes, which also covers a drawer or pane that has just been shown.
  useEffect(() => {
    const area = areaRef.current;
    if (!area || typeof ResizeObserver === "undefined") return undefined;
    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      if (Math.abs(entry.contentRect.width - width) < 0.5) return;
      width = entry.contentRect.width;
      area.style.height = "auto";
      if (area.scrollHeight) area.style.height = `${area.scrollHeight}px`;
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  // The menu shows where a reference is cited by bringing the preview to its sentence, which
  // keeps the row to its number and text alone instead of opening a panel beneath it.
  const showCitation = () => {
    const context = findCitationContext(doc, footnoteId);
    if (!context) {
      showToast("This reference is not cited in the essay yet, so there is no place in the draft to show.");
      return;
    }
    onJump({ blockId: context.blockId, footnoteId, sentence: context.sentence });
  };

  return (
    <li className="essay-ws-ref">
      <span className="essay-ref-badge" aria-hidden="true">{number}.</span>
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
      </div>
      {/* Every action of a reference lives in one quiet menu, which comes forward when the row
          is pointed at or holds focus, so that a long list of notes stays as calm as the
          sources beside it and never widens the column. */}
      <span className="essay-ws-ref-tools">
        <Menu
          label={`Actions for footnote ${number}`}
          items={[
            { label: "Show where it is cited", onSelect: showCitation },
            ...(readingId ? [{ label: "Open reading", onSelect: () => navigate({ view: "reader", id: readingId }) }] : []),
            { label: "Delete reference", danger: true, onSelect: () => onDelete(footnoteId) },
          ]}
        />
      </span>
    </li>
  );
}

// An uploaded source, opened inside the essay just as a reading opens in the reader, so that
// a cited page can be checked without leaving the draft.
function DocumentViewer({ file, onClose }: { file: ViewedDocument | null; onClose: () => void }) {
  return (
    <Sheet
      open={file !== null}
      onClose={onClose}
      title={file?.title ?? "Document"}
      subtitle={file?.locator ? `Cited at ${file.locator}` : "Opened from this essay"}
      className="essay-doc-viewer"
      footer={
        <div className="row" style={{ gap: "0.5rem", justifyContent: "flex-end" }}>
          {file && (
            <a className="button quiet" href={file.url} target="_blank" rel="noreferrer">
              Open in a new tab
            </a>
          )}
          <button type="button" className="button primary" onClick={onClose}>
            Done
          </button>
        </div>
      }
    >
      {file && <ViewerPages key={`${file.url}#${file.page ?? 0}`} file={file} />}
    </Sheet>
  );
}

function ViewerPages({ file }: { file: ViewedDocument }) {
  const pdf = isPdfDocument(file);

  return (
    <div className="essay-doc-viewer-body">
      {pdf ? (
        <PdfPages
          url={file.url}
          initialPage={file.page ? file.page - 1 : undefined}
          className="essay-doc-frame"
          fallback={<p className="small muted">Opening {file.title}, which may take a moment for a long file.</p>}
        />
      ) : (
        <p className="small muted">
          Only PDFs can be shown inside the essay, so use Open in a new tab to read it in the browser instead.
        </p>
      )}
    </div>
  );
}

// The widths of the two side columns in pixels, kept on this device so that they stay as set
// across reloads. A column that has never been dragged is null and keeps its automatic width.
const COLUMNS_KEY = "essay-columns";
const COLUMN_LIMITS = { rail: { min: 224, max: 520 }, aside: { min: 256, max: 640 } } as const;
// The essay between the columns never gets narrower than a page can sensibly be read.
const CENTRE_MIN_WIDTH = 360;
const COLUMN_STEP = 16;

type Column = keyof typeof COLUMN_LIMITS;
type ColumnWidths = Record<Column, number | null>;

const clampColumn = (column: Column, width: number): number =>
  Math.round(Math.min(COLUMN_LIMITS[column].max, Math.max(COLUMN_LIMITS[column].min, width)));

function readColumns(): ColumnWidths {
  try {
    const stored = JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "{}") as { rail?: unknown; aside?: unknown };
    const pick = (column: Column, value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? clampColumn(column, value) : null;
    return { rail: pick("rail", stored.rail), aside: pick("aside", stored.aside) };
  } catch {
    return { rail: null, aside: null };
  }
}

// The drag handle on the edge between a side column and the essay. It is moved with a pointer
// or with the left and right arrows, sent to either limit with Home and End, and put back to
// the automatic width with a double click.
function ColumnSplitter({
  column,
  label,
  controls,
  width,
  limits,
  fromPointer,
  onChange,
  onReset,
}: {
  column: Column;
  label: string;
  controls: string;
  width: number;
  limits: () => { min: number; max: number };
  fromPointer: (clientX: number) => number;
  onChange: (width: number) => void;
  onReset: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<number | null>(null);
  // The right column grows as its edge moves left, so its arrows are the other way about.
  const grow = column === "rail" ? 1 : -1;
  const { min, max } = limits();

  const release = (event: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    pointer.current = null;
    setDragging(false);
  };

  return (
    <div
      className={`split-handle essay-ws-splitter${dragging ? " dragging" : ""}`}
      data-column={column}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.min(max, Math.max(min, Math.round(width)))}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        // Stopping the default keeps the drag from selecting text as the pointer passes over it.
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        pointer.current = event.pointerId;
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (pointer.current === event.pointerId) onChange(fromPointer(event.clientX));
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={() => {
        pointer.current = null;
        setDragging(false);
      }}
      onKeyDown={(event) => {
        let next: number | null = null;
        if (event.key === "ArrowRight") next = width + COLUMN_STEP * grow;
        else if (event.key === "ArrowLeft") next = width - COLUMN_STEP * grow;
        else if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        if (next === null) return;
        event.preventDefault();
        onChange(next);
      }}
      onDoubleClick={onReset}
    />
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
  // null fits the page to the width of the column, which is how the preview opens.
  const [zoom, setZoom] = useState<number | null>(null);
  const cancelTarget = useRef(false);
  const [jump, setJump] = useState<JumpTarget | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewing, setViewing] = useState<ViewedDocument | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [previewEl, setPreviewEl] = useState<HTMLDivElement | null>(null);
  // The preview is mounted only while it is the chosen view, so the measuring hooks follow the
  // element itself rather than a ref that they could not see change.
  const attachPreview = useCallback((node: HTMLDivElement | null) => {
    previewRef.current = node;
    setPreviewEl(node);
  }, []);
  // The scale the pages are drawn at, which is also the percentage the corner reports.
  const scale = useEssayFitScale(previewEl, zoom);
  const sensors = useDragSensors();

  // The side columns' widths, with the workspace they divide and the widths they are drawn at,
  // which the handles report while a column is still at its automatic width.
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<ColumnWidths>(readColumns);
  const [drawn, setDrawn] = useState<ColumnWidths>({ rail: 0, aside: 0 });

  useEffect(() => {
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(columns));
    } catch {
      /* A full or blocked store only loses the widths. */
    }
  }, [columns]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return undefined;
    const measure = () => {
      const rail = workspace.querySelector<HTMLElement>(".essay-ws-rail")?.offsetWidth ?? 0;
      const aside = workspace.querySelector<HTMLElement>(".essay-ws-aside")?.offsetWidth ?? 0;
      setDrawn((now) => (now.rail === rail && now.aside === aside ? now : { rail, aside }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [columns]);

  // A column stops short of the point where the essay between the columns would be squeezed.
  // The right column only takes width from the essay where it is a column, from 1280px.
  const columnLimits = (column: Column) => {
    const total = workspaceRef.current?.getBoundingClientRect().width ?? 0;
    const asideShown = window.matchMedia?.("(min-width: 1280px)").matches ?? true;
    const other = (column === "rail" ? (asideShown ? columns.aside ?? drawn.aside : 0) : columns.rail ?? drawn.rail) ?? 0;
    const { min, max } = COLUMN_LIMITS[column];
    return { min, max: Math.max(min, Math.min(max, total - other - CENTRE_MIN_WIDTH)) };
  };

  const setColumn = (column: Column, width: number) => {
    const { min, max } = columnLimits(column);
    const next = Math.round(Math.min(max, Math.max(min, width)));
    setColumns((now) => (now[column] === next ? now : { ...now, [column]: next }));
  };

  const columnFromPointer = (column: Column) => (clientX: number) => {
    const box = workspaceRef.current?.getBoundingClientRect();
    if (!box) return columns[column] ?? drawn[column] ?? COLUMN_LIMITS[column].min;
    return column === "rail" ? clientX - box.left : box.right - clientX;
  };

  const columnStyle: CSSProperties = {
    ...(columns.rail !== null ? { "--essay-rail-w": `${columns.rail}px` } : {}),
    ...(columns.aside !== null ? { "--essay-aside-w": `${columns.aside}px` } : {}),
  } as CSSProperties;

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

  // Full screen is an overlay inside the window, never the browser's own full screen, which
  // in the desktop window covers the taskbar and runs off the screen. It closes with Escape.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen]);

  // The overlay also closes on its own when the preview gives way to the plan.
  useEffect(() => {
    if (centreView !== "preview") setFullscreen(false);
  }, [centreView]);

  const [editingTarget, setEditingTarget] = useState(false);

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
  // Read by reference, so that the preview parses the PDF again only when the stored bytes change.
  const pdfField = storedField(assessment, "pdf");
  const storedPdf = useMemo(() => pdfBytesOf(pdfField), [pdfField]);

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

  // Every zoom from the corner bar or a Ctrl and wheel gesture passes through the essay's range.
  const changeZoom = (next: number | null) => setZoom(next === null ? null : clampEssayZoom(next));

  useCtrlWheelZoom(previewEl, scale, changeZoom);

  const toggleFullscreen = () => setFullscreen((on) => !on);

  const exportDocx = () => {
    downloadDocxFile(assessment.draft, assessment.title);
    showToast("Word document downloaded.");
  };

  // A stored PDF downloads as it is, and otherwise the drawn pages go to the print window,
  // whose Save as PDF option gives the same pages that the preview shows.
  const exportPdf = () => {
    const name = safeFileName(assessment.title || `${module.code} essay`);
    if (storedPdf) {
      downloadBytes(storedPdf, `${name}.pdf`, "application/pdf");
      showToast("PDF downloaded.");
      return;
    }
    const sheet = previewRef.current?.querySelector<HTMLElement>(".essay-sheet-container");
    if (sheet && printEssayPages(sheet, name)) showToast("Choose Save as PDF in the print window to keep a copy.");
    else showToast("The pages could not be prepared for a PDF, so try again once the preview has drawn.");
  };

  // A confirmation cannot show over the full screen overlay, so the preview leaves it first.
  const replaceDocument = async () => {
    setFullscreen(false);
    await handleImportClick();
  };

  // Module readings
  const refIds = assessment.referenceItemIds.join(",");
  const readings = useLiveQuery(
    () => moduleReadings(module.id, assessment.referenceItemIds),
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

  const handleSaveFootnote = (fnId: string, newText: string) => {
    void save((prev) => ({
      ...prev,
      draft: {
        ...prev.draft,
        footnotes: prev.draft.footnotes.map((f) => (f.id === fnId ? { ...f, text: newText } : f)),
      },
    }));
  };

  // Deleting a reference removes its footnote and every marker that points at it, so that the
  // draft never keeps a number in the text with nothing below it.
  const handleDeleteFootnote = async (fnId: string) => {
    const ok = await confirmAction({
      title: "Delete this reference?",
      body: "The footnote is removed from the draft together with its marker in the text. Save a snapshot first if you may want it back.",
      confirm: "Delete reference",
      danger: true,
    });
    if (!ok) return;
    await save((prev) => ({
      ...prev,
      draft: {
        ...prev.draft,
        blocks: prev.draft.blocks.map((block) =>
          block.runs.some((run) => run.type === "footnote_ref" && run.footnoteId === fnId)
            ? { ...block, runs: block.runs.filter((run) => !(run.type === "footnote_ref" && run.footnoteId === fnId)) }
            : block,
        ),
        footnotes: prev.draft.footnotes.filter((f) => f.id !== fnId),
      },
    }));
    showToast("Reference deleted.");
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

  // An admin document is stored as a reading of its own, kept apart from the week boards, so
  // that the normal readings viewer opens it by the same id the essay lists it under.
  const addAdminDocuments = async (files: File[]) => {
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
      const sha = await sha256(file);
      const existing = await resolveExistingFile(sha);
      const fileId = existing?.fileId ?? newId();
      await commit([
        {
          table: "items",
          row: {
            id: ref.id,
            kind: "secondary" as const,
            author: null,
            title: stripExtension(file.name),
            source: null,
            pages: null,
            year: null,
            doc_date: null,
            file_id: existing?.fileId ?? null,
            original_file_id: existing?.originalFileId ?? null,
            tray_module_id: null,
            zotero_key: null,
            last_page: null,
            read_status: "unread" as const,
          },
        },
      ]);
      if (!existing) {
        await queueUpload({ file_id: fileId, item_id: ref.id, name: file.name, mime: ref.mime, sha256: sha, bytes: file.size, blob: file });
      }
      await save((prev) => ({ ...prev, adminDocuments: [...(prev.adminDocuments ?? []), ref] }));
    }
  };

  // Every admin document opens in the normal reader. One uploaded before admin documents had
  // readings of their own is only a stored key on the essay, so the first time it is opened it
  // is given the file row and the hidden reading that a new upload gets, under ids made from
  // its own, so that opening it on two devices makes the same rows rather than two copies.
  const openAdminDocument = async (doc: AttachmentRef) => {
    if (doc.r2Key && !(await db.items.get(doc.id))) {
      const fileId = `${doc.id}:file`;
      await commit([
        {
          table: "files",
          row: {
            id: fileId,
            sha256: /[0-9a-f]{64}/i.exec(doc.r2Key)?.[0].toLowerCase() ?? `legacy:${doc.id}`,
            r2_key: doc.r2Key,
            mime: doc.mime,
            bytes: doc.size,
            original_name: doc.name,
            page_count: null,
            text_status: "pending" as const,
          },
        },
        {
          table: "items",
          row: {
            id: doc.id,
            kind: "secondary" as const,
            author: null,
            title: stripExtension(doc.name),
            source: null,
            pages: null,
            year: null,
            doc_date: null,
            file_id: fileId,
            original_file_id: null,
            tray_module_id: null,
            zotero_key: null,
            last_page: null,
            read_status: "unread" as const,
          },
        },
      ]);
    }
    navigate({ view: "reader", id: doc.id });
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

  // Sources uploaded in the Sources card go up by the same route as admin documents, and the
  // card keeps the returned key on the paper, so that its references can open the file later.
  const uploadSourceFile = async (file: File): Promise<EssaySourceUpload> => {
    if (!navigator.onLine) throw new Error("Connect to the internet to upload a source.");
    if (file.size > ADMIN_DOCUMENT_LIMIT) throw new Error(`${file.name} is over 50 MB, so it cannot be uploaded in one go.`);
    const r2Key = await uploadEssayFile(file, mimeFor(file) ?? (file.type || "application/octet-stream"));
    return { r2Key };
  };

  // A reference opens its source at the page it cites: a stored file opens in the document
  // viewer, and a source added by hand with a link opens that link in a new tab.
  const openPassage = (link: SourceLink, source: EssaySource) => {
    const locator = link.wholeDocument ? undefined : sourceLinkLocator(link) ?? undefined;
    const r2Key = textField(source, "r2Key");
    if (r2Key) {
      const page = link.wholeDocument ? Number.NaN : Number.parseInt(String(link.page ?? ""), 10);
      setViewing({
        title: source.title,
        url: `/api/objects/${r2Key}`,
        mime: textField(source, "mime"),
        name: textField(source, "name"),
        page: Number.isFinite(page) ? page : undefined,
        locator,
      });
      return;
    }
    const url = safeExternalUrl(textField(source, "url"));
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    showToast(
      locator
        ? `This source has no file or link to open, so check ${locator} in your own copy.`
        : "This source has no file or link to open, so check it in your own copy.",
    );
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

  const sheet = (
    // The zoom sits on a wrapper outside the sheet, so that printing the sheet for Export as
    // PDF never carries the preview's zoom with it.
    <div className="essay-sheet-zoom" style={{ zoom: scale }}>
      <EssayDocumentSheet doc={assessment.draft} jump={jump} />
    </div>
  );

  // The preview's controls sit in the mode bar beside Preview and Plan, so that the page has
  // one sticky bar at its top. Full screen covers the mode bar, so there they move into the
  // overlay itself.
  const previewCorner = (
    <EssayPreviewCorner
      zoom={zoom}
      scale={scale}
      onZoomChange={changeZoom}
      fullscreen={fullscreen}
      onToggleFullscreen={toggleFullscreen}
      onExportDocx={exportDocx}
      onExportPdf={exportPdf}
      onReplace={() => void replaceDocument()}
      disabled={!hasContent && !storedPdf}
    />
  );

  return (
    <div className="page wide essay-page essay-ws-page">
      <div className="section-head essay-head essay-ws-head">
        <input
          className="title-input essay-title-input"
          type="text"
          value={question}
          title={question || undefined}
          placeholder="Essay title or question as set"
          aria-label="Essay question"
          onChange={(e) => setQuestion(e.target.value)}
          onBlur={(e) => void save({ title: e.target.value.trim() })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        {/* The breadcrumb row is gone, so the way back to the module lives in this menu beside the title. */}
        <span className="essay-ws-head-menu">
          <Menu
            label="Essay actions"
            items={[
              { label: `Back to ${module.code || "the module"}`, onSelect: () => navigate({ view: "module", id: module.id }) },
              { label: "Edit in Word", onSelect: () => navigate(wordProcessorRoute) },
              { label: "Delete essay", danger: true, onSelect: () => void handleDeleteAssessment() },
            ]}
          />
        </span>
        <span className="spacer" />
        <span className="save-status" data-status={saveStatus} role="status" aria-live="polite">
          <span className="save-status-dot" aria-hidden="true" />
          {saveLabel}
        </span>
        {/* The References toggle shows only between 900px and 1280px, where the right column is a drawer. */}
        <button
          type="button"
          className="button small essay-ws-drawer-toggle"
          aria-expanded={pane === "aside"}
          aria-controls="essay-pane-aside"
          onClick={() => setPane((current) => (current === "aside" ? "centre" : "aside"))}
        >
          References{orderedFootnotes.length ? ` (${orderedFootnotes.length})` : ""}
        </button>
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
        <div className="essay-ws" data-pane={pane} ref={workspaceRef} style={columnStyle}>
          {/* Left rail: the brief, the essay's own papers and its sources */}
          <DropZone list="sources" id="essay-pane-rail" className="essay-ws-rail">
            <section className="essay-ws-card" aria-labelledby="essay-brief-head">
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

              {/* Admin documents belong to the brief, so they are folded into its card. */}
              <div className="essay-ws-brief-docs">
                <div className="essay-ws-card-head">
                  <h3 id="essay-admin-head" className="essay-ws-brief-subhead">Admin documents</h3>
                  <button type="button" className="button quiet small" onClick={() => adminInput.current?.click()}>
                    Add
                  </button>
                </div>
                {adminDocuments.length === 0 ? (
                  <p className="small muted">Add the brief, the marking criteria or any other papers for this essay.</p>
                ) : (
                  <ul className="essay-ws-docs" aria-labelledby="essay-admin-head">
                    {adminDocuments.map((doc) => (
                      <li key={doc.id}>
                        <button
                          type="button"
                          className="essay-ws-doc-name"
                          title={`Open ${doc.name}`}
                          onClick={() => void openAdminDocument(doc)}
                        >
                          {doc.name}
                        </button>
                        <span className="essay-ws-doc-menu" style={{ gridArea: "remove" }}>
                          <Menu
                            label={`Actions for ${doc.name}`}
                            items={[
                              { label: "Open", onSelect: () => void openAdminDocument(doc) },
                              { label: "Remove", danger: true, onSelect: () => void removeAdminDocument(doc) },
                            ]}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            {/* The Sources card is the single place to add, cite and check anything the essay can
                cite, since its own Add control already offers an upload, the course reading
                picker and a source typed by hand, and its rows still drag into References. */}
            <EssaySourcesPanel
              moduleId={module.id}
              moduleCode={module.code}
              essayId={essayId}
              readings={readings}
              uploadFile={uploadSourceFile}
              onOpenPassage={openPassage}
            />
          </DropZone>

          <ColumnSplitter
            column="rail"
            label="Resize the brief and sources column"
            controls="essay-pane-rail"
            width={columns.rail ?? drawn.rail ?? COLUMN_LIMITS.rail.min}
            limits={() => columnLimits("rail")}
            fromPointer={columnFromPointer("rail")}
            onChange={(width) => setColumn("rail", width)}
            onReset={() => setColumns((now) => ({ ...now, rail: null }))}
          />

          {/* Centre: the essay itself */}
          <DropZone list="draft" id="essay-pane-centre" className="essay-ws-centre">
            <div className="essay-ws-toolbar">
              {/* Preview and Plan are one segmented control, and Edit in Word is the page's one
                  filled button beside it, so that the way into Word is the first thing seen. */}
              <div className="essay-ws-modes">
                <SegmentedTabs
                  label="Essay view"
                  value={centreView}
                  onChange={setCentreView}
                  options={[
                    { value: "preview", label: "Preview", id: "essay-view-preview", controls: "essay-centre-preview" },
                    { value: "plan", label: "Plan", id: "essay-view-plan", controls: "essay-centre-plan" },
                  ]}
                />
                {centreView === "preview" && !fullscreen && previewCorner}
                <Link
                  to={wordProcessorRoute}
                  className="button primary essay-open-button"
                  title="Open the draft in the word processor"
                >
                  <Icon name="highlight" size={16} />
                  Edit in Word
                </Link>
              </div>
            </div>

            {centreView === "preview" ? (
              <div
                id="essay-centre-preview"
                role="tabpanel"
                aria-labelledby="essay-view-preview"
                className={`essay-ws-preview${fullscreen ? " is-fullscreen" : ""}`}
                ref={attachPreview}
              >
                {fullscreen && previewCorner}
                {/* The pages sit in the page's own flow, so the window scrolls through them while
                    the side columns stay put, and a zoom past the column's width scrolls sideways
                    here alone. */}
                <div className="essay-preview-frame essay-preview-flow" role="region" aria-label="Pages">
                  {storedPdf ? <EssayPdfPages bytes={storedPdf} scale={scale} fallback={sheet} /> : sheet}
                </div>
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

          <ColumnSplitter
            column="aside"
            label="Resize the references column"
            controls="essay-pane-aside"
            width={columns.aside ?? drawn.aside ?? COLUMN_LIMITS.aside.min}
            limits={() => columnLimits("aside")}
            fromPointer={columnFromPointer("aside")}
            onChange={(width) => setColumn("aside", width)}
            onReset={() => setColumns((now) => ({ ...now, aside: null }))}
          />

          {/* Right column: references, a drawer below 1280px */}
          <aside id="essay-pane-aside" className="essay-ws-aside" aria-label="References">
            <DropZone list="references" className="essay-ws-card essay-ws-refs">
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
                        onDelete={(fnId) => void handleDeleteFootnote(fnId)}
                      />
                    );
                  })}
                </ol>
              )}
            </DropZone>
          </aside>
        </div>

        <DragOverlay dropAnimation={null}>
          {draggedItem ? <div className="essay-ws-drag-chip">{draggedItem.title}</div> : null}
        </DragOverlay>
      </DndContext>

      {/* Uploaded sources, opened inside the essay */}
      <DocumentViewer file={viewing} onClose={() => setViewing(null)} />

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
