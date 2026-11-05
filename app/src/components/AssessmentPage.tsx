// Assessment & essay: a module's essay, laid out in the order a history
// student works on it. The question comes first, as it was set, then the
// draft so far and the plan of the argument. Beside them sit the deadline,
// the word count, the sources being used and the snapshots saved along the
// way. The word processor is the page's one main button. On the module page
// it is a card under Course materials & assessments, opened like a week.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import {
  assessmentNotesKey,
  deleteDraftSnapshot,
  downloadDocxFile,
  draftExcerpt,
  formatChicagoFootnote,
  importAssessmentDocxFile,
  restoreDraftSnapshot,
  saveDraftSnapshot,
  saveModuleAssessment,
  useModuleAssessment,
  wordProgress,
} from "../lib/assessment";
import { shortDate } from "../lib/dates";
import { db } from "../lib/db";
import { countDocxWords, type DocxFootnote } from "../lib/docx";
import { countdown } from "../lib/sections";
import { newId } from "../lib/sync";
import { chicagoBibliography, fullTitle, shortTitle } from "../lib/titles";
import type { ItemRow, ModuleRow } from "../lib/types";
import { confirmAction, showToast, useTitle } from "../lib/ui";
import { DatePicker } from "./DatePicker";
import { NotesLoading } from "./ErrorBoundary";
import { Menu } from "./Menu";
import { Sheet } from "./Sheet";

const NoteEditor = lazy(() => import("./NoteEditor"));

const dayOf = (iso: string) => new Date(`${iso}T00:00:00`);

// The card on the module page, in the Course materials & assessments grid.
export function AssessmentCard({ module }: { module: ModuleRow }) {
  const assessment = useModuleAssessment(module.id, module.code);
  const words = countDocxWords(assessment.draft).total;
  const progress = wordProgress(words, assessment.wordTarget);
  const due = assessment.dueDate ? countdown(assessment.dueDate) : null;
  const to = { view: "assessment" as const, id: module.id };
  const question = assessment.title.trim();
  return (
    <article className={`essay-card${due && (due.state === "soon" || due.state === "today") ? " due-soon" : ""}`}>
      <Link to={to} className="essay-card-cover" tabIndex={-1} ariaHidden={true}>
        <span className={`essay-card-question${question ? "" : " is-empty"}`}>{question || "Set the essay question"}</span>
        {assessment.wordTarget ? (
          <span className="essay-bar essay-card-bar" aria-hidden="true"><span style={{ width: `${Math.round(progress.share * 100)}%` }} /></span>
        ) : null}
      </Link>
      <div className="week-card-body">
        <div className="week-card-meta">
          <span className="week-card-code">Assessment</span>
          {assessment.dueDate && <span className="week-card-dates">Due {shortDate(dayOf(assessment.dueDate))}</span>}
        </div>
        <Link to={to} className="week-card-title-link essay-card-title">Assessment & essay</Link>
        <div className="week-card-footer">
          <span className="count">{progress.words}{due ? `, due ${due.words}` : ""}</span>
        </div>
      </div>
    </article>
  );
}

export function AssessmentPage({ id }: { id: string }) {
  const module = useLiveQuery(async () => {
    const found = await db.modules.get(id);
    return found && !found.deleted ? found : null;
  }, [id]);
  useTitle(module ? `${module.code} assessment` : undefined);
  if (module === undefined) return null;
  if (module === null) return <div className="page"><p className="muted">This module no longer exists.</p></div>;
  return <AssessmentBody module={module} />;
}

function AssessmentBody({ module }: { module: ModuleRow }) {
  const assessment = useModuleAssessment(module.id, module.code);
  const save = (patch: Parameters<typeof saveModuleAssessment>[1]) => saveModuleAssessment(module.id, patch, { moduleCode: module.code });

  // Typing keeps its own copy, so a save arriving from elsewhere never moves the cursor.
  const [question, setQuestion] = useState(assessment.title);
  const [target, setTarget] = useState(assessment.wordTarget ? String(assessment.wordTarget) : "");
  const typingQuestion = useRef(false);
  const typingTarget = useRef(false);
  useEffect(() => { if (!typingQuestion.current) setQuestion(assessment.title); }, [assessment.title]);
  useEffect(() => { if (!typingTarget.current) setTarget(assessment.wordTarget ? String(assessment.wordTarget) : ""); }, [assessment.wordTarget]);

  const [choosing, setChoosing] = useState(false);
  const [snapshotName, setSnapshotName] = useState("");
  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const importer = useRef<HTMLInputElement>(null);

  const counts = useMemo(() => countDocxWords(assessment.draft), [assessment.draft]);
  const progress = wordProgress(counts.total, assessment.wordTarget);
  const excerpt = useMemo(() => draftExcerpt(assessment.draft), [assessment.draft]);
  const due = assessment.dueDate ? countdown(assessment.dueDate) : null;

  // Every reading in the module, and any source chosen before it moved.
  const refIds = assessment.referenceItemIds.join(",");
  const readings = useLiveQuery(async () => {
    const weeks = (await db.weeks.where("module_id").equals(module.id).toArray()).filter((w) => !w.deleted);
    const weekIds = new Set(weeks.map((w) => w.id));
    const links = (await db.week_items.toArray()).filter((wi) => !wi.deleted && weekIds.has(wi.week_id));
    const ids = new Set(links.map((wi) => wi.item_id));
    for (const chosen of assessment.referenceItemIds) ids.add(chosen);
    const rows = (await db.items.toArray()).filter(
      (i) => !i.deleted && i.kind !== "slides" && (ids.has(i.id) || i.tray_module_id === module.id),
    );
    return rows.sort((a, b) => fullTitle(a).localeCompare(fullTitle(b)));
  }, [module.id, refIds], [] as ItemRow[]);

  const chosen = useMemo(() => {
    const set = new Set(assessment.referenceItemIds);
    return readings.filter((i) => set.has(i.id));
  }, [readings, assessment.referenceItemIds]);
  const primary = chosen.filter((i) => i.kind === "primary");
  const secondary = chosen.filter((i) => i.kind !== "primary");

  const toggleSource = async (itemId: string) => {
    const has = assessment.referenceItemIds.includes(itemId);
    await save({ referenceItemIds: has ? assessment.referenceItemIds.filter((x) => x !== itemId) : [...assessment.referenceItemIds, itemId] });
  };

  const copyBibliography = async () => {
    const lines: string[] = [];
    if (primary.length) lines.push("Primary sources", ...primary.map(chicagoBibliography), "");
    if (secondary.length) lines.push("Secondary sources", ...secondary.map(chicagoBibliography));
    try {
      await navigator.clipboard.writeText(lines.join("\n").trim());
      showToast("Bibliography copied.");
    } catch {
      showToast("Could not copy the bibliography.");
    }
  };

  // A footnote citing the source goes at the end of the draft, for the
  // word processor to move where it belongs.
  const addFootnote = async (item: ItemRow) => {
    const footnoteId = `fn-${newId()}`;
    await saveModuleAssessment(module.id, (prev) => {
      const blocks = [...prev.draft.blocks];
      const last = blocks.length - 1;
      if (last >= 0) blocks[last] = { ...blocks[last], runs: [...blocks[last].runs, { type: "footnote_ref", footnoteId }] };
      const note: DocxFootnote = { id: footnoteId, text: formatChicagoFootnote(item), citationItemId: item.id };
      return { ...prev, draft: { ...prev.draft, blocks, footnotes: [...prev.draft.footnotes, note] } };
    }, { moduleCode: module.code });
    showToast("Footnote added at the end of the draft.");
  };

  const saveSnapshot = async () => {
    if (savingSnapshot) return;
    setSavingSnapshot(true);
    try {
      await saveDraftSnapshot(module.id, snapshotName, module.code);
      setSnapshotName("");
      showToast("Snapshot saved.");
    } finally {
      setSavingSnapshot(false);
    }
  };

  const sourceRow = (item: ItemRow) => (
    <li key={item.id}>
      <Link to={{ view: "reader", id: item.id }} title={fullTitle(item)}>{fullTitle(item)}</Link>
      <Menu
        label={`More actions for ${shortTitle(item)}`}
        items={[
          { label: "Add a footnote citing it", onSelect: () => void addFootnote(item) },
          { label: "Remove from sources", onSelect: () => void toggleSource(item.id) },
        ]}
      />
    </li>
  );

  return (
    <div className="page wide essay-page">
      <div className="crumbs">
        <Link to={{ view: "module", id: module.id }}>{module.code}</Link> <span aria-hidden="true">/</span> Assessment & essay
      </div>
      <div className="section-head essay-head">
        <h1>Assessment & essay</h1>
        <span className="spacer" />
        <Link to={{ view: "essay", id: module.id }} className="button primary">Open word processor</Link>
      </div>
      {module.title && <p className="lede">{module.title}</p>}

      <div className="essay-layout">
        <div className="essay-main">
          <section className="essay-question-block">
            <label className="field essay-question">
              <span>Essay question</span>
              <textarea
                rows={2}
                value={question}
                placeholder="Write the question as it was set"
                onFocus={() => { typingQuestion.current = true; }}
                onBlur={() => { typingQuestion.current = false; }}
                onChange={(e) => {
                  setQuestion(e.target.value);
                  void save({ title: e.target.value });
                }}
              />
            </label>
            <p className="small muted essay-hint">Keep it as it was set, so the essay keeps answering it. It is the title in the word processor.</p>
          </section>

          <section className="essay-panel essay-draft" aria-labelledby="essay-draft-title">
            <div className="essay-panel-head">
              <h2 id="essay-draft-title">Draft</h2>
              <span className="essay-stats">
                <span>{counts.total.toLocaleString("en-GB")} {counts.total === 1 ? "word" : "words"}</span>
                <span>{assessment.draft.footnotes.length} {assessment.draft.footnotes.length === 1 ? "footnote" : "footnotes"}</span>
                <span>{assessment.draft.comments.length} {assessment.draft.comments.length === 1 ? "comment" : "comments"}</span>
              </span>
            </div>
            {excerpt
              ? <p className="essay-excerpt">{excerpt}</p>
              : <p className="small muted">Nothing written yet. Open the word processor to start the draft, or import one from Word.</p>}
            <div className="essay-actions">
              <button type="button" className="button" onClick={() => { downloadDocxFile(assessment.draft, assessment.title); showToast("Word document downloaded."); }}>
                Export .docx
              </button>
              <button type="button" className="quiet" onClick={() => importer.current?.click()}>Import .docx</button>
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
                    await importAssessmentDocxFile(module.id, file, module.code);
                    showToast(`${file.name} imported as the draft.`);
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : "Could not import that Word document.");
                  }
                }}
              />
            </div>
          </section>

          <section className="essay-plan" aria-labelledby="essay-plan-title">
            <h2 id="essay-plan-title">Plan and argument</h2>
            <p className="small muted essay-hint">Your argument in a sentence, then the sections that make it. A collapsible heading folds a section away.</p>
            <Suspense fallback={<NotesLoading />}>
              <NoteEditor
                target={{ week_id: assessmentNotesKey(module.id) }}
                label="Plan and argument"
                placeholder="Your argument in a sentence, then a heading for each section. Type / for headings and lists, or @ to cite a reading."
              />
            </Suspense>
          </section>
        </div>

        <aside className="essay-aside" aria-label="Deadline, word count, sources and snapshots">
          <section className="essay-panel essay-deadline" aria-labelledby="essay-deadline-title">
            <h2 id="essay-deadline-title">Deadline</h2>
            <DatePicker
              value={assessment.dueDate ?? null}
              onChange={(d) => void save({ dueDate: d })}
              label="Assessment due date"
              title={`Due date for the ${module.code} essay`}
              hint="It counts down here and on the module page."
              placeholder="Choose due date"
              clearable
            />
            {due && assessment.dueDate
              ? <p className={`essay-due ${due.state}`}>{shortDate(dayOf(assessment.dueDate), { year: true })}, {due.words}</p>
              : <p className="small muted essay-due">No due date yet.</p>}
          </section>

          <section className="essay-panel essay-words" aria-labelledby="essay-words-title">
            <h2 id="essay-words-title">Word count</h2>
            <p className="essay-progress-words">{progress.words}</p>
            {assessment.wordTarget ? (
              <span className="essay-bar" role="progressbar" aria-label="Words written" aria-valuemin={0} aria-valuemax={assessment.wordTarget} aria-valuenow={counts.total}>
                <span style={{ width: `${Math.round(progress.share * 100)}%` }} />
              </span>
            ) : null}
            <p className="small muted">Body {counts.body.toLocaleString("en-GB")}, quotations {counts.quotes.toLocaleString("en-GB")}, footnotes {counts.footnotes.toLocaleString("en-GB")}.</p>
            <label className="field essay-target">
              <span>Word target</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                step={100}
                value={target}
                placeholder="2500"
                onFocus={() => { typingTarget.current = true; }}
                onBlur={() => { typingTarget.current = false; }}
                onChange={(e) => {
                  setTarget(e.target.value);
                  void save({ wordTarget: e.target.value.trim() ? Number(e.target.value) : null });
                }}
              />
            </label>
          </section>

          <section className="essay-panel essay-sources" aria-labelledby="essay-sources-title">
            <div className="essay-panel-head">
              <h2 id="essay-sources-title">Sources</h2>
              <button type="button" className="quiet" onClick={() => setChoosing(true)}>Choose sources</button>
            </div>
            {chosen.length === 0 ? (
              <p className="small muted">No sources chosen yet. Choose the readings this essay uses, from this module.</p>
            ) : (
              <>
                <div className="essay-source-group">
                  <h3>Primary sources</h3>
                  {primary.length ? <ul className="essay-source-list">{primary.map(sourceRow)}</ul> : <p className="small muted">None yet.</p>}
                </div>
                <div className="essay-source-group">
                  <h3>Secondary reading</h3>
                  {secondary.length ? <ul className="essay-source-list">{secondary.map(sourceRow)}</ul> : <p className="small muted">None yet.</p>}
                </div>
                <div className="essay-actions">
                  <button type="button" className="button" onClick={() => void copyBibliography()}>Copy bibliography</button>
                </div>
              </>
            )}
          </section>

          <section className="essay-panel essay-snapshots" aria-labelledby="essay-snapshots-title">
            <h2 id="essay-snapshots-title">Snapshots</h2>
            <p className="small muted essay-hint">Save one before a big revision, to go back to it or send it as Word.</p>
            <div className="essay-snapshot-form">
              <input
                type="text"
                aria-label="Snapshot name"
                placeholder="First full draft"
                value={snapshotName}
                enterKeyHint="done"
                onChange={(e) => setSnapshotName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void saveSnapshot(); }}
              />
              <button type="button" className="button" disabled={savingSnapshot} onClick={() => void saveSnapshot()}>
                {savingSnapshot ? "Saving…" : "Save snapshot"}
              </button>
            </div>
            {assessment.previousDrafts.length > 0 && (
              <ul className="essay-snapshot-list">
                {assessment.previousDrafts.map((snap) => (
                  <li key={snap.id}>
                    <span className="name">
                      {snap.name}
                      <span className="when">
                        {snap.word_count.toLocaleString("en-GB")} {snap.word_count === 1 ? "word" : "words"},{" "}
                        {shortDate(new Date(snap.created_at))}, {new Date(snap.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </span>
                    <Menu
                      label={`More actions for ${snap.name}`}
                      items={[
                        {
                          label: "Restore snapshot",
                          onSelect: async () => {
                            const ok = await confirmAction({
                              title: `Restore “${snap.name}”?`,
                              body: "It replaces the draft as it is now. Save a snapshot first to keep the current draft.",
                              confirm: "Restore snapshot",
                            });
                            if (!ok) return;
                            await restoreDraftSnapshot(module.id, snap.id, module.code);
                            showToast(`“${snap.name}” restored.`);
                          },
                        },
                        { label: "Download .docx", onSelect: () => downloadDocxFile(snap.doc, snap.name) },
                        {
                          label: "Delete snapshot",
                          danger: true,
                          onSelect: async () => {
                            const ok = await confirmAction({
                              title: `Delete “${snap.name}”?`,
                              body: "The snapshot cannot be brought back. The draft itself is not touched.",
                              confirm: "Delete snapshot",
                              danger: true,
                            });
                            if (!ok) return;
                            await deleteDraftSnapshot(module.id, snap.id, module.code);
                            showToast("Snapshot deleted.");
                          },
                        },
                      ]}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>

      <Sheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title="Choose sources"
        subtitle={`Readings in ${module.code}`}
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
              <div key={group} className="essay-source-group">
                <h3>{group === "primary" ? "Primary sources" : "Secondary reading"}</h3>
                <ul className="citation-list">
                  {rows.map((item) => (
                    <li key={item.id}>
                      <label className="check-row">
                        <input type="checkbox" checked={assessment.referenceItemIds.includes(item.id)} onChange={() => void toggleSource(item.id)} />
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
    </div>
  );
}
