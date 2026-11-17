import { db } from "../lib/db";
import { deleteSessionAsking } from "../lib/edits";
import { addSlides, SLIDES_ACCEPT } from "../lib/importing";
import { byPosition } from "../lib/keys";
import { byWeek, SESSION_KINDS } from "../lib/modules";
import { update } from "../lib/sync";
import type { SessionRow, WeekRow } from "../lib/types";
import { NotesLoading } from "./ErrorBoundary";
import { WeekWhen } from "./WeekPage";
import { useLiveQuery, useSuspendingLiveQuery } from "dexie-react-hooks";
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
import { noteSessionOpened } from "../lib/settings";
import { ReadingRow } from "./ReadingRow";
import { groupReadings } from "../lib/kinds";
import type { ReadingView } from "../lib/library";
import { SplitHandle } from "./SplitHandle";
import { readSplit, splitColumns, writeSplit } from "../lib/split";
import { TitleEdit } from "./TitleEdit";
import { Icon } from "./icons";
import { showToast, typing, useNarrow, useTitle } from "../lib/ui";

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

// The module's weeks, for the menus on the reading rows, and the sessions either side
// of this one in the module's order, for moving on without going back to the week. One
// query serves both, and it reads every session of the module at once with anyOf rather
// than asking week by week, so it costs four reads however many weeks the module has.
type Neighbour = { session: SessionRow; week: WeekRow } | null;
type SessionNav = { weeks: WeekRow[]; previous: Neighbour; next: Neighbour };
const NO_NAV: SessionNav = { weeks: [], previous: null, next: null };

async function loadSessionNav(id: string): Promise<SessionNav> {
  const session = await db.sessions.get(id);
  const week = session ? await db.weeks.get(session.week_id) : undefined;
  if (!week) return NO_NAV;
  const weeks = (await db.weeks.where("module_id").equals(week.module_id).toArray()).filter((w) => !w.deleted).sort(byWeek);
  const sessions = (await db.sessions.where("week_id").anyOf(weeks.map((w) => w.id)).toArray()).filter((x) => !x.deleted);
  const order = weeks.flatMap((w) => sessions.filter((x) => x.week_id === w.id).sort(byPosition).map((x) => ({ session: x, week: w })));
  const at = order.findIndex((o) => o.session.id === id);
  if (at < 0) return { weeks, previous: null, next: null };
  return { weeks, previous: order[at - 1] ?? null, next: order[at + 1] ?? null };
}

export function SessionPage({ id, rec, t, turn }: { id: string; rec?: string; t?: number; turn?: number }) {
  // Remembered as opened, so the home page can offer it again.
  useEffect(() => { void noteSessionOpened(id); }, [id]);
  const data = useSuspendingLiveQuery(() => loadSession(id), ["session-page", id]);
  const recorder = useRecorder(id);
  const [error, setError] = useState<string | null>(null);
  const audios = useRef(new Map<string, HTMLAudioElement>());
  const picker = useRef<HTMLInputElement>(null);
  const transcriptPicker = useRef<HTMLInputElement>(null);
  const narrow = useNarrow();
  const gridRef = useRef<HTMLDivElement>(null);
  const [splitFraction, setSplitFraction] = useState(readSplit);
  const updateSplit = (next: number) => { setSplitFraction(writeSplit(next)); };
  const slidesPicker = useRef<HTMLInputElement>(null);
  // Only menus and the links at the foot of the page use this, so it does not suspend:
  // a second suspending query here would wait for the first instead of loading beside it.
  const nav = useLiveQuery(() => loadSessionNav(id), [id], NO_NAV);
  const [renaming, setRenaming] = useState(false);
  useTitle(data ? `${data.module.code} ${weekCode(data.week)} ${data.session.title || sessionLabel(data.session.kind)}` : undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" && nav.previous) navigate({ view: "session", id: nav.previous.session.id });
      if (e.key === "]" && nav.next) navigate({ view: "session", id: nav.next.session.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav.previous, nav.next]);

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

  if (data === null) return <div className="page"><p className="muted">This session no longer exists.</p></div>;
  const { module, week, session, view, audio, readings } = data;
  const label = session.title || sessionLabel(session.kind);
  const name = (o: { session: SessionRow; week: WeekRow }) => `${weekCode(o.week)} ${o.session.title || sessionLabel(o.session.kind)}`;
  const saveName = (value: string) => {
    setRenaming(false);
    if (value.trim() !== (session.title ?? "")) void update("sessions", session.id, { title: value.trim() || null });
  };
  // A session holds one deck, so choosing slides when it has some replaces them.
  const slidesAction = view.slides.length ? "Replace slides" : "Add slides";
  // What its row on the week page offers, here as well. Adding things to the
  // session lives in the Add menu beside it instead, on every screen size.
  const sessionMenu = [
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
      {/* The tab and Back already say where the session sits, so the line above
          the title keeps only when its week runs and the sessions either side. */}
      <div className="week-crumbs page-topline">
        <WeekWhen week={week} />
        {(nav.previous || nav.next) && (
          <nav className="week-nav week-nav-top" aria-label="Other sessions">
            {nav.previous ? (
              <Link
                to={{ view: "session", id: nav.previous.session.id }}
                className="week-nav-btn prev"
                title={`Previous session: ${name(nav.previous)} (press [)`}
              >
                <span className="nav-dir back" aria-hidden="true"><Icon name="down" size={14} /></span>
                <span>{name(nav.previous)}</span>
              </Link>
            ) : (
              <span className="week-nav-btn disabled" aria-hidden="true">
                <span className="nav-dir back"><Icon name="down" size={14} /></span>
              </span>
            )}
            {nav.next ? (
              <Link
                to={{ view: "session", id: nav.next.session.id }}
                className="week-nav-btn next"
                title={`Next session: ${name(nav.next)} (press ])`}
              >
                <span>{name(nav.next)}</span>
                <span className="nav-dir next" aria-hidden="true"><Icon name="down" size={14} /></span>
              </Link>
            ) : (
              <span className="week-nav-btn disabled" aria-hidden="true">
                <span className="nav-dir next"><Icon name="down" size={14} /></span>
              </span>
            )}
          </nav>
        )}
      </div>
      <div className="section-head" style={{ alignItems: "center", flexWrap: "wrap" }}>
        {/* The session's own actions sit beside its title, which they act upon,
            and recording and adding stay at the far end. */}
        <div className="page-title-group">
          {renaming ? (
            <TitleEdit
              value={session.title ?? ""}
              label="Session name"
              placeholder={sessionLabel(session.kind)}
              onSave={(next) => saveName(next)}
              onCancel={() => setRenaming(false)}
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
          <Menu label={`More actions for this ${label.toLowerCase()}`} items={sessionMenu} />
        </div>
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
          <button className="button primary" onClick={toggle}>Record</button>
        )}
        {/* The quieter ways of filling a session share one menu beside Record. It stays
            while recording too, so slides can still go in during the lecture itself. */}
        <Menu
          label="Add to this session"
          trigger={<span>Add</span>}
          items={[
            { label: slidesAction, onSelect: () => slidesPicker.current?.click() },
            { label: "Add a recording file", onSelect: () => picker.current?.click() },
            { label: "Add a Moodle transcript", onSelect: () => transcriptPicker.current?.click() },
          ]}
        />
        <input
          ref={slidesPicker} type="file" multiple hidden accept={SLIDES_ACCEPT}
          onChange={async (e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            // Read before the files go in, since afterwards the session has slides either way.
            const replacing = view.slides.length > 0;
            const trimmed = files.length > 1 && files.some((f) => !f.type.startsWith("image/") && !/\.(heic|heif)$/i.test(f.name));
            try {
              const added = await addSlides(session.id, files);
              if (added) {
                showToast(trimmed ? `A session holds one slide deck, so ${files[0].name} was kept.` : (replacing ? "Slides replaced." : "Slides added."));
              }
            } catch (err) {
              setError(`The slides could not be ${replacing ? "replaced" : "added"}. ${(err as Error).message || "Try again in a moment."}`);
            }
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
      {error && <p className="small problem" role="alert">{error}</p>}
      {recorder.recording && (
        <p className="small muted rec-hint">You can leave this page while it records. A bar at the foot of the screen keeps the recording in view, wherever you go.</p>
      )}

      {(() => {
        const hasSide = view.slides.length > 0 || readings.length > 0;
        return (
          <div
            ref={gridRef}
            className={`session-grid${hasSide ? (narrow ? " with-side" : " with-side split") : ""}`}
            style={hasSide && !narrow ? (splitColumns(splitFraction) as React.CSSProperties) : undefined}
          >
            <div className="session-notes" style={{ viewTransitionName: "session-notes" }}>
              <Suspense fallback={<NotesLoading />}>
                <NoteEditor target={{ session_id: id }} label={`${sessionLabel(view.session.kind)} notes`} />
              </Suspense>
            </div>
            {hasSide && !narrow && (
              <SplitHandle grid={gridRef} value={splitFraction} onChange={updateSplit} />
            )}
            {hasSide && (
              <div className="session-side" style={{ viewTransitionName: "session-side" }}>
                {groupReadings(readings).map((group) => (
                  <section key={group.key} className={`side-readings kind-${group.key}`} aria-label={group.label}>
                    <h2 className="group-label">{group.label}</h2>
                    <ul className="readings">{group.views.map((r) => <ReadingRow key={r.item.id} view={r} weeks={nav.weeks} short />)}</ul>
                  </section>
                ))}
                {/* The slides come last, so nothing sits below them to pass under while they stay in view.
                    The deck shown has one line above it: its own row, with the reading's menu, and beside
                    that the choice of deck when there are several and Enlarge. */}
                {view.slides.length > 0 && (
                  <Suspense fallback={<div className="slide-loading" aria-busy="true" />}>
                    <SlideViewer
                      decks={view.slides}
                      heading="Slides"
                      className="side-readings side-slides"
                      renderHeader={(deck, controls) => (
                        <ul className="readings slides-row">
                          <ReadingRow key={deck.item.id} view={deck} weeks={nav.weeks} short extra={controls} />
                        </ul>
                      )}
                    />
                  </Suspense>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {view.recordings.map((recording) => {
        const isTargetRec = rec ? recording.id === rec : recording.id === latest?.id;
        const panelStartAt = isTargetRec ? t : undefined;
        const panelFocusTurn = (rec ? recording.id === rec : true) ? turn : undefined;
        return recording.turns && !recording.file_id ? (
          <ImportedPanel key={recording.id} recording={recording} title={`${module.code} ${weekCode(week)} ${label}`} focusTurn={panelFocusTurn} />
        ) : (
          <RecordingPanel
            key={recording.id}
            recording={recording}
            file={audio.get(recording.id)}
            register={register}
            focusTurn={panelFocusTurn}
            startAt={panelStartAt}
            title={`${module.code} ${weekCode(week)} ${label}`}
          />
        );
      })}
    </div>
  );
}
