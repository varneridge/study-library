// Chinese names written in pinyin, read the way English-language broadcasters
// say them rather than as espeak-ng's English spelling rules would.
//
// espeak-ng, which Kokoro uses to turn text into sounds, reads pinyin as if it
// were English, so "x" comes out as "z" and "q" as "k": Xiaoping becomes
// "ZY-uh-ruh-ping" and Qing becomes "King". Pinyin is a regular system, so a
// word that splits wholly into pinyin syllables can be given its conventional
// anglicised pronunciation by rule, including names never seen before.
//
// The syllables are not listed. They are built from the initials, the finals
// and which groups of initials each final follows, which is how pinyin itself
// is defined, so the code stays small and the rules can be checked one by one.
// Sounds are written in the symbols Kokoro takes (espeak-ng's British IPA).
//
// shared/pronunciation-fixtures.json holds the expected results, and the
// Python version for the local server is tested against the same file.

import lists from "../../../../shared/pinyin-lists.json";

type Group = "lab" | "f" | "dt" | "nl" | "gkh" | "pal" | "ret" | "sib";

/** Each initial's spelling, its group and its sound. */
const INITIALS: Array<[string, Group, string]> = [
  ["b", "lab", "b"], ["p", "lab", "p"], ["m", "lab", "m"], ["f", "f", "f"],
  ["d", "dt", "d"], ["t", "dt", "t"], ["n", "nl", "n"], ["l", "nl", "l"],
  ["g", "gkh", "\u0261"], ["k", "gkh", "k"], ["h", "gkh", "h"],
  ["j", "pal", "d\u0292"], ["q", "pal", "t\u0283"], ["x", "pal", "\u0283"],
  ["zh", "ret", "d\u0292"], ["ch", "ret", "t\u0283"], ["sh", "ret", "\u0283"], ["r", "ret", "\u0279"],
  ["z", "sib", "dz"], ["c", "sib", "ts"], ["s", "sib", "s"],
];

/**
 * Each final: its spelling after an initial, the groups it follows, any single
 * initials it also follows, and its sound as a glide and a rhyme. The glide
 * joins the initial, so stress falls on the rhyme: "Xiao" is sh-y + OW.
 */
interface Final {
  spelling: string;
  groups: Group[];
  also?: string[];
  glide: string;
  rhyme: string;
}

const FINALS: Final[] = [
  { spelling: "a", groups: ["lab", "f", "dt", "nl", "gkh", "ret", "sib"], glide: "", rhyme: "\u0251\u02d0" },
  { spelling: "ai", groups: ["lab", "dt", "nl", "gkh", "ret", "sib"], glide: "", rhyme: "a\u026a" },
  { spelling: "an", groups: ["lab", "f", "dt", "nl", "gkh", "ret", "sib"], glide: "", rhyme: "an" },
  { spelling: "ang", groups: ["lab", "f", "dt", "nl", "gkh", "ret", "sib"], glide: "", rhyme: "a\u014b" },
  { spelling: "ao", groups: ["lab", "dt", "nl", "gkh", "ret", "sib"], glide: "", rhyme: "a\u028a" },
  { spelling: "e", groups: ["dt", "nl", "gkh", "ret", "sib"], also: ["m"], glide: "", rhyme: "\u0259" },
  { spelling: "ei", groups: ["lab", "f", "dt", "nl", "gkh"], also: ["zh", "sh", "z"], glide: "", rhyme: "e\u026a" },
  { spelling: "en", groups: ["lab", "f", "gkh", "ret", "sib"], also: ["d", "n"], glide: "", rhyme: "\u0259n" },
  { spelling: "eng", groups: ["lab", "f", "dt", "nl", "gkh", "ret", "sib"], glide: "", rhyme: "\u028c\u014b" },
  { spelling: "o", groups: ["lab", "f"], glide: "", rhyme: "\u0254\u02d0" },
  { spelling: "ong", groups: ["dt", "nl", "gkh", "ret", "sib"], glide: "", rhyme: "\u0252\u014b" },
  { spelling: "ou", groups: ["dt", "nl", "gkh", "ret", "sib", "f"], also: ["p", "m"], glide: "", rhyme: "\u0259\u028a" },
  // "i" after zh, ch, sh and r is the "shir" vowel, and after z, c and s the "zuh" vowel (see vowelOfI).
  { spelling: "i", groups: ["lab", "dt", "nl", "pal", "ret", "sib"], glide: "", rhyme: "i\u02d0" },
  { spelling: "ia", groups: ["pal"], also: ["l"], glide: "j", rhyme: "\u0251\u02d0" },
  { spelling: "ian", groups: ["lab", "dt", "nl", "pal"], glide: "j", rhyme: "\u025bn" },
  { spelling: "iang", groups: ["pal"], also: ["n", "l"], glide: "j", rhyme: "a\u014b" },
  { spelling: "iao", groups: ["lab", "dt", "nl", "pal"], glide: "j", rhyme: "a\u028a" },
  { spelling: "ie", groups: ["lab", "dt", "nl", "pal"], glide: "j", rhyme: "\u025b" },
  { spelling: "in", groups: ["lab", "nl", "pal"], glide: "", rhyme: "\u026an" },
  { spelling: "ing", groups: ["lab", "dt", "nl", "pal"], glide: "", rhyme: "\u026a\u014b" },
  { spelling: "iong", groups: ["pal"], glide: "j", rhyme: "\u028a\u014b" },
  { spelling: "iu", groups: ["pal"], also: ["m", "d", "n", "l"], glide: "j", rhyme: "\u0259\u028a" },
  // After j, q and x a written "u" is the rounded "u" of "Xu" (see the palatal forms below).
  { spelling: "u", groups: ["lab", "f", "dt", "nl", "gkh", "pal", "ret", "sib"], glide: "", rhyme: "u\u02d0" },
  { spelling: "ua", groups: ["gkh", "ret"], glide: "w", rhyme: "\u0251\u02d0" },
  { spelling: "uai", groups: ["gkh"], also: ["zh", "ch", "sh"], glide: "w", rhyme: "a\u026a" },
  { spelling: "uan", groups: ["dt", "nl", "gkh", "pal", "ret", "sib"], glide: "w", rhyme: "an" },
  { spelling: "uang", groups: ["gkh"], also: ["zh", "ch", "sh"], glide: "w", rhyme: "a\u014b" },
  { spelling: "ui", groups: ["dt", "gkh", "ret", "sib"], glide: "w", rhyme: "e\u026a" },
  { spelling: "un", groups: ["dt", "gkh", "pal", "ret", "sib"], also: ["l"], glide: "", rhyme: "\u028an" },
  { spelling: "uo", groups: ["dt", "nl", "gkh", "ret", "sib"], glide: "w", rhyme: "\u0254\u02d0" },
  { spelling: "ue", groups: ["pal"], also: ["n", "l"], glide: "w", rhyme: "\u025b" },
  // \u00fc, written v when typed without the dots, after n and l only (Lu with dots, as in Lu Xun's family name).
  { spelling: "v", groups: [], also: ["n", "l"], glide: "j", rhyme: "u\u02d0" },
  { spelling: "ve", groups: [], also: ["n", "l"], glide: "j", rhyme: "\u025b" },
];

/** After j, q and x the written "u" family is really the \u00fc family. */
const PALATAL_FORMS: Record<string, [string, string]> = {
  u: ["", "u\u02d0"],
  un: ["", "u\u02d0n"],
  uan: ["w", "\u025bn"],
  ue: ["w", "\u025b"],
};

/** Syllables with no initial, as pinyin writes them (y- and w- stand in for i-, u- and \u00fc-). */
const BARE: Array<[string, string, string]> = [
  ["a", "", "\u0251\u02d0"], ["ai", "", "a\u026a"], ["an", "", "an"], ["ang", "", "a\u014b"], ["ao", "", "a\u028a"],
  ["e", "", "\u0259"], ["ei", "", "e\u026a"], ["en", "", "\u025bn"], ["eng", "", "\u028c\u014b"], ["er", "", "\u025c\u02d0"],
  ["o", "", "\u0254\u02d0"], ["ou", "", "\u0259\u028a"],
  ["yi", "", "i\u02d0"], ["yin", "", "\u026an"], ["ying", "", "\u026a\u014b"],
  ["ya", "j", "\u0251\u02d0"], ["yao", "j", "a\u028a"], ["yan", "j", "\u025bn"], ["yang", "j", "a\u014b"],
  ["ye", "j", "\u025b"], ["yo", "j", "\u0254\u02d0"], ["yong", "j", "\u028a\u014b"], ["you", "j", "\u0259\u028a"],
  ["yu", "j", "u\u02d0"], ["yuan", "jw", "\u025bn"], ["yue", "jw", "\u025b"], ["yun", "j", "u\u02d0n"],
  ["wa", "w", "\u0251\u02d0"], ["wai", "w", "a\u026a"], ["wan", "w", "an"], ["wang", "w", "a\u014b"],
  ["wei", "w", "e\u026a"], ["wen", "w", "\u0259n"], ["weng", "w", "\u028c\u014b"], ["wo", "w", "\u0254\u02d0"], ["wu", "w", "u\u02d0"],
];

function vowelOfI(group: Group): string {
  if (group === "ret") return "\u025c\u02d0";
  if (group === "sib") return "\u0259";
  return "i\u02d0";
}

/** Every pinyin syllable, mapped to its onset (initial and glide) and its rhyme. */
const SYLLABLES: Map<string, [string, string]> = (() => {
  const out = new Map<string, [string, string]>();
  for (const [spelling, glide, rhyme] of BARE) out.set(spelling, [glide, rhyme]);
  for (const [initial, group, sound] of INITIALS) {
    for (const f of FINALS) {
      if (!f.groups.includes(group) && !f.also?.includes(initial)) continue;
      let { glide, rhyme } = f;
      if (f.spelling === "i") rhyme = vowelOfI(group);
      if (group === "pal" && PALATAL_FORMS[f.spelling]) [glide, rhyme] = PALATAL_FORMS[f.spelling];
      out.set(initial + f.spelling, [sound + glide, rhyme]);
    }
  }
  return out;
})();

/** How many syllables pinyin defines here; a check that the rules above stay complete. */
export const SYLLABLE_COUNT = SYLLABLES.size;

const LONGEST = Math.max(...[...SYLLABLES.keys()].map((s) => s.length));

/** Lower case, tone marks removed, and \u00fc written as v, so tone-marked pinyin reads the same as plain. */
function plain(word: string): string {
  return word
    .toLowerCase()
    .replace(/u:/g, "v")
    .normalize("NFD")
    .replace(/u\u0308/g, "v")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * The syllables of one apostrophe-free part, or null when it does not split
 * wholly into pinyin. A syllable starting with a, e or o may only begin a part:
 * pinyin writes an apostrophe before one anywhere else (Xi'an), which keeps
 * Wade-Giles names such as "Chiang" from being read as "chi-ang".
 */
function split(part: string): string[] | null {
  const memo = new Map<number, string[] | null>();
  const from = (i: number): string[] | null => {
    if (i === part.length) return [];
    const known = memo.get(i);
    if (known !== undefined) return known;
    let found: string[] | null = null;
    for (let len = Math.min(LONGEST, part.length - i); len >= 1 && !found; len -= 1) {
      const piece = part.slice(i, i + len);
      if (!SYLLABLES.has(piece) || (i > 0 && /^[aeo]/.test(piece))) continue;
      const rest = from(i + len);
      if (rest) found = [piece, ...rest];
    }
    memo.set(i, found);
    return found;
  };
  return from(0);
}

/** The syllables of a word, or null when any part is not pinyin. */
export function pinyinSyllables(word: string): string[] | null {
  const parts = plain(word).split(/['\u2019]/);
  if (parts.some((p) => p === "")) return null;
  const out: string[] = [];
  for (const p of parts) {
    const s = split(p);
    if (!s) return null;
    out.push(...s);
  }
  return out;
}

const NAMES = new Set(lists.names);
const NOT_NAMES = new Set(lists.notNames);

/**
 * Spellings that English words almost never have but pinyin often does: x at
 * the start of a syllable, q before i or u, zh, and finals such as -iao, -iu,
 * -uo and -eng. "Taxi" and "Boxing" have an x but not at a syllable start, and
 * "Antique" has its q before -ue, so they stay English.
 */
const ONLY_PINYIN = /(?:^|[ng])x|q(?=i|u(?:a|n|$))|zh|iu|uo|iao|iang|iong|uang|ia(?=[bcdfghjklmpqrstvwxyz])|ao(?=[bcdfghjklmnpqrstvwxyz]|$)|.eng|'/;

/** A capitalised word, with tone marks or an apostrophe allowed, and nothing else. */
const NAME_SHAPE = /^[A-Z\u00c0-\u01dc][a-z\u00e0-\u01dc]*(?:['\u2019][a-z\u00e0-\u01dc]+)*$/u;

/** Whether a word could be a pinyin name: capitalised, wholly pinyin, and not a word known to be something else. */
function couldBeName(word: string): boolean {
  return NAME_SHAPE.test(word.normalize("NFC")) && !NOT_NAMES.has(plain(word)) && pinyinSyllables(word) !== null;
}

/** Whether a word is a pinyin name on its own, without help from the words beside it. */
export function isPinyinName(word: string): boolean {
  if (!couldBeName(word)) return false;
  const p = plain(word).replace(/\u2019/g, "'");
  return NAMES.has(p) || ONLY_PINYIN.test(p);
}

export interface PinyinName {
  start: number;
  end: number;
  word: string;
  phonemes: string;
}

/**
 * The pinyin names in a passage. A word counts when it is a name on its own
 * (isPinyinName) or when it could be one and stands directly beside a word
 * that counts, so in "Hua Guofeng" and "Deng Xiaoping" the plainer half is
 * carried by its partner, while "China" and "Lenin" on their own are left to
 * espeak-ng. A hyphenated word counts only when every part of it is pinyin, so
 * the Wade-Giles "Kai-shek" is left for the course dictionary.
 */
export function findPinyinNames(text: string): PinyinName[] {
  const words = [...text.matchAll(/[\p{L}\u2019'-]+/gu)].map((m) => ({ start: m.index ?? 0, word: m[0] }));
  const parts = (w: string) => w.split("-").filter((p) => p !== "");
  const could = words.map((w) => parts(w.word).length > 0 && parts(w.word).every(couldBeName));
  const counts = words.map((w, i) => could[i] && parts(w.word).some(isPinyinName));
  // Carry the decision to directly neighbouring words, joined by a single space, in both directions.
  const touching = (i: number) => text.slice(words[i].start + words[i].word.length, words[i + 1].start) === " ";
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i + 1 < words.length; i += 1) {
      if (!touching(i)) continue;
      if (counts[i] && could[i + 1]) counts[i + 1] = true;
      if (counts[i + 1] && could[i]) counts[i] = true;
    }
  }
  const out: PinyinName[] = [];
  words.forEach((w, i) => {
    if (!counts[i]) return;
    const phonemes = parts(w.word).map((p) => pinyinPhonemes(p)).join(" ");
    out.push({ start: w.start, end: w.start + w.word.length, word: w.word, phonemes });
  });
  return out;
}

/**
 * A pinyin word's sounds in Kokoro's symbols, stressed on its last syllable as
 * English speakers stress Chinese names ("Xiao-PING", "Ze-DONG"). Null when the
 * word is not pinyin. Callers decide whether the word is a name (isPinyinName).
 */
export function pinyinPhonemes(word: string): string | null {
  const syllables = pinyinSyllables(word);
  if (!syllables) return null;
  return syllables
    .map((s, i) => {
      const [onset, rhyme] = SYLLABLES.get(s)!;
      return i === syllables.length - 1 ? `${onset}\u02c8${rhyme}` : `${onset}${rhyme}`;
    })
    .join("");
}
