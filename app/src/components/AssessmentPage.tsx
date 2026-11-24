// Assessment & essay: a module's essay studio, laid out for an LSE history student.
// The workspace has three flush columns so that the writing stays front and centre: the brief
// with its admin documents, the module readings and the essay's sources on the left, the
// essay itself in the centre (the page preview or the plan), and its references on the
// right. Files dropped on any part of the page, or chosen with Add, are checked on the
// source card before they are kept, and a reading, a source or the word processor opened
// from the page comes up in a new tab. The essay's pages scroll with the window, as one long document,
// while the two side columns and the mode bar stay in view. Below 1280px the right column
// becomes a drawer, and below 900px one pane shows at a time, chosen by tabs. On the module
// page it is a card under Course materials & assessments, opened like a week.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { DndContext, DragOverlay, useDroppable, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { useLiveQuery, useSuspendingLiveQuery } from "dexie-react-hooks";
import { Link, openInTab } from "../App";
import { navigate, type Route } from "../lib/router";
import {
  assessmentNotesKey,
  deleteModuleEssay,
  downloadDocxFile,
  ensureSourceReading,
  formatChicagoFootnote,
  importAssessmentDocxFile,
  moveSourceTo,
  readingCategoryOf,
  renameModuleEssay,
  saveModuleAssessment,
  useModuleAssessment,
  type CustomSource,
  type EssaySource,
  type SourceRef,
} from "../lib/assessment";
import { shortDate } from "../lib/dates";
import { db } from "../lib/db";
import { countDocxWords, type DocxDocument, type DocxFootnote, type DocxBlock, type DocxRun } from "../lib/docx";
import { listCollision, swallowClickAfterDrag, useDragSensors } from "../lib/drag";
import {
  ESSAY_SOURCE_CATEGORIES,
  ESSAY_SOURCE_CATEGORY_LABEL,
  compareSourceTitles,
  effectiveWordCount,
  findCitationContext,
  formatCustomBibliography,
  formatCustomFootnote,
  numberedFootnotes,
  removeLinksForFootnote,
  safeExternalUrl,
  sourceLinkLocator,
  type EssaySourceCategory,
  type SourceLink,
} from "../lib/essaySources";
import { countdown } from "../lib/sections";
import { newId } from "../lib/sync";
import { moduleReadings } from "../lib/library";
import { draftFromFile, draftFromItem, draftFromSource, type SourceDraft, type SourceRole } from "../lib/sourceIntake";
import { chicagoBibliography, fullTitle } from "../lib/titles";
import type { AttachmentRef, ItemRow, ModuleRow } from "../lib/types";
import { confirmAction, showToast, useTitle } from "../lib/ui";
import { DatePicker } from "./DatePicker";
import { NotesLoading } from "./ErrorBoundary";
import { clampEssayZoom, EssayPreviewCorner } from "./EssayPreviewCorner";
import { EssayPdfPages, useCtrlWheelZoom, useEssayFitScale } from "./EssayPreviewPages";
import { EssaySourcesPanel } from "./EssaySourcesPanel";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import { SourceCard, useEssayFileDrop } from "./SourceCard";
import { SourcePicker, type SourceChoice } from "./SourcePicker";
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

// A reading opened from the essay comes up in a new tab, in front in the desktop window and
// in the browser alike, so that the draft stays open behind it.
const openReading = (to: Route): void => {
  openInTab(to);
};

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

// The source a reference cites, as its row names it: the source's id, its title, or null
// when the source has gone, the passage it is linked to when there is one, and whether
// there is anything that Go to could open.
interface ReferenceBinding {
  sourceId: string;
  title: string | null;
  locator: string | null;
  link: SourceLink | null;
  canGoTo: boolean;
}

// A module reading chosen for the essay or a source added by hand, as the rail lists them.
interface ResearchItem {
  id: string;
  title: string;
  isModule: boolean;
  moduleItem?: ItemRow;
  customSource?: CustomSource;
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
// A reference linked to a source names it beneath its text, with Go to beside it, which opens
// the source at the passage it cites, so that checking a quotation takes one tap.
function ReferenceRow({
  number,
  footnoteId,
  text,
  doc,
  binding,
  onCommit,
  onJump,
  onLink,
  onGoTo,
  onUnlink,
  onDelete,
}: {
  number: number;
  footnoteId: string;
  text: string;
  doc: DocxDocument;
  binding?: ReferenceBinding;
  onCommit: (footnoteId: string, text: string) => void;
  onJump: (target: { blockId: string; footnoteId: string; sentence: string }) => void;
  // Opens the source picker beside the reference, to link it to a source or change its link.
  onLink: (footnoteId: string, anchor: HTMLElement | null) => void;
  onGoTo: (binding: ReferenceBinding) => void;
  onUnlink: (footnoteId: string) => void;
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
        {binding && (
          <div className="essay-ws-ref-link">
            <span className="essay-ws-ref-link-title">
              {binding.title
                ? `Linked to \u201c${binding.title}\u201d${binding.locator ? `, ${binding.locator}` : ""}`
                : "Linked to a source that is no longer in this essay"}
            </span>
            {binding.canGoTo && (
              <button
                type="button"
                className="essay-ws-ref-goto"
                aria-label={binding.title ? `Go to \u201c${binding.title}\u201d${binding.locator ? `, ${binding.locator}` : ""}` : "Go to the source"}
                onClick={() => onGoTo(binding)}
              >
                Go to
              </button>
            )}
          </div>
        )}
      </div>
      {/* Every action of a reference lives in one quiet menu, which comes forward when the row
          is pointed at or holds focus, so that a long list of notes stays as calm as the
          sources beside it and never widens the column. */}
      <span className="essay-ws-ref-tools">
        <Menu
          label={`Actions for footnote ${number}`}
          items={[
            { label: "Show where it is cited", onSelect: showCitation },
            { label: binding ? "Change link" : "Link to a source", onSelect: () => onLink(footnoteId, areaRef.current) },
            ...(binding ? [{ label: "Unlink", onSelect: () => onUnlink(footnoteId) }] : []),
            { label: "Delete reference", danger: true, onSelect: () => onDelete(footnoteId) },
          ]}
        />
      </span>
    </li>
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
  // Every field save goes through here, and a failure is reported in a toast, because the Saved
  // indicator that once showed it is gone. Whether it worked is returned, so that a caller
  // says what changed only when it did.
  const save = async (patch: Parameters<typeof saveModuleAssessment>[1]): Promise<boolean> => {
    try {
      await saveModuleAssessment(module.id, patch, { moduleCode: module.code, essayId });
      return true;
    } catch (err) {
      console.error("Saving the essay failed", err);
      showToast("The essay could not be saved. Your latest change may be lost.");
      return false;
    }
  };

  const [pane, setPane] = useState<Pane>("centre");
  const [centreView, setCentreView] = useState<CentreView>("preview");
  const [question, setQuestion] = useState(assessment.title);
  const [target, setTarget] = useState(assessment.wordTarget ? String(assessment.wordTarget) : "");
  const typingQuestion = useRef(false);
  const typingTarget = useRef(false);
  // The preview opens at 130%, which reads comfortably beside the side columns, and null, which
  // Fit chooses, fits the page to the width of the column.
  const [zoom, setZoom] = useState<number | null>(1.3);
  const cancelTarget = useRef(false);
  const [jump, setJump] = useState<JumpTarget | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // The source card, with the files or the source being checked. A drop while it is open adds
  // the new files to it, so that one card takes everything brought in at once.
  const [intake, setIntake] = useState<{ mode: "add" | "edit"; drafts: SourceDraft[] } | null>(null);
  const openIntake = (files: File[], role: SourceRole) => {
    const drafts = files.map((file) => draftFromFile(file, role));
    setIntake((current) => ({ mode: "add", drafts: [...(current?.drafts ?? []), ...drafts] }));
  };
  const drop = useEssayFileDrop(openIntake);
  // The reference whose link is being chosen, and the field the picker sits beside.
  const [linking, setLinking] = useState<string | null>(null);
  const linkAnchor = useRef<HTMLElement | null>(null);
  const [citing, setCiting] = useState(false);
  const citeAnchor = useRef<HTMLButtonElement | null>(null);
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
      const block = previewRef.current?.querySelector(`[data-block-id="${CSS.escape(jump.blockId)}"]`);
      // A PDF kept with the essay is drawn in place of the Word sheet, so it has no blocks to find.
      if (!block) {
        showToast(
          storedField(assessment, "pdf")
            ? "The preview is showing the PDF kept with this essay, so it cannot point to the sentence."
            : "This reference is not cited in the essay text yet, so there is no place in the draft to show.",
        );
        return;
      }
      block.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    const clear = window.setTimeout(() => setJump(null), JUMP_HIGHLIGHT_MS);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [jump, assessment]);

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

  const importer = useRef<HTMLInputElement>(null);
  const adminInput = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => countDocxWords(assessment.draft), [assessment.draft]);
  const includeFootnotes = assessment.includeFootnotes !== false;
  const effectiveWords = effectiveWordCount(counts, assessment.draft, includeFootnotes);
  const due = assessment.dueDate ? countdown(assessment.dueDate) : null;
  const hasContent = hasDocxBytes(assessment) || counts.body + counts.quotes + counts.footnotes > 0;
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
        body: "The current draft will be replaced by the file you choose.",
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
      body: "The footnote is removed from the draft together with its marker in the text.",
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
      ...(prev.sourceLinks ? { sourceLinks: removeLinksForFootnote(prev.sourceLinks, fnId) } : {}),
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

  // Cites a source with a footnote at the end of the draft, for a drop on the references
  // or when citing a whole source.
  const citeInDraft = async (item: ResearchItem) => {
    const text = item.moduleItem
      ? formatChicagoFootnote(item.moduleItem)
      : item.customSource
        ? formatCustomFootnote(item.customSource)
        : null;
    if (!text) return;
    const footnoteId = `fn-${newId()}`;
    const saved = await save((prev) => {
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
    if (saved) showToast("Footnote added at the end of the draft.");
  };

  // An admin document uploaded before admin documents had readings of their own is only a
  // stored key on the essay, so it is given the file row and the hidden reading a new upload
  // gets as soon as the essay opens, under ids made from its own, so that its name is an
  // ordinary link to the reader and doing this on two devices makes the same rows.
  const legacyAdminKey = adminDocuments.filter((doc) => doc.r2Key).map((doc) => doc.id).join(",");
  useEffect(() => {
    for (const doc of adminDocuments) {
      if (doc.r2Key) void ensureSourceReading(doc).catch(() => undefined);
    }
    // The documents are read again only when one with a stored key is added or removed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legacyAdminKey]);

  const sortedAdminDocuments = useMemo(
    () => [...adminDocuments].sort((a, b) => compareSourceTitles(a.name, b.name) || a.id.localeCompare(b.id)),
    [adminDocuments],
  );

  // An admin document moved into a group becomes one of the essay's readings under its own
  // id, so a legacy one is given its reading first.
  const moveAdminDocument = async (doc: AttachmentRef, to: EssaySourceCategory) => {
    if (!(await ensureSourceReading(doc))) {
      showToast("That document has no stored file, so it cannot become a reading.");
      return;
    }
    if (await save((prev) => moveSourceTo(prev, { type: "admin", id: doc.id }, to))) {
      showToast(`Moved to ${ESSAY_SOURCE_CATEGORY_LABEL[to]}.`);
    }
  };

  // The source card opens again on a source already on the essay, with its details as stored.
  const editSource = async (ref: SourceRef) => {
    const meta = assessment.sourceMeta?.[ref.id];
    let draft: SourceDraft | null = null;
    if (ref.type === "reading" || ref.type === "admin") {
      const doc = ref.type === "admin" ? adminDocuments.find((d) => d.id === ref.id) : undefined;
      if (doc) await ensureSourceReading(doc);
      const item = await db.items.get(ref.id);
      if (item && !item.deleted) {
        const role: SourceRole = doc ? "admin" : readingCategoryOf(assessment, item) === "primary" ? "primary" : "secondary";
        draft = { ...draftFromItem(item, role, meta), ...(doc ? { name: doc.name } : {}) };
      }
    } else {
      const source = ref.type === "custom"
        ? customSources.find((c) => c.id === ref.id)
        : (assessment.attachedPapers ?? []).find((paper) => paper.id === ref.id);
      if (source) draft = draftFromSource(source, ref.type, meta);
    }
    if (!draft) {
      showToast("That source is no longer on this essay, so its details cannot be edited.");
      return;
    }
    setIntake({ mode: "edit", drafts: [draft] });
  };

  const intakeDone = ({ added, updated }: { added: number; updated: number }) => {
    setIntake(null);
    if (!added) {
      showToast("Details saved.");
      return;
    }
    const what = added === 1 ? "One source was" : `${added} sources were`;
    showToast(`${what} added to the essay${updated ? ", and the other details were saved" : ""}.`);
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

  // A page reference opens its source at the page it cites: an uploaded paper in the reader,
  // in a new tab, through the reading it is given, and a source added by hand at its link.
  const openPassage = (link: SourceLink, source: EssaySource) => {
    const locator = link.wholeDocument ? undefined : sourceLinkLocator(link) ?? undefined;
    if (textField(source, "r2Key")) {
      const page = link.wholeDocument ? Number.NaN : Number.parseInt(String(link.page ?? ""), 10);
      openReading({ view: "reader", id: source.id, ...(Number.isFinite(page) && page > 0 ? { page: page - 1 } : {}) });
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

  // What each reference cites, from its passage link when it has one and otherwise from the
  // source its footnote names, with the title to show and whether Go to has anything to open.
  const bindings = useMemo(() => {
    const map = new Map<string, ReferenceBinding>();
    const links = assessment.sourceLinks ?? [];
    const papers = assessment.attachedPapers ?? [];
    for (const note of assessment.draft.footnotes) {
      const link = links.find((l) => l.footnoteId === note.id) ?? null;
      const sourceId = link?.sourceId ?? note.citationItemId ?? null;
      if (!sourceId) continue;
      const reading = readings.find((r) => r.id === sourceId);
      const custom = customSources.find((c) => c.id === sourceId);
      const paper = papers.find((p) => p.id === sourceId);
      map.set(note.id, {
        sourceId,
        title: reading?.title ?? custom?.title ?? paper?.title ?? null,
        locator: link ? sourceLinkLocator(link) : null,
        link,
        canGoTo: Boolean(reading || paper?.r2Key || safeExternalUrl(custom?.url)),
      });
    }
    return map;
  }, [assessment.draft.footnotes, assessment.sourceLinks, assessment.attachedPapers, readings, customSources]);

  // Go to opens what a reference cites: a reading or an uploaded paper in the reader, in a new
  // tab, at the highlighted passage or the page when the link has one, and a source added by
  // hand at its own link.
  const goToReference = (binding: ReferenceBinding) => {
    const custom = customSources.find((c) => c.id === binding.sourceId);
    if (custom) {
      const url = safeExternalUrl(custom.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const page = Number.parseInt(binding.link?.page ?? "", 10);
    openReading({
      view: "reader",
      id: binding.sourceId,
      ...(Number.isFinite(page) && page > 0 ? { page: page - 1 } : {}),
      ...(binding.link?.highlightId ? { hl: binding.link.highlightId } : {}),
    });
  };

  const linkReference = (footnoteId: string, anchor: HTMLElement | null) => {
    linkAnchor.current = anchor;
    setLinking(footnoteId);
  };

  // A choice links the reference at once, so that it names its source straight away. Choosing
  // a passage also opens the reading in a new tab, straight from the tap so that the browser
  // allows it, to select the words it cites, and the passage is linked from there.
  const pickLinkSource = (choice: SourceChoice) => {
    const footnoteId = linking;
    if (!footnoteId) return;
    const number = orderedFootnotes.find((fn) => fn.id === footnoteId)?.number;
    const name = number ? `Footnote ${number}` : "The footnote";
    if (choice.kind === "passage") {
      openReading({ view: "reader", id: choice.sourceId, cite: { module: module.id, ...(essayId ? { essay: essayId } : {}), footnote: footnoteId } });
    }
    void save((prev) => ({
      ...prev,
      draft: {
        ...prev.draft,
        footnotes: prev.draft.footnotes.map((f) => (f.id === footnoteId ? { ...f, citationItemId: choice.sourceId } : f)),
      },
      ...(prev.sourceLinks ? { sourceLinks: removeLinksForFootnote(prev.sourceLinks, footnoteId) } : {}),
    })).then((saved) => {
      if (!saved) return;
      showToast(
        choice.kind === "passage"
          ? `${name} is linked to its source. Select the passage in the reading, then choose Link passage.`
          : `${name} is linked to the whole source.`,
      );
    });
  };

  // Cites a source from the References Cite button, matching the word processor's picker:
  // a whole source adds a footnote at the end of the draft, and a passage also opens the
  // reading in a new tab so the passage can be linked straight onto that footnote.
  const pickCitation = (choice: SourceChoice) => {
    const footnoteId = `fn-${newId()}`;
    if (choice.kind === "passage") {
      openReading({ view: "reader", id: choice.sourceId, cite: { module: module.id, ...(essayId ? { essay: essayId } : {}), footnote: footnoteId } });
    }
    void save((prev) => {
      const blocks = [...prev.draft.blocks];
      const last = blocks.length - 1;
      if (last >= 0) {
        blocks[last] = {
          ...blocks[last],
          runs: [...blocks[last].runs, { type: "footnote_ref", footnoteId }],
        };
      }
      const note: DocxFootnote = { id: footnoteId, text: choice.footnoteText, citationItemId: choice.sourceId };
      return {
        ...prev,
        draft: { ...prev.draft, blocks, footnotes: [...prev.draft.footnotes, note] },
      };
    }).then((saved) => {
      if (!saved) return;
      showToast(
        choice.kind === "passage"
          ? "Footnote added at the end of the draft. Select the passage in the reading, then choose Link passage."
          : "Footnote added at the end of the draft.",
      );
    });
  };

  // Unlinking keeps the footnote's own text and offers Undo, which puts the source and any
  // passage link back.
  const unlinkReference = async (footnoteId: string) => {
    let before: { citationItemId: string | null; links: SourceLink[] } = { citationItemId: null, links: [] };
    const saved = await save((prev) => {
      before = {
        citationItemId: prev.draft.footnotes.find((f) => f.id === footnoteId)?.citationItemId ?? null,
        links: (prev.sourceLinks ?? []).filter((l) => l.footnoteId === footnoteId),
      };
      return {
        ...prev,
        draft: {
          ...prev.draft,
          footnotes: prev.draft.footnotes.map((f) => (f.id === footnoteId ? { ...f, citationItemId: null } : f)),
        },
        ...(prev.sourceLinks ? { sourceLinks: removeLinksForFootnote(prev.sourceLinks, footnoteId) } : {}),
      };
    });
    if (!saved) return;
    showToast("Link removed, and the footnote keeps its text.", {
      label: "Undo",
      run: () =>
        void save((prev) => {
          const kept = prev.sourceLinks ?? [];
          return {
            ...prev,
            draft: {
              ...prev.draft,
              footnotes: prev.draft.footnotes.map((f) => (f.id === footnoteId ? { ...f, citationItemId: before.citationItemId } : f)),
            },
            sourceLinks: [...kept, ...before.links.filter((l) => !kept.some((k) => k.id === l.id))],
          };
        }),
    });
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
    <div className="page wide essay-page essay-ws-page" lang="en-GB" {...drop.handlers}>
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
            <div className="essay-ws-rail-head">
              <div className="essay-ws-rail-title">
                <textarea
                  className="title-input essay-title-input"
                  rows={1}
                  value={question}
                  title={question || undefined}
                  placeholder="Essay title or question as set"
                  aria-label="Essay question"
                  onChange={(e) => setQuestion(e.target.value.replace(/\s*\n+\s*/g, " "))}
                  onBlur={(e) => void save({ title: e.target.value.trim() })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  }}
                />
                {/* The breadcrumb row is gone, so the way back to the module lives in this menu beside the title. */}
                <span className="essay-ws-head-menu">
                  <Menu
                    label="Essay actions"
                    items={[
                      { label: `Back to ${module.code || "the module"}`, onSelect: () => navigate({ view: "module", id: module.id }) },
                      { label: "Edit in Word", onSelect: () => openInTab(wordProcessorRoute) },
                      { label: "Delete essay", danger: true, onSelect: () => void handleDeleteAssessment() },
                    ]}
                  />
                </span>
              </div>
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
            </div>
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

              {/* Admin documents belong to the brief, so they are folded into its card, and files
                  dropped on them become admin documents. Each row is drawn as a source row is. */}
              <div
                className={`essay-ws-brief-docs${drop.overRole === "admin" ? " is-drop-target" : ""}`}
                data-drop-role="admin"
              >
                <div className="essay-ws-card-head">
                  <h3 id="essay-admin-head" className="essay-ws-brief-subhead">Admin documents</h3>
                  <button type="button" className="button quiet small" onClick={() => adminInput.current?.click()}>
                    Add
                  </button>
                </div>
                {sortedAdminDocuments.length === 0 ? (
                  <p className="small muted">Drop the brief, the marking criteria or any other papers for this essay here, or use Add.</p>
                ) : (
                  <ul className="essay-ws-docs" aria-labelledby="essay-admin-head">
                    {sortedAdminDocuments.map((doc) => (
                      <li key={doc.id}>
                        <Link to={{ view: "reader", id: doc.id }} className="essay-ws-doc-name" title={doc.name} newTab="always">
                          {doc.name}
                        </Link>
                        <span className="essay-ws-doc-menu">
                          <Menu
                            label={`Actions for ${doc.name}`}
                            items={[
                              { label: "Edit details", onSelect: () => void editSource({ type: "admin", id: doc.id }) },
                              {
                                label: "Move to",
                                items: ESSAY_SOURCE_CATEGORIES.map((category) => ({
                                  label: ESSAY_SOURCE_CATEGORY_LABEL[category],
                                  onSelect: () => void moveAdminDocument(doc, category),
                                })),
                              },
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
              onFiles={openIntake}
              onEdit={(ref) => void editSource(ref)}
              onOpenPassage={openPassage}
              dragging={drop.dragging}
              overRole={drop.overRole}
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
                  title="Open the draft in the word processor, in a new tab"
                  newTab="always"
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
                <Suspense fallback={<NotesLoading />}>
                  <NoteEditor
                    target={{ week_id: assessmentNotesKey(module.id, essayId) }}
                    label="Plan and argument"
                    placeholder="Write your plan here: your thesis in a sentence, then headings for sections, lists for evidence and @ to cite a reading."
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
                {hasSources && (
                  <button
                    ref={citeAnchor}
                    type="button"
                    className="button quiet small essay-ws-refs-cite"
                    title="Cite a source"
                    aria-label="Cite a source"
                    aria-haspopup="dialog"
                    aria-expanded={citing}
                    onClick={() => setCiting(true)}
                  >
                    <Icon name="cite" size={14} />
                    Cite
                  </button>
                )}
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
                <p className="small muted essay-ws-refs-empty">
                  No references yet, so use Cite above or beside a source, or add a footnote when you edit in Word.
                </p>
              ) : (
                <ol className="essay-ws-ref-list">
                  {orderedFootnotes.map((fn) => (
                    <ReferenceRow
                      key={fn.id}
                      number={fn.number}
                      footnoteId={fn.id}
                      text={fn.text}
                      doc={assessment.draft}
                      binding={bindings.get(fn.id)}
                      onCommit={handleSaveFootnote}
                      onJump={jumpTo}
                      onLink={linkReference}
                      onGoTo={goToReference}
                      onUnlink={(fnId) => void unlinkReference(fnId)}
                      onDelete={(fnId) => void handleDeleteFootnote(fnId)}
                    />
                  ))}
                </ol>
              )}
            </DropZone>
          </aside>
        </div>

        <DragOverlay dropAnimation={null}>
          {draggedItem ? <div className="essay-ws-drag-chip">{draggedItem.title}</div> : null}
        </DragOverlay>
      </DndContext>

      {intake && (
        <SourceCard
          drafts={intake.drafts}
          mode={intake.mode}
          essay={{ moduleId: module.id, moduleCode: module.code, essayId }}
          onClose={() => setIntake(null)}
          onDone={intakeDone}
        />
      )}

      <SourcePicker
        open={linking !== null}
        onClose={() => setLinking(null)}
        anchor={linkAnchor}
        moduleId={module.id}
        moduleCode={module.code}
        essayId={essayId}
        title="Link to a source"
        onPick={pickLinkSource}
      />

      <SourcePicker
        open={citing}
        onClose={() => setCiting(false)}
        anchor={citeAnchor}
        moduleId={module.id}
        moduleCode={module.code}
        essayId={essayId}
        title="Cite a source"
        onPick={pickCitation}
      />

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
          if (files.length) openIntake(files, "admin");
        }}
      />
    </div>
  );
}
