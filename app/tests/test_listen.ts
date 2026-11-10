
// Unit tests for Listen modules (script, align, edition, queue, highlight, mp3,
// rate, durations, modelProbe) and for the controller's playback behaviour.
import assert from "node:assert/strict";
import { alignWords, buildTimeline, timeForOffset, tokeniseWords, wordIndexAt } from "../src/lib/listen/align";
import { audioFramesOnly, parseMp3 } from "../src/lib/listen/mp3";
import {
  buildListenScript,
  flatten,
  pageToScript,
  pageToScriptNearest,
  paragraphOf,
  paragraphStartFor,
  scriptRangeToPageRanges,
  scriptToPage,
  sentenceRanges,
  splitUtterances,
  utteranceAt,
  wordStartAt,
  MAX_UTTERANCE_CHARS,
  type ReflowBlock,
} from "../src/lib/listen/script";
import { joinEdition, planEdition } from "../src/lib/listen/edition";
import { FollowGate, followWordDelta, paragraphTopDelta, scrollDelta } from "../src/lib/listen/highlight";
import { estimateUtteranceSeconds, nextRequests, readySecondsFrom } from "../src/lib/listen/queue";
import { clampRate, formatRate, quantiseRate, rampRate } from "../src/lib/listen/rate";
import { chunkTokens } from "../src/lib/listen/durations";
import { explainProbes, probeModel } from "../src/lib/listen/modelProbe";
import { createListenController, seekTimeFor, wordIndexAtTime } from "../src/lib/listen/controller";
import { KokoroLoadError } from "../src/lib/listen/browserEngine";
import { isEngineUnavailable, pickSpeechVoice, type SpeechBackend, type SpeechUtteranceLike } from "../src/lib/listen/speech";
import type { ListenScript, SynthResult, TtsEngine } from "../src/lib/listen/types";
import { MAX_RATE } from "../src/lib/listen/types";

// Silence unused-import lint for helpers kept available to future tests.
void buildTimeline;
void timeForOffset;
void wordIndexAt;
void audioFramesOnly;
void parseMp3;
void joinEdition;

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** An audio element that plays nothing and records what it was told. */
function fakeAudio() {
  let src = "";
  const a = {
    srcSets: 0,
    currentTime: 0,
    playbackRate: 1,
    defaultPlaybackRate: 1,
    preservesPitch: true,
    paused: true,
    ended: false,
    readyState: 4,
    duration: 1,
    ontimeupdate: null as null | (() => void),
    onended: null as null | (() => void),
    onpause: null as null | (() => void),
    onplay: null as null | (() => void),
    async play() {
      a.paused = false;
    },
    pause() {
      a.paused = true;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  Object.defineProperty(a, "src", {
    get: () => src,
    set: (v: string) => {
      src = v;
      a.srcSets += 1;
    },
  });
  return a as typeof a & { src: string };
}

/** An engine that makes one second of audio per paragraph, recording every request in order. */
function fakeEngine(fail?: Error) {
  const requests: string[] = [];
  const engine: TtsEngine = {
    id: "browser",
    ready: async () => {},
    voices: async () => [],
    synthesise(text: string, _voice: string, signal: AbortSignal): Promise<SynthResult> {
      requests.push(text);
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        setTimeout(() => {
          if (fail) reject(fail);
          else resolve({ sampleRate: 24000, pcm: new Float32Array(24000), tokens: [], engine: "browser", modelVersion: "test" });
        }, 0);
      });
    },
  };
  return { engine, requests };
}

const threeParagraphs: ReflowBlock[] = [
  { kind: "para", lines: [{ page: 0, start: 0, text: "Alpha beta gamma." }] },
  { kind: "para", lines: [{ page: 0, start: 20, text: "Delta epsilon zeta." }] },
  { kind: "para", lines: [{ page: 0, start: 40, text: "Eta theta iota." }] },
];

export function registerListenTests(test: (name: string, fn: () => void | Promise<void>) => void): void {
  const blocks: ReflowBlock[] = [
    { kind: "heading", lines: [{ page: 0, start: 0, text: "Introduction" }] },
    {
      kind: "para",
      lines: [
        { page: 0, start: 13, text: "The commu-", hyphen: true },
        { page: 0, start: 23, text: "nity met in 1984, e.g. at St. Ives. " },
        { page: 1, start: 0, text: "It rained! Nobody left." },
      ],
    },
    { kind: "note", lines: [{ page: 1, start: 30, text: "1 A footnote that is never read." }] },
  ];

  test("listen: flatten skips headings and notes and joins text cleanly", () => {
    const { text } = flatten(blocks);
    // Headings and notes are both skipped for a distraction-free audio experience
    assert.equal(text, "The community met in 1984, e.g. at St. Ives. It rained! Nobody left.");
    assert.ok(!text.includes("Introduction"));
    assert.ok(!text.includes("footnote"));
  });

  test("listen: script to page mapping across hyphens and page turns", () => {
    const { text, pieces } = flatten(blocks);
    const s = { pieces };
    const at = text.indexOf("nity");
    assert.deepEqual(scriptToPage(s, at), { page: 0, at: 23 });
    assert.deepEqual(scriptToPage(s, text.indexOf("It rained")), { page: 1, at: 0 });
    assert.equal(pageToScript(s, { page: 1, at: 3 }), text.indexOf("rained"));
    const word = text.indexOf("community");
    assert.deepEqual(scriptRangeToPageRanges(s, word, word + "community".length), [
      { page: 0, start: 17, end: 22 },
      { page: 0, start: 23, end: 27 },
    ]);
  });

  test("listen: splits sentences without breaking at abbreviations or initials", () => {
    const { text } = flatten(blocks);
    const s = sentenceRanges(text, 0, text.length).map(([a, b]) => text.slice(a, b));
    assert.deepEqual(s, ["The community met in 1984, e.g. at St. Ives.", "It rained!", "Nobody left."]);
  });

  test("listen: a paragraph is one utterance, however many sentences it has", () => {
    const { text, headings } = flatten(blocks);
    const u = splitUtterances(text, headings);
    assert.equal(u.length, 1);
    assert.equal(u[0].text, "The community met in 1984, e.g. at St. Ives. It rained! Nobody left.");
    assert.equal(u[0].paragraph, 0);
  });

  test("listen: a long paragraph is cut into chunks of whole sentences within the limit", () => {
    const sentence = (n: number) => `Sentence ${n} ${"runs on with many words ".repeat(7).trim()}.`;
    const long = [1, 2, 3, 4].map(sentence).join(" ");
    assert.ok(long.length > MAX_UTTERANCE_CHARS);
    const text = `${long}\nA short second paragraph.`;
    const u = splitUtterances(text, []);
    const firstParagraph = u.filter((x) => x.paragraph === 0);
    assert.ok(firstParagraph.length >= 2);
    for (const x of firstParagraph) {
      assert.ok(x.text.length <= MAX_UTTERANCE_CHARS);
      assert.ok(x.text.endsWith("."), `chunk ends mid-sentence: ${x.text.slice(-20)}`);
    }
    assert.equal(firstParagraph.map((x) => x.text).join(" "), long);
    assert.deepEqual(u[u.length - 1], { index: u.length - 1, paragraph: 1, start: long.length + 1, end: text.length, text: "A short second paragraph.", kind: "body" });
    assert.deepEqual(paragraphOf(u, 1), { paragraph: 0, first: 0, last: firstParagraph.length - 1, start: 0, end: long.length });
  });

  test("listen: keeps every utterance within length limits", () => {
    const long = "word ".repeat(300).trim() + ".";
    const u = splitUtterances(long, [], 100);
    assert.ok(u.length > 10);
    for (const x of u) {
      assert.ok(x.text.length <= 100);
    }
  });

  test("listen: builds script with sha256 hash and finds utterances", async () => {
    const script = await buildListenScript(blocks);
    assert.match(script.hash, /^[0-9a-f]{64}$/);
    assert.equal(utteranceAt(script.utterances, script.text.indexOf("Nobody")), 0);
  });

  test("listen: a tap maps to the start of its word, and a tap between runs to the next word", async () => {
    const script = await buildListenScript(threeParagraphs);
    const at = pageToScriptNearest(script, { page: 0, at: 8 }); // inside "beta"
    assert.equal(wordStartAt(script.text, at!), script.text.indexOf("beta"));
    assert.equal(pageToScriptNearest(script, { page: 0, at: 18 }), script.text.indexOf("Delta")); // the gap after a paragraph
    assert.equal(wordStartAt("don't stop", 4), 0);
    assert.equal(wordStartAt("one, two", 3), 5);
  });

  test("listen: the reading place snaps to the start of its paragraph", () => {
    assert.deepEqual(paragraphStartFor(blocks, { page: 1, at: 5 }), { page: 0, at: 13 });
    assert.deepEqual(paragraphStartFor(blocks, { page: 0, at: 30 }), { page: 0, at: 13 });
    assert.equal(paragraphStartFor(blocks, { page: 1, at: 40 }), null); // inside a note
  });

  test("listen: word seeking within an utterance", () => {
    const words = alignWords("Alpha beta gamma.", [], 1.7);
    assert.equal(seekTimeFor(words, 0), 0);
    assert.ok(Math.abs(seekTimeFor(words, 6) - 0.6) < 1e-9); // "beta": weights 6, 5, 6 over 1.7 s
    assert.ok(Math.abs(seekTimeFor(words, 8) - 0.6) < 1e-9); // inside "beta" still seeks to its start
    assert.equal(seekTimeFor([], 5), 0);
    assert.equal(wordIndexAtTime(words, 0.65), 1);
    assert.equal(wordIndexAtTime(words, -1), -1);
  });

  test("listen: gradual speed up by paragraph or by minute, up to its cap", () => {
    const ramp = { enabled: true, step: 0.05, every: "paragraph" as const, maxBoost: 0.5 };
    assert.equal(rampRate(1, ramp, 0, 0), 1);
    assert.equal(rampRate(1, ramp, 3, 0), 1.15);
    assert.equal(rampRate(1, ramp, 40, 0), 1.5);
    assert.equal(rampRate(1.25, { ...ramp, every: "minute" }, 0, 125), 1.35);
    assert.equal(rampRate(1, { ...ramp, enabled: false }, 10, 600), 1);
    assert.equal(rampRate(MAX_RATE, ramp, 10, 0), MAX_RATE);
    assert.equal(quantiseRate(1.234), 1.25);
    assert.equal(clampRate(Number.NaN), 1);
    assert.equal(formatRate(1.5), "1.5x");
    assert.equal(formatRate(2), "2x");
  });

  test("listen: queue calculates next requests and buffers", () => {
    const est = () => 2;
    const r = nextRequests({ current: 3, total: 20, ready: new Map(), inFlight: new Set(), estimateSeconds: est }, { aheadSeconds: 7, maxInFlight: 10 });
    assert.deepEqual(r, [3, 4, 5, 6]);

    assert.equal(readySecondsFrom(1, 5, new Map([[1, 2], [2, 3], [4, 9]])), 5);
    assert.ok(Math.abs(estimateUtteranceSeconds("x".repeat(150)) - 10) < 0.01);
  });

  test("listen: plans audio editions", () => {
    assert.deepEqual(planEdition([4, 4, 4, 4], 1, 9), { from: 1, to: 3, seconds: 8 });
    assert.deepEqual(planEdition([30, 1], 0, 10), { from: 0, to: 1, seconds: 30 });
  });

  test("listen: follow gate and scroll delta", () => {
    const gate = new FollowGate(1000);
    assert.ok(gate.follows(10000));
    gate.userScrolled(10000);
    assert.ok(!gate.follows(10500));
    assert.ok(gate.follows(11100));

    // Word above band
    const d1 = scrollDelta({ top: 50, bottom: 70 }, { top: 100, height: 500 });
    assert.ok(d1 < 0);
    // Word inside band (between 200 and 450)
    const d2 = scrollDelta({ top: 250, bottom: 270 }, { top: 100, height: 500 });
    assert.equal(d2, 0);
  });

  test("listen: a new paragraph scrolls to the top, and a word near the top is left there", () => {
    const view = { top: 0, height: 600 };
    assert.equal(paragraphTopDelta(340, view, 40), 300);
    assert.equal(paragraphTopDelta(40.5, view, 40), 0);
    assert.equal(followWordDelta({ top: 45, bottom: 65 }, view, 40), 0); // just under the header: stays
    assert.ok(followWordDelta({ top: 560, bottom: 580 }, view, 40) > 0); // near the bottom of a tall paragraph
    assert.ok(followWordDelta({ top: 10, bottom: 30 }, view, 40) < 0); // scrolled out above
  });

  test("listen: word tokenisation and timeline alignment", () => {
    const words = tokeniseWords("Hello, world! 123");
    assert.equal(words.length, 3);
    assert.equal(words[0].norm, "hello");
    assert.equal(words[1].norm, "world");

    const tokens = [
      { text: "Hello", start: 0, end: 0.5 },
      { text: "world", start: 0.6, end: 1.1 },
    ];
    const aligned = alignWords("Hello world", tokens, 1.2);
    assert.equal(aligned.length, 2);
    assert.equal(aligned[0].source, "engine");
    assert.equal(aligned[1].source, "engine");
  });

  test("listen: without model durations, words are timed within their own sentence", () => {
    const tokens = chunkTokens([
      { text: "One two.", seconds: 1 },
      { text: "Three.", seconds: 2 },
    ]);
    assert.deepEqual(tokens.map((t) => t.text), ["One", "two", "Three"]);
    assert.equal(tokens[2].start, 1);
    assert.equal(tokens[2].end, 3);
    const aligned = alignWords("One two. Three.", tokens, 3);
    assert.ok(aligned.every((w) => w.source === "engine"));
    assert.equal(aligned[2].t0, 1);
  });

  test("listen: a model that cannot be fetched is explained, not reported as a bare failure", async () => {
    const offline = await probeModel("onnx-community/Kokoro-82M-v1.0-ONNX", async () => {
      throw new TypeError("Failed to fetch");
    });
    assert.equal(offline.kind, "network");
    const blocked = await probeModel(
      "onnx-community/Kokoro-82M-v1.0-ONNX",
      async () => {
        throw new TypeError("Failed to fetch");
      },
      () => ["connect-src blocked https://huggingface.co/onnx-community"],
    );
    assert.equal(blocked.kind, "csp");
    const missing = await probeModel("x/y", async () => new Response("", { status: 404 }));
    assert.equal(missing.kind, "not-found");
    const ok = await probeModel("x/y", async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    assert.ok(ok.ok);
    assert.match(explainProbes([missing, offline]), /huggingface\.co could not be reached/);
    assert.ok(isEngineUnavailable(new KokoroLoadError("Kokoro could not load: x")));
    assert.ok(!isEngineUnavailable(new Error("Synthesis failed: bad input")));
    assert.equal(pickSpeechVoice([{ name: "A", lang: "en-US" }, { name: "B", lang: "en_GB" }])?.name, "B");
  });

  test("listen: pressing play twice at once still plays (regression: the player stalled while buffering)", async () => {
    const script = await buildListenScript(threeParagraphs);
    const { engine } = fakeEngine();
    const audio = fakeAudio();
    const c = createListenController({ script, engine, audio: audio as unknown as HTMLAudioElement, title: "t", album: "a", speech: null });
    void c.play();
    void c.play();
    await flush();
    assert.equal(c.getSnapshot().state, "playing");
    assert.ok(audio.src.startsWith("blob:"));
  });

  test("listen: plays the first paragraph as soon as it is made and makes only the next while it plays", async () => {
    const script = await buildListenScript(threeParagraphs);
    const { engine, requests } = fakeEngine();
    const audio = fakeAudio();
    const c = createListenController({ script, engine, audio: audio as unknown as HTMLAudioElement, title: "t", album: "a", speech: null });
    await c.play();
    await flush();
    assert.equal(c.getSnapshot().state, "playing");
    assert.deepEqual(requests, ["Alpha beta gamma.", "Delta epsilon zeta."]);
    audio.onended?.();
    await flush();
    assert.equal(c.getSnapshot().paragraph, 1);
    assert.deepEqual(requests, ["Alpha beta gamma.", "Delta epsilon zeta.", "Eta theta iota."]);
  });

  test("listen: a tap in the paragraph playing seeks without reloading, and a tap elsewhere starts at that word", async () => {
    const script = await buildListenScript(threeParagraphs);
    const { engine } = fakeEngine();
    const audio = fakeAudio();
    const c = createListenController({ script, engine, audio: audio as unknown as HTMLAudioElement, title: "t", album: "a", speech: null });
    await c.play();
    await flush();
    const loads = audio.srcSets;
    await c.playFromPoint({ page: 0, at: 8 }); // "beta"
    assert.equal(audio.srcSets, loads, "the playing paragraph is not reloaded");
    assert.ok(Math.abs(audio.currentTime - 6 / 17) < 1e-9);
    await c.playFromPoint({ page: 0, at: 45 }); // "theta", not yet made
    await flush();
    assert.equal(c.getSnapshot().utterance, 2);
    assert.equal(c.getSnapshot().state, "playing");
    assert.ok(audio.srcSets > loads);
    assert.ok(Math.abs(audio.currentTime - 4 / 15) < 1e-9); // "theta": weights 4, 6, 5
  });

  test("listen: gradual speed up raises the speed when a paragraph ends", async () => {
    const script = await buildListenScript(threeParagraphs);
    const { engine } = fakeEngine();
    const audio = fakeAudio();
    const c = createListenController({ script, engine, audio: audio as unknown as HTMLAudioElement, title: "t", album: "a", speech: null });
    c.setRate(1.2);
    c.setRamp({ enabled: true, step: 0.05, every: "paragraph", maxBoost: 0.5 });
    await c.play();
    await flush();
    assert.equal(audio.playbackRate, 1.2);
    audio.onended?.();
    await flush();
    assert.equal(audio.playbackRate, 1.25);
    assert.equal(c.getSnapshot().rate, 1.25);
    assert.equal(c.getSnapshot().baseRate, 1.2);
    c.setRate(1.5); // a speed chosen by hand starts the ramp again from it
    assert.equal(audio.playbackRate, 1.5);
  });

  test("listen: when Kokoro cannot load, the device's voice reads instead", async () => {
    const script = await buildListenScript(threeParagraphs);
    const { engine } = fakeEngine(new KokoroLoadError("Kokoro could not load: huggingface.co could not be reached"));
    const audio = fakeAudio();
    const spoken: SpeechUtteranceLike[] = [];
    const speech: SpeechBackend = {
      synth: { speak: (u) => spoken.push(u), cancel() {}, pause() {}, resume() {}, getVoices: () => [{ name: "Daniel", lang: "en-GB" }] },
      make: (text) => ({ text, rate: 1, lang: "", voice: null, onboundary: null, onend: null, onerror: null }),
    };
    const c = createListenController({ script, engine, audio: audio as unknown as HTMLAudioElement, title: "t", album: "a", speech });
    await c.play();
    await flush();
    const snap = c.getSnapshot();
    assert.equal(snap.backend, "speech");
    assert.equal(snap.state, "playing");
    assert.match(snap.error ?? "", /device's voice/);
    assert.deepEqual(spoken.map((u) => u.text), ["Alpha beta gamma."]);
    assert.equal(spoken[0].lang, "en-GB");
    spoken[0].onend?.();
    await flush();
    assert.deepEqual(spoken.map((u) => u.text), ["Alpha beta gamma.", "Delta epsilon zeta."]);
  });

  test("listen: the resume point is a paragraph start, or the one before when it had only just begun", async () => {
    const script: ListenScript = await buildListenScript(threeParagraphs);
    const { engine } = fakeEngine();
    const audio = fakeAudio();
    let clock = 0;
    const c = createListenController({ script, engine, audio: audio as unknown as HTMLAudioElement, title: "t", album: "a", speech: null, now: () => clock });
    await c.play();
    await flush();
    audio.onended?.();
    await flush();
    assert.deepEqual(c.getResumePoint(), { page: 0, at: 0 }); // just into paragraph 2: go back to paragraph 1
    for (let i = 0; i < 5; i += 1) {
      clock += 1000;
      audio.ontimeupdate?.();
    }
    assert.deepEqual(c.getResumePoint(), { page: 0, at: 20 });
  });
}
