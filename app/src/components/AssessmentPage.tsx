// Assessment & essay: a module's essay studio, laid out for an LSE history student.
// The essay sheet preview sits front and centre in authentic page form with the title
// editable in place at the top. Segmented controls give instant access to the plan and
// argument, sources and citations, and snapshot history. On the module page it is a card
// under Course materials & assessments, opened like a week.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
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
import {
  effectiveWordCount,
  formatCustomBibliography,
  formatCustomFootnote,
  numberedFootnotes,
  safeExternalUrl,
} from "../lib/essaySources";
import { countdown } from "../lib/sections";
import { newId } from "../lib/sync";
import { chicagoBibliography, fullTitle, shortTitle } from "../lib/titles";
import { clampZoom, stepZoom, ZOOM_STEPS } from "../lib/zoom";
import type { ItemRow, ModuleRow } from "../lib/types";
import { confirmAction, showToast, useTitle } from "../lib/ui";
import { DatePicker } from "./DatePicker";
import { NotesLoading } from "./ErrorBoundary";
import { Icon, IconButton } from "./icons";
import { Menu } from "./Menu";
import { Sheet } from "./Sheet";

const NoteEditor = lazy(() => import("./NoteEditor"));

const dayOf = (iso: string) => new Date(`${iso}T00:00:00`);

// The preview sheet is laid out at A4 width (210 mm at 96 dpi) and scaled from there.
const PREVIEW_PAGE_WIDTH = 794;
// The essay preview zooms through the same steps as the reader, up to twice its size.
const PREVIEW_MAX_ZOOM = 2;
const MIN_FIT_SCALE = 0.3;
const MAX_FIT_SCALE = 2;

const clampScale = (value: number) => Math.min(MAX_FIT_SCALE, Math.max(MIN_FIT_SCALE, value));

// A stored Word file counts as present once it holds more than a bare header.
const hasDocxBytes = (assessment: object): boolean => {
  const stored = (assessment as { docx?: { byteLength: number } | null }).docx;
  return Boolean(stored && stored.byteLength > 4);
};

type SaveState = "saved" | "saving" | "error";

type EssayTab = "draft" | "plan" | "sources" | "snapshots";

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
          {assessment.dueDate && <span className="week-card-dates">Due {shortDate(dayOf(assessment.dueDate))}</span>}
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
        {due && (
          <div className="week-card-footer">
            <span className="count">Due {due.words}</span>
          </div>
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

// Scales the page stack with a transform, which animates smoothly, and sizes a stage to the
// scaled result because a transform does not change layout size. The measured width of the
// viewport also gives the scale that makes a page fit it exactly.
function PreviewZoomStage({
  scale,
  onFitScale,
  children,
}: {
  scale: number;
  onFitScale: (fitScale: number) => void;
  children: React.ReactNode;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [sheetHeight, setSheetHeight] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    const sheet = sheetRef.current;
    if (!viewport || !sheet) return;
    const measure = () => {
      const styles = window.getComputedStyle(viewport);
      const gutter = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0);
      const available = viewport.clientWidth - gutter;
      if (available > 0) onFitScale(Math.round(clampScale(available / PREVIEW_PAGE_WIDTH) * 1000) / 1000);
      setSheetHeight(sheet.offsetHeight);
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [onFitScale]);

  return (
    <div className="essay-zoom-viewport" ref={viewportRef}>
      <div
        className="essay-zoom-stage"
        style={{ width: PREVIEW_PAGE_WIDTH * scale, height: sheetHeight ? sheetHeight * scale : undefined }}
      >
        <div className="essay-zoom-sheet" ref={sheetRef} style={{ transform: `scale(${scale})` }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// Authentic paper sheet rendering the essay page by page in Times New Roman with genuine margins.
function EssayDocumentSheet({
  doc,
}: {
  doc: DocxDocument;
}) {
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

    const runs = block.runs.map((run: DocxRun, i: number) => {
      if (run.type === "footnote_ref" && run.footnoteId) {
        const fn = fnMap.get(run.footnoteId);
        return (
          <sup key={i} className="essay-sheet-fn-ref" title={fn?.text || "Footnote"}>
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

      return (
        <span key={i} className={cls || undefined}>
          {run.text ?? ""}
        </span>
      );
    });

    if (block.type === "heading1") return <h2 key={block.id} className="essay-sheet-h1">{runs}</h2>;
    if (block.type === "heading2") return <h3 key={block.id} className="essay-sheet-h2">{runs}</h3>;
    if (block.type === "heading3") return <h4 key={block.id} className="essay-sheet-h3">{runs}</h4>;
    if (block.type === "blockquote") return <blockquote key={block.id} className="essay-sheet-quote">{runs}</blockquote>;
    if (block.type === "bullet") return <ul key={block.id} className="essay-sheet-list"><li className="essay-sheet-bullet">{runs}</li></ul>;
    if (block.type === "ordered") return <ol key={block.id} className="essay-sheet-list"><li className="essay-sheet-ordered">{runs}</li></ol>;
    return (
      <p
        key={block.id}
        className="essay-sheet-p"
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

export function AssessmentPage({ id, essayId }: { id: string; essayId?: string }) {
  const module = useLiveQuery(async () => {
    const found = await db.modules.get(id);
    return found && !found.deleted ? found : null;
  }, [id]);
  useTitle(module ? `${module.code} essay` : undefined);
  if (module === undefined) return null;
  if (module === null) return <div className="page"><p className="muted">This module no longer exists.</p></div>;
  return <AssessmentBody module={module} essayId={essayId} />;
}

function AssessmentBody({ module, essayId }: { module: ModuleRow; essayId?: string }) {
  const assessment = useModuleAssessment(module.id, module.code, essayId);
  // Every field save goes through here so the status beside the title stays truthful, with a
  // counter so that overlapping saves cannot report "Saved" while another is still running.
  const save = async (patch: Parameters<typeof saveModuleAssessment>[1]) => {
    inflightSaves.current += 1;
    setSaveState("saving");
    try {
      await saveModuleAssessment(module.id, patch, { moduleCode: module.code, essayId });
      if (inflightSaves.current === 1) setSaveState("saved");
    } catch (err) {
      console.error("Saving the essay failed", err);
      setSaveState("error");
    } finally {
      inflightSaves.current -= 1;
    }
  };

  const [activeTab, setActiveTab] = useState<EssayTab>("draft");
  const [question, setQuestion] = useState(assessment.title);
  const [target, setTarget] = useState(assessment.wordTarget ? String(assessment.wordTarget) : "");
  const typingQuestion = useRef(false);
  const typingTarget = useRef(false);
  const tabListRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [fitScale, setFitScale] = useState(1);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const inflightSaves = useRef(0);
  const cancelTarget = useRef(false);
  const [editingFnId, setEditingFnId] = useState<string | null>(null);
  const [editingFnText, setEditingFnText] = useState("");

  useEffect(() => {
    const updateIndicator = () => {
      if (!tabListRef.current) return;
      const activeBtn = tabListRef.current.querySelector<HTMLButtonElement>(`[role="tab"][aria-selected="true"]`);
      if (activeBtn) {
        setIndicatorStyle({
          left: activeBtn.offsetLeft,
          width: activeBtn.offsetWidth,
        });
      }
    };
    updateIndicator();
    window.addEventListener("resize", updateIndicator);
    return () => window.removeEventListener("resize", updateIndicator);
  }, [activeTab]);

  useEffect(() => {
    if (!typingQuestion.current) setQuestion(assessment.title);
  }, [assessment.title]);

  useEffect(() => {
    if (!typingTarget.current) setTarget(assessment.wordTarget ? String(assessment.wordTarget) : "");
  }, [assessment.wordTarget]);

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

  const [snapshotName, setSnapshotName] = useState("");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const importer = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => countDocxWords(assessment.draft), [assessment.draft]);
  const includeFootnotes = assessment.includeFootnotes !== false;
  const effectiveWords = effectiveWordCount(counts, assessment.draft, includeFootnotes);
  const due = assessment.dueDate ? countdown(assessment.dueDate) : null;
  const hasContent = hasDocxBytes(assessment) || counts.body + counts.quotes + counts.footnotes > 0;
  const scale = fitWidth ? fitScale : zoom;
  const unsavedTitle = question.trim() !== (assessment.title ?? "").trim();
  const saveLabel = unsavedTitle
    ? "Unsaved"
    : saveState === "saving"
      ? "Saving…"
      : saveState === "error"
        ? "Not saved"
        : "Saved";
  const saveStatus = unsavedTitle ? "unsaved" : saveState;

  const zoomBy = (direction: 1 | -1) => {
    const next = Math.min(PREVIEW_MAX_ZOOM, clampZoom(stepZoom(scale, direction)));
    // At either end there is no further step, so nothing changes.
    if (direction > 0 ? next <= scale + 0.001 : next >= scale - 0.001) return;
    setZoom(next);
    setFitWidth(false);
  };

  const resetZoom = () => {
    setZoom(1);
    setFitWidth(false);
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
    const list: Array<{
      id: string;
      title: string;
      isModule: boolean;
      moduleItem?: ItemRow;
      customSource?: CustomSource;
    }> = [];
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

  const fromResearchNotCited = useMemo(() => {
    return allResearchItems.filter((ri) => !citedIds.has(ri.id));
  }, [allResearchItems, citedIds]);

  const handleSaveFootnote = (fnId: string, newText: string) => {
    const trimmed = newText.trim();
    if (!trimmed) {
      setEditingFnId(null);
      return;
    }
    void save((prev) => ({
      ...prev,
      draft: {
        ...prev.draft,
        footnotes: prev.draft.footnotes.map((f) =>
          f.id === fnId ? { ...f, text: trimmed } : f
        ),
      },
    }));
    setEditingFnId(null);
    showToast("Citation updated.");
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

  const addModuleFootnote = async (item: ItemRow) => {
    const footnoteId = `fn-${newId()}`;
    await save((prev) => {
      const blocks = [...prev.draft.blocks];
      const last = blocks.length - 1;
      if (last >= 0) {
        blocks[last] = {
          ...blocks[last],
          runs: [...blocks[last].runs, { type: "footnote_ref", footnoteId }],
        };
      }
      const note: DocxFootnote = {
        id: footnoteId,
        text: formatChicagoFootnote(item),
        citationItemId: item.id,
      };
      return {
        ...prev,
        draft: { ...prev.draft, blocks, footnotes: [...prev.draft.footnotes, note] },
      };
    });
    showToast("Footnote added at the end of the draft.");
  };

  const addCustomFootnote = async (source: CustomSource) => {
    const footnoteId = `fn-${newId()}`;
    await save((prev) => {
      const blocks = [...prev.draft.blocks];
      const last = blocks.length - 1;
      if (last >= 0) {
        blocks[last] = {
          ...blocks[last],
          runs: [...blocks[last].runs, { type: "footnote_ref", footnoteId }],
        };
      }
      const note: DocxFootnote = {
        id: footnoteId,
        text: formatCustomFootnote(source),
        citationItemId: source.id,
      };
      return {
        ...prev,
        draft: { ...prev.draft, blocks, footnotes: [...prev.draft.footnotes, note] },
      };
    });
    showToast("Footnote added at the end of the draft.");
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

  const wordProcessorRoute = {
    view: "essay" as const,
    id: module.id,
    ...(essayId && essayId !== "default" ? { essay: essayId } : {}),
  };

  return (
    <div className="page wide essay-page">
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

      <div className="section-head essay-head" style={{ marginBottom: "0.5rem" }}>
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
      </div>

      {/* Stats bar */}
      <div className="essay-stats-bar">
        <div className="row" style={{ gap: "1.25rem", alignItems: "center", flexWrap: "wrap" }}>
          <div>
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
          <label className="essay-footnote-toggle">
            <input
              type="checkbox"
              checked={includeFootnotes}
              onChange={(e) => void save({ includeFootnotes: e.target.checked })}
            />
            <span>Include footnotes in word count</span>
          </label>
        </div>
        <div className="row" style={{ gap: "1rem", alignItems: "center" }}>
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
      </div>

      {/* Sliding segmented control tabs */}
      <div className="essay-tabs-track" ref={tabListRef} role="tablist" aria-label="Essay sections">
        <div
          className="essay-tab-indicator"
          style={{
            transform: `translateX(${indicatorStyle.left}px)`,
            width: `${indicatorStyle.width}px`,
          }}
          aria-hidden="true"
        />
        <button
          type="button"
          role="tab"
          id="tab-draft"
          aria-selected={activeTab === "draft"}
          aria-controls="panel-draft"
          className="essay-tab-btn"
          onClick={() => setActiveTab("draft")}
        >
          Draft & preview
        </button>
        <button
          type="button"
          role="tab"
          id="tab-plan"
          aria-selected={activeTab === "plan"}
          aria-controls="panel-plan"
          className="essay-tab-btn"
          onClick={() => setActiveTab("plan")}
        >
          Plan & argument
        </button>
        <button
          type="button"
          role="tab"
          id="tab-sources"
          aria-selected={activeTab === "sources"}
          aria-controls="panel-sources"
          className="essay-tab-btn"
          onClick={() => setActiveTab("sources")}
        >
          References {orderedFootnotes.length + fromResearchNotCited.length > 0 ? `(${orderedFootnotes.length + fromResearchNotCited.length})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-snapshots"
          aria-selected={activeTab === "snapshots"}
          aria-controls="panel-snapshots"
          className="essay-tab-btn"
          onClick={() => setActiveTab("snapshots")}
        >
          Snapshots {assessment.previousDrafts.length > 0 ? `(${assessment.previousDrafts.length})` : ""}
        </button>
      </div>

      {/* TAB 1: Draft & Page-Form Preview */}
      {activeTab === "draft" && (
        <div id="panel-draft" role="tabpanel" aria-labelledby="tab-draft">
          <div className="essay-preview-toolbar">
            <Link to={wordProcessorRoute} className="button primary essay-open-button">
              <Icon name="notes" size={16} />
              <span>Open in word processor</span>
            </Link>
            <span className="small muted essay-preview-breakdown">
              Body {counts.body.toLocaleString("en-GB")}, block quotations {counts.quotes.toLocaleString("en-GB")}, footnotes {counts.footnotes.toLocaleString("en-GB")}.
            </span>
            <div className="essay-zoom-controls" role="group" aria-label="Zoom">
              <IconButton icon="zoomOut" label="Zoom out" disabled={scale <= ZOOM_STEPS[0] + 0.001} onClick={() => zoomBy(-1)} />
              <button
                type="button"
                className="essay-zoom-percent"
                title="Reset zoom to 100%"
                aria-label={`Zoom ${Math.round(scale * 100)} per cent. Reset to 100 per cent`}
                onClick={resetZoom}
              >
                {Math.round(scale * 100)}%
              </button>
              <IconButton
                icon="zoomIn"
                label="Zoom in"
                disabled={scale >= PREVIEW_MAX_ZOOM - 0.001}
                onClick={() => zoomBy(1)}
              />
              <IconButton
                icon="fitWidth"
                label="Fit to width"
                pressed={fitWidth}
                className="essay-zoom-fit"
                onClick={() => setFitWidth((current) => !current)}
              />
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

          <PreviewZoomStage scale={scale} onFitScale={setFitScale}>
            <EssayDocumentSheet doc={assessment.draft} />
          </PreviewZoomStage>
        </div>
      )}

      {/* TAB 2: Plan & Argument */}
      {activeTab === "plan" && (
        <div id="panel-plan" role="tabpanel" aria-labelledby="tab-plan" className="essay-plan">
          <div className="section-head" style={{ marginBottom: "0.5rem" }}>
            <h2 style={{ margin: 0 }}>Plan & argument</h2>
            <span className="spacer" />
          </div>
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

      {/* TAB 3: References */}
      {activeTab === "sources" && (
        <div id="panel-sources" role="tabpanel" aria-labelledby="tab-sources">
          <div className="section-head" style={{ marginBottom: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
            <div>
              <h2 style={{ margin: 0 }}>References</h2>
              <p className="small muted" style={{ margin: "0.25rem 0 0" }}>
                Sources currently cited in the document and discovered materials from research.
              </p>
            </div>
            <span className="spacer" />
            <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap" }}>
              <button type="button" className="button small" onClick={() => setChoosing(true)}>
                Choose module readings
              </button>
              <button type="button" className="button small" onClick={() => setAddingCustom(true)}>
                Add external source
              </button>
              {(orderedFootnotes.length > 0 || hasSources) && (
                <button type="button" className="button primary small" onClick={() => void copyBibliography()}>
                  Copy Chicago bibliography
                </button>
              )}
            </div>
          </div>

          <div className="essay-sources-grid" style={{ display: "grid", gap: "1.5rem", marginTop: "1.25rem" }}>
            {/* Section 1: Currently in document */}
            <section className="essay-panel">
              <div className="essay-panel-head">
                <h3 style={{ margin: 0, fontSize: "var(--fs-md)", fontFamily: "var(--sans)" }}>
                  Currently in the document ({orderedFootnotes.length})
                </h3>
              </div>
              {orderedFootnotes.length === 0 ? (
                <p className="small muted">No citations or footnotes in the draft yet.</p>
              ) : (
                <div className="essay-in-doc-citations">
                  {orderedFootnotes.map((fn) => {
                    const isEditing = editingFnId === fn.id;
                    const rawFn = assessment.draft.footnotes.find((f) => f.id === fn.id);
                    const linkedItem = rawFn?.citationItemId
                      ? allResearchItems.find((r) => r.id === rawFn.citationItemId)
                      : null;

                    return (
                      <div key={fn.id} className="essay-ref-item">
                        <span className="essay-ref-badge">[{fn.number}]</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {isEditing ? (
                            <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
                              <input
                                className="essay-ref-edit-input"
                                type="text"
                                value={editingFnText}
                                autoFocus
                                onChange={(e) => setEditingFnText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") handleSaveFootnote(fn.id, editingFnText);
                                  if (e.key === "Escape") setEditingFnId(null);
                                }}
                              />
                              <button
                                type="button"
                                className="button small primary"
                                onClick={() => handleSaveFootnote(fn.id, editingFnText)}
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                className="button small quiet"
                                onClick={() => setEditingFnId(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="essay-ref-text">
                              <span>{fn.text}</span>
                              {linkedItem?.moduleItem && (
                                <span style={{ display: "inline-block", marginLeft: "0.5rem" }}>
                                  <Link
                                    to={{ view: "reader", id: linkedItem.id }}
                                    className="small muted"
                                  >
                                    Open reading &rarr;
                                  </Link>
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        {!isEditing && (
                          <button
                            type="button"
                            className="button quiet small"
                            onClick={() => {
                              setEditingFnId(fn.id);
                              setEditingFnText(fn.text);
                            }}
                          >
                            Edit
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* Section 2: From research (not in document) */}
            <section className="essay-panel">
              <div className="essay-panel-head">
                <h3 style={{ margin: 0, fontSize: "var(--fs-md)", fontFamily: "var(--sans)" }}>
                  From research (not in document) ({fromResearchNotCited.length})
                </h3>
              </div>
              {fromResearchNotCited.length === 0 ? (
                <p className="small muted">
                  {allResearchItems.length === 0
                    ? "No research materials added yet. Choose readings from this module or add external sources."
                    : "All research materials are currently cited in your document."}
                </p>
              ) : (
                <ul className="essay-source-list">
                  {fromResearchNotCited.map((item) => (
                    <li key={item.id}>
                      {item.isModule && item.moduleItem ? (
                        <>
                          <Link to={{ view: "reader", id: item.id }} title={item.title}>
                            {item.title}
                          </Link>
                          <span className="badge small" style={{ marginLeft: "0.5rem" }}>Module</span>
                          <button
                            type="button"
                            className="button quiet small"
                            onClick={() => void addModuleFootnote(item.moduleItem!)}
                          >
                            + Cite in draft
                          </button>
                          <Menu
                            label={`Actions for ${shortTitle(item.moduleItem)}`}
                            items={[
                              { label: "Add footnote citing it", onSelect: () => void addModuleFootnote(item.moduleItem!) },
                              { label: "Remove from essay", onSelect: () => void toggleModuleSource(item.id) },
                            ]}
                          />
                        </>
                      ) : (
                        <>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <span style={{ fontFamily: "var(--serif)" }}>{formatCustomBibliography(item.customSource!)}</span>
                            {safeExternalUrl(item.customSource?.url) && (
                              <a
                                href={safeExternalUrl(item.customSource?.url)!}
                                target="_blank"
                                rel="noreferrer"
                                className="small muted"
                                style={{ display: "inline-block", marginLeft: "0.5rem" }}
                              >
                                Link &rarr;
                              </a>
                            )}
                          </div>
                          <span className="badge small" style={{ marginLeft: "0.5rem" }}>External</span>
                          <button
                            type="button"
                            className="button quiet small"
                            onClick={() => void addCustomFootnote(item.customSource!)}
                          >
                            + Cite in draft
                          </button>
                          <Menu
                            label={`Actions for ${item.customSource?.title}`}
                            items={[
                              { label: "Add footnote citing it", onSelect: () => void addCustomFootnote(item.customSource!) },
                              { label: "Remove source", danger: true, onSelect: () => void handleDeleteCustomSource(item.id) },
                            ]}
                          />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}

      {/* TAB 4: Snapshots */}
      {activeTab === "snapshots" && (
        <div id="panel-snapshots" role="tabpanel" aria-labelledby="tab-snapshots">
          <section className="essay-panel">
            <h2 style={{ fontSize: "var(--fs-lg)", margin: "0 0 0.5rem" }}>Revision snapshots</h2>
            <p className="small muted essay-hint">
              Save named snapshots before major revisions to preserve your work and compare changes.
            </p>
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
          </section>
        </div>
      )}

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
    </div>
  );
}