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
  wordProgress,
  type CustomSource,
} from "../lib/assessment";
import { shortDate } from "../lib/dates";
import { db } from "../lib/db";
import { countDocxWords, type DocxDocument, type DocxFootnote } from "../lib/docx";
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
import type { ItemRow, ModuleRow } from "../lib/types";
import { confirmAction, showToast, useTitle } from "../lib/ui";
import { DatePicker } from "./DatePicker";
import { NotesLoading } from "./ErrorBoundary";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import { Sheet } from "./Sheet";

const NoteEditor = lazy(() => import("./NoteEditor"));

const dayOf = (iso: string) => new Date(`${iso}T00:00:00`);

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
  const counts = countDocxWords(assessment.draft);
  const effectiveWords = effectiveWordCount(counts, assessment.draft, assessment.includeFootnotes !== false);
  const progress = wordProgress(effectiveWords, assessment.wordTarget);
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
        {assessment.wordTarget ? (
          <span className="essay-bar essay-card-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(progress.share * 100)}%` }} />
          </span>
        ) : null}
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
        <div className="week-card-footer">
          <span className="count">{progress.words}{due ? `, due ${due.words}` : ""}</span>
        </div>
      </div>
    </article>
  );
}

// Authentic paper sheet rendering the essay in page form with editable title and footnotes.
function EssayDocumentSheet({
  doc,
  title,
  onTitleChange,
  onFocus,
  onBlur,
}: {
  doc: DocxDocument;
  title: string;
  onTitleChange: (newTitle: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
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

  return (
    <div className="essay-sheet-container">
      <article className="essay-sheet-preview">
        <header className="essay-sheet-header">
          <textarea
            className="essay-sheet-title-input"
            value={title}
            placeholder="Essay title or question as set"
            rows={1}
            aria-label="Essay question"
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => onTitleChange(e.target.value)}
          />
          <div className="essay-sheet-meta">
            <span>Candidate essay draft</span>
          </div>
        </header>

        {!hasAnyText ? (
          <div className="essay-sheet-empty">
            <p><strong>Nothing written yet.</strong></p>
            <p className="small muted">Open the word processor above to start writing, or import a Word document.</p>
          </div>
        ) : (
          <div className="essay-sheet-body">
            {doc.blocks.map((block) => {
              if (block.type === "page_break") {
                return <hr key={block.id} className="essay-sheet-pagebreak" />;
              }
              const runs = block.runs.map((run, i) => {
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
            })}
          </div>
        )}

        {orderedFootnotes.length > 0 && (
          <footer className="essay-sheet-footnotes">
            <hr className="essay-sheet-fn-rule" />
            <ol className="essay-sheet-fn-list">
              {orderedFootnotes.map((fn) => (
                <li key={fn.id} value={fn.number}>
                  {fn.text}
                </li>
              ))}
            </ol>
          </footer>
        )}
      </article>
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
  const save = (patch: Parameters<typeof saveModuleAssessment>[1]) =>
    saveModuleAssessment(module.id, patch, { moduleCode: module.code, essayId });

  const [activeTab, setActiveTab] = useState<EssayTab>("draft");
  const [question, setQuestion] = useState(assessment.title);
  const [target, setTarget] = useState(assessment.wordTarget ? String(assessment.wordTarget) : "");
  const typingQuestion = useRef(false);
  const typingTarget = useRef(false);

  useEffect(() => {
    if (!typingQuestion.current) setQuestion(assessment.title);
  }, [assessment.title]);

  useEffect(() => {
    if (!typingTarget.current) setTarget(assessment.wordTarget ? String(assessment.wordTarget) : "");
  }, [assessment.wordTarget]);

  const [choosing, setChoosing] = useState(false);
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
  const progress = wordProgress(effectiveWords, assessment.wordTarget);
  const due = assessment.dueDate ? countdown(assessment.dueDate) : null;

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
    await saveModuleAssessment(
      module.id,
      (prev) => {
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
      },
      { moduleCode: module.code, essayId },
    );
    showToast("Footnote added at the end of the draft.");
  };

  const addCustomFootnote = async (source: CustomSource) => {
    const footnoteId = `fn-${newId()}`;
    await saveModuleAssessment(
      module.id,
      (prev) => {
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
      },
      { moduleCode: module.code, essayId },
    );
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
          <Link to={{ view: "module", id: module.id }}>{module.code}</Link> <span aria-hidden="true">/</span> {assessment.title || "Essay"}
        </div>
        <Menu
          label="Essay actions"
          items={[
            {
              label: "Export .docx",
              onSelect: () => {
                downloadDocxFile(assessment.draft, assessment.title);
                showToast("Word document downloaded.");
              },
            },
            {
              label: "Import .docx",
              onSelect: () => importer.current?.click(),
            },
            {
              label: "Delete essay",
              danger: true,
              onSelect: () => void handleDeleteAssessment(),
            },
          ]}
        />
      </div>

      <div className="section-head essay-head" style={{ marginBottom: "0.5rem" }}>
        <h1 style={{ fontFamily: "var(--serif)", fontSize: "var(--fs-2xl)" }}>{assessment.title || "Essay Studio"}</h1>
        <span className="spacer" />
        <Link to={wordProcessorRoute} className="button primary">
          <Icon name="notes" size={16} />
          <span>Open in word processor</span>
        </Link>
      </div>

      {module.title && <p className="lede" style={{ marginBottom: "1rem" }}>{module.title}</p>}

      {/* Stats bar */}
      <div className="essay-stats-bar">
        <div className="row" style={{ gap: "1.25rem", alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <strong>{effectiveWords.toLocaleString("en-GB")}</strong>{" "}
            <span className="muted">{effectiveWords === 1 ? "word" : "words"}</span>
            {assessment.wordTarget ? (
              <span className="muted"> of {assessment.wordTarget.toLocaleString("en-GB")} target</span>
            ) : null}
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
          {due && assessment.dueDate ? (
            <span className={`badge ${due.state === "soon" || due.state === "today" ? "badge-accent" : ""}`}>
              Due {shortDate(dayOf(assessment.dueDate))}, {due.words}
            </span>
          ) : (
            <span className="muted small">No deadline set</span>
          )}
        </div>
      </div>

      {/* Segmented control tabs */}
      <div className="essay-tabs" role="tablist" aria-label="Essay sections">
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
          Sources & citations {hasSources ? `(${chosenModuleItems.length + customSources.length})` : ""}
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
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
            <span className="small muted">
              Body {counts.body.toLocaleString("en-GB")}, block quotations {counts.quotes.toLocaleString("en-GB")}, footnotes {counts.footnotes.toLocaleString("en-GB")}.
            </span>
            <div className="row" style={{ gap: "0.5rem" }}>
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
              <button type="button" className="button quiet small" onClick={() => importer.current?.click()}>
                Import .docx
              </button>
            </div>
          </div>

          <EssayDocumentSheet
            doc={assessment.draft}
            title={question}
            onFocus={() => {
              typingQuestion.current = true;
            }}
            onBlur={() => {
              typingQuestion.current = false;
            }}
            onTitleChange={(nextTitle) => {
              setQuestion(nextTitle);
              void save({ title: nextTitle });
            }}
          />
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

      {/* TAB 3: Sources & Citations */}
      {activeTab === "sources" && (
        <div id="panel-sources" role="tabpanel" aria-labelledby="tab-sources">
          <div className="section-head" style={{ marginBottom: "0.75rem", flexWrap: "wrap", gap: "0.5rem" }}>
            <div>
              <h2 style={{ margin: 0 }}>Sources & citations</h2>
              <p className="small muted" style={{ margin: "0.25rem 0 0" }}>
                Primary sources and secondary reading for this essay, formatted in Chicago 18th edition.
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
              {hasSources && (
                <button type="button" className="button primary small" onClick={() => void copyBibliography()}>
                  Copy Chicago bibliography
                </button>
              )}
            </div>
          </div>

          {!hasSources ? (
            <div className="first-steps" style={{ marginTop: "1rem" }}>
              <p><strong>No sources chosen yet.</strong></p>
              <p className="small muted">
                Add readings from this module or add external archives, books, and articles discovered in your research.
              </p>
            </div>
          ) : (
            <div className="essay-sources-grid" style={{ display: "grid", gap: "1.5rem", marginTop: "1.25rem" }}>
              {/* Primary sources */}
              <section className="essay-panel">
                <div className="essay-panel-head">
                  <h3 style={{ margin: 0, fontSize: "var(--fs-md)", fontFamily: "var(--sans)" }}>
                    Primary sources ({primaryModuleItems.length + primaryCustomSources.length})
                  </h3>
                </div>
                {primaryModuleItems.length === 0 && primaryCustomSources.length === 0 ? (
                  <p className="small muted">No primary sources added yet.</p>
                ) : (
                  <ul className="essay-source-list">
                    {primaryModuleItems.map((item) => (
                      <li key={item.id}>
                        <Link to={{ view: "reader", id: item.id }} title={fullTitle(item)}>
                          {fullTitle(item)}
                        </Link>
                        <span className="badge small" style={{ marginLeft: "0.5rem" }}>Module</span>
                        <Menu
                          label={`Actions for ${shortTitle(item)}`}
                          items={[
                            { label: "Add footnote citing it", onSelect: () => void addModuleFootnote(item) },
                            { label: "Remove from essay", onSelect: () => void toggleModuleSource(item.id) },
                          ]}
                        />
                      </li>
                    ))}
                    {primaryCustomSources.map((source) => (
                      <li key={source.id}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontFamily: "var(--serif)" }}>{formatCustomBibliography(source)}</span>
                          {safeExternalUrl(source.url) && (
                            <a
                              href={safeExternalUrl(source.url)!}
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
                        <Menu
                          label={`Actions for ${source.title}`}
                          items={[
                            { label: "Add footnote citing it", onSelect: () => void addCustomFootnote(source) },
                            { label: "Remove source", danger: true, onSelect: () => void handleDeleteCustomSource(source.id) },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Secondary reading */}
              <section className="essay-panel">
                <div className="essay-panel-head">
                  <h3 style={{ margin: 0, fontSize: "var(--fs-md)", fontFamily: "var(--sans)" }}>
                    Secondary reading ({secondaryModuleItems.length + secondaryCustomSources.length})
                  </h3>
                </div>
                {secondaryModuleItems.length === 0 && secondaryCustomSources.length === 0 ? (
                  <p className="small muted">No secondary reading added yet.</p>
                ) : (
                  <ul className="essay-source-list">
                    {secondaryModuleItems.map((item) => (
                      <li key={item.id}>
                        <Link to={{ view: "reader", id: item.id }} title={fullTitle(item)}>
                          {fullTitle(item)}
                        </Link>
                        <span className="badge small" style={{ marginLeft: "0.5rem" }}>Module</span>
                        <Menu
                          label={`Actions for ${shortTitle(item)}`}
                          items={[
                            { label: "Add footnote citing it", onSelect: () => void addModuleFootnote(item) },
                            { label: "Remove from essay", onSelect: () => void toggleModuleSource(item.id) },
                          ]}
                        />
                      </li>
                    ))}
                    {secondaryCustomSources.map((source) => (
                      <li key={source.id}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontFamily: "var(--serif)" }}>{formatCustomBibliography(source)}</span>
                          {safeExternalUrl(source.url) && (
                            <a
                              href={safeExternalUrl(source.url)!}
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
                        <Menu
                          label={`Actions for ${source.title}`}
                          items={[
                            { label: "Add footnote citing it", onSelect: () => void addCustomFootnote(source) },
                            { label: "Remove source", danger: true, onSelect: () => void handleDeleteCustomSource(source.id) },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
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

      {/* Target and Deadline settings at the bottom */}
      <div className="row" style={{ marginTop: "2rem", gap: "1.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ flex: 1, minWidth: "14rem" }}>
          <DatePicker
            value={assessment.dueDate ?? null}
            onChange={(d) => void save({ dueDate: d })}
            label="Assessment due date"
            title={`Due date for ${assessment.title || "the essay"}`}
            placeholder="Set due date"
            clearable
          />
        </div>
        <div style={{ width: "10rem" }}>
          <label className="field" style={{ margin: 0 }}>
            <span>Word target</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={100}
              value={target}
              placeholder="2500"
              onFocus={() => {
                typingTarget.current = true;
              }}
              onBlur={() => {
                typingTarget.current = false;
              }}
              onChange={(e) => {
                setTarget(e.target.value);
                void save({ wordTarget: e.target.value.trim() ? Number(e.target.value) : null });
              }}
            />
          </label>
        </div>
      </div>

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
