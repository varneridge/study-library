import { NotesLoading } from "./ErrorBoundary";
import { addMeeting, moveSection, isDissertation, isLibrary, isSyllabus, moduleHasNotes, moduleHasSessions, moduleHasMeetings } from "../lib/sections";
import { combinePhotos, READING_ACCEPT } from "../lib/photos";
import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../App";
import { db } from "../lib/db";
import { prefetch } from "../lib/files";
import { applyPlans, planFile, addSlides, SLIDES_ACCEPT } from "../lib/importing";
import { byPosition, keyBetween, keysAfter } from "../lib/keys";
import { clock } from "../lib/recorder";
import { loadWeekPage, type ReadingView } from "../lib/library";
import { sessionLabel, notesLabel, weekCode, SESSION_KINDS, titleAfter, isSection } from "../lib/modules";
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
import { blockText } from "../lib/notes";
import { ChoiceCard } from "./ChoiceCard";
import { Icon } from "./icons";
import { WeekBoard } from "./WeekBoard";
import { SessionSlides, SlideBoard } from "./SlideBoard";
import { uploadModulePicture } from "../lib/uploads";
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

import { KIND_GROUP } from "../lib/kinds";

function recordingLine(recording: RecordingRow): string {
  const state = recordingState(recording);
  if (state) return state;
  if (recording.status === "failed") return "Recording could not be processed";
  return recording.duration_seconds ? `Recording, ${clock(recording.duration_seconds)}` : "Recording";
}

// Where dropped files go depends on where they land: on a session they
// become its slides, on primary readings they become primary readings, on
// summaries they become summaries, and anywhere else they are secondary
// readings, unless their names say otherwise.
export interface FileTarget { kind: "auto" | "primary" | "secondary" | "summary" | "slides"; sessionId?: string; label: string }

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
  const docOnly = isSyllabus(week) || isLibrary(module);
  const effectiveTarget = target ?? (docOnly ? { kind: "summary" as const, label: "documents" } : undefined);
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const plans = files.map((file) => {
    const plan = planFile(file, weeks, week);
    const targetKind = effectiveTarget?.kind;
    if (targetKind === "slides") return { ...plan, kind: "slides" as const, sessionId: effectiveTarget?.sessionId ?? null };
    if (targetKind === "primary" && plan.kind !== "skip" && plan.kind !== "week-title") {
      return { ...plan, kind: "primary" as const, sessionId: null };
    }
    if (targetKind === "secondary" && plan.kind !== "skip" && plan.kind !== "week-title") {
      return { ...plan, kind: "secondary" as const, sessionId: null };
    }
    if (targetKind === "summary" && plan.kind !== "skip" && plan.kind !== "week-title") {
      return { ...plan, kind: "summary" as const, sessionId: null };
    }
    return plan;
  });
  const count = await applyPlans(module, plans);
  if (count) showToast(`${count} ${count === 1 ? "file" : "files"} added to ${weekCode(week)}${effectiveTarget?.kind === "slides" ? `, ${effectiveTarget.label}` : ""}. Uploading now.`);
}

function targetOf(element: Element | null, week: WeekRow, isDocumentOnly?: boolean): FileTarget {
  if (isDocumentOnly) return { kind: "summary", label: "documents" };
  const zone = element?.closest("[data-drop]") as HTMLElement | null;
  if (zone?.dataset.drop === "slides") return { kind: "slides", sessionId: zone.dataset.session, label: zone.dataset.label ?? "slides" };
  if (zone?.dataset.drop === "primary") return { kind: "primary", label: KIND_GROUP.primary.toLowerCase() };
  if (zone?.dataset.drop === "summary") return { kind: "summary", label: KIND_GROUP.summary.toLowerCase() };
  if (zone?.dataset.drop === "readings") return { kind: "secondary", label: KIND_GROUP.secondary.toLowerCase() };
  return { kind: "auto", label: weekCode(week) };
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
      <div className="session-notes-action">
        <Link
          to={{ view: "session", id: session.id }}
          className="button small"
        >
          <Icon name="notes" size={16} />
          <span>{notesLabel(session, notes.some((n) => n.blocks.some((b) => blockText(b).trim())))}</span>
        </Link>
      </div>
    </section>
  );
}

function SectionNotes({ weekId, code }: { weekId: string; code: string }) {
  const target = useMemo(() => ({ week_id: weekId }), [weekId]);
  return (
    <section id="section-notes" className="section section-notes">
      <h2 className="group-label">Notes</h2>
      <Suspense fallback={<NotesLoading />}>
        <NoteEditor target={target} label={`Notes on ${code}`} placeholder="Notes on this section" />
      </Suspense>
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
  const [addCardOpen, setAddCardOpen] = useState(false);
  const addFilesButton = useRef<HTMLButtonElement>(null);
  const addTargetRef = useRef<FileTarget | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const coverPicker = useRef<HTMLInputElement>(null);
  const sessionPicker = useRef<HTMLInputElement>(null);
  const prefetched = useRef<string | null>(null);

  const onPickCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !data) return;
    try {
      const key = await uploadModulePicture(file);
      await update("weeks", data.view.week.id, { image_key: key });
      showToast("Cover picture set.");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not upload cover picture.");
    }
  };

  const onRemoveCover = async () => {
    if (!data) return;
    await update("weeks", data.view.week.id, { image_key: null });
    showToast("Cover picture removed.");
  };

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
  const hasSectionNotes = (data.sectionNotes ?? []).some((n) => n.blocks.some((b) => blockText(b).trim()));
  const isDocumentOnly = isSyllabus(week) || isLibrary(module);

  async function toggleReadingWeek() {
    const { kept } = await setReadingWeek(week, module, !week.is_reading_week);
    if (kept) showToast(`Marked as a reading week. ${kept === 1 ? "One session" : `${kept} sessions`} with notes or recordings stayed.`);
  }

  const onDrop = (event: React.DragEvent) => {
    setOver(null);
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void addFiles(Array.from(event.dataTransfer.files), module, week, targetOf(event.target as Element, week, isDocumentOnly));
  };
  const overText = over
    ? isDocumentOnly
      ? `Drop to add documents to ${weekCode(week)}${titleAfter(week, ", ")}`
      : over.kind === "slides"
        ? `Drop to add slides to ${over.label}`
        : over.kind === "primary"
          ? `Drop to add primary readings to ${weekCode(week)}`
          : over.kind === "secondary"
            ? `Drop to add secondary readings to ${weekCode(week)}${titleAfter(week, ", ")}`
            : over.kind === "summary"
              ? `Drop to add summaries to ${weekCode(week)}`
              : `Drop to add files to ${weekCode(week)}${titleAfter(week, ", ")}`
    : null;

  return (
    <div
      className={`page week-page dropzone${over ? " over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        const next = targetOf(e.target as Element, week, isDocumentOnly);
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
        {isDocumentOnly ? (
          <button
            className="button"
            onClick={() => {
              addTargetRef.current = { kind: "summary", label: "documents" };
              picker.current?.click();
            }}
          >
            Add document
          </button>
        ) : (
          <>
            <button ref={addFilesButton} className="button" onClick={() => setAddCardOpen(true)}>Add files</button>
            <ChoiceCard
              open={addCardOpen}
              onClose={() => setAddCardOpen(false)}
              anchor={addFilesButton}
              label="Add files to this week"
              title="Add files as"
            >
              <div className="choice-list">
                <button
                  type="button"
                  className="choice-row"
                  onClick={() => {
                    setAddCardOpen(false);
                    addTargetRef.current = undefined;
                    picker.current?.click();
                  }}
                >
                  <span>As in the file names</span>
                </button>
                <button
                  type="button"
                  className="choice-row"
                  onClick={() => {
                    setAddCardOpen(false);
                    addTargetRef.current = { kind: "primary", label: "primary readings" };
                    picker.current?.click();
                  }}
                >
                  <span>{KIND_GROUP.primary}</span>
                </button>
                <button
                  type="button"
                  className="choice-row"
                  onClick={() => {
                    setAddCardOpen(false);
                    addTargetRef.current = { kind: "secondary", label: "secondary readings" };
                    picker.current?.click();
                  }}
                >
                  <span>{KIND_GROUP.secondary}</span>
                </button>
                <button
                  type="button"
                  className="choice-row"
                  onClick={() => {
                    setAddCardOpen(false);
                    addTargetRef.current = { kind: "summary", label: "course materials" };
                    picker.current?.click();
                  }}
                >
                  <span>{KIND_GROUP.summary}</span>
                </button>
              </div>
            </ChoiceCard>
          </>
        )}
        {section && moduleHasMeetings(module) && (
          <button className="button" onClick={async () => navigate({ view: "session", id: await addMeeting(week.id) })}>Add a meeting</button>
        )}
        {section ? (
          <Menu
            label={isLibrary(module) ? "More actions for this shelf" : "More actions for this section"}
            items={[
              { label: isLibrary(module) ? "Rename shelf" : "Rename section", onSelect: () => setRenaming(true) },
              { label: "Set cover picture", onSelect: () => coverPicker.current?.click() },
              { label: "Remove cover picture", onSelect: onRemoveCover, hidden: !week.image_key },
              { label: "Move up", onSelect: () => void moveSection(week, -1).then((ok) => { if (!ok) showToast(isLibrary(module) ? "Already the first shelf." : "Already the first section."); }) },
              { label: "Move down", onSelect: () => void moveSection(week, 1).then((ok) => { if (!ok) showToast(isLibrary(module) ? "Already the last shelf." : "Already the last section."); }) },
              { label: isLibrary(module) ? "Delete shelf" : "Delete section", danger: true, onSelect: async () => { await deleteSection(week, module.id); navigate({ view: "module", id: module.id }); } },
            ]}
          />
        ) : (
        <Menu
          label="More actions for this week"
          items={[
            { label: week.title ? "Rename week" : "Give the week a title", onSelect: () => setRenaming(true) },
            { label: "Set cover picture", onSelect: () => coverPicker.current?.click() },
            { label: "Remove cover picture", onSelect: onRemoveCover, hidden: !week.image_key },
            { label: week.is_reading_week ? "Make this a teaching week" : "Make this a reading week", onSelect: () => void toggleReadingWeek() },
            ...(moduleHasSessions(module) ? KINDS.map((k) => ({ label: `Add a ${k.label.toLowerCase()}`, onSelect: () => void addSession(week, k.value) })) : []),
            { label: "Clear the week title", onSelect: () => void update("weeks", week.id, { title: null }), hidden: !week.title },
          ]}
        />
        )}
        <input ref={coverPicker} type="file" hidden accept="image/*" onChange={onPickCover} />
        <input
          ref={picker} type="file" multiple hidden accept={READING_ACCEPT}
          onChange={(e) => {
            const target = addTargetRef.current;
            addTargetRef.current = undefined;
            if (e.target.files) void addFiles(Array.from(e.target.files), module, week, target);
            e.target.value = "";
          }}
        />
      </div>

      {/* Prominent notes buttons above readings */}
      {(view.sessions.length > 0 || section) && moduleHasNotes(module) && (
        <div className="week-notes-bar" role="navigation" aria-label="Notes">
          {view.sessions.map((s) => {
            const has = s.notes.some((n) => n.blocks.some((b) => blockText(b).trim()));
            return (
              <Link
                key={s.session.id}
                to={{ view: "session", id: s.session.id }}
                className={`button week-note-btn${has ? " has-notes" : " empty"}`}
              >
                <Icon name="notes" size={16} />
                <span>{notesLabel(s.session, has)}</span>
              </Link>
            );
          })}
          {section && (
            <a href="#section-notes" className={`button week-note-btn${hasSectionNotes ? " has-notes" : " empty"}`}>
              <Icon name="notes" size={16} />
              <span>{hasSectionNotes ? "Section notes" : "Add section notes"}</span>
            </a>
          )}
        </div>
      )}

      <div data-drop="readings" className={over?.kind === "secondary" || over?.kind === "primary" || over?.kind === "summary" || over?.kind === "auto" ? "drop-over-lists" : undefined}>
        <WeekBoard
          week={week}
          primaries={view.primaries}
          readings={view.readings}
          summaries={view.summaries}
          weeks={weeks ?? []}
          moduleId={module.id}
          isLibrary={isLibrary(module)}
          isSyllabus={isSyllabus(week)}
        />
        {over && !view.readings.length && !view.primaries.length && !view.summaries?.length && (
          <div className="section"><div className="readings empty-target file-target">{isDocumentOnly ? `Documents for ${weekCode(week)}` : `Readings for ${weekCode(week)}`}</div></div>
        )}
      </div>

      {/* A section's own notes: a chapter's plan, an argument, what to find. */}
      {section && moduleHasNotes(module) && <SectionNotes weekId={week.id} code={weekCode(week)} />}

      {moduleHasSessions(module) && (
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
      )}

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
