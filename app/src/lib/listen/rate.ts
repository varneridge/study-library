// Playback speed for Listen: any speed from MIN_RATE to MAX_RATE in RATE_STEP
// steps, and a gradual speed up that adds a small step every paragraph or every
// minute, up to a cap above the speed it started from. Speed is the media
// element's playbackRate with pitch preserved, so no change ever needs new audio.

import type { RampSettings } from "./types";
import { MAX_RATE, MIN_RATE } from "./types";

export const RATE_STEP = 0.05;
export const RATE_PRESETS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3];

export const DEFAULT_RAMP: RampSettings = { enabled: false, step: 0.05, every: "paragraph", maxBoost: 0.5 };

/** Within [MIN_RATE, MAX_RATE]; 1 for anything that is not a number. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

/** Clamped and rounded to the nearest RATE_STEP, with no floating-point tail (1.25, not 1.2500000000000002). */
export function quantiseRate(rate: number): number {
  return Math.round(Math.round(clampRate(rate) / RATE_STEP) * RATE_STEP * 100) / 100;
}

/**
 * The speed after `paragraphs` completed paragraphs and `playedSeconds` of
 * listening, starting from `base`. Off, or a step or cap of zero, gives `base`.
 */
export function rampRate(base: number, ramp: RampSettings, paragraphs: number, playedSeconds: number): number {
  const start = quantiseRate(base);
  if (!ramp.enabled || ramp.step <= 0 || ramp.maxBoost <= 0) return start;
  const steps = ramp.every === "paragraph" ? Math.max(0, Math.floor(paragraphs)) : Math.max(0, Math.floor(playedSeconds / 60));
  return quantiseRate(start + Math.min(ramp.maxBoost, steps * ramp.step));
}

/** "1.5x" for display. */
export function formatRate(rate: number): string {
  return `${quantiseRate(rate).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}x`;
}
