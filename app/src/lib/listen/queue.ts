// Which utterances to synthesise next. Kept pure so that the rules that decide
// whether playback stalls can be tested without an engine: the player calls it
// whenever an utterance finishes, fails, or playback moves.

export interface QueueInput {
  /** The utterance being heard, or the one playback will start from. */
  current: number;
  total: number;
  /** Seconds of audio for each utterance already synthesised (and cached). */
  ready: ReadonlyMap<number, number>;
  inFlight: ReadonlySet<number>;
  /** Utterances that failed this session; skipped, never retried in a loop. */
  failed?: ReadonlySet<number>;
  /** Expected seconds for an utterance not yet synthesised. */
  estimateSeconds: (index: number) => number;
}

export interface QueueOptions {
  /** Keep at least this much audio ready or on its way beyond the current utterance's start. */
  aheadSeconds: number;
  /** Most engine calls at once (1 for the single-threaded browser worker). */
  maxInFlight: number;
}

/** Kokoro reads English at roughly 15 characters a second at speed 1. */
export function estimateUtteranceSeconds(text: string): number {
  return Math.max(0.6, text.length / 15);
}

/** The utterances to request now, nearest first. Empty when enough is ready or in flight. */
export function nextRequests(input: QueueInput, options: QueueOptions): number[] {
  const out: number[] = [];
  let slots = Math.max(0, options.maxInFlight - input.inFlight.size);
  let ahead = 0;
  for (let i = Math.max(0, input.current); i < input.total; i += 1) {
    if (ahead >= options.aheadSeconds) break;
    const known = input.ready.get(i);
    const skip = input.failed?.has(i) ?? false;
    if (known === undefined && !input.inFlight.has(i) && !skip) {
      if (slots === 0) break;
      out.push(i);
      slots -= 1;
    }
    if (!skip) ahead += known ?? input.estimateSeconds(i);
  }
  return out;
}

/** Seconds of contiguous ready audio from `current`, the buffer that survives a locked screen. */
export function readySecondsFrom(current: number, total: number, ready: ReadonlyMap<number, number>): number {
  let s = 0;
  for (let i = current; i < total; i += 1) {
    const d = ready.get(i);
    if (d === undefined) break;
    s += d;
  }
  return s;
}
