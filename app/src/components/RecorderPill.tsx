// While a lecture is being recorded, the recording shrinks to a small bar
// that follows you round the app, as a call or a voice memo does on a
// phone. The rest of the app stays yours to use: open a reading, look up a
// note, check another module. The bar shows the time and a live level, and
// holds pause and stop. Tapping its name goes back to the session's notes.

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { db } from "../lib/db";
import { sessionLabel, weekCode } from "../lib/modules";
import { clock, inputLevel, pauseRecording, resumeRecording, stopRecording, useRecordingNow } from "../lib/recorder";
import { navigate, type Route } from "../lib/router";

function Level({ paused }: { paused: boolean }) {
  const bars = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame = 0;
    const history = [0, 0, 0, 0, 0];
    const draw = () => {
      history.shift();
      history.push(inputLevel());
      bars.current?.querySelectorAll<HTMLElement>("i").forEach((bar, i) => {
        bar.style.transform = `scaleY(${0.15 + history[i] * 0.85})`;
      });
      frame = window.setTimeout(() => requestAnimationFrame(draw), 90);
    };
    draw();
    return () => clearTimeout(frame);
  }, []);
  return <span ref={bars} className={`rec-level${paused ? " paused" : ""}`} aria-hidden="true"><i /><i /><i /><i /><i /></span>;
}

export function RecorderPill({ route }: { route: Route }) {
  const now = useRecordingNow();
  const [confirming, setConfirming] = useState(false);
  const place = useLiveQuery(async () => {
    if (!now) return null;
    const session = await db.sessions.get(now.sessionId);
    const week = session ? await db.weeks.get(session.week_id) : undefined;
    const module = week ? await db.modules.get(week.module_id) : undefined;
    return session && week && module ? `${module.code} ${weekCode(week)} ${session.title || sessionLabel(session.kind)}` : "Recording";
  }, [now?.sessionId], null);

  useEffect(() => {
    document.body.classList.toggle("recording-active", Boolean(now));
    return () => document.body.classList.remove("recording-active");
  }, [now]);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  // On its own session page the full controls are already there.
  if (!now || (route.view === "session" && route.id === now.sessionId)) return null;

  return (
    <div className={`rec-pill${now.paused ? " paused" : ""}`} role="region" aria-label="Recording in progress">
      <span className="rec-dot" aria-hidden="true" />
      <button className="rec-where plain" onClick={() => navigate({ view: "session", id: now.sessionId })} title="Back to the notes for this session">
        <span className={`rec-state${now.problem ? " problem" : ""}`}>{now.paused ? "Paused" : now.problem ? "No sound for 30 seconds" : "Recording"}</span>
        <span className="rec-name">{place}</span>
      </button>
      <Level paused={now.paused} />
      <span className="rec-time" aria-live="off">{clock(now.elapsed)}</span>
      <button className="rec-button" onClick={() => (now.paused ? resumeRecording() : pauseRecording())} aria-label={now.paused ? "Resume recording" : "Pause recording"}>
        {now.paused ? "Resume" : "Pause"}
      </button>
      <button
        className={`rec-button stop${confirming ? " confirming" : ""}`}
        onClick={() => { if (confirming) { setConfirming(false); void stopRecording(); } else setConfirming(true); }}
        aria-label={confirming ? "Tap again to stop recording" : "Stop recording"}
      >
        {confirming ? "Tap again to stop" : "Stop"}
      </button>
    </div>
  );
}
