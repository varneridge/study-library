// An edition is one continuous MP3 made of consecutive encoded utterances,
// played from a single blob: URL. It is what makes listening with the screen
// off reliable on an iPhone, where a page stops running scripts once the
// screen locks and only an already loaded media file keeps playing. Every
// utterance is CBR MP3 at the same rate, so their audio frames join into one
// valid stream, and frame counting (mp3.ts) gives each utterance's exact start.

import { buildTimeline } from "./align";
import { audioFramesOnly, parseMp3 } from "./mp3";
import type { PlaybackTimeline, WordTiming } from "./types";

export interface EditionPart {
  utterance: number;
  /** Offset of the utterance in ListenScript.text. */
  scriptStart: number;
  mp3: Uint8Array;
  words: WordTiming[];
}

export interface Edition {
  bytes: Uint8Array;
  timeline: PlaybackTimeline;
  from: number;
  /** Exclusive. */
  to: number;
  sampleRate: number;
}

/** The utterances an edition of at most `maxSeconds` starting at `from` covers, end exclusive. */
export function planEdition(estimates: number[], from: number, maxSeconds: number): { from: number; to: number; seconds: number } {
  let seconds = 0;
  let to = from;
  while (to < estimates.length && (to === from || seconds + estimates[to] <= maxSeconds)) {
    seconds += estimates[to];
    to += 1;
  }
  return { from, to, seconds };
}

/**
 * Join consecutive encoded utterances into one MP3 and its timeline.
 * Throws when the parts are not consecutive or not all at one sample rate,
 * because either would make every later word time wrong.
 */
export function joinEdition(parts: EditionPart[], primingSeconds = 0): Edition {
  if (!parts.length) throw new Error("an edition needs at least one utterance");
  const frames: Uint8Array[] = [];
  const rendered: Array<{ utterance: number; scriptStart: number; samples: number; sampleRate: number; words: WordTiming[] }> = [];
  let sampleRate = 0;
  parts.forEach((p, i) => {
    if (i > 0 && p.utterance !== parts[i - 1].utterance + 1) {
      throw new Error(`edition parts must be consecutive: ${parts[i - 1].utterance} then ${p.utterance}`);
    }
    const audio = audioFramesOnly(p.mp3);
    const info = parseMp3(audio);
    if (sampleRate && info.sampleRate !== sampleRate) throw new Error("edition parts differ in sample rate");
    sampleRate = info.sampleRate;
    frames.push(audio);
    rendered.push({ utterance: p.utterance, scriptStart: p.scriptStart, samples: info.samples, sampleRate: info.sampleRate, words: p.words });
  });
  const bytes = new Uint8Array(frames.reduce((s, f) => s + f.length, 0));
  let o = 0;
  for (const f of frames) {
    bytes.set(f, o);
    o += f.length;
  }
  return {
    bytes,
    timeline: buildTimeline(rendered, primingSeconds),
    from: parts[0].utterance,
    to: parts[parts.length - 1].utterance + 1,
    sampleRate,
  };
}
