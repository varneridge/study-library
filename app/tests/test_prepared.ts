// Unit tests for prepared Listen audio on the device (prepared.ts, preparedKey.ts).
import assert from "node:assert/strict";
import { betterTier, downloadPrepared, fitDecoded, forgetCacheIndex, parsePrepared, PreparedAudioEngine, preparedUrl, requestPreparation, type PreparedDeps } from "../src/lib/listen/prepared";
import { isPreparedAudioKey, preparedAudioKey } from "../src/lib/listen/preparedKey";
import { PRONUNCIATION_VERSION } from "../src/lib/listen/spokenText";
import type { SynthResult, TtsEngine } from "../src/lib/listen/types";
import fixtures from "../../shared/pronunciation-fixtures.json";
import { describeSpeech } from "../src/components/SpeechState";
import { formatBytes, nearlyFull } from "../src/components/ListenUsage";
import { ROW_COST, writesThatFit } from "../src/lib/listen/limits";

type Test = (name: string, fn: () => void | Promise<void>) => void;

function frame(header: object, mp3: number[]): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + mp3.length);
  out.set([0x4b, 0x54, 0x4d, 0x31]);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(mp3, 8 + json.length);
  return out;
}

class MemoryCache {
  store = new Map<string, Uint8Array>();
  async delete(url: string) {
    return this.store.delete(url);
  }
  async match(url: string) {
    const hit = this.store.get(url);
    return hit ? new Response(hit.slice()) : undefined;
  }
  async put(url: string, response: Response) {
    this.store.set(url, new Uint8Array(await response.arrayBuffer()));
  }
}

function fallbackEngine(calls: string[]): TtsEngine {
  return {
    id: "browser",
    ready: async () => {},
    voices: async () => [],
    synthesise: async (text) => {
      calls.push(text);
      return { sampleRate: 24000, pcm: new Float32Array(10), tokens: [], engine: "browser", modelVersion: "fallback" } as SynthResult;
    },
  };
}

export function registerPreparedTests(test: Test): void {
  test("prepared: keys are stable, short and follow voice, text and the rules version", async () => {
    const a = await preparedAudioKey("bf_emma", "Hello.");
    assert.equal(a, await preparedAudioKey("bf_emma", "Hello."));
    assert.notEqual(a, await preparedAudioKey("bm_george", "Hello."));
    assert.notEqual(a, await preparedAudioKey("bf_emma", "Hello!"));
    assert.ok(isPreparedAudioKey(a));
    assert.ok(!isPreparedAudioKey("../etc"));
  });

  test("prepared: the rules version matches the shared fixtures and the Python twin", () => {
    assert.equal(PRONUNCIATION_VERSION, fixtures.version);
  });

  test("prepared: files are parsed and decoded audio is cut to the recorded length", () => {
    const parsed = parsePrepared(frame({ sampleRate: 24000, samples: 3, voice: "bf_emma", modelVersion: "m", tokens: [] }, [1, 2, 3]));
    assert.deepEqual([...parsed!.mp3], [1, 2, 3]);
    assert.equal(parsed!.header.samples, 3);
    assert.equal(parsePrepared(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), null);
    const decoded = Float32Array.from({ length: 1105 + 4 }, (_, i) => i);
    assert.deepEqual([...fitDecoded(decoded, 4)], [1105, 1106, 1107, 1108]);
    assert.equal(fitDecoded(Float32Array.from([1, 2]), 4).length, 2);
  });

  test("prepared: prepared paragraphs play from their file, keep it, and the rest fall back once reported", async () => {
    const key = await preparedAudioKey("bf_emma", "Ready.");
    const cache = new MemoryCache();
    const fetched: string[] = [];
    const deps: PreparedDeps = {
      fetch: (async (url: string) => {
        fetched.push(url);
        return url === preparedUrl(key)
          ? new Response(frame({ sampleRate: 24000, samples: 2, voice: "bf_emma", modelVersion: "m", tokens: [{ text: "Ready.", start: 0, end: 0.1 }] }, [9]))
          : new Response("{}", { status: 404 });
      }) as typeof fetch,
      decode: async () => Float32Array.from([0.5, 0.25]),
      cache: async () => cache as unknown as Cache,
      lexicon: async () => [],
    };
    const calls: string[] = [];
    const missing: string[] = [];
    const engine = new PreparedAudioEngine(fallbackEngine(calls), (v) => missing.push(v), deps);
    const signal = new AbortController().signal;
    const ready = await engine.synthesise("Ready.", "bf_emma", signal);
    assert.deepEqual([...ready.pcm], [0.5, 0.25]);
    assert.equal(ready.tokens[0].text, "Ready.");
    assert.equal(ready.modelVersion, "prepared:m");
    await engine.synthesise("Ready.", "bf_emma", signal);
    assert.equal(fetched.filter((u) => u === preparedUrl(key)).length, 1, "the second play comes from the device's cache");
    await engine.synthesise("Not yet.", "bf_emma", signal);
    await engine.synthesise("Nor this.", "bf_emma", signal);
    assert.deepEqual(calls, ["Not yet.", "Nor this."]);
    assert.deepEqual(missing, ["bf_emma"], "a voice with missing paragraphs is reported once");
  });

  test("prepared: the engine names and reads paragraphs as the pronunciation layer marks them", async () => {
    const seen: string[] = [];
    const fallback = fallbackEngine(seen);
    const fetched: string[] = [];
    const deps: PreparedDeps = {
      fetch: (async (url: string) => { fetched.push(url); return new Response("", { status: 404 }); }) as typeof fetch,
      decode: async () => new Float32Array(0),
      cache: async () => null,
      lexicon: async () => [{ word: "Ussuri", say: "oo-SOO-ree" }],
    };
    await new PreparedAudioEngine(fallback, () => {}, deps).synthesise("On the Ussuri, c. 1969.", "bf_emma", new AbortController().signal);
    const marked = "On the [Ussuri](/u\u02d0s\u02c8u\u02d0\u0279i\u02d0/), circa nineteen sixty-nine.";
    assert.deepEqual(seen, [marked]);
    assert.equal(fetched[0], preparedUrl(await preparedAudioKey("bf_emma", marked)));
  });

  test("prepared: offline, every paragraph is read by the engine", async () => {
    const calls: string[] = [];
    const deps: PreparedDeps = { fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch, decode: async () => new Float32Array(0), cache: async () => null, lexicon: async () => [] };
    const engine = new PreparedAudioEngine(fallbackEngine(calls), () => {}, deps);
    await engine.synthesise("Anything.", "bf_emma", new AbortController().signal);
    assert.deepEqual(calls, ["Anything."]);
  });

  test("prepared: requests go in batches and ready paragraphs are downloaded", async () => {
    forgetCacheIndex();
    const bodies: Array<{ utterances: string[] }> = [];
    const doFetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { utterances: string[] };
      bodies.push(body);
      return new Response(JSON.stringify({ items: body.utterances.map((t) => ({ key: t, ready: true })) }));
    }) as typeof fetch;
    const texts = Array.from({ length: 450 }, (_, i) => `p${i}`);
    const items = await requestPreparation("item", "bf_emma", texts, [], doFetch);
    assert.deepEqual(bodies.map((b) => b.utterances.length), [400, 50]);
    assert.equal(items.length, 450);
    const cache = new MemoryCache();
    const deps: PreparedDeps = { fetch: (async () => new Response(new Uint8Array([1]))) as typeof fetch, decode: async () => new Float32Array(0), cache: async () => cache as unknown as Cache, lexicon: async () => [] };
    assert.equal(await downloadPrepared(["a", "b", "c"], deps), 3);
    assert.equal([...cache.store.keys()].filter((k) => !k.startsWith("/__")).length, 3);
  });
}

export function registerPreparedTierTests(test: Test): void {
  test("prepared: audio from a lesser machine is fetched again once a graphics card has remade it", async () => {
    assert.ok(betterTier("gpu", "cpu"));
    assert.ok(betterTier("gpu", undefined));
    assert.ok(!betterTier("cpu", "gpu"));
    assert.ok(!betterTier(null, "cpu"));
    const cache = new MemoryCache();
    const old = frame({ sampleRate: 24000, samples: 1, voice: "bf_emma", modelVersion: "m", tier: "cpu", tokens: [] }, [1]);
    cache.store.set(preparedUrl("k1"), old);
    const fetched: Array<RequestInit | undefined> = [];
    const better = frame({ sampleRate: 24000, samples: 1, voice: "bf_emma", modelVersion: "m", tier: "gpu", tokens: [] }, [2]);
    const deps: PreparedDeps = {
      fetch: (async (_url: string, init?: RequestInit) => { fetched.push(init); return new Response(better); }) as typeof fetch,
      decode: async () => new Float32Array(0),
      cache: async () => cache as unknown as Cache,
      lexicon: async () => [],
    };
    await downloadPrepared([{ key: "k1", tier: "cpu" }], deps);
    assert.equal(fetched.length, 0, "the same tier is kept");
    await downloadPrepared([{ key: "k1", tier: "gpu" }], deps);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0]?.cache, "reload");
    assert.equal(parsePrepared(cache.store.get(preparedUrl("k1"))!)!.header.tier, "gpu");
  });

  test("speech: Settings describes each engine in words", () => {
    assert.match(describeSpeech(null), /not answering/);
    assert.match(describeSpeech({ engine: "torch", device: "cuda" }), /graphics card.*prepares Listen audio first/);
    assert.match(describeSpeech({ engine: "onnx", device: "cpu", precision: "fp32" }), /Standard speech on the processor/);
    assert.match(describeSpeech({ engine: "onnx", device: "cpu", precision: "int8" }), /compressed/);
  });
}

export function registerPreparedLimitTests(test: Test): void {
  test("limits: Listen's writes stop at its share of the daily allowance", () => {
    assert.equal(writesThatFit(0, 100, 30_000), 100);
    assert.equal(writesThatFit(29_990, 100, 30_000), Math.floor(10 / ROW_COST), "each paragraph costs its own row and one for each index");
    assert.equal(writesThatFit(30_000, 100, 30_000), 0);
    assert.equal(writesThatFit(31_000, 100, 30_000), 0);
  });

  test("limits: a device keeps prepared audio under its cap, removing what was played longest ago", async () => {
    forgetCacheIndex();
    const cache = new MemoryCache();
    let n = 0;
    const deps: PreparedDeps = {
      fetch: (async () => new Response(new Uint8Array(400))) as typeof fetch,
      decode: async () => new Float32Array(0),
      cache: async () => cache as unknown as Cache,
      lexicon: async () => [],
      deviceCap: 1000,
    };
    const tick = () => new Promise((r) => setTimeout(r, 2 + n++));
    await downloadPrepared(["a"], deps);
    await tick();
    await downloadPrepared(["b"], deps);
    await tick();
    await downloadPrepared(["a"], deps); // played again, so "b" is now the oldest
    await tick();
    await downloadPrepared(["c"], deps); // 1,200 bytes against a 1,000 cap
    const kept = [...cache.store.keys()].filter((k) => !k.startsWith("/__"));
    assert.deepEqual(kept.sort(), [preparedUrl("a"), preparedUrl("c")]);
    forgetCacheIndex();
  });

  test("limits: Settings shows sizes in words and warns at 80%", () => {
    assert.equal(formatBytes(340 * 1024 ** 2), "340 MB");
    assert.equal(formatBytes(1.25 * 1024 ** 3), "1.3 GB");
    assert.equal(formatBytes(5 * 1024 ** 3), "5 GB");
    assert.ok(nearlyFull(80, 100) && !nearlyFull(79, 100) && !nearlyFull(1, 0));
  });
}
