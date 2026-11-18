// Unit tests for pinyin.ts, mostly from shared/pronunciation-fixtures.json, which the Python version shares.
import assert from "node:assert/strict";
import { findPinyinNames, isPinyinName, pinyinPhonemes, pinyinSyllables, SYLLABLE_COUNT } from "../src/lib/listen/pinyin";
import fixtures from "../../shared/pronunciation-fixtures.json";

type Test = (name: string, fn: () => void | Promise<void>) => void;

// Every symbol the converter may use, all of which espeak-ng itself emits for
// British English, so Kokoro's tokenizer knows each one.
const KOKORO_SYMBOLS = new Set([..."bpmfdtnlkhzsjw\u0261\u0292\u0283\u0279a\u0251\u0252\u0254\u0259\u025b\u025c\u026a\u028a\u028ceiu\u014b\u02d0\u02c8"]);

export function registerPinyinTests(test: Test): void {
  test("pinyin: the rules build the full set of syllables", () => {
    // Standard pinyin has a little over 400 syllables; the rules give 414 including the \u00fc forms.
    assert.equal(SYLLABLE_COUNT, 414);
  });

  test("pinyin: every case in shared/pronunciation-fixtures.json", () => {
    for (const [word, phonemes] of fixtures.pinyinPhonemes as Array<[string, string | null]>) assert.equal(pinyinPhonemes(word), phonemes, word);
  });

  test("pinyin: names are found in passages, and English words and Wade-Giles names are left alone", () => {
    for (const { text, names } of fixtures.pinyinNames) assert.deepEqual(findPinyinNames(text).map((n) => n.word), names, text);
  });

  test("pinyin: found names carry their place in the passage and their sounds", () => {
    const text = "Under Deng Xiaoping";
    const [deng, xiaoping] = findPinyinNames(text);
    assert.equal(text.slice(deng.start, deng.end), "Deng");
    assert.equal(text.slice(xiaoping.start, xiaoping.end), "Xiaoping");
    assert.equal(xiaoping.phonemes, pinyinPhonemes("Xiaoping"));
  });

  test("pinyin: only symbols Kokoro knows", () => {
    for (const word of ["Zhuang", "Qiong", "Nve", "Chuai", "Er", "Weng", "Yue", "Shui", "Ri", "Ceng"]) {
      const p = pinyinPhonemes(word);
      assert.ok(p, word);
      for (const ch of p!) assert.ok(KOKORO_SYMBOLS.has(ch), `${word}: ${ch}`);
    }
  });

  test("pinyin: vowel syllables need an apostrophe after the first, as pinyin writes them", () => {
    assert.deepEqual(pinyinSyllables("Xi'an"), ["xi", "an"]);
    assert.deepEqual(pinyinSyllables("Xian"), ["xian"]);
    assert.equal(pinyinSyllables("Chiang"), null);
    assert.equal(isPinyinName("Chiang"), false);
  });

  test("pinyin: capitals, lists and spellings decide what counts as a name", () => {
    assert.equal(isPinyinName("Xiaoping"), true);
    assert.equal(isPinyinName("xiaoping"), false);
    assert.equal(isPinyinName("BEIJING"), false);
    assert.equal(isPinyinName("Beijing"), true);
    assert.equal(isPinyinName("China"), false);
    assert.equal(isPinyinName("Karaoke"), false);
    assert.equal(isPinyinName("Taxi"), false);
  });
}
