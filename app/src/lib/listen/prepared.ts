// Prepared audio on the device. A paragraph prepared ahead of time by the
// full Kokoro model (backend/tts/prepare.py, through worker/listen.ts) plays
// from its finished file; anything not prepared yet is read by the engine
// Listen would otherwise use. On a phone this is the difference between
// running Kokoro's compressed model in the browser and simply playing audio.
//
// Files are kept in Cache Storage once fetched, and a reading's prepared
// paragraphs are downloaded there when Listen opens, so a reading heard once
// on Wi-Fi plays again offline and with the screen locked.

import { annotate, type PronunciationEntry } from "./annotate";
import { preparedAudioKey } from "./preparedKey";
import type { SynthResult, TimedToken, TtsEngine, VoiceInfo } from "./types";

export const PREPARED_CACHE = "listen-prepared-v1";
const MAGIC = [0x4b, 0x54, 0x4d, 0x31]; // "KTM1"
/** The delay an MP3 decoder adds at the start (576 encoder plus 529 decoder samples), when the browser does not trim it. */
const MP3_DELAY = 1105;
const PREPARE_BATCH = 400;

export interface PreparedHeader {
  sampleRate: number;
  samples: number;
  voice: string;
  modelVersion: string;
  /** The kind of machine that made it: gpu, cpu or basic. Absent in files made before tiers. */
  tier?: string;
  tokens: TimedToken[];
}

const TIER_RANK: Record<string, number> = { basic: 0, cpu: 1, gpu: 2 };

/** Whether audio made on a `have` machine should be fetched again because a `want` machine has remade it. */
export function betterTier(want: string | null | undefined, have: string | null | undefined): boolean {
  return (TIER_RANK[want ?? ""] ?? -1) > (TIER_RANK[have ?? ""] ?? 0);
}

export function preparedUrl(key: string): string {
  return `/api/listen/audio/${key}`;
}

/** The header and MP3 of a prepared file, or null when it is not one. */
export function parsePrepared(bytes: Uint8Array): { header: PreparedHeader; mp3: Uint8Array } | null {
  if (bytes.length < 8 || MAGIC.some((b, i) => bytes[i] !== b)) return null;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true);
  if (8 + n > bytes.length) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as PreparedHeader;
    return { header, mp3: bytes.subarray(8 + n) };
  } catch {
    return null;
  }
}

/**
 * Decoded audio cut to the length the preparing machine recorded. Browsers
 * that read the encoder's gapless information already trim the MP3's own
 * delay; one that does not leaves it at the start, so it is dropped there.
 */
export function fitDecoded(decoded: Float32Array, samples: number): Float32Array {
  if (decoded.length <= samples) return decoded;
  const start = Math.min(decoded.length - samples, MP3_DELAY);
  return decoded.slice(start, start + samples);
}

/** MP3 to mono PCM at the given rate, with the browser's own decoder. */
export async function decodeMp3(mp3: Uint8Array, sampleRate: number): Promise<Float32Array> {
  const context = new OfflineAudioContext(1, 1, sampleRate);
  const copy = mp3.slice().buffer;
  const audio = await context.decodeAudioData(copy);
  return audio.getChannelData(0).slice();
}

export interface PreparedDeps {
  fetch: typeof fetch;
  decode: (mp3: Uint8Array, sampleRate: number) => Promise<Float32Array>;
  /** Cache Storage, or null where the browser refuses it (private browsing). */
  cache: () => Promise<Cache | null>;
  /** The course dictionary as it is now (pronunciations.ts). */
  lexicon: () => Promise<PronunciationEntry[]>;
}

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(PREPARED_CACHE);
  } catch {
    return null;
  }
}

export const defaultDeps = (lexicon: () => Promise<PronunciationEntry[]> = async () => []): PreparedDeps => ({
  fetch: (input, init) => fetch(input, init),
  decode: decodeMp3,
  cache: openCache,
  lexicon,
});

/** The bytes of a prepared file, from the device's cache or else the Worker, or null when it is not prepared yet. */
async function preparedBytes(key: string, deps: PreparedDeps, signal?: AbortSignal, tier?: string | null): Promise<Uint8Array | null> {
  const url = preparedUrl(key);
  const cache = await deps.cache();
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  let reload = false;
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    // A copy made on a lesser machine is replaced once a better one has remade it.
    if (!betterTier(tier, parsePrepared(bytes)?.header.tier)) return bytes;
    reload = true;
  }
  let response: Response;
  try {
    response = await deps.fetch(url, { credentials: "same-origin", signal, ...(reload ? { cache: "reload" as RequestCache } : {}) });
  } catch {
    return null; // offline, or the Worker could not be reached: the engine reads it instead
  }
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (cache) await cache.put(url, new Response(bytes.slice(), { headers: { "Content-Type": "application/x-kokoro-prepared" } })).catch(() => {});
  return bytes;
}

/**
 * An engine that plays prepared audio where there is some and asks `fallback`
 * for the rest. `onMissing` hears of each voice that had a paragraph missing,
 * once, so the reader can ask for that voice to be prepared.
 */
export class PreparedAudioEngine implements TtsEngine {
  readonly id: TtsEngine["id"];
  private readonly reported = new Set<string>();

  constructor(
    private readonly fallback: TtsEngine,
    private readonly onMissing: (voice: string) => void = () => {},
    private readonly deps: PreparedDeps = defaultDeps(),
  ) {
    this.id = fallback.id;
  }

  ready(timeoutMs: number): Promise<void> {
    return this.fallback.ready(timeoutMs);
  }

  voices(): Promise<VoiceInfo[]> {
    return this.fallback.voices();
  }

  async synthesise(text: string, voice: string, signal: AbortSignal): Promise<SynthResult> {
    // The paragraph as the speech server reads it, which is also what its prepared audio is named after.
    const spoken = annotate(text, await this.deps.lexicon());
    const key = await preparedAudioKey(voice, spoken);
    const bytes = await preparedBytes(key, this.deps, signal);
    const parsed = bytes ? parsePrepared(bytes) : null;
    if (parsed && parsed.header.voice === voice) {
      try {
        const pcm = fitDecoded(await this.deps.decode(parsed.mp3, parsed.header.sampleRate), parsed.header.samples);
        return { sampleRate: parsed.header.sampleRate, pcm, tokens: parsed.header.tokens, engine: this.id, modelVersion: `prepared:${parsed.header.modelVersion}` };
      } catch {
        // A file the browser cannot decode is read by the engine instead.
      }
    }
    if (!this.reported.has(voice)) {
      this.reported.add(voice);
      this.onMissing(voice);
    }
    return this.fallback.synthesise(spoken, voice, signal);
  }
}

/** Ask for a reading's paragraphs to be prepared in one voice, as annotate() marks them. Returns each paragraph's key and whether it is ready. */
export async function requestPreparation(
  itemId: string,
  voice: string,
  written: string[],
  lexicon: PronunciationEntry[] = [],
  doFetch: typeof fetch = (input, init) => fetch(input, init),
): Promise<Array<{ key: string; ready: boolean; tier?: string | null }>> {
  const utterances = written.map((t) => annotate(t, lexicon));
  const out: Array<{ key: string; ready: boolean; tier?: string | null }> = [];
  for (let i = 0; i < utterances.length; i += PREPARE_BATCH) {
    const response = await doFetch("/api/listen/prepare", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, voice, utterances: utterances.slice(i, i + PREPARE_BATCH) }),
    });
    if (!response.ok) throw new Error(`Preparing audio was refused (HTTP ${response.status})`);
    out.push(...((await response.json()) as { items: Array<{ key: string; ready: boolean; tier?: string | null }> }).items);
  }
  return out;
}

/** Keep a reading's ready paragraphs on the device, two at a time, for listening offline. */
export async function downloadPrepared(
  items: Array<string | { key: string; tier?: string | null }>,
  deps: PreparedDeps = defaultDeps(),
  signal?: AbortSignal,
): Promise<number> {
  const wanted = items.map((i) => (typeof i === "string" ? { key: i, tier: null } : i));
  let next = 0;
  let stored = 0;
  const lane = async () => {
    while (next < wanted.length && !signal?.aborted) {
      const { key, tier } = wanted[next++];
      if (await preparedBytes(key, deps, signal, tier)) stored += 1;
    }
  };
  await Promise.all([lane(), lane()]);
  return stored;
}
