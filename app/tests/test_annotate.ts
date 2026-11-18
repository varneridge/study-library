// Unit tests for the course dictionary's respellings (respell.ts) and the
// pronunciation layer that marks words with their sounds (annotate.ts).
import assert from "node:assert/strict";
import { annotate, parseMarks, phonemiseMarked, plainText } from "../src/lib/listen/annotate";
import { respellingProblem, soundsOf } from "../src/lib/listen/respell";
import { pinyinPhonemes } from "../src/lib/listen/pinyin";

type Test = (name: string, fn: () => void | Promise<void>) => void;

const S = "\u02c8";

export function registerAnnotateTests(test: Test): void {
  test("respell: plain respellings become Kokoro's sounds, stressed where capitals say", () => {
    assert.equal(soundsOf("oo-SOO-ree"), `u\u02d0s${S}u\u02d0\u0279i\u02d0`);
    assert.equal(soundsOf("SY-noh"), `s${S}a\u026an\u0259\u028a`);
    assert.equal(soundsOf("dzuh-DONG"), `dz\u0259d${S}\u0252\u014b`);
    assert.equal(soundsOf("shee-AN"), `\u0283i\u02d0${S}an`);
    assert.equal(soundsOf("lyoh"), `lj${S}\u0259\u028a`);
    assert.equal(soundsOf("chang ky-SHEK"), `t\u0283${S}a\u014b ka\u026a\u0283${S}\u025bk`);
  });

  test("respell: sounds between slashes are taken as they are, and nonsense is refused", () => {
    assert.equal(soundsOf("/u\u02d0s\u02c8\u028a\u0259\u0279i/"), "u\u02d0s\u02c8\u028a\u0259\u0279i");
    assert.equal(soundsOf("oo-SOO-ree!"), null);
    assert.equal(soundsOf("   "), null);
  });

  test("respell: the editor explains what stops an entry being saved", () => {
    assert.equal(respellingProblem("Ussuri", "oo-SOO-ree"), null);
    assert.equal(respellingProblem("", "oo"), "Type the word as it is written.");
    assert.equal(respellingProblem("Ussuri", ""), "Type how the word sounds.");
    assert.match(respellingProblem("Ussuri", "oo?")!, /letters and hyphens/);
    assert.match(respellingProblem("Sun Yat-sen", "soon-yat-SEN")!, /each of the 2 words/);
  });

  test("annotate: dictionary words, phrases and pinyin names are marked, the rest rewritten", () => {
    const entries = [{ word: "Ussuri", say: "oo-SOO-ree" }, { word: "Chiang Kai-shek", say: "chang ky-SHEK" }];
    const out = annotate("Chiang Kai-shek fled; Mao Zedong held the ussuri, c. 1949.", entries);
    assert.equal(
      out,
      `[Chiang](/t\u0283${S}a\u014b/) [Kai-shek](/ka\u026a\u0283${S}\u025bk/) fled; [Mao](/${pinyinPhonemes("Mao")}/) [Zedong](/${pinyinPhonemes("Zedong")}/) held the [ussuri](/u\u02d0s${S}u\u02d0\u0279i\u02d0/), circa 1949.`,
    );
    assert.equal(plainText(out), "Chiang Kai-shek fled; Mao Zedong held the ussuri, circa 1949.");
  });

  test("annotate: your entry wins over the pinyin rules, and whole words only", () => {
    const out = annotate("Mao and Maoism.", [{ word: "Mao", say: "MOW" }]);
    assert.equal(out, `[Mao](/m${S}a\u028a/) and Maoism.`);
    assert.equal(annotate("Ussurian", [{ word: "Ussuri", say: "oo-SOO-ree" }]), "Ussurian");
  });

  test("annotate: a phrase whose respelling has a different number of words is left alone", () => {
    assert.equal(annotate("Sun Yat-sen", [{ word: "Sun Yat-sen", say: "soon-yat-SEN" }]), "Sun Yat-sen");
  });

  test("annotate: text with nothing to mark comes back as spokenText gives it", () => {
    assert.equal(annotate("Brezhnev and Gorbachev."), "Brezhnev and Gorbachev.");
  });
}

export function registerMarkedSoundTests(test: Test): void {
  test("marks: marked text splits into plain words and the places of fixed sounds", () => {
    const { plain, marks } = parseMarks("On the [Ussuri](/u\u02d0s/), then [Mao](/ma\u028a/).");
    assert.equal(plain, "On the Ussuri, then Mao.");
    assert.deepEqual(marks.map((m) => plain.slice(m.start, m.end)), ["Ussuri", "Mao"]);
  });

  test("marks: fixed sounds are put between the phonemised stretches, keeping punctuation against its word", async () => {
    const phonemise = async (t: string) => t.trim().toUpperCase();
    const { plain, marks } = parseMarks("On the [Ussuri](/u\u02d0s/), then [Mao](/ma\u028a/).");
    assert.equal(await phonemiseMarked(plain, marks, phonemise), "ON THE u\u02d0s, THEN ma\u028a.");
    assert.equal(await phonemiseMarked("Plain words.", [], phonemise), "PLAIN WORDS.");
  });
}
