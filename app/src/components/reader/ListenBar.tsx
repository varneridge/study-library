// ListenBar: floating or docked playback bar for Kokoro speech synthesis in the Reader.
// Provides play/pause, sentence stepping, speed selection, voice choice (British first),
// offline edition preparation, and status indications.

import { useEffect, useState, useTransition } from "react";
import type { ListenController, ListenSnapshot } from "../../lib/listen/controller";
import type { VoiceInfo } from "../../lib/listen/types";
import { IconButton } from "../icons";
import "./ListenBar.css";

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

export interface ListenBarProps {
  controller: ListenController;
  onClose: () => void;
  voices?: VoiceInfo[];
}

export function ListenBar({ controller, onClose, voices = [] }: ListenBarProps) {
  const [snapshot, setSnapshot] = useState<ListenSnapshot>(() => controller.getSnapshot());
  const [offlineProgress, setOfflineProgress] = useState<{ done: number; total: number } | null>(null);
  const [, startTransition] = useTransition();

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

  const handleTogglePlay = () => {
    if (isPlaying) {
      controller.pause();
    } else {
      void controller.play();
    }
  };

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

  return (
    <section className="listen-bar" aria-label="Audio reader controls">
      <div className="lb-main-row">
        {/* Playback Controls */}
        <div className="lb-playback-group">
          <IconButton
            icon="prevTrack"
            label="Previous sentence"
            shortcut="J"
            disabled={snapshot.utterance <= 0 || isPreparing}
            onClick={() => controller.skipSentences(-1)}
          />
          <button
            type="button"
            className={`lb-play-btn ${isPlaying ? "lb-play-btn--playing" : ""}`}
            onClick={handleTogglePlay}
            disabled={isPreparing}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            <IconButton
              icon={isPlaying ? "pause" : "play"}
              label={isPlaying ? "Pause" : "Play"}
              onClick={handleTogglePlay}
            />
          </button>
          <IconButton
            icon="nextTrack"
            label="Next sentence"
            shortcut="K"
            disabled={snapshot.utterance >= snapshot.totalUtterances - 1 || isPreparing}
            onClick={() => controller.skipSentences(1)}
          />
        </div>

        {/* Progress & Status */}
        <div className="lb-status" aria-live="polite">
          {isPreparing && offlineProgress ? (
            <span className="lb-status-text">
              Preparing audio: {Math.round((offlineProgress.done / Math.max(1, offlineProgress.total)) * 100)}%
            </span>
          ) : isBuffering ? (
            <span className="lb-status-text lb-status-text--buffering">Synthesising speech...</span>
          ) : snapshot.error ? (
            <span className="lb-status-text lb-status-text--error">{snapshot.error}</span>
          ) : (
            <span className="lb-status-text">
              Sentence {snapshot.utterance + 1} of {snapshot.totalUtterances}
              {snapshot.currentPage > 0 ? ` (page ${snapshot.currentPage + 1})` : ""}
            </span>
          )}
        </div>

        {/* Speed Controls */}
        <div className="lb-speed-group" role="radiogroup" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={snapshot.rate === s}
              className={`lb-chip ${snapshot.rate === s ? "lb-chip--active" : ""}`}
              onClick={() => controller.setRate(s)}
            >
              {s}×
            </button>
          ))}
        </div>

        {/* Voice Selector */}
        <div className="lb-voice-group">
          <label htmlFor="lb-voice-select" className="lb-voice-label">
            Voice
          </label>
          <select
            id="lb-voice-select"
            className="lb-voice-select"
            value={snapshot.voice}
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
          disabled={isPreparing}
          title="Merges all audio into a single continuous track so you can listen with your phone locked"
        >
          {isPreparing ? "Preparing..." : "Listen offline"}
        </button>

        {/* Close Button */}
        <IconButton icon="close" label="Close audio player" onClick={onClose} />
      </div>
    </section>
  );
}
