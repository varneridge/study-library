// ListenBar: one compact floating capsule for Listen in the Reader, in the
// manner of Speechify and Notion. The capsule holds only what is used while
// listening: previous and next paragraph either side of play, the speed and the
// voice as pills, offline listening behind one icon, and close. Everything set
// less often (fine speed, the gradual speed up, the voice list, offline audio)
// opens in a small popover above the capsule, one at a time. The ring round the
// play button shows how far through the reading the current paragraph is, and
// spins while audio is being prepared. Short notices (the fallback voice, an
// error, a first hint) sit in a chip above the capsule rather than in it, and
// so does Recentre, which appears once the reader has scrolled away from the
// words being read and brings them, and following, back.

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import type { ListenController, ListenSnapshot } from "../../lib/listen/controller";
import { formatRate, quantiseRate, RATE_PRESETS, RATE_STEP } from "../../lib/listen/rate";
import type { RampSettings, VoiceInfo } from "../../lib/listen/types";
import { DEFAULT_VOICES, MAX_RATE, MIN_RATE } from "../../lib/listen/types";
import { Icon, IconButton } from "../icons";
import "./ListenBar.css";

const RAMP_CAPS = [0.25, 0.5, 1];

/** Up to two hours of audio for offline listening. */
const OFFLINE_SECONDS = 7200;

/** How long an informational notice stays before it leaves on its own. */
const NOTICE_MS = 9000;

type Panel = "speed" | "voice" | "offline" | null;

export interface ListenBarProps {
  controller: ListenController;
  onClose: () => void;
  voices?: VoiceInfo[];
}

/** The name to show for a voice id: from the list when it is there, else from the id itself ("bf_emma" is Emma). */
export function voiceLabel(id: string, voices: VoiceInfo[]): string {
  const known = voices.find((v) => v.id === id) ?? DEFAULT_VOICES.find((v) => v.id === id);
  if (known) return known.name;
  const bare = id.includes("_") ? id.slice(id.indexOf("_") + 1) : id;
  return bare ? bare.charAt(0).toUpperCase() + bare.slice(1) : "Voice";
}

/**
 * A speed step for display ("+0.05x"). formatRate cannot be used for it, as it
 * clamps to the slowest speed and would show a 0.05 step as 0.5x.
 */
export function formatStep(step: number): string {
  return `+${Number(step.toFixed(2))}x`;
}

interface Notice {
  key: string;
  text: string;
  detail?: string;
  tone: "hint" | "info" | "error";
  /** Informational notices leave on their own; errors stay until dismissed. */
  lingers: boolean;
}

/** The one notice worth showing now, if any, in order of what the reader most needs to know. */
function noticeFor(s: ListenSnapshot, offline: { done: number; total: number } | null): Notice | null {
  if (s.state === "preparing" && offline) {
    const pct = Math.round((offline.done / Math.max(1, offline.total)) * 100);
    return { key: "offline", text: `Preparing offline audio, ${pct}%`, tone: "info", lingers: true };
  }
  if (s.error && s.backend === "speech") {
    return { key: `speech:${s.error}`, text: "Using your device's voice, as Kokoro could not load", detail: s.error, tone: "info", lingers: false };
  }
  if (s.error) return { key: `error:${s.error}`, text: s.error, detail: s.error, tone: "error", lingers: true };
  if (s.state === "buffering") return { key: "buffering", text: "Preparing audio", tone: "info", lingers: true };
  if (s.state === "idle") return { key: "hint", text: "Tap or click any word to read from there", tone: "hint", lingers: true };
  return null;
}

/** An arrow towards the words being read when they are out of sight, or a target when they are on screen. */
function RecentreGlyph({ away }: { away: "above" | "below" | null }) {
  if (!away) {
    return (
      <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="10" cy="10" r="1.8" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false" style={away === "above" ? { transform: "rotate(180deg)" } : undefined}>
      <path d="M10 4v11m0 0-4.5-4.5M10 15l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OfflineGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">
      <path d="M10 3.5v9m0 0-3.5-3.5M10 12.5l3.5-3.5M4.5 15.5h11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ListenBar({ controller, onClose, voices = [] }: ListenBarProps) {
  const [snapshot, setSnapshot] = useState<ListenSnapshot>(() => controller.getSnapshot());
  const [offlineProgress, setOfflineProgress] = useState<{ done: number; total: number } | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const ids = useId();
  const rootRef = useRef<HTMLElement>(null);
  const triggers = useRef<Record<Exclude<Panel, null>, HTMLButtonElement | null>>({ speed: null, voice: null, offline: null });
  const offlineCtrl = useRef<AbortController | null>(null);

  useEffect(() => {
    return controller.subscribe((s) => {
      startTransition(() => {
        setSnapshot(s);
      });
    });
  }, [controller]);

  // Preparation that is still running when the bar closes is stopped with it.
  useEffect(() => () => offlineCtrl.current?.abort(), []);

  const panelRef = useRef<Panel>(null);
  panelRef.current = panel;
  const closePanel = useCallback((returnFocus: boolean) => {
    const open = panelRef.current;
    if (open && returnFocus) triggers.current[open]?.focus();
    setPanel(null);
  }, []);

  // An opened popover takes focus on its first control, so the keyboard lands where the eye does.
  useEffect(() => {
    if (!panel) return;
    rootRef.current?.querySelector<HTMLElement>(".lb-pop input, .lb-pop button:not(:disabled), .lb-pop select")?.focus();
  }, [panel]);

  // A popover closes on Escape, with focus back on its pill, and on any press outside the bar.
  useEffect(() => {
    if (!panel) return;
    // Caught on the way down, so Escape closes only the popover and not the reader behind it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePanel(true);
      }
    };
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closePanel(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [panel, closePanel]);

  const notice = noticeFor(snapshot, offlineProgress);
  const noticeKey = notice?.key ?? null;
  const noticeLingers = notice?.lingers ?? true;

  // An informational notice leaves on its own after a while; an error waits to be dismissed.
  // The timer pauses while a popover covers the notice so the reader has a chance to see it.
  useEffect(() => {
    if (!noticeKey || noticeLingers || panel) return;
    const timer = setTimeout(() => setDismissed(noticeKey), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [noticeKey, noticeLingers, panel]);

  const isPlaying = snapshot.state === "playing";
  const isBuffering = snapshot.state === "buffering";
  const isPreparing = snapshot.state === "preparing";
  const onSpeech = snapshot.backend === "speech";
  const ramp = snapshot.ramp;
  const total = Math.max(1, snapshot.totalParagraphs);
  const progress = snapshot.totalParagraphs > 0 ? (snapshot.paragraph + 1) / total : 0;

  // One button, one handler: a nested button would toggle twice on one click.
  // While a paragraph is being prepared, a press changes nothing (the controller
  // ignores a second play), and the spinning ring says why.
  const handleTogglePlay = () => {
    if (isPlaying) controller.pause();
    else void controller.play();
  };

  const toggle = (which: Exclude<Panel, null>) => setPanel((open) => (open === which ? null : which));

  const setRamp = (change: Partial<RampSettings>) => controller.setRamp({ ...ramp, ...change });

  const handlePrepareOffline = () => {
    if (isPreparing) {
      offlineCtrl.current?.abort();
      return;
    }
    const ctrl = new AbortController();
    offlineCtrl.current = ctrl;
    setDismissed(null);
    setOfflineProgress({ done: 0, total: snapshot.totalUtterances });
    setPanel(null);
    controller
      .prepareEdition(OFFLINE_SECONDS, (done, all) => setOfflineProgress({ done, total: all }), ctrl.signal)
      .then(() => {
        setOfflineProgress(null);
        if (!ctrl.signal.aborted) void controller.play();
      })
      .catch((err) => {
        console.error("Failed to prepare offline edition:", err);
        setOfflineProgress(null);
      })
      .finally(() => {
        if (offlineCtrl.current === ctrl) offlineCtrl.current = null;
      });
  };

  const list = voices.length > 0 ? voices : DEFAULT_VOICES;
  const britishVoices = list.filter((v) => v.lang === "en-GB");
  const otherVoices = list.filter((v) => v.lang !== "en-GB");
  const rampTop = quantiseRate(snapshot.baseRate + ramp.maxBoost);
  const showNotice = notice && notice.key !== dismissed && !panel;
  // Recentre is offered whenever following is off and there is a place to go back to.
  const hasPlace = snapshot.state === "playing" || snapshot.state === "paused" || snapshot.state === "buffering";
  const showRecentre = hasPlace && !snapshot.following && !panel;
  const recentreLabel =
    snapshot.away === "above"
      ? "Recentre: the words being read are above"
      : snapshot.away === "below"
        ? "Recentre: the words being read are below"
        : "Recentre on the words being read";
  const playLabel = isPlaying ? "Pause" : isBuffering ? "Preparing audio" : "Play";

  const voiceGroup = (label: string, group: VoiceInfo[]) =>
    group.length > 0 && (
      <div className="lb-voice-group" role="group" aria-label={label}>
        <p className="lb-pop-label">{label}</p>
        {group.map((v) => (
          <button
            key={v.id}
            type="button"
            role="radio"
            aria-checked={snapshot.voice === v.id}
            className="lb-voice-option"
            disabled={onSpeech}
            onClick={() => {
              void controller.setVoice(v.id);
              closePanel(true);
            }}
          >
            <span className="lb-voice-name">{v.name}</span>
            <span className="lb-voice-meta">{v.gender}</span>
          </button>
        ))}
      </div>
    );

  return (
    <section className="listen-bar" aria-label="Audio reader controls" ref={rootRef}>
      {panel === "speed" && (
        <div className="lb-pop" role="dialog" aria-label="Speed" id={`${ids}-speed`}>
          <div className="lb-pop-head">
            <span className="lb-pop-title">Speed</span>
            <output className="lb-pop-value">{formatRate(snapshot.baseRate)}</output>
          </div>
          <div className="lb-fine">
            <button
              type="button"
              className="lb-step"
              aria-label="Slower"
              disabled={snapshot.baseRate <= MIN_RATE}
              onClick={() => controller.setRate(snapshot.baseRate - RATE_STEP)}
            >
              <span aria-hidden="true">&minus;</span>
            </button>
            <input
              type="range"
              className="lb-slider"
              min={MIN_RATE}
              max={MAX_RATE}
              step={RATE_STEP}
              value={snapshot.baseRate}
              aria-label="Playback speed"
              aria-valuetext={formatRate(snapshot.baseRate)}
              onChange={(e) => controller.setRate(Number(e.target.value))}
            />
            <button
              type="button"
              className="lb-step"
              aria-label="Faster"
              disabled={snapshot.baseRate >= MAX_RATE}
              onClick={() => controller.setRate(snapshot.baseRate + RATE_STEP)}
            >
              <span aria-hidden="true">+</span>
            </button>
          </div>
          <div className="lb-presets" role="radiogroup" aria-label="Speed presets">
            {RATE_PRESETS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={snapshot.baseRate === s} className="lb-preset" onClick={() => controller.setRate(s)}>
                {formatRate(s)}
              </button>
            ))}
          </div>
          <div className="lb-ramp">
            <button type="button" role="switch" aria-checked={ramp.enabled} className="lb-switch-row" onClick={() => setRamp({ enabled: !ramp.enabled })}>
              <span>Speed up gradually</span>
              <span className="lb-switch" aria-hidden="true" />
            </button>
            {ramp.enabled && (
              <div className="lb-ramp-options">
                <select
                  className="lb-select"
                  aria-label="How often to speed up"
                  value={ramp.every}
                  onChange={(e) => setRamp({ every: e.target.value === "minute" ? "minute" : "paragraph" })}
                >
                  <option value="paragraph">Every paragraph</option>
                  <option value="minute">Every minute</option>
                </select>
                <select className="lb-select" aria-label="Fastest speed to reach" value={ramp.maxBoost} onChange={(e) => setRamp({ maxBoost: Number(e.target.value) })}>
                  {RAMP_CAPS.map((c) => (
                    <option key={c} value={c}>{`Up to ${formatRate(quantiseRate(snapshot.baseRate + c))}`}</option>
                  ))}
                </select>
                <p className="lb-pop-note">
                  {`Adds ${formatStep(ramp.step)} each time. `}
                  {snapshot.rate >= rampTop ? "At full speed now." : `Now ${formatRate(snapshot.rate)}.`}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {panel === "voice" && (
        <div className="lb-pop lb-pop--voices" role="dialog" aria-label="Voice" id={`${ids}-voice`}>
          {onSpeech && <p className="lb-pop-note">Kokoro's voices come back when Kokoro loads; your device's voice is reading for now.</p>}
          <div role="radiogroup" aria-label="Voice">
            {voiceGroup("British", britishVoices)}
            {voiceGroup("American", otherVoices)}
          </div>
        </div>
      )}

      {panel === "offline" && (
        <div className="lb-pop" role="dialog" aria-label="Offline listening" id={`${ids}-offline`}>
          <p className="lb-pop-title">Offline listening</p>
          <p className="lb-pop-note">
            {onSpeech
              ? "Offline audio needs Kokoro, which could not load, so it is not available for now."
              : "Prepares up to two hours from here as one track, so it keeps playing with your phone locked or without a connection."}
          </p>
          <button type="button" className="lb-primary" disabled={onSpeech} onClick={handlePrepareOffline}>
            Prepare offline audio
          </button>
          {snapshot.error && <p className="lb-pop-detail">{snapshot.error}</p>}
        </div>
      )}

      {showNotice && (
        <button
          type="button"
          className={`lb-notice lb-notice--${notice.tone}`}
          title={notice.detail ?? notice.text}
          aria-label={
            notice.detail && notice.detail !== notice.text
              ? `${notice.text}: ${notice.detail.replace(/\.+$/, "")}. Press to dismiss.`
              : `${notice.text.replace(/\.+$/, "")}. Press to dismiss.`
          }
          onClick={() => setDismissed(notice.key)}
        >
          {notice.tone === "info" && (isBuffering || isPreparing) && <span className="lb-notice-dot" aria-hidden="true" />}
          <span className="lb-notice-text">{notice.text}</span>
        </button>
      )}

      {showRecentre && (
        <button type="button" className="lb-recentre" aria-label={recentreLabel} title={recentreLabel} onClick={() => controller.recentre()}>
          <RecentreGlyph away={snapshot.away} />
          <span>Recentre</span>
        </button>
      )}

      <p className="lb-sr" aria-live="polite">
        {notice && notice.tone !== "hint" ? notice.text : ""}
      </p>

      <div className="lb-capsule">
        <IconButton
          icon="prevTrack"
          label="Previous paragraph"
          shortcut="J"
          disabled={snapshot.paragraph <= 0 || isPreparing}
          onClick={() => controller.skipParagraphs(-1)}
        />
        <span
          className={`lb-ring${isBuffering || isPreparing ? " lb-ring--busy" : ""}`}
          style={{ "--lb-progress": `${Math.round(progress * 1000) / 10}%` } as React.CSSProperties}
        >
          <button type="button" className="lb-play" onClick={handleTogglePlay} disabled={isPreparing} aria-label={playLabel} aria-busy={isBuffering || isPreparing}>
            <Icon name={isPlaying ? "pause" : "play"} size={16} />
          </button>
        </span>
        <IconButton
          icon="nextTrack"
          label="Next paragraph"
          shortcut="K"
          disabled={snapshot.paragraph >= snapshot.totalParagraphs - 1 || isPreparing}
          onClick={() => controller.skipParagraphs(1)}
        />
        <span className="lb-count">
          <span aria-hidden="true">
            {snapshot.paragraph + 1}/{snapshot.totalParagraphs}
          </span>
          <span className="lb-sr">{`Paragraph ${snapshot.paragraph + 1} of ${snapshot.totalParagraphs}`}</span>
        </span>

        <span className="lb-divider" aria-hidden="true" />

        <button
          type="button"
          ref={(el) => {
            triggers.current.speed = el;
          }}
          className="lb-pill lb-pill--speed"
          aria-haspopup="dialog"
          aria-expanded={panel === "speed"}
          aria-controls={panel === "speed" ? `${ids}-speed` : undefined}
          aria-label={`Speed ${formatRate(snapshot.rate)}`}
          onClick={() => toggle("speed")}
        >
          {formatRate(snapshot.rate)}
        </button>
        <button
          type="button"
          ref={(el) => {
            triggers.current.voice = el;
          }}
          className="lb-pill lb-pill--voice"
          aria-haspopup="dialog"
          aria-expanded={panel === "voice"}
          aria-controls={panel === "voice" ? `${ids}-voice` : undefined}
          aria-label={`Voice: ${onSpeech ? "your device's voice" : voiceLabel(snapshot.voice, list)}`}
          onClick={() => toggle("voice")}
        >
          <span className="lb-pill-text">{onSpeech ? "Device" : voiceLabel(snapshot.voice, list)}</span>
          <Icon name="caret" size={12} />
        </button>

        <span className="lb-divider" aria-hidden="true" />

        <button
          type="button"
          ref={(el) => {
            triggers.current.offline = el;
          }}
          className={`lb-icon${isPreparing ? " lb-icon--busy" : ""}`}
          aria-haspopup="dialog"
          aria-expanded={panel === "offline"}
          aria-label={isPreparing ? "Stop preparing offline audio" : "Offline listening"}
          title={isPreparing ? "Stop preparing offline audio" : "Offline listening"}
          onClick={() => (isPreparing ? handlePrepareOffline() : toggle("offline"))}
        >
          <OfflineGlyph />
        </button>
        <IconButton icon="close" label="Close audio player" onClick={onClose} />
      </div>
    </section>
  );
}
