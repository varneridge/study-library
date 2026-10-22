import { extensionFor, safeFileName } from "../lib/names";
import { useEffect, useRef, useState } from "react";
import { navigate } from "../lib/router";
import { clock, finishRecording, useRecordingNow } from "../lib/recorder";
import { api } from "../lib/sync";
import { deleteRecording, withUndo } from "../lib/edits";
import { confirmAction, showToast } from "../lib/ui";
import { Menu } from "./Menu";
import { useProcessorStatus, waitingText } from "../lib/status";
import { TranscriptView } from "./TranscriptView";
import type { FileRow, RecordingRow } from "../lib/types";

const STATUS: Record<string, string> = {
  recording: "Recording",
  uploading: "Uploading recording",
  uploaded: "Waiting to process",
  processing: "Preparing audio",
  transcribing: "Transcribing",
};

export function recordingState(recording: RecordingRow): string | null {
  return STATUS[recording.status] ?? null;
}

// A transcript imported from Moodle, with no audio of its own.
export function ImportedPanel({ recording, title, focusTurn }: { recording: RecordingRow; title: string; focusTurn?: number }) {
  const [open, setOpen] = useState(focusTurn !== undefined);
  useEffect(() => { if (focusTurn !== undefined) setOpen(true); }, [focusTurn]);
  return (
    <section className="recording imported">
      <div className="section-head">
        <h3>Transcript</h3>
        <span className="count">from Moodle</span>
        <span className="spacer" />
        <Menu
          label="More actions for this transcript"
          items={[{
            label: "Delete transcript",
            danger: true,
            onSelect: async () => {
              const ok = await confirmAction({ title: "Delete this transcript?", body: "You can restore it from Settings for 90 days.", confirm: "Delete transcript", danger: true });
              if (ok) await withUndo("Transcript deleted.", deleteRecording(recording));
            },
          }]}
        />
      </div>
      <button className="quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "Hide transcript" : "Read the transcript"}
      </button>
      {open && <TranscriptView recordingId={recording.id} turns={recording.turns ?? []} title={title} focusTurn={focusTurn} />}
    </section>
  );
}

export function RecordingPanel({
  recording, file, register, startAt, focusTurn, title,
}: {
  recording: RecordingRow;
  file: FileRow | undefined;
  // The session, as "HY248 AT4 Lecture", which names the downloaded audio.
  title?: string;
  register: (id: string, audio: HTMLAudioElement | null) => void;
  startAt?: number;
  focusTurn?: number;
}) {
  // A search result opens the transcript at the words it found.
  const [open, setOpen] = useState(focusTurn !== undefined);
  const [rate, setRate] = useState(() => Number(localStorage.getItem("playback-rate")) || 1);
  const audio = useRef<HTMLAudioElement | null>(null);
  const now = useRecordingNow();
  const activeHere = now?.recordingId === recording.id;
  const playable = Boolean(file && file.mime.startsWith("audio/"));
  const turns = recording.turns ?? [];
  const skip = (seconds: number) => {
    const el = audio.current;
    if (el) el.currentTime = Math.max(0, Math.min(el.duration || Infinity, el.currentTime + seconds));
  };
  const changeRate = (next: number) => {
    setRate(next);
    localStorage.setItem("playback-rate", String(next));
    if (audio.current) audio.current.playbackRate = next;
  };

  useEffect(() => {
    if (startAt === undefined || !playable) return;
    const audio = document.querySelector<HTMLAudioElement>(`audio[data-recording="${recording.id}"]`);
    if (audio) {
      audio.currentTime = startAt;
      audio.scrollIntoView({ block: "center" });
    }
  }, [startAt, playable, recording.id]);

  const waiting = waitingText(useProcessorStatus());
  const stage = recordingState(recording);
  // Once the audio is up, a quiet processor is the reason nothing moves.
  const state = waiting && ["uploaded", "processing", "transcribing"].includes(recording.status) ? waiting : stage;

  return (
    <section className="recording">
      <div className="section-head">
        <h3>{recording.source === "upload" ? "Uploaded recording" : "Recording"}</h3>
        {recording.duration_seconds ? <span className="count">{clock(recording.duration_seconds)}</span> : null}
        <span className="spacer" />
        {state && <span className="small muted">{state}</span>}
        {recording.status === "failed" && (
          <span className="small problem">
            Processing failed. <button className="link" onClick={() => api(`/api/recordings/${recording.id}/retry`, { method: "POST" })}>Retry</button>
          </span>
        )}
        <Menu
          label="More actions for this recording"
          items={[
            {
              label: "Finish recording",
              hidden: activeHere || recording.source !== "live" || !["recording", "uploading"].includes(recording.status),
              onSelect: async () => {
                const ok = await confirmAction({
                  title: "Finish this recording?",
                  body: "Only do this if the device that started it is no longer recording. Any audio already uploaded will be processed.",
                  confirm: "Finish recording",
                });
                if (ok) {
                  await finishRecording(recording.id);
                  showToast("Recording finished.");
                }
              },
            },
            {
              label: "Download audio",
              hidden: !playable,
              onSelect: () => {
                const a = document.createElement("a");
                a.href = `/api/objects/${file!.r2_key}`;
                a.download = safeFileName(`${title ? `${title} ` : ""}recording`, extensionFor(file!.mime, file!.original_name));
                document.body.append(a);
                a.click();
                a.remove();
              },
            },
            {
              label: "Delete recording",
              danger: true,
              hidden: activeHere,
              onSelect: async () => {
                const ok = await confirmAction({
                  title: "Delete this recording?",
                  body: "The audio and transcript go. Your notes stay. You can restore it from Settings for 90 days.",
                  confirm: "Delete recording",
                  danger: true,
                });
                if (ok) await withUndo("Recording deleted.", deleteRecording(recording));
              },
            },
          ]}
        />
      </div>
      {playable && (
        <>
          <audio
            controls
            preload="metadata"
            data-recording={recording.id}
            ref={(el) => {
              audio.current = el;
              if (el) el.playbackRate = rate;
              register(recording.id, el);
            }}
            onLoadedMetadata={(e) => { e.currentTarget.playbackRate = rate; }}
            src={`/api/objects/${file!.r2_key}`}
            style={{ width: "100%" }}
          />
          <div className="player-tools">
            <button className="tool" onClick={() => skip(-15)} aria-label="Back 15 seconds">−15 s</button>
            <button className="tool" onClick={() => skip(15)} aria-label="Forward 15 seconds">+15 s</button>
            <span className="spacer" />
            <div className="segmented" role="group" aria-label="Playback speed">
              {[1, 1.25, 1.5, 1.75, 2].map((r) => (
                <button key={r} className="tool" aria-pressed={rate === r} onClick={() => changeRate(r)}>{r}×</button>
              ))}
            </div>
          </div>
        </>
      )}
      {turns.length > 0 && (
        <>
          <button className="quiet" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? "Hide transcript" : "Read the transcript"}
          </button>
          {open && <TranscriptView recordingId={recording.id} turns={turns} title="Transcript" focusTurn={focusTurn} />}
        </>
      )}
    </section>
  );
}
