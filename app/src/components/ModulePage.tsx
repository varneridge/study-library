import { navigate } from "../lib/router";
import { shortDate } from "../lib/dates";
import { deleteSection } from "../lib/edits";
import { moveSection, addSection, isDissertation, saveKeyDates, countdown } from "../lib/sections";
import { Menu } from "./Menu";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { fullTitle } from "../lib/titles";
import { applySuggestion, keepMine, viaLabel } from "../lib/citations";
import { update, newId } from "../lib/sync";
import { db } from "../lib/db";
import { applyPlans, planFile } from "../lib/importing";
import { showToast, useCloseOnBack, useTitle } from "../lib/ui";
import type { ReadingView, WeekOverview } from "../lib/library";
import type { ModuleRow, WeekRow } from "../lib/types";
import { useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { Link } from "../App";
import { loadModuleOverview } from "../lib/library";
import { sessionLabel, weekCode, isSection } from "../lib/modules";
import { BlockView } from "./BlockView";
import { MoveSelect, ReadingRow } from "./ReadingRow";
import { ModuleSettings } from "./ModuleSettings";

function formatReadingCount(counts: { read: number; total: number }): string | null {
  const { read, total } = counts;
  if (total === 0) return null;
  if (read === 0) return `${total} ${total === 1 ? "reading" : "readings"}`;
  if (read === total) return `all ${total} read`;
  return `${read} of ${total} read`;
}

// Details found in PDFs, all in one place: tick the ones to use.
function CitationReview({ views, onClose }: { views: ReadingView[]; onClose: () => void }) {
  useCloseOnBack(true, onClose);
  const ref = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState(() => new Set(views.map((v) => v.item.id)));
  useEffect(() => { ref.current?.showModal(); }, []);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChosen(next);
  };
  return (
    <dialog ref={ref} className="dialog review-citations" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2>Check the details found</h2>
      <p className="small muted">Study Library read these PDFs and found fuller details. Untick any you would rather keep as they are.</p>
      <ul className="citation-list">
        {views.map(({ item }) => (
          <li key={item.id}>
            <label>
              <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} />
              <span>
                <span className="was">{fullTitle(item)}</span>
                <span className="now">{fullTitle({ ...item, ...item.suggested! })}</span>
                <span className="via small muted">Found {viaLabel(item.suggested!.via)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="quiet" onClick={async () => { for (const v of views) await keepMine(v.item); onClose(); }}>Keep all as they are</button>
        <button className="button primary" disabled={!chosen.size} onClick={async () => {
          for (const v of views) {
            if (chosen.has(v.item.id)) await applySuggestion(v.item, true);
            else await keepMine(v.item);
          }
          showToast(`${chosen.size} ${chosen.size === 1 ? "reading" : "readings"} updated.`);
          onClose();
        }}>Use {chosen.size} of {views.length}</button>
      </div>
    </dialog>
  );
}

async function addFilesTo(files: File[], module: ModuleRow, week: WeekRow) {
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const count = await applyPlans(module, files.map((file) => planFile(file, weeks, week)));
  if (count) showToast(`${count} ${count === 1 ? "file" : "files"} added to ${weekCode(week)}. Uploading now.`);
}

function TraySection({ tray, weeks }: { tray: ReadingView[]; weeks: WeekRow[] }) {
  return (
    <div className="section tray" style={{ marginTop: "2.5rem", marginBottom: "2rem" }}>
      <div className="section-head"><h2>Unsorted</h2></div>
      <ul className="readings">
        {tray.map((r) => (
          <ReadingRow key={r.item.id} view={r} weeks={weeks} extra={<MoveSelect view={r} weeks={weeks} label="Choose a week" />} />
        ))}
      </ul>
    </div>
  );
}

function WeekCard({
  overview,
  module,
  dates,
  renaming,
  onStartRename,
  onEndRename,
}: {
  overview: WeekOverview;
  module: ModuleRow;
  dates: ReturnType<typeof useTermDates>;
  renaming: boolean;
  onStartRename: () => void;
  onEndRename: () => void;
}) {
  const { week, readingCount, thumb_key, sessions, isCurrentWeek } = overview;
  const [fileOver, setFileOver] = useState(false);
  const summary = formatReadingCount(readingCount);
  const isSec = isSection(week);
  const code = weekCode(week);

  return (
    <article
      id={`week-${code}`}
      data-drop-week={week.id}
      className={`week-card week${isCurrentWeek ? " this-week" : ""}${fileOver ? " drop-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          setFileOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileOver(false);
      }}
      onDrop={(e) => {
        setFileOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void addFilesTo(Array.from(e.dataTransfer.files), module, week);
      }}
    >
      <div className="week-card-cover">
        {thumb_key ? (
          <img src={`/api/objects/${thumb_key}`} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="week-card-cover-fallback">
            <span className="week-card-cover-display">{code}</span>
          </div>
        )}
        {isCurrentWeek && <span className="this-week-tag this-week-pill">This week</span>}
        {isSec && (
          <div className="week-card-actions">
            <Menu label={`More actions for ${code}`} items={[
              { label: "Rename", onSelect: onStartRename },
              { label: "Move up", onSelect: () => void moveSection(week, -1).then((ok) => { if (!ok) showToast("Already the first section."); }) },
              { label: "Move down", onSelect: () => void moveSection(week, 1).then((ok) => { if (!ok) showToast("Already the last section."); }) },
              { label: "Delete section", danger: true, onSelect: () => void deleteSection(week, module.id) },
            ]} />
          </div>
        )}
      </div>

      <div className="week-card-body">
        <div className="week-card-meta">
          <span className="week-code week-card-code">{code}</span>
          {!isSec && (
            <span className="week-card-dates">{weekDatesText(week.term, week.number, dates)}</span>
          )}
        </div>

        {renaming ? (
          <input
            className="title-input section-name"
            type="text"
            defaultValue={week.title ?? ""}
            autoFocus
            placeholder={`Section ${week.number}`}
            aria-label="Section name"
            enterKeyHint="done"
            onBlur={(e) => {
              onEndRename();
              void update("weeks", week.id, { title: e.target.value.trim() || null });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") onEndRename();
            }}
          />
        ) : (
          <Link to={{ view: "week", id: week.id }} className="week-title week-card-title-link">
            {isSec ? (
              week.title || `Section ${week.number}`
            ) : (
              week.title || (week.is_reading_week ? <span className="reading-weeks week-card-title-reading-week">Reading week</span> : code)
            )}
          </Link>
        )}

        {!week.is_reading_week && sessions.length > 0 && (
          <div className="week-card-sessions week-head">
            {sessions.map(({ session, hasNotes }) => (
              <Link
                key={session.id}
                to={{ view: "session", id: session.id }}
                className={`session-link week-card-session-link${hasNotes ? " has-notes" : ""}`}
                title={`Notes for the ${(session.title || sessionLabel(session.kind)).toLowerCase()}`}
              >
                {session.title || sessionLabel(session.kind)}
              </Link>
            ))}
          </div>
        )}

        {summary && (
          <div className="week-card-footer">
            <span className="count week-card-count">{summary}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function KeyDates({ module }: { module: ModuleRow }) {
  const dates = module.key_dates ?? [];
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState("");
  const [date, setDate] = useState("");
  const add = async () => {
    if (saving || !label.trim() || !date) return;
    setSaving(true);
    try {
      await saveKeyDates(module, [...dates, { id: newId(), label: label.trim(), date }]);
      setLabel(""); setDate(""); setAdding(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="key-dates section" aria-label="Key dates">
      <div className="section-head">
        <h2>Key dates</h2>
        <span className="spacer" />
        {!adding && <button className="quiet" onClick={() => setAdding(true)}>Add a date</button>}
      </div>
      {dates.length === 0 && !adding && <p className="small muted">The proposal, chapter drafts, the submission. Each counts down on the home page.</p>}
      <ul className="key-date-list">
        {dates.map((d) => (
          <li key={d.id}>
            <span className="kd-label">{d.label}</span>
            <span className={`kd-when ${countdown(d.date).state}`}>{shortDate(new Date(`${d.date}T00:00:00`), { year: true })}, {countdown(d.date).words}</span>
            <button className="quiet small" aria-label={`Remove ${d.label}`} onClick={() => void saveKeyDates(module, dates.filter((x) => x.id !== d.id))}>Remove</button>
          </li>
        ))}
      </ul>
      {adding && (
        <div className="row key-date-add">
          <label className="field" style={{ flex: 1 }}><span>What</span>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Chapter 2 draft" autoFocus enterKeyHint="next" />
          </label>
          <label className="field"><span>When</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <button className="button primary" disabled={saving || !label.trim() || !date} onClick={() => void add()}>{saving ? "Adding…" : "Add"}</button>
          <button className="quiet" disabled={saving} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
    </section>
  );
}

export function ModulePage({ id }: { id: string }) {
  const now = useTeachingWeek();
  const dates = useTermDates();
  const data = useLiveQuery(() => loadModuleOverview(id, now), [id, now]);
  const [editing, setEditing] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const scrolledRef = useRef(false);
  useTitle(data?.module.code);

  useEffect(() => {
    if (data && !scrolledRef.current) {
      scrolledRef.current = true;
      const targetWeek =
        data.weeks.find((w) => w.isCurrentWeek)?.week ??
        (data.module.last_opened_week_id
          ? data.weeks.find((w) => w.week.id === data.module.last_opened_week_id)?.week
          : null);
      if (targetWeek) {
        const code = weekCode(targetWeek);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        setTimeout(() => {
          document.getElementById(`week-${code}`)?.scrollIntoView({
            behavior: reduce ? "auto" : "smooth",
            block: "nearest",
          });
        }, 80);
      }
    }
  }, [data]);

  if (data === undefined) return null;
  if (data === null) return <div className="page"><p className="muted">This module no longer exists.</p></div>;

  const { module, weeks, tray, found, empty } = data;
  const dissertation = isDissertation(module);

  return (
    <div className="page">
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h1>{module.code}</h1>
        <span className="spacer" />
        {found.length > 0 && (
          <button className="found" onClick={() => setReviewing(true)}>
            Details found for {found.length} {found.length === 1 ? "reading" : "readings"}
          </button>
        )}
        <button className="quiet" aria-pressed={editing} onClick={() => setEditing(!editing)}>Edit module</button>
        <Link to={{ view: "import", id: module.id }} className={`button${empty ? " primary" : ""}`}>Import readings</Link>
      </div>
      {module.title && <p className="lede">{module.title}</p>}
      {reviewing && found.length > 0 && <CitationReview views={found} onClose={() => setReviewing(false)} />}
      {editing && <ModuleSettings module={module} weeks={weeks.map((w) => w.week)} onClose={() => setEditing(false)} />}
      {module.description && module.description.length > 0 && (
        <details className="section" style={{ marginTop: "1rem" }}>
          <summary className="small muted">About this module</summary>
          <BlockView blocks={module.description} />
        </details>
      )}

      {dissertation && <KeyDates module={module} />}
      {dissertation && (
        <div className="row" style={{ justifyContent: "flex-end", margin: "1rem 0" }}>
          <button
            className="button small"
            onClick={async () => {
              const newWeekId = await addSection(module.id);
              navigate({ view: "week", id: newWeekId });
            }}
          >
            Add a section
          </button>
        </div>
      )}

      {empty && !dissertation && (
        <div className="first-steps">
          <p><strong>Add this module's readings.</strong> <span className="touch-hide">Drop a folder of files anywhere on this page, or on a single week below. </span>Import readings lets you check them first.</p>
          <p className="small muted">Files named like "(AT3) Author, 'Title'" go to their weeks by themselves. The rest wait in Unsorted.</p>
        </div>
      )}

      {!dissertation && weeks.length > 0 && (
        <nav className="jump" aria-label="Weeks">
          {weeks.map((ov) => {
            const w = ov.week;
            const code = weekCode(w);
            const isThis = ov.isCurrentWeek;
            return (
              <button
                key={w.id}
                type="button"
                className={`small${w.is_reading_week ? " is-reading-week" : ""}${isThis ? " is-this-week" : ""}`}
                aria-current={isThis ? "date" : undefined}
                onClick={() => {
                  document.getElementById(`week-${code}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {code}
              </button>
            );
          })}
        </nav>
      )}

      <div className="week-grid">
        {weeks.map((ov) => (
          <WeekCard
            key={ov.week.id}
            overview={ov}
            module={module}
            dates={dates}
            renaming={renamingId === ov.week.id}
            onStartRename={() => setRenamingId(ov.week.id)}
            onEndRename={() => setRenamingId(null)}
          />
        ))}
      </div>

      {tray.length > 0 && <TraySection tray={tray} weeks={weeks.map((w) => w.week)} />}
    </div>
  );
}
