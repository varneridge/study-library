import { db } from "../lib/db";
import { deleteSessionAsking } from "../lib/edits";
import { addSlides, SLIDES_ACCEPT } from "../lib/importing";
import { byPosition } from "../lib/keys";
import { byWeek, SESSION_KINDS, titleAfter } from "../lib/modules";
import { update } from "../lib/sync";
import type { SessionRow, WeekRow } from "../lib/types";
import { NotesLoading } from "./ErrorBoundary";
import { WeekWhen } from "./WeekPage";
import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "../App";
import { loadSession } from "../lib/library";
import { sessionLabel, weekCode } from "../lib/modules";
import { activeSession, clock, pauseRecording, resumeRecording, startRecording, stopRecording, useRecorder } from "../lib/recorder";
import { navigate } from "../lib/router";
import { insert, newId } from "../lib/sync";
import { mimeFor, queueUpload } from "../lib/uploads";
import { ImportedPanel, RecordingPanel } from "./Recording";
import { Menu } from "./Menu";
import { importTranscript } from "../lib/transcriptImport";
import { showToast } from "../lib/ui";
import { noteSessionOpened } from "../lib/settings";
import { QuestionList } from "./QuestionList";
import { ReadingRow } from "./ReadingRow";
import { useNarrow, useTitle } from "../lib/ui";

const NoteEditor = lazy(() => import("./NoteEditor"));
// Slides need pdf.js, which loads only when a session has slides to show.
const SlideViewer = lazy(() => import("./SlideViewer").then((m) => ({ default: m.SlideViewer })));

// A fingerprint for large recordings. Hashing a whole lecture video would
// need it all in memory, so this samples the start and end with the size.
async function quickHash(file: File): Promise<string> {
  const size = 4 * 1024 * 1024;
  const head = await file.slice(0, size).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - size)).arrayBuffer();
  const meta = new TextEncoder().encode(`${file.size}:${file.name}:${file.lastModified}`);
  const joined = new Uint8Array(head.byteLength + tail.byteLength + meta.byteLength);
  joined.set(new Uint8Array(head), 0);
  joined.set(new Uint8Array(tail), head.byteLength);
  joined.set(meta, head.byteLength + tail.byteLength);
  const digest = await crypto.subtle.digest("SHA-256", joined);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function addRecordingFile(sessionId: string, file: File) {
  const mime = mimeFor(file) ?? (file.type || "");
  if (!/^(audio|video)\//.test(mime)) throw new Error("Choose an audio or video file.");
  const recordingId = newId();
  await insert("recordings", {
    id: recordingId, session_id: sessionId, source: "upload", file_id: null, duration_seconds: null,
    status: "uploading",
  });
  await queueUpload({
    file_id: newId(), item_id: "", recording_id: recordingId, name: file.name, mime,
    sha256: await quickHash(file), bytes: file.size, blob: file,
  });
}

export function SessionPage({ id, t, turn }: { id: string; t?: number; turn?: number }) {
  // Remembered as opened, so the home page can offer it again.
  useEffect(() => { void noteSessionOpened(id); }, [id]);
  const data = useLiveQuery(() => loadSession(id), [id]);
  const recorder = useRecorder(id);
  const [error, setError] = useState<string | null>(null);
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const picker = useRef<HTMLInputElement>(null);
  const transcriptPicker = useRef<HTMLInputElement>(null);
  const narrow = useNarrow();
  const slidesPicker = useRef<HTMLInputElement>(null);
  // The module's weeks, so the rows here offer the same menu as on a week page.
  const moduleWeeks = useLiveQuery(async () => {
    const session = await db.sessions.get(id);
    const week = session ? await db.weeks.get(session.week_id) : undefined;
    return week ? (await db.weeks.where("module_id").equals(week.module_id).toArray()).filter((w) => !w.deleted).sort(byWeek) : [];
  }, [id], [] as WeekRow[]);
  const [renaming, setRenaming] = useState(false);
  // The sessions either side of this one, in the module's order, for moving
  // on without going back to the week.
  const around = useLiveQuery(async () => {
    const session = await db.sessions.get(id);
    const week = session ? await db.weeks.get(session.week_id) : undefined;
    if (!session || !week) return null;
    const weeks = (await db.weeks.where("module_id").equals(week.module_id).toArray()).filter((w) => !w.deleted).sort(byWeek);
    const order: { session: SessionRow; week: WeekRow }[] = [];
    for (const w of weeks) {
      const list = (await db.sessions.where("week_id").equals(w.id).toArray()).filter((x) => !x.deleted).sort(byPosition);
      for (const x of list) order.push({ session: x, week: w });
    }
    const at = order.findIndex((o) => o.session.id === id);
    return { previous: order[at - 1] ?? null, next: order[at + 1] ?? null };
  }, [id]);
  useTitle(data ? `${data.module.code} ${weekCode(data.week)} ${data.session.title || sessionLabel(data.session.kind)}` : undefined);

  const register = useCallback((recordingId: string, audio: HTMLAudioElement | null) => {
    if (audio) audios.current.set(recordingId, audio);
    else audios.current.delete(recordingId);
  }, []);

  const play = useCallback((recordingId: string, offset: number) => {
    const audio = audios.current.get(recordingId);
    if (!audio) {
      setError("This recording is not ready to play yet.");
      return;
    }
    audio.currentTime = Math.max(0, offset - 2);
    void audio.play();
    audio.scrollIntoView({ block: "nearest" });
  }, []);

  if (data === undefined) return null;
  if (data === null) return <div className="page"><p className="muted">This session no longer exists.</p></div>;
  const { module, week, session, view, audio, readings } = data;
  const label = session.title || sessionLabel(session.kind);
  const name = (o: { session: SessionRow; week: WeekRow }) => `${weekCode(o.week)} ${o.session.title || sessionLabel(o.session.kind)}`;
  const saveName = (value: string) => {
    setRenaming(false);
    if (value.trim() !== (session.title ?? "")) void update("sessions", session.id, { title: value.trim() || null });
  };
  // What its row on the week page offers, here as well.
  const sessionMenu = [
    { label: "Add slides", onSelect: () => slidesPicker.current?.click(), hidden: !narrow },
    { label: "Add a Moodle transcript", onSelect: () => transcriptPicker.current?.click(), hidden: !narrow },
    { label: "Add a recording file", onSelect: () => picker.current?.click(), hidden: !narrow },
    { label: "Rename", onSelect: () => setRenaming(true) },
    ...SESSION_KINDS.filter((k) => k.value !== session.kind && session.kind !== "supervision").map((k) => ({
      label: `Make this a ${k.label.toLowerCase()}`, onSelect: () => void update("sessions", session.id, { kind: k.value }),
    })),
    { label: "Delete session", danger: true, onSelect: async () => {
      if (await deleteSessionAsking(session, label)) navigate({ view: "week", id: week.id });
    } },
  ];
  const latest = view.recordings[view.recordings.length - 1];

  async function toggle() {
    setError(null);
    try {
      if (recorder.recording) await stopRecording();
      else await startRecording(id);
    } catch (e) {
      setError(e instanceof Error && e.name === "NotAllowedError"
        ? "Microphone access was refused. Allow it in the browser to record."
        : (e as Error).message);
    }
  }

  return (
    <div className="page wide session-page">
      <div className="crumbs">
        <Link to={{ view: "module", id: module.id }}>{module.code}</Link> <span aria-hidden="true">/</span>{" "}
        <Link to={{ view: "week", id: week.id }}>{weekCode(week)}{titleAfter(week)}</Link>
        <WeekWhen week={week} />
      </div>
      <div className="section-head" style={{ alignItems: "center", flexWrap: "wrap" }}>
        {renaming ? (
          <input
            className="title-input" type="text" defaultValue={session.title ?? ""} autoFocus placeholder={sessionLabel(session.kind)}
            aria-label="Session name" enterKeyHint="done"
            onBlur={(e) => saveName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveName(e.currentTarget.value); if (e.key === "Escape") setRenaming(false); }}
          />
        ) : (
          <h1
            className="editable"
            tabIndex={0}
            title="Click to rename this session"
            onClick={() => setRenaming(true)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setRenaming(true); } }}
          >
            {label}
          </h1>
        )}
        <span className="spacer" />
        {recorder.recording ? (
          <>
            <span className={`rec-dot${recorder.paused ? " paused" : ""}`} aria-hidden="true" />
            <span className="rec-time">{recorder.paused ? "Paused " : ""}{clock(recorder.elapsed)}</span>
            {recorder.problem && (
              <span className="small problem" role="status">No sound for 30 seconds. Check the microphone is on and chosen in the browser.</span>
            )}
            <button className="button" onClick={() => (recorder.paused ? resumeRecording() : pauseRecording())}>{recorder.paused ? "Resume" : "Pause"}</button>
            <button className="button stop" onClick={toggle}>Stop recording</button>
          </>
        ) : recorder.elsewhere ? (
          <button className="link small" onClick={() => { const other = activeSession(); if (other) navigate({ view: "session", id: other }); }}>
            Recording in another session. Go to it
          </button>
        ) : (
          <>
            {/* On a phone the quieter actions go in the session's menu, beside Record. */}
            {!narrow && (
              <>
                <button className="quiet" onClick={() => slidesPicker.current?.click()} title="A PDF or PowerPoint, or photos of the slides">Add slides</button>
                <button className="quiet" onClick={() => transcriptPicker.current?.click()} title="The .txt or .vtt file Moodle offers with a recording">Add a Moodle transcript</button>
                <button className="quiet" onClick={() => picker.current?.click()}>Add a recording file</button>
              </>
            )}
            <button className="button primary" onClick={toggle}>Record</button>
          </>
        )}
        <Menu label={`More actions for this ${label.toLowerCase()}`} items={sessionMenu} />
        <input
          ref={slidesPicker} type="file" multiple hidden accept={SLIDES_ACCEPT}
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            const added = await addSlides(session.id, files);
            if (added) showToast(added === 1 ? "Slides added." : `${added} sets of slides added.`);
          }}
        />
        <input
          ref={transcriptPicker} type="file" hidden accept=".txt,.vtt,.srt,text/plain,text/vtt"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              const turns = await importTranscript(id, file);
              showToast(`Transcript added: ${turns} turns.`);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
        <input
          ref={picker} type="file" hidden accept="audio/*,video/*,.mp4,.m4a,.mp3,.mov,.webm"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              await addRecordingFile(id, file);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      </div>
      {error && <p className="small problem">{error}</p>}
      {recorder.recording && (
        <p className="small muted rec-hint">You can leave this page while it records. A bar at the foot of the screen keeps the recording in view, wherever you go.</p>
      )}

      <div className={`session-grid${view.slides.length ? " with-slides" : readings.length ? " with-side" : ""}`}>
        <div className="session-notes">
          <Suspense fallback={<NotesLoading />}>
            <NoteEditor target={{ session_id: id }} label={`${sessionLabel(view.session.kind)} notes`} />
          </Suspense>
        </div>
        {(view.slides.length > 0 || readings.length > 0) && (
          <div className="session-side">
            {readings.length > 0 && (
              <section className="side-readings">
                <h2 className="group-label">This week&rsquo;s readings</h2>
                <ul className="readings">{readings.map((r) => <ReadingRow key={r.item.id} view={r} weeks={moduleWeeks} short />)}</ul>
              </section>
            )}
            {view.slides.length > 0 && (
              <section className="side-readings">
                <h2 className="group-label">Slides</h2>
                <ul className="readings">{view.slides.map((r) => <ReadingRow key={r.item.id} view={r} weeks={moduleWeeks} short />)}</ul>
              </section>
            )}
            {/* The slides come last, so nothing sits below them to pass under while they stay in view. */}
            {view.slides.length > 0 && <Suspense fallback={<div className="slide-loading" aria-busy="true" />}><SlideViewer decks={view.slides} /></Suspense>}
          </div>
        )}
      </div>

      {(view.session.kind !== "lecture" || view.questions.length > 0) && (
        <section className="section">
          <div className="section-head">
            <h2>{view.session.kind === "lecture" ? "Questions" : "Seminar questions"}</h2>
            <span className="spacer" />
            <span className="small muted questions-hint">Enter for the next question. Alt and an arrow to move one.</span>
          </div>
          <QuestionList sessionId={view.session.id} questions={view.questions} always />
        </section>
      )}

      {view.recordings.map((recording) => recording.turns && !recording.file_id ? (
        <ImportedPanel key={recording.id} recording={recording} title={`${module.code} ${weekCode(week)} ${label}`} focusTurn={turn} />
      ) : (
        <RecordingPanel
          key={recording.id}
          recording={recording}
          file={audio.get(recording.id)}
          register={register}
          focusTurn={turn}
          startAt={recording.id === latest?.id ? t : undefined}
          title={`${module.code} ${weekCode(week)} ${label}`}
        />
      ))}

      {/* On to the session before or after, as a week page goes to the next week. */}
      {around && (around.previous || around.next) && (
        <nav className="week-nav" aria-label="Other sessions">
          {around.previous ? <Link to={{ view: "session", id: around.previous.session.id }}>← {name(around.previous)}</Link> : <span />}
          {around.next ? <Link to={{ view: "session", id: around.next.session.id }}>{name(around.next)} →</Link> : <span />}
        </nav>
      )}
    </div>
  );
}
