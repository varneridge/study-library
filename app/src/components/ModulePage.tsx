import { navigate } from "../lib/router";
import { shortDate } from "../lib/dates";
import { deleteSection } from "../lib/edits";
import { moveSection, addSection, isDissertation, saveKeyDates, countdown } from "../lib/sections";
import { Menu } from "./Menu";
import { useDragSensors } from "../lib/drag";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fullTitle } from "../lib/titles";
import { keepMine, pending, viaLabel } from "../lib/citations";
import { update, newId } from "../lib/sync";
import {
  DndContext, DragOverlay, pointerWithin, useDraggable, useDroppable,
  type DragEndEvent,
} from "@dnd-kit/core";
import { db } from "../lib/db";
import { applyPlans, planFile } from "../lib/importing";
import { moveToTray, moveToWeek } from "../lib/moves";
import { shortTitle } from "../lib/titles";
import { showToast, useCloseOnBack } from "../lib/ui";
import type { ReadingView } from "../lib/library";
import type { ModuleRow, WeekRow } from "../lib/types";
import { isThisWeek, useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { Link } from "../App";
import { loadModule, readCount, type WeekView } from "../lib/library";
import { sessionLabel, weekCode, isSection } from "../lib/modules";
import { BlockView } from "./BlockView";
import { Icon } from "./icons";
import { MoveSelect, ReadingRow } from "./ReadingRow";
import { ModuleSettings } from "./ModuleSettings";
import { useTitle } from "../lib/ui";

function progress(view: WeekView): string | null {
  const { read, total } = readCount([...view.readings, ...view.primaries]);
  if (total === 0) return null;
  if (read === 0) return `${total} ${total === 1 ? "reading" : "readings"}`;
  return `${read} of ${total} read`;
}

// What the week's sessions hold, in a few words. Empty sessions say nothing.
function sessionSummary(view: WeekView): string | null {
  const parts = view.sessions
    .map(({ session, slides, notes, recordings, questions }) => {
      const has = [
        notes.length && "notes",
        slides.length && "slides",
        recordings.length && "recording",
        questions.length && `${questions.length} ${questions.length === 1 ? "question" : "questions"}`,
      ].filter(Boolean) as string[];
      if (!has.length) return null;
      const list = has.length > 1 ? `${has.slice(0, -1).join(", ")} and ${has.at(-1)}` : has[0];
      return `${session.title || sessionLabel(session.kind)}: ${list}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(". ") + "." : null;
}

// Details found in PDFs, all in one place: tick the ones to use.
function CitationReview({ views, onClose }: { views: ReadingView[]; onClose: () => void }) {
  useCloseOnBack(true, onClose);
  const ref = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState(() => new Set(views.map((v) => v.item.id)));
  useEffect(() => { ref.current?.showModal(); }, []);
  const toggle = (id: string) => { const next = new Set(chosen); if (next.has(id)) next.delete(id); else next.add(id); setChosen(next); };
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
            if (chosen.has(v.item.id)) {
              const s = v.item.suggested!;
              await update("items", v.item.id, {
                work_kind: s.work_kind ?? null,
                author: s.author,
                editor: s.editor ?? null,
                year: s.year,
                title: s.title,
                source: s.source,
                publisher: s.publisher ?? null,
                volume: s.volume ?? null,
                issue: s.issue ?? null,
                pages: s.pages,
                doc_date: s.doc_date ?? null,
                doi: s.doi ?? null,
                suggested: {
                  ...s,
                  applied: true,
                  previous: {
                    work_kind: v.item.work_kind ?? null,
                    author: v.item.author,
                    editor: v.item.editor ?? null,
                    year: v.item.year,
                    title: v.item.title,
                    source: v.item.source,
                    publisher: v.item.publisher ?? null,
                    volume: v.item.volume ?? null,
                    issue: v.item.issue ?? null,
                    pages: v.item.pages,
                    doc_date: v.item.doc_date ?? null,
                    doi: v.item.doi ?? null,
                  },
                },
              });
            } else {
              await keepMine(v.item);
            }
          }
          showToast(`${chosen.size} ${chosen.size === 1 ? "reading" : "readings"} updated.`);
          onClose();
        }}>Use {chosen.size} of {views.length}</button>
      </div>
    </dialog>
  );
}

// A reading on the module page can be picked up and dropped on any week.
function Movable({ view, short, extra, weeks }: { view: ReadingView; short?: boolean; extra?: React.ReactNode; weeks?: WeekRow[] }) {
  const id = view.link ? `link:${view.link.id}` : `item:${view.item.id}`;
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({ id, data: { view } });
  return <ReadingRow view={view} short={short} extra={extra} weeks={weeks} drag={{ setNodeRef, attributes, listeners: listeners as never, dragging: isDragging }} />;
}

async function addFilesTo(files: File[], module: ModuleRow, week: WeekRow) {
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const count = await applyPlans(module, files.map((file) => planFile(file, weeks, week)));
  if (count) showToast(`${count} ${count === 1 ? "file" : "files"} added to ${weekCode(week)}. Uploading now.`);
}

// Readings with no week yet. While a reading is dragged, this is a place to drop it too.
function TraySection({ tray, weeks }: { tray: ReadingView[]; weeks: WeekRow[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: "tray" });
  return (
    <div ref={setNodeRef} className={`section tray${isOver ? " drag-over" : ""}`} style={{ marginTop: 0, marginBottom: "2rem" }}>
      <div className="section-head"><h2>Unsorted</h2></div>
      <ul className="readings">
        {tray.map((r) => (
          <Movable key={r.item.id} view={r} weeks={weeks} extra={<MoveSelect view={r} weeks={weeks} label="Choose a week" />} />
        ))}
      </ul>
    </div>
  );
}

// Floats at the foot of the screen while a reading is dragged, so the page
// itself never shifts under your pointer.
function Dock() {
  const { setNodeRef, isOver } = useDroppable({ id: "tray-dock" });
  return (
    <div className="move-dock" role="region" aria-label="Drop targets">
      <p className="small">Drop on any week to move it there, or</p>
      <span ref={setNodeRef} className={`target${isOver ? " over" : ""}`}>Unsorted</span>
    </div>
  );
}

function WeekBlock({ view, open, onToggle, module }: { view: WeekView; open: boolean; onToggle: () => void; module: ModuleRow }) {
  const now = useTeachingWeek();
  const dates = useTermDates();
  const { week } = view;
  const { setNodeRef, isOver } = useDroppable({ id: `week:${week.id}` });
  const [fileOver, setFileOver] = useState(false);
  const summary = progress(view);
  const sessions = sessionSummary(view);
  const hasBody = view.readings.length > 0 || view.primaries.length > 0 || Boolean(sessions);
  const [renaming, setRenaming] = useState(false);
  return (
    <div
      ref={setNodeRef}
      className={`week${isOver ? " drag-over" : ""}${fileOver ? " drop-over" : ""}${isThisWeek(view.week, now) ? " this-week" : ""}`}
      id={`week-${week.term}${week.number}`}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setFileOver(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileOver(false); }}
      onDrop={(e) => {
        setFileOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void addFilesTo(Array.from(e.dataTransfer.files), module, week);
      }}
    >
      <div className="week-head">
        {hasBody ? (
          <button className="caret" aria-expanded={open} aria-label={open ? "Collapse week" : "Expand week"} onClick={onToggle}>
            <span className={`caret-icon${open ? " open" : ""}`}><Icon name="caret" size={16} /></span>
          </button>
        ) : (
          <span className="caret" aria-hidden="true" />
        )}
        {renaming ? (
          <input
            className="title-input section-name" type="text" defaultValue={week.title ?? ""} autoFocus placeholder={`Section ${week.number}`}
            aria-label="Section name" enterKeyHint="done"
            onBlur={(e) => { setRenaming(false); void update("weeks", week.id, { title: e.target.value.trim() || null }); }}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setRenaming(false); }}
          />
        ) : (
          <Link to={{ view: "week", id: week.id }} className="week-title">
            <span className="week-code">{weekCode(week)}</span>
            {isThisWeek(week, now) && <span className="this-week-tag" title={weekDatesText(week.term, week.number, dates)}>This week</span>}
            {!isSection(week) && (week.title || (week.is_reading_week ? <span className="reading-weeks">Reading week</span> : null))}
          </Link>
        )}
        {summary && <span className="count">{summary}</span>}
        {/* Each session's notes, one tap away from any week. */}
        {!week.is_reading_week && view.sessions.length > 0 && (
          <span className="week-sessions">
            {view.sessions.map(({ session, notes }) => (
              <Link key={session.id} to={{ view: "session", id: session.id }} className={`session-link${notes.length ? " has-notes" : ""}`}
                title={`Notes for the ${(session.title || sessionLabel(session.kind)).toLowerCase()}`}>
                {session.title || sessionLabel(session.kind)}
              </Link>
            ))}
          </span>
        )}
        {/* A section is named and ordered by you, so it can be renamed, moved and deleted. */}
        {isSection(week) && (
          <Menu label={`More actions for ${weekCode(week)}`} items={[
            { label: "Rename", onSelect: () => setRenaming(true) },
            { label: "Move up", onSelect: () => void moveSection(week, -1).then((ok) => { if (!ok) showToast("Already the first section."); }) },
            { label: "Move down", onSelect: () => void moveSection(week, 1).then((ok) => { if (!ok) showToast("Already the last section."); }) },
            { label: "Delete section", danger: true, onSelect: () => void deleteSection(week, module.id) },
          ]} />
        )}
      </div>
      {!open && sessions && <p className="week-gist small muted">{sessions}</p>}
      {open && hasBody && (
        <div className="week-body">
          {view.readings.length > 0 && (
            <ul className="readings">{view.readings.map((r) => <Movable key={r.item.id} view={r} short />)}</ul>
          )}
          {view.primaries.length > 0 && (
            <>
              <p className="group-label">Primary sources</p>
              <ul className="readings">{view.primaries.map((r) => <Movable key={r.item.id} view={r} />)}</ul>
            </>
          )}
          {sessions && <p className="small muted" style={{ margin: "0.6rem 0 0" }}>{sessions}</p>}
        </div>
      )}
    </div>
  );
}

export function ModulePage({ id }: { id: string }) {
  const data = useLiveQuery(() => loadModule(id), [id]);
  const now = useTeachingWeek();
  const dates = useTermDates();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [seeded, setSeeded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [dragging, setDragging] = useState<ReadingView | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const sensors = useDragSensors();
  useTitle(data?.module.code);

  useEffect(() => {
    if (data && !seeded) {
      const last = data.module.last_opened_week_id;
      if (last) setOpen(new Set([last]));
      setSeeded(true);
      if (last) {
        const week = data.weeks.find((w) => w.week.id === last)?.week;
        if (week) setTimeout(() => document.getElementById(`week-${weekCode(week)}`)?.scrollIntoView({ block: "start" }), 50);
      }
    }
  }, [data, seeded]);

  useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(".jump");
    if (!el) return;
    const update = () => {
      document.documentElement.style.setProperty("--jump-h", `${el.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);

  if (data === undefined) return null;
  if (data === null) return <div className="page"><p className="muted">This module no longer exists.</p></div>;

  const { module, weeks, tray } = data;

  const dissertation = isDissertation(module);
  const found = [...weeks.flatMap((w) => [...w.readings, ...w.primaries]), ...tray].filter((v) => pending(v.item));
  // A module with nothing in it yet makes importing its main action.
  const empty = !tray.length && weeks.every((w) => !w.readings.length && !w.primaries.length && !w.sessions.some((x) => x.slides.length));

  const toggle = (weekId: string) => {
    const next = new Set(open);
    if (next.has(weekId)) next.delete(weekId);
    else next.add(weekId);
    setOpen(next);
  };
  const jump = (view: WeekView) => {
    setOpen(new Set(open).add(view.week.id));
    setTimeout(() => document.getElementById(`week-${weekCode(view.week)}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  };

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
      {!dissertation && <div className="jump" role="navigation" aria-label="Jump to week">
        {weeks.map((view) => {
          const current = isThisWeek(view.week, now);
          const label = [view.week.title, view.week.is_reading_week ? "Reading week" : null, weekDatesText(view.week.term, view.week.number, dates), current ? "this week" : null].filter(Boolean).join(", ");
          return (
            <button
              key={view.week.id} onClick={() => jump(view)} title={label} aria-current={current ? "date" : undefined}
              className={[view.week.is_reading_week ? "is-reading-week" : "", current ? "is-this-week" : ""].filter(Boolean).join(" ") || undefined}
            >
              {weekCode(view.week)}
            </button>
          );
        })}
      </div>}
      {empty && !dissertation && (
        <div className="first-steps">
          <p><strong>Add this module's readings.</strong> <span className="touch-hide">Drop a folder of files anywhere on this page, or on a single week below. </span>Import readings lets you check them first.</p>
          <p className="small muted">Files named like "(AT3) Author, 'Title'" go to their weeks by themselves. The rest wait in Unsorted.</p>
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", margin: "-1rem 0 0.5rem" }}>
        {open.size < weeks.length ? (
          <button className="quiet small" onClick={() => setOpen(new Set(weeks.map((w) => w.week.id)))}>{dissertation ? "Open every section" : "Open every week"}</button>
        ) : (
          <button className="quiet small" onClick={() => setOpen(new Set())}>{dissertation ? "Close every section" : "Close every week"}</button>
        )}
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        onDragStart={(e) => setDragging((e.active.data.current as { view: ReadingView }).view)}
        onDragCancel={() => setDragging(null)}
        onDragEnd={(e: DragEndEvent) => {
          const view = (e.active.data.current as { view: ReadingView }).view;
          const over = e.over ? String(e.over.id) : null;
          setDragging(null);
          if ((over === "tray" || over === "tray-dock") && view.link) void moveToTray(view.item, view.link, module.id);
          if (over?.startsWith("week:")) {
            const target = weeks.find((w) => w.week.id === over.slice(5))?.week;
            if (target) void moveToWeek(view.item, view.link, target);
          }
        }}
      >
        {tray.length > 0 && <TraySection tray={tray} weeks={weeks.map((w) => w.week)} />}
        {dragging?.link && <Dock />}

        <div style={{ borderTop: "1px solid var(--rule)" }}>
          {weeks.map((view) => (
            <WeekBlock key={view.week.id} view={view} module={module} open={open.has(view.week.id)} onToggle={() => toggle(view.week.id)} />
          ))}
        </div>
        {dissertation && (
          <p className="section">
            <button className="button" onClick={async () => { const id = await addSection(module.id); navigate({ view: "week", id }); }}>Add a section</button>
            <span className="small muted" style={{ marginLeft: "0.75rem" }}>A chapter, a set of sources, supervision: whatever you organise by.</span>
          </p>
        )}
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
          {dragging ? <div className="drag-card">{shortTitle(dragging.item)}<span className="where">Drop on a week</span></div> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

// A dissertation's key dates, such as the proposal, chapter drafts and the
// submission. Each counts down on the home page as job deadlines do.
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
