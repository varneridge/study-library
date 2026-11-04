import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import {
  assessmentNotesKey,
  deleteDraftSnapshot,
  downloadDocxFile,
  formatChicagoFootnote,
  importAssessmentDocxFile,
  restoreDraftSnapshot,
  saveDraftSnapshot,
  saveModuleAssessment,
  useModuleAssessment,
} from "../lib/assessment";
import { shortDate } from "../lib/dates";
import { db } from "../lib/db";
import { countDocxWords, type DocxFootnote } from "../lib/docx";
import { setSetting, useSetting } from "../lib/settings";
import { countdown } from "../lib/sections";
import { newId } from "../lib/sync";
import { chicagoBibliography, fullTitle, shortTitle } from "../lib/titles";
import type { ItemRow, ModuleRow } from "../lib/types";
import { showToast, useCloseOnBack } from "../lib/ui";
import { DatePicker } from "./DatePicker";
import { Icon } from "./icons";

const NoteEditor = lazy(() => import("./NoteEditor"));

export function AssessmentSection({ module }: { module: ModuleRow }) {
  const isCollapsed = useSetting<boolean>(`collapse:assessment:${module.id}`, true);
  const assessment = useModuleAssessment(module.id, module.code);
  const [activeTab, setActiveTab] = useState<"draft" | "references" | "notes" | "history">("draft");
  const [pickingRefs, setPickingRefs] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [localTitle, setLocalTitle] = useState(assessment.title);
  const [localWordTarget, setLocalWordTarget] = useState(
    assessment.wordTarget !== null && assessment.wordTarget !== undefined
      ? String(assessment.wordTarget)
      : "",
  );
  const titleFocusedRef = useRef(false);
  const targetFocusedRef = useRef(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!titleFocusedRef.current) setLocalTitle(assessment.title);
  }, [assessment.title]);

  useEffect(() => {
    if (!targetFocusedRef.current) {
      setLocalWordTarget(
        assessment.wordTarget !== null && assessment.wordTarget !== undefined
          ? String(assessment.wordTarget)
          : "",
      );
    }
  }, [assessment.wordTarget]);

  useCloseOnBack(pickingRefs, () => setPickingRefs(false));

  const open = !isCollapsed;
  const toggleOpen = () => {
    void setSetting(`collapse:assessment:${module.id}`, open);
  };

  const refIdsKey = assessment.referenceItemIds.join(",");

  // Load all readings belonging to this module
  const moduleItems = useLiveQuery(async () => {
    const weeks = (await db.weeks.where("module_id").equals(module.id).toArray()).filter((w) => !w.deleted);
    const weekIds = new Set(weeks.map((w) => w.id));
    const weekItems = (await db.week_items.toArray()).filter((wi) => !wi.deleted && weekIds.has(wi.week_id));
    const ids = new Set(weekItems.map((wi) => wi.item_id));
    for (const refId of assessment.referenceItemIds) ids.add(refId);
    const rows = (await db.items.toArray()).filter(
      (i) => !i.deleted && i.kind !== "slides" && (ids.has(i.id) || i.tray_module_id === module.id),
    );
    return rows.sort((a, b) => fullTitle(a).localeCompare(fullTitle(b)));
  }, [module.id, refIdsKey], [] as ItemRow[]);

  const curatedItems = useMemo(() => {
    const refSet = new Set(assessment.referenceItemIds);
    return moduleItems.filter((i) => refSet.has(i.id));
  }, [moduleItems, assessment.referenceItemIds]);

  const primaryRefs = useMemo(
    () => curatedItems.filter((i) => i.kind === "primary"),
    [curatedItems],
  );
  const secondaryRefs = useMemo(
    () => curatedItems.filter((i) => i.kind !== "primary"),
    [curatedItems],
  );

  const wordCounts = useMemo(() => countDocxWords(assessment.draft), [assessment.draft]);

  const toggleReferenceItem = async (itemId: string) => {
    const has = assessment.referenceItemIds.includes(itemId);
    const nextIds = has
      ? assessment.referenceItemIds.filter((id) => id !== itemId)
      : [...assessment.referenceItemIds, itemId];
    await saveModuleAssessment(
      module.id,
      { referenceItemIds: nextIds },
      { moduleCode: module.code },
    );
  };

  const handleCopyBibliography = async () => {
    if (curatedItems.length === 0) {
      showToast("Add references first to copy a bibliography.");
      return;
    }
    const lines: string[] = [];
    if (primaryRefs.length > 0) {
      lines.push("Primary Sources");
      for (const item of primaryRefs) {
        lines.push(chicagoBibliography(item));
      }
      lines.push("");
    }
    if (secondaryRefs.length > 0) {
      lines.push("Secondary Sources");
      for (const item of secondaryRefs) {
        lines.push(chicagoBibliography(item));
      }
    }
    const text = lines.join("\n").trim();
    try {
      await navigator.clipboard.writeText(text);
      showToast("Bibliography copied to clipboard.");
    } catch {
      showToast("Could not copy to clipboard.");
    }
  };

  const handleQuickInsertFootnote = async (item: ItemRow) => {
    const fnId = `fn-${newId()}`;
    const noteText = formatChicagoFootnote(item);
    await saveModuleAssessment(
      module.id,
      (prev) => {
        const blocks = [...prev.draft.blocks];
        const lastIdx = blocks.length - 1;
        if (lastIdx >= 0) {
          blocks[lastIdx] = {
            ...blocks[lastIdx],
            runs: [...blocks[lastIdx].runs, { type: "footnote_ref", footnoteId: fnId }],
          };
        }
        const newFn: DocxFootnote = {
          id: fnId,
          text: noteText,
          citationItemId: item.id,
        };
        return {
          ...prev,
          draft: {
            ...prev.draft,
            blocks,
            footnotes: [...prev.draft.footnotes, newFn],
          },
        };
      },
      { moduleCode: module.code },
    );
    showToast("Footnote added to working draft.");
  };

  return (
    <section className="section assessment-section" aria-label="Assessment and essay" style={{ marginTop: "1rem" }}>
      <div className="section-head" style={{ marginBottom: open ? "0.75rem" : 0 }}>
        <h2 style={{ margin: 0 }}>
          <button
            type="button"
            className="section-toggle"
            aria-expanded={open}
            aria-controls={`assessment-panel-${module.id}`}
            onClick={toggleOpen}
          >
            <Icon name={open ? "down" : "caret"} size={16} />
            <span>Assessment & essay</span>
            <span className="toggle-count">
              ({wordCounts.total.toLocaleString()} {wordCounts.total === 1 ? "word" : "words"})
            </span>
          </button>
        </h2>
        {open && (
          <>
            <span className="spacer" />
            <Link to={{ view: "essay", id: module.id }} className="button primary small">
              Open word processor
            </Link>
          </>
        )}
      </div>

      <div id={`assessment-panel-${module.id}`} className="assessment-body" hidden={!open}>
        <div className="assessment-tabs" role="tablist" aria-label="Assessment sections">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "draft"}
            className={`assessment-tab${activeTab === "draft" ? " on" : ""}`}
            onClick={() => setActiveTab("draft")}
          >
            Working draft
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "references"}
            className={`assessment-tab${activeTab === "references" ? " on" : ""}`}
            onClick={() => setActiveTab("references")}
          >
            References ({curatedItems.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "notes"}
            className={`assessment-tab${activeTab === "notes" ? " on" : ""}`}
            onClick={() => setActiveTab("notes")}
          >
            Plans & notes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "history"}
            className={`assessment-tab${activeTab === "history" ? " on" : ""}`}
            onClick={() => setActiveTab("history")}
          >
            Previous drafts ({assessment.previousDrafts.length})
          </button>
        </div>

        {activeTab === "draft" && (
          <div className="assessment-pane">
            <div className="assessment-draft-card">
              <div className="assessment-draft-fields">
                <label className="field" style={{ flex: 2, minWidth: "14rem" }}>
                  <span>Essay title / question</span>
                  <input
                    type="text"
                    value={localTitle}
                    onFocus={() => {
                      titleFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      titleFocusedRef.current = false;
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      setLocalTitle(val);
                      void saveModuleAssessment(
                        module.id,
                        { title: val },
                        { moduleCode: module.code },
                      );
                    }}
                    placeholder="Enter essay question or working title"
                  />
                </label>
                <label className="field" style={{ width: "8.5rem" }}>
                  <span>Word target</span>
                  <input
                    type="number"
                    min={0}
                    step={100}
                    value={localWordTarget}
                    onFocus={() => {
                      targetFocusedRef.current = true;
                    }}
                    onBlur={() => {
                      targetFocusedRef.current = false;
                    }}
                    onChange={(e) => {
                      const rawVal = e.target.value;
                      setLocalWordTarget(rawVal);
                      const val = rawVal.trim() ? Number(rawVal) : null;
                      void saveModuleAssessment(
                        module.id,
                        { wordTarget: val },
                        { moduleCode: module.code },
                      );
                    }}
                    placeholder="2500"
                  />
                </label>
                <div className="field" style={{ minWidth: "11rem" }}>
                  <span>Due date</span>
                  <DatePicker
                    value={assessment.dueDate ?? null}
                    onChange={(d) =>
                      void saveModuleAssessment(
                        module.id,
                        { dueDate: d },
                        { moduleCode: module.code },
                      )
                    }
                    label="Assessment due date"
                    placeholder="Choose due date"
                    clearable
                  />
                </div>
              </div>

              <div className="assessment-draft-summary">
                <div className="assessment-stat">
                  <span className="small muted">Progress</span>
                  <strong>
                    {wordCounts.total.toLocaleString()}
                    {assessment.wordTarget ? ` of ${assessment.wordTarget.toLocaleString()}` : ""} words
                  </strong>
                </div>
                <div className="assessment-stat">
                  <span className="small muted">Footnotes</span>
                  <strong>{assessment.draft.footnotes.length}</strong>
                </div>
                <div className="assessment-stat">
                  <span className="small muted">Review comments</span>
                  <strong>{assessment.draft.comments.length}</strong>
                </div>
                {assessment.dueDate && (
                  <div className="assessment-stat">
                    <span className="small muted">Deadline</span>
                    <strong className={countdown(assessment.dueDate).state}>
                      {shortDate(new Date(`${assessment.dueDate}T00:00:00`), { year: true })} ({countdown(assessment.dueDate).words})
                    </strong>
                  </div>
                )}
              </div>

              <div className="row" style={{ gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
                <Link to={{ view: "essay", id: module.id }} className="button primary">
                  Open word processor
                </Link>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    downloadDocxFile(assessment.draft, assessment.title);
                    showToast("Downloaded Word (.docx) document.");
                  }}
                >
                  Export .docx
                </button>
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => importInputRef.current?.click()}
                >
                  Import .docx
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  hidden
                  accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    try {
                      await importAssessmentDocxFile(module.id, file, module.code);
                      showToast(`Imported ${file.name} into working draft.`);
                    } catch (err) {
                      showToast(err instanceof Error ? err.message : "Could not import .docx file.");
                    }
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === "references" && (
          <div className="assessment-pane">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: "0.75rem" }}>
              <span className="small muted">
                Curate the primary and secondary sources for your essay.
              </span>
              <div className="row" style={{ gap: "0.5rem" }}>
                <button
                  type="button"
                  className="button small quiet"
                  disabled={curatedItems.length === 0}
                  onClick={() => void handleCopyBibliography()}
                >
                  Copy bibliography
                </button>
                <button
                  type="button"
                  className="button small"
                  onClick={() => setPickingRefs(true)}
                >
                  Choose readings ({curatedItems.length})
                </button>
              </div>
            </div>

            {curatedItems.length === 0 ? (
              <p className="small muted">
                No references selected yet. Click Choose readings to pick primary and secondary sources from this module.
              </p>
            ) : (
              <div className="assessment-ref-groups">
                <div>
                  <h3 className="small muted" style={{ margin: "0 0 0.4rem" }}>
                    Primary sources ({primaryRefs.length})
                  </h3>
                  {primaryRefs.length === 0 ? (
                    <p className="small muted">None selected.</p>
                  ) : (
                    <ul className="assessment-ref-list">
                      {primaryRefs.map((item) => (
                        <li key={item.id} className="assessment-ref-row">
                          <Link to={{ view: "reader", id: item.id }} className="assessment-ref-title">
                            {fullTitle(item)}
                          </Link>
                          <div className="row" style={{ gap: "0.35rem" }}>
                            <button
                              type="button"
                              className="quiet small"
                              onClick={() => void handleQuickInsertFootnote(item)}
                            >
                              + Footnote
                            </button>
                            <button
                              type="button"
                              className="quiet small"
                              aria-label={`Remove ${shortTitle(item)} from references`}
                              onClick={() => void toggleReferenceItem(item.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div style={{ marginTop: "1rem" }}>
                  <h3 className="small muted" style={{ margin: "0 0 0.4rem" }}>
                    Secondary literature ({secondaryRefs.length})
                  </h3>
                  {secondaryRefs.length === 0 ? (
                    <p className="small muted">None selected.</p>
                  ) : (
                    <ul className="assessment-ref-list">
                      {secondaryRefs.map((item) => (
                        <li key={item.id} className="assessment-ref-row">
                          <Link to={{ view: "reader", id: item.id }} className="assessment-ref-title">
                            {fullTitle(item)}
                          </Link>
                          <div className="row" style={{ gap: "0.35rem" }}>
                            <button
                              type="button"
                              className="quiet small"
                              onClick={() => void handleQuickInsertFootnote(item)}
                            >
                              + Footnote
                            </button>
                            <button
                              type="button"
                              className="quiet small"
                              aria-label={`Remove ${shortTitle(item)} from references`}
                              onClick={() => void toggleReferenceItem(item.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "notes" && (
          <div className="assessment-pane">
            <Suspense fallback={<p className="small muted">Loading editor…</p>}>
              <NoteEditor
                target={{ week_id: assessmentNotesKey(module.id) }}
                label="Essay plans and notes"
                placeholder="Outline your argument, essay plan and structure here. Type / for headings and lists, or @ to cite a reading."
              />
            </Suspense>
          </div>
        )}

        {activeTab === "history" && (
          <div className="assessment-pane">
            <div className="row" style={{ gap: "0.5rem", marginBottom: "0.75rem" }}>
              <input
                type="text"
                style={{ flex: 1 }}
                placeholder="Snapshot label (e.g. First complete draft)"
                aria-label="Snapshot label"
                value={snapshotName}
                onChange={(e) => setSnapshotName(e.target.value)}
              />
              <button
                type="button"
                className="button small"
                onClick={async () => {
                  await saveDraftSnapshot(module.id, snapshotName, module.code);
                  setSnapshotName("");
                  showToast("Draft snapshot saved.");
                }}
              >
                Save current as snapshot
              </button>
            </div>

            {assessment.previousDrafts.length === 0 ? (
              <p className="small muted">
                No previous drafts saved yet. Save a snapshot before major revisions or export any version as a Word (.docx) file.
              </p>
            ) : (
              <ul className="assessment-history-list">
                {assessment.previousDrafts.map((snap) => (
                  <li key={snap.id} className="assessment-history-row">
                    <div>
                      <strong>{snap.name}</strong>
                      <span className="small muted" style={{ marginLeft: "0.5rem" }}>
                        {snap.word_count.toLocaleString()} {snap.word_count === 1 ? "word" : "words"} ·{" "}
                        {new Date(snap.created_at).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="row" style={{ gap: "0.4rem" }}>
                      <button
                        type="button"
                        className="quiet small"
                        onClick={async () => {
                          await restoreDraftSnapshot(module.id, snap.id, module.code);
                          showToast(`Restored "${snap.name}".`);
                        }}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        className="quiet small"
                        onClick={() => downloadDocxFile(snap.doc, snap.name)}
                      >
                        Download .docx
                      </button>
                      <button
                        type="button"
                        className="quiet small danger"
                        aria-label={`Delete snapshot ${snap.name}`}
                        onClick={() => void deleteDraftSnapshot(module.id, snap.id, module.code)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {pickingRefs && (
        <div className="modal-backdrop" onClick={() => setPickingRefs(false)}>
          <div
            className="dialog word-cite-dialog"
            role="dialog"
            aria-label="Choose essay references"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-head" style={{ marginBottom: "0.75rem" }}>
              <h2 style={{ margin: 0 }}>Choose essay references</h2>
              <span className="spacer" />
              <button type="button" className="button small primary" onClick={() => setPickingRefs(false)}>
                Done
              </button>
            </div>
            {moduleItems.length === 0 ? (
              <p className="small muted">No readings in this module yet.</p>
            ) : (
              <ul className="citation-list">
                {moduleItems.map((item) => {
                  const checked = assessment.referenceItemIds.includes(item.id);
                  return (
                    <li key={item.id}>
                      <label className="check-row" style={{ cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => void toggleReferenceItem(item.id)}
                        />
                        <span>
                          <strong>{shortTitle(item)}</strong>{" "}
                          <span className="small muted">
                            ({item.kind === "primary" ? "Primary" : "Secondary"}) — {fullTitle(item)}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
