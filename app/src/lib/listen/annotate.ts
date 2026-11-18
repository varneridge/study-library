// The whole pronunciation layer for one paragraph: written forms rewritten
// (spokenText.ts), then every word with a known pronunciation marked with its
// exact sounds, first your own course dictionary and then pinyin names
// (pinyin.ts). A marked word is written as misaki writes a fixed pronunciation,
// "[Ussuri](/uːsˈuːɹiː/)", in Kokoro's espeak-ng symbols.
//
// The marked text is what the speech server reads (backend/tts/pronounce.py
// turns the sounds into misaki's symbols) and what prepared audio is named
// after (preparedKey.ts), so changing a dictionary entry changes the name of
// exactly the paragraphs that contain the word, and only those are prepared
// again. The browser's Kokoro takes the plain words for now (plainText).

import { findPinyinNames } from "./pinyin";
import { soundsOf } from "./respell";
import { spokenText } from "./spokenText";

export interface PronunciationEntry {
  /** The word or phrase as written, matched without regard to capitals. */
  word: string;
  /** How it sounds: a respelling such as "oo-SOO-ree", or Kokoro's symbols between slashes. */
  say: string;
}

interface Mark {
  start: number;
  end: number;
  sounds: string;
}

const LINK = /\[([^\]]+)\]\(\/([^)]*)\/\)/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The dictionary's marks in a passage: whole words only, the longest phrase first, each word of a phrase marked on its own. */
function dictionaryMarks(text: string, entries: PronunciationEntry[]): Mark[] {
  const marks: Mark[] = [];
  const taken = (s: number, e: number) => marks.some((m) => s < m.end && e > m.start);
  const usable = entries
    .map((e) => ({ words: e.word.trim().split(/\s+/).filter(Boolean), sounds: soundsOf(e.say)?.split(" ") ?? [] }))
    // A phrase needs one pronunciation for each of its words, since each is timed and highlighted on its own.
    .filter((e) => e.words.length > 0 && e.sounds.length === e.words.length)
    .sort((a, b) => b.words.join(" ").length - a.words.join(" ").length);
  for (const entry of usable) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}'\\u2019-])${entry.words.map(escapeRegExp).join("\\s+")}(?![\\p{L}\\p{N}'\\u2019-])`, "giu");
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0;
      if (taken(start, start + m[0].length)) continue;
      let offset = start;
      entry.words.forEach((w, i) => {
        const at = text.toLowerCase().indexOf(w.toLowerCase(), offset);
        marks.push({ start: at, end: at + w.length, sounds: entry.sounds[i] });
        offset = at + w.length;
      });
    }
  }
  return marks;
}

/** A paragraph as the speech server should read it: spoken forms written out, and known words marked with their sounds. */
export function annotate(text: string, entries: PronunciationEntry[] = []): string {
  const spoken = spokenText(text);
  const marks = dictionaryMarks(spoken, entries);
  for (const name of findPinyinNames(spoken)) {
    if (!marks.some((m) => name.start < m.end && name.end > m.start)) marks.push({ start: name.start, end: name.end, sounds: name.phonemes });
  }
  marks.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const m of marks) {
    out += spoken.slice(last, m.start) + `[${spoken.slice(m.start, m.end)}](/${m.sounds}/)`;
    last = m.end;
  }
  return out + spoken.slice(last);
}

/** Marked text with the marks taken out, for an engine that cannot take sounds. */
export function plainText(annotated: string): string {
  return annotated.replace(LINK, "$1");
}

export interface MarkedWord {
  /** Offsets into the plain text, end exclusive. */
  start: number;
  end: number;
  sounds: string;
}

/** Marked text split into its plain words and the places and sounds of its marked ones. */
export function parseMarks(annotated: string): { plain: string; marks: MarkedWord[] } {
  let plain = "";
  const marks: MarkedWord[] = [];
  let last = 0;
  for (const m of annotated.matchAll(LINK)) {
    plain += annotated.slice(last, m.index);
    marks.push({ start: plain.length, end: plain.length + m[1].length, sounds: m[2] });
    plain += m[1];
    last = (m.index ?? 0) + m[0].length;
  }
  return { plain: plain + annotated.slice(last), marks };
}

/**
 * The sounds of one sentence whose marked words have fixed sounds: the plain
 * stretches between them go through `phonemise` (kokoro-js's own front end)
 * and the marked words are put in as they are. A stretch that touched its
 * neighbour in the text touches it in the sounds too, so "Ussuri," keeps its
 * comma against the word, as espeak-ng would have written it.
 */
export async function phonemiseMarked(sentence: string, marks: MarkedWord[], phonemise: (text: string) => Promise<string>): Promise<string> {
  let out = "";
  let last = 0;
  const add = async (stretch: string) => {
    if (stretch.trim() === "") {
      if (stretch.length > 0 && out !== "" && !out.endsWith(" ")) out += " ";
      return;
    }
    const sounds = (await phonemise(stretch)).trim();
    if (/^\s/.test(stretch) && out !== "" && !out.endsWith(" ")) out += " ";
    out += sounds;
    if (/\s$/.test(stretch)) out += " ";
  };
  for (const m of [...marks].sort((a, b) => a.start - b.start)) {
    await add(sentence.slice(last, m.start));
    out += m.sounds;
    last = m.end;
  }
  await add(sentence.slice(last));
  return out.trim();
}
