// Unit tests for spokenText.ts: what each written form becomes before Kokoro reads it.
// The cases live in shared/pronunciation-fixtures.json, which the Python version shares.
import assert from "node:assert/strict";
import { cardinalWords, ordinalWords, romanValue, spokenText } from "../src/lib/listen/spokenText";
import fixtures from "../../shared/pronunciation-fixtures.json";

type Test = (name: string, fn: () => void | Promise<void>) => void;

export function registerSpokenTextTests(test: Test): void {
  test("spoken text: every case in shared/pronunciation-fixtures.json", () => {
    for (const [written, spoken] of fixtures.spokenText as Array<[string, string]>) assert.equal(spokenText(written), spoken, written);
  });

  test("spoken text: rewriting twice changes nothing more, as the server rewrites what the browser sends", () => {
    for (const [, spoken] of fixtures.spokenText as Array<[string, string]>) assert.equal(spokenText(spoken), spoken, spoken);
  });

  test("spoken text: number words", () => {
    assert.deepEqual([1, 12, 20, 23, 39].map(cardinalWords), ["one", "twelve", "twenty", "twenty-three", "thirty-nine"]);
    assert.deepEqual([1, 2, 3, 12, 20, 21, 30].map(ordinalWords), ["first", "second", "third", "twelfth", "twentieth", "twenty-first", "thirtieth"]);
    assert.deepEqual(["IV", "XXXIX", "IIII", "XL", ""].map(romanValue), [4, 39, null, null, null]);
  });
}
