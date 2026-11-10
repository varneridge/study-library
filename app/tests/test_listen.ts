// Unit tests for Listen modules (script, align, edition, queue, highlight, mp3)
import assert from "node:assert/strict";
import { alignWords, buildTimeline, timeForOffset, tokeniseWords, wordIndexAt } from "../src/lib/listen/align";
import { audioFramesOnly, parseMp3 } from "../src/lib/listen/mp3";
import {
  buildListenScript,
  flatten,
  pageToScript,
  scriptRangeToPageRanges,
  scriptToPage,
  splitUtterances,
  utteranceAt,
  type ReflowBlock,
} from "../src/lib/listen/script";
import { joinEdition, planEdition } from "../src/lib/listen/edition";
import { FollowGate, scrollDelta } from "../src/lib/listen/highlight";
import { estimateUtteranceSeconds, nextRequests, readySecondsFrom } from "../src/lib/listen/queue";

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
    const { text, headings } = flatten(blocks);
    const u = splitUtterances(text, headings).map((x) => x.text);
    assert.deepEqual(u, ["The community met in 1984, e.g. at St. Ives.", "It rained!", "Nobody left."]);
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
    assert.equal(utteranceAt(script.utterances, script.text.indexOf("Nobody")), 2);
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
}
