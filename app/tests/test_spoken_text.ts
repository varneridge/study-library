// Unit tests for spokenText.ts: what each written form becomes before Kokoro reads it.
// The cases live in shared/pronunciation-fixtures.json, which the Python version shares.
import assert from "node:assert/strict";
import { cardinalWords, ordinalWords, romanValue, spokenText, yearWords } from "../src/lib/listen/spokenText";
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
    assert.deepEqual([1, 12, 20, 23, 39, 40, 54, 99].map(cardinalWords), ["one", "twelve", "twenty", "twenty-three", "thirty-nine", "forty", "fifty-four", "ninety-nine"]);
    assert.deepEqual([1, 2, 3, 12, 20, 21, 30].map(ordinalWords), ["first", "second", "third", "twelfth", "twentieth", "twenty-first", "thirtieth"]);
    assert.deepEqual(["IV", "XXXIX", "IIII", "XL", ""].map(romanValue), [4, 39, null, null, null]);
  });

  test("spoken text: years are said as pairs of numbers, and only from 1100 to 2099", () => {
    assert.deepEqual(
      [1954, 1900, 1905, 2000, 2007, 2015, 1100].map(yearWords),
      ["nineteen fifty-four", "nineteen hundred", "nineteen oh five", "two thousand", "two thousand and seven", "twenty fifteen", "eleven hundred"],
    );
    assert.deepEqual([1099, 2100, 0, 1954.5].map(yearWords), [null, null, null, null]);
  });

  test("spoken text: years and decades in a sentence", () => {
    assert.equal(spokenText("It fell in 1954."), "It fell in nineteen fifty-four.");
    assert.equal(spokenText("Born in 1905 and died in 2007."), "Born in nineteen oh five and died in two thousand and seven.");
    assert.equal(spokenText("Reforms of the 1950s"), "Reforms of the nineteen fifties");
    assert.equal(spokenText("The 1900s"), "The nineteen hundreds");
  });

  test("spoken text: days and months are said the British way", () => {
    assert.equal(spokenText("on 14 June"), "on the fourteenth of June");
    assert.equal(spokenText("on 14th June"), "on the fourteenth of June");
    assert.equal(spokenText("on June 14"), "on June the fourteenth");
    assert.equal(spokenText("on 14 June 1954"), "on the fourteenth of June nineteen fifty-four");
    assert.equal(spokenText("on 16 to 18 August"), "on the sixteenth to the eighteenth of August");
    assert.equal(spokenText("on 16th to 18th August"), "on the sixteenth to the eighteenth of August");
    assert.equal(spokenText("on 16\u201318 August"), "on the sixteenth to the eighteenth of August");
    assert.equal(spokenText("on 32 June"), "on 32 June");
  });

  test("spoken text: May is a month only beside a day number", () => {
    assert.equal(spokenText("May 14"), "May the fourteenth");
    assert.equal(spokenText("14 May"), "the fourteenth of May");
    assert.equal(spokenText("May I ask, in May, if it may rain"), "May I ask, in May, if it may rain");
  });

  test("spoken text: four digits that are not a year are left as written", () => {
    for (const text of ["1500 soldiers", "p. 1954", "page 1954", "pages 1954", "number 1954", "about 1500", "1,954", "3.1954", "1954.5", "1954%", "1954 %", "code 1950-12", "1099", "2100"]) {
      const expected = text.startsWith("p. ") ? text.replace("p. ", "page ") : text;
      assert.equal(spokenText(text), expected, text);
    }
  });
}
