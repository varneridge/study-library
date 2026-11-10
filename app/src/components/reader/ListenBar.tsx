// ListenBar: floating or docked playback bar for Kokoro speech synthesis in the Reader.
// Provides play/pause, paragraph stepping, fully adjustable speed with a gradual
// speed up, voice choice (British first), offline edition preparation, and status.

import { useEffect, useId, useState, useTransition } from "react";
import type { ListenController, ListenSnapshot } from "../../lib/listen/controller";
import { formatRate, quantiseRate, RATE_PRESETS, RATE_STEP } from "../../lib/listen/rate";
import type { RampSettings, VoiceInfo } from "../../lib/listen/types";
import { MAX_RATE, MIN_RATE } from "../../lib/listen/types";
import { Icon, IconButton } from "../icons";
import "./ListenBar.css";

const RAMP_CAPS = [0.25, 0.5, 1];

export interface ListenBarProps {
  controller: ListenController;
  onClose: () => void;
  voices?: VoiceInfo[];
}

export function ListenBar({ controller, onClose, voices = [] }: ListenBarProps) {
  const [snapshot, setSnapshot] = useState<ListenSnapshot>(() => controller.getSnapshot());
  const [offlineProgress, setOfflineProgress] = useState<{ done: number; total: number } | null>(null);
  const [, startTransition] = useTransition();
  const ids = useId();

  useEffect(() => {
    return controller.subscribe((s) => {
      startTransition(() => {
        setSnapshot(s);
      });
    });
  }, [controller]);

  const isPlaying = snapshot.state === "playing";
  const isBuffering = snapshot.state === "buffering";
  const isPreparing = snapshot.state === "preparing";
  const ramp = snapshot.ramp;

  // One button, one handler: a nested button would toggle twice on one click.
  const handleTogglePlay = () => {
    if (isPlaying) {
      controller.pause();
    } else {
      void controller.play();
    }
  };

  const setRamp = (change: Partial<RampSettings>) => controller.setRamp({ ...ramp, ...change });

  const handlePrepareOffline = () => {
    if (isPreparing) return;
    const ctrl = new AbortController();
    setOfflineProgress({ done: 0, total: snapshot.totalUtterances });
    controller
      .prepareEdition(
        7200, // up to 2 hours
        (done, total) => setOfflineProgress({ done, total }),
        ctrl.signal,
      )
      .then(() => {
        setOfflineProgress(null);
        void controller.play();
      })
      .catch((err) => {
        console.error("Failed to prepare offline edition:", err);
        setOfflineProgress(null);
      });
  };

  const britishVoices = voices.filter((v) => v.lang === "en-GB");
  const otherVoices = voices.filter((v) => v.lang !== "en-GB");
  const rampTop = quantiseRate(snapshot.baseRate + ramp.maxBoost);

  return (
    <section className="listen-bar" aria-label="Audio reader controls">
      <div className="lb-main-row">
        {/* Playback Controls */}
        <div className="lb-playback-group">
          <IconButton
            icon="prevTrack"
            label="Previous paragraph"
            shortcut="J"
            disabled={snapshot.paragraph <= 0 || isPreparing}
            onClick={() => controller.skipParagraphs(-1)}
          />
          <button
            type="button"
            className={`lb-play-btn ${isPlaying ? "lb-play-btn--playing" : ""}`}
            onClick={handleTogglePlay}
            disabled={isPreparing}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            <Icon name={isPlaying ? "pause" : "play"} size={18} />
          </button>
          <IconButton
            icon="nextTrack"
            label="Next paragraph"
            shortcut="K"
            disabled={snapshot.paragraph >= snapshot.totalParagraphs - 1 || isPreparing}
            onClick={() => controller.skipParagraphs(1)}
          />
        </div>

        {/* Progress & Status */}
        <div className="lb-status" aria-live="polite">
          {isPreparing && offlineProgress ? (
            <span className="lb-status-text">
              Preparing audio: {Math.round((offlineProgress.done / Math.max(1, offlineProgress.total)) * 100)}%
            </span>
          ) : isBuffering ? (
            <span className="lb-status-text lb-status-text--buffering">Preparing this paragraph...</span>
          ) : snapshot.error ? (
            <span className={`lb-status-text ${snapshot.backend === "speech" ? "lb-status-text--notice" : "lb-status-text--error"}`}>
              {snapshot.error}
            </span>
          ) : (
            <span className="lb-status-text">
              Paragraph {snapshot.paragraph + 1} of {snapshot.totalParagraphs}
              {snapshot.currentPage > 0 ? ` (page ${snapshot.currentPage + 1})` : ""}
              {snapshot.state === "playing" || snapshot.state === "paused" ? ". Tap any word to read from it." : ""}
            </span>
          )}
        </div>

        {/* Voice Selector */}
        <div className="lb-voice-group">
          <label htmlFor={`${ids}-voice`} className="lb-voice-label">
            Voice
          </label>
          <select
            id={`${ids}-voice`}
            className="lb-voice-select"
            value={snapshot.voice}
            disabled={snapshot.backend === "speech"}
            onChange={(e) => void controller.setVoice(e.target.value)}
          >
            {britishVoices.length > 0 && (
              <optgroup label="British Voices">
                {britishVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.gender}, {v.grade})
                  </option>
                ))}
              </optgroup>
            )}
            {otherVoices.length > 0 && (
              <optgroup label="American Voices">
                {otherVoices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.gender}, {v.grade})
                  </option>
                ))}
              </optgroup>
            )}
            {voices.length === 0 && (
              <>
                <optgroup label="British Voices">
                  <option value="bf_emma">Emma (British Female)</option>
                  <option value="bm_george">George (British Male)</option>
                  <option value="bm_lewis">Lewis (British Male)</option>
                  <option value="bf_isabella">Isabella (British Female)</option>
                </optgroup>
                <optgroup label="American Voices">
                  <option value="af_heart">Heart (American Female)</option>
                  <option value="am_adam">Adam (American Male)</option>
                </optgroup>
              </>
            )}
          </select>
        </div>

        {/* Offline Listening Button */}
        <button
          type="button"
          className="lb-offline-btn"
          onClick={handlePrepareOffline}
          disabled={isPreparing || snapshot.backend === "speech"}
          title="Merges all audio into a single continuous track so you can listen with your phone locked"
        >
          {isPreparing ? "Preparing..." : "Listen offline"}
        </button>

        {/* Close Button */}
        <IconButton icon="close" label="Close audio player" onClick={onClose} />
      </div>

      <div className="lb-speed-row">
        {/* Quick presets */}
        <div className="lb-speed-group" role="radiogroup" aria-label="Playback speed presets">
          {RATE_PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={snapshot.baseRate === s}
              className={`lb-chip ${snapshot.baseRate === s ? "lb-chip--active" : ""}`}
              onClick={() => controller.setRate(s)}
            >
              {formatRate(s)}
            </button>
          ))}
        </div>

        {/* Fine speed: a stepper and a slider over the whole range */}
        <div className="lb-fine-speed">
          <button
            type="button"
            className="lb-step-btn"
            aria-label="Slower"
            disabled={snapshot.baseRate <= MIN_RATE}
            onClick={() => controller.setRate(snapshot.baseRate - RATE_STEP)}
          >
            -
          </button>
          <input
            type="range"
            className="lb-speed-slider"
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
            className="lb-step-btn"
            aria-label="Faster"
            disabled={snapshot.baseRate >= MAX_RATE}
            onClick={() => controller.setRate(snapshot.baseRate + RATE_STEP)}
          >
            +
          </button>
          <output className="lb-speed-value" aria-live="polite">
            {formatRate(snapshot.rate)}
          </output>
        </div>

        {/* Gradual speed up */}
        <div className="lb-ramp-group">
          <label className="lb-ramp-toggle">
            <input type="checkbox" checked={ramp.enabled} onChange={(e) => setRamp({ enabled: e.target.checked })} />
            <span>Gradual speed up</span>
          </label>
          {ramp.enabled && (
            <>
              <select
                className="lb-ramp-select"
                aria-label="How often to speed up"
                value={ramp.every}
                onChange={(e) => setRamp({ every: e.target.value === "minute" ? "minute" : "paragraph" })}
              >
                <option value="paragraph">{`+${formatRate(ramp.step)} each paragraph`}</option>
                <option value="minute">{`+${formatRate(ramp.step)} each minute`}</option>
              </select>
              <select
                className="lb-ramp-select"
                aria-label="Fastest speed to reach"
                value={ramp.maxBoost}
                onChange={(e) => setRamp({ maxBoost: Number(e.target.value) })}
              >
                {RAMP_CAPS.map((c) => (
                  <option key={c} value={c}>{`up to ${formatRate(quantiseRate(snapshot.baseRate + c))}`}</option>
                ))}
              </select>
              <span className="lb-ramp-note">
                {snapshot.rate >= rampTop ? "At full speed" : `Now ${formatRate(snapshot.rate)}`}
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
