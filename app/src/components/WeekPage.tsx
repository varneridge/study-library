import { NotesLoading } from "./ErrorBoundary";
import { addMeeting, moveSection } from "../lib/sections";
import { combinePhotos, READING_ACCEPT } from "../lib/photos";
import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "../App";
import { db } from "../lib/db";
import { prefetch } from "../lib/files";
import { applyPlans, planFile, addSlides, SLIDES_ACCEPT } from "../lib/importing";
import { byPosition, keyBetween, keysAfter } from "../lib/keys";
import { clock } from "../lib/recorder";
import { loadWeekPage, type ReadingView } from "../lib/library";
import { sessionLabel, weekCode, SESSION_KINDS, titleAfter, isSection } from "../lib/modules";
import { commit, newId, update } from "../lib/sync";
import type { FileRow, ModuleRow, RecordingRow, SessionRow, WeekRow } from "../lib/types";
import { recordingState } from "./Recording";
import { Menu } from "./Menu";
import { QuestionList } from "./QuestionList";
import { addSession, deleteSession, moveSession, sessionHasContent, setReadingWeek, withUndo, deleteSessionAsking, deleteSection } from "../lib/edits";
import { navigate } from "../lib/router";
import { confirmAction, showToast, typing, useNarrow, useTitle, useSwipe } from "../lib/ui";
import type { SessionView } from "../lib/library";
import type { SessionKind } from "../lib/types";
import { isThisWeek, useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { BlockView } from "./BlockView";
import { Icon } from "./icons";
import { WeekBoard } from "./WeekBoard";
import { SessionSlides, SlideBoard } from "./SlideBoard";
import { importTranscript, isTranscriptFile } from "../lib/transcriptImport";

// When a week runs, and whether that is now, beside the crumbs.
export function WeekWhen({ week }: { week: WeekRow }) {
  const dates = useTermDates();
  const now = useTeachingWeek();
  const text = weekDatesText(week.term, week.number, dates);
  if (!text) return null;
  return (
    <span className="week-when">
      {text}
      {isThisWeek(week, now) && <span className="this-week-tag">This week</span>}
    </span>
  );
}

function TitleEditor({ week, editing, setEditing }: { week: WeekRow; editing: boolean; setEditing: (on: boolean) => void }) {
  const [value, setValue] = useState(week.title ?? "");
  useEffect(() => setValue(week.title ?? ""), [week.title, editing]);
  if (!editing && isSection(week)) {
    return (
      <h1
        className="editable"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
        title="Click to rename this section"
      >
        {weekCode(week)}
      </h1>
    );
  }
  if (!editing) {
    return (
      <h1
        className="editable"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
        title="Click to rename this week"
      >
        {week.title ? <><span className="week-code-inline">{weekCode(week)}</span>{" "}{week.title}</> : week.is_reading_week ? `${weekCode(week)} reading week` : weekCode(week)}
      </h1>
    );
  }
  const save = () => {
    setEditing(false);
    if (value.trim() !== (week.title ?? "")) void update("weeks", week.id, { title: value.trim() || null });
  };
  return (
    <input
      type="text" value={value} autoFocus aria-label={isSection(week) ? "Section name" : "Week title"}
      placeholder={isSection(week) ? `Section ${week.number}` : `A title for ${weekCode(week)}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
      style={{ fontFamily: "var(--serif)", fontSize: "var(--fs-2xl)", fontWeight: 600 }}
    />
  );
}

function recordingLine(recording: RecordingRow): string {
  const state = recordingState(recording);
  if (state) return state;
  if (recording.status === "failed") return "Recording could not be processed";
  return recording.duration_seconds ? `Recording, ${clock(recording.duration_seconds)}` : "Recording";
}

// Where dropped files go depends on where they land: on a session they
// become its slides, on primary sources they become primary sources, and
// anywhere else they are readings, unless their names say otherwise.
export interface FileTarget { kind: "readings" | "primary" | "slides"; sessionId?: string; label: string }

async function addFiles(added: File[], module: ModuleRow, week: WeekRow, target?: FileTarget) {
  // Pictures added together become one reading, a page each.
  let files: File[];
  try { files = await combinePhotos(added); } catch (error) { showToast((error as Error).message); return; }
  // Moodle transcripts go to the session they were dropped on, or the
  // week's first lecture when dropped elsewhere.
  const texts = files.filter(isTranscriptFile);
  if (texts.length) {
    const sessions = (await db.sessions.where("week_id").equals(week.id).toArray()).filter((s) => !s.deleted).sort(byPosition);
    const session = sessions.find((s) => s.id === target?.sessionId) ?? sessions.find((s) => s.kind !== "seminar") ?? sessions[0];
    if (!session) showToast("This week has no session to add a transcript to.");
    else {
      for (const file of texts) {
        try { await importTranscript(session.id, file); } catch (error) { showToast((error as Error).message); return; }
      }
      showToast(`Transcript added to the ${session.title || sessionLabel(session.kind).toLowerCase()}.`);
    }
    files = files.filter((f) => !isTranscriptFile(f));
    if (!files.length) return;
  }
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const plans = files.map((file) => {
    const plan = planFile(file, weeks, week);
    if (target?.kind === "slides") return { ...plan, kind: "slides" as const, sessionId: target.sessionId ?? null };
    if (target?.kind === "primary" && plan.kind !== "skip") return { ...plan, kind: "primary" as const };
    return plan;
  });
  const count = await applyPlans(module, plans);
  if (count) showToast(`${count} ${count === 1 ? "file" : "files"} added to ${weekCode(week)}${target?.kind === "slides" ? `, ${target.label}` : ""}. Uploading now.`);
}

function targetOf(element: Element | null, week: WeekRow): FileTarget {
  const zone = element?.closest("[data-drop]") as HTMLElement | null;
  if (zone?.dataset.drop === "slides") return { kind: "slides", sessionId: zone.dataset.session, label: zone.dataset.label ?? "slides" };
  if (zone?.dataset.drop === "primary") return { kind: "primary", label: "primary sources" };
  return { kind: "readings", label: weekCode(week) };
}

const KINDS = SESSION_KINDS;
const NoteEditor = lazy(() => import("./NoteEditor"));

function SessionBlock({
  view, index, count, weeks, onAddSlides, dropOver,
}: {
  view: SessionView; index: number; count: number; weeks: WeekRow[]; onAddSlides: (sessionId: string) => void; dropOver?: boolean;
}) {
  const { session, slides, notes, recordings, questions } = view;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(session.title ?? "");
  useEffect(() => setName(session.title ?? ""), [session.title]);
  const label = session.title || sessionLabel(session.kind);
  const narrow = useNarrow();

  const saveName = () => {
    setRenaming(false);
    if (name.trim() !== (session.title ?? "")) void update("sessions", session.id, { title: name.trim() || null });
  };

  const remove = () => void deleteSessionAsking(session, label);

  return (
    <section className={`session${dropOver ? " drop-over" : ""}`} data-drop="slides" data-session={session.id} data-label={label}>
      <div className="session-head">
        {renaming ? (
          <input
            type="text" value={name} autoFocus placeholder={sessionLabel(session.kind)}
            aria-label="Session name"
            onChange={(e) => setName(e.target.value)} onBlur={saveName}
            onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setName(session.title ?? ""); setRenaming(false); } }}
            style={{ flex: 1, fontFamily: "var(--serif)", fontWeight: 600 }}
          />
        ) : (
          // The one way into the session: its name, with its notes, slides and recordings behind it.
          <h2 className="session-title">
            <Link to={{ view: "session", id: session.id }} className="session-open" title="Notes, slides and recordings">
              {label}<span className="go" aria-hidden="true"><Icon name="caret" size={16} /></span>
            </Link>
          </h2>
        )}
        {!narrow && <button className="quiet" onClick={() => onAddSlides(session.id)}>Add slides</button>}
        <Menu
          label={`More actions for ${label}`}
          items={[
            { label: "Add slides", onSelect: () => onAddSlides(session.id), hidden: !narrow },
            { label: "Rename", onSelect: () => setRenaming(true) },
            ...KINDS.filter((k) => k.value !== session.kind && session.kind !== "supervision").map((k) => ({
              label: `Make this a ${k.label.toLowerCase()}`,
              onSelect: () => void update("sessions", session.id, { kind: k.value }),
            })),
            { label: "Move up", onSelect: () => void moveSession(session, -1), hidden: index === 0 },
            { label: "Move down", onSelect: () => void moveSession(session, 1), hidden: index === count - 1 },
            { label: "Delete session", onSelect: () => void remove(), danger: true },
          ]}
        />
      </div>
      <SessionSlides sessionId={session.id} fallback={slides} />
      {/* Questions are typed straight in, as on the session page. */}
      <QuestionList sessionId={session.id} questions={questions} always={session.kind !== "lecture"} />
      {recordings.map((r) => (
        <p key={r.id} className="small muted" style={{ margin: "0.5rem 0 0" }}>
          <Link to={{ view: "session", id: session.id }}>{recordingLine(r)}</Link>
        </p>
      ))}
      {notes.map(({ note, blocks }) => (
        // Long notes show their opening, with the rest a tap away.
        <div key={note.id} className={`notes-preview${blocks.length > 6 ? " clipped" : ""}`}>
          <BlockView blocks={blocks.length > 6 ? blocks.slice(0, 5) : blocks} />
          {blocks.length > 6 && (
            <Link to={{ view: "session", id: session.id }} className="notes-more">Read all {blocks.length} lines of notes</Link>
          )}
        </div>
      ))}
    </section>
  );
}

export function WeekPage({ id }: { id: string }) {
  const data = useLiveQuery(() => loadWeekPage(id), [id]);
  const weeks = useLiveQuery(async () => {
    if (!data) return [];
    return (await db.weeks.where("module_id").equals(data.module.id).toArray()).filter((w) => !w.deleted);
  }, [data?.module.id]);
  const [over, setOver] = useState<FileTarget | null>(null);
  const [renaming, setRenaming] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const sessionPicker = useRef<HTMLInputElement>(null);
  const prefetched = useRef<string | null>(null);

  useEffect(() => {
    if (!data) return;
    if (data.module.last_opened_week_id !== id) void update("modules", data.module.id, { last_opened_week_id: id });
    if (prefetched.current === id) return;
    prefetched.current = id;
    void (async () => {
      const ids = [data.view.week.id, data.next?.id].filter(Boolean) as string[];
      const links = (await db.week_items.where("week_id").anyOf(ids).toArray()).filter((l) => !l.deleted);
      const items = (await db.items.bulkGet(links.map((l) => l.item_id))).filter(Boolean);
      const files = (await db.files.bulkGet(items.map((i) => i!.file_id).filter(Boolean) as string[])).filter(Boolean) as FileRow[];
      await prefetch(files);
    })();
  }, [data, id]);

  useTitle(data ? `${data.module.code} ${weekCode(data.view.week)}` : undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" && data?.previous) navigate({ view: "week", id: data.previous.id });
      if (e.key === "]" && data?.next) navigate({ view: "week", id: data.next.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data?.previous, data?.next]);

  // On a phone, swipe left for the next week and right for the one before,
  // as the links at the foot of the page do.
  const nextId = data?.next?.id, previousId = data?.previous?.id;
  const goNext = useCallback(() => { if (nextId) navigate({ view: "week", id: nextId }); }, [nextId]);
  const goPrevious = useCallback(() => { if (previousId) navigate({ view: "week", id: previousId }); }, [previousId]);
  useSwipe(nextId ? goNext : null, previousId ? goPrevious : null);

  if (data === undefined) return null;
  if (data === null) return <div className="page"><p className="muted">This week no longer exists.</p></div>;
  const { module, view } = data;
  const section = isSection(view.week);
  const week = view.week;

  async function toggleReadingWeek() {
    const { kept } = await setReadingWeek(week, module, !week.is_reading_week);
    if (kept) showToast(`Marked as a reading week. ${kept === 1 ? "One session" : `${kept} sessions`} with notes or recordings stayed.`);
  }

  const onDrop = (event: React.DragEvent) => {
    setOver(null);
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void addFiles(Array.from(event.dataTransfer.files), module, week, targetOf(event.target as Element, week));
  };
  const overText = over
    ? over.kind === "slides" ? `Drop to add slides to ${over.label}`
      : over.kind === "primary" ? `Drop to add primary sources to ${weekCode(week)}`
        : `Drop to add readings to ${weekCode(week)}${titleAfter(week, ", ")}`
    : null;

  return (
    <div
      className={`page week-page dropzone${over ? " over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        const next = targetOf(e.target as Element, week);
        if (next.kind !== over?.kind || next.sessionId !== over?.sessionId) setOver(next);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
      onDrop={onDrop}
    >
      {overText && <div className="drop-banner" role="status">{overText}</div>}
      <div className="crumbs">
        <Link to={{ view: "module", id: module.id }}>{module.code}</Link> <span aria-hidden="true">/</span> {weekCode(week)}
        <WeekWhen week={week} />
      </div>
      <div className="section-head" style={{ marginBottom: 0, alignItems: "center" }}>
        <div style={{ flex: 1, minWidth: 0 }}><TitleEditor week={week} editing={renaming} setEditing={setRenaming} /></div>
        <button className="button" onClick={() => picker.current?.click()}>Add files</button>
        {section && (
          <button className="button" onClick={async () => navigate({ view: "session", id: await addMeeting(week.id) })}>Add a meeting</button>
        )}
        {section ? (
          <Menu
            label="More actions for this section"
            items={[
              { label: "Rename section", onSelect: () => setRenaming(true) },
              { label: "Move up", onSelect: () => void moveSection(week, -1).then((ok) => { if (!ok) showToast("Already the first section."); }) },
              { label: "Move down", onSelect: () => void moveSection(week, 1).then((ok) => { if (!ok) showToast("Already the last section."); }) },
              { label: "Delete section", danger: true, onSelect: async () => { await deleteSection(week, module.id); navigate({ view: "module", id: module.id }); } },
            ]}
          />
        ) : (
        <Menu
          label="More actions for this week"
          items={[
            { label: week.title ? "Rename week" : "Give the week a title", onSelect: () => setRenaming(true) },
            { label: week.is_reading_week ? "Make this a teaching week" : "Make this a reading week", onSelect: () => void toggleReadingWeek() },
            ...KINDS.map((k) => ({ label: `Add a ${k.label.toLowerCase()}`, onSelect: () => void addSession(week, k.value) })),
            { label: "Clear the week title", onSelect: () => void update("weeks", week.id, { title: null }), hidden: !week.title },
          ]}
        />
        )}
        <input
          ref={picker} type="file" multiple hidden accept={READING_ACCEPT}
          onChange={(e) => { if (e.target.files) void addFiles(Array.from(e.target.files), module, week); e.target.value = ""; }}
        />
      </div>

      <div data-drop="readings" className={over?.kind === "readings" || over?.kind === "primary" ? "drop-over-lists" : undefined}>
        <WeekBoard week={week} readings={view.readings} primaries={view.primaries} weeks={weeks ?? []} moduleId={module.id} />
        {over && !view.readings.length && !view.primaries.length && (
          <div className="section"><div className="readings empty-target file-target">Readings for {weekCode(week)}</div></div>
        )}
      </div>

      {/* A section's own notes: a chapter's plan, an argument, what to find. */}
      {section && (
        <section className="section section-notes">
          <h2 className="group-label">Notes</h2>
          <Suspense fallback={<NotesLoading />}>
            <NoteEditor target={{ week_id: week.id }} label={`Notes on ${weekCode(week)}`} placeholder="Notes on this section" />
          </Suspense>
        </section>
      )}

      <SlideBoard week={week} weeks={weeks ?? []} moduleId={module.id} sessions={view.sessions}>
      {view.sessions.map((sessionView, index) => (
        <SessionBlock
          key={sessionView.session.id}
          view={sessionView}
          index={index}
          count={view.sessions.length}
          dropOver={over?.kind === "slides" && over.sessionId === sessionView.session.id}
          weeks={weeks ?? []}
          onAddSlides={(sessionId) => {
            if (sessionPicker.current) {
              sessionPicker.current.dataset.session = sessionId;
              sessionPicker.current.click();
            }
          }}
        />
      ))}
      </SlideBoard>

      <nav className="week-nav" aria-label="Other weeks">
        {data.previous ? (
          <Link to={{ view: "week", id: data.previous.id }} title={section ? "Previous section (press [)" : "Previous week (press [)"}>← {weekCode(data.previous)}{titleAfter(data.previous)}</Link>
        ) : <span />}
        {data.next ? (
          <Link to={{ view: "week", id: data.next.id }} title={section ? "Next section (press ])" : "Next week (press ])"}>{weekCode(data.next)}{titleAfter(data.next)} →</Link>
        ) : <span />}
      </nav>
      <input
        ref={sessionPicker} type="file" multiple hidden accept={SLIDES_ACCEPT}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          const sessionId = e.target.dataset.session ?? null;
          e.target.value = "";
          if (sessionId) await addSlides(sessionId, files);
        }}
      />
    </div>
  );
}
