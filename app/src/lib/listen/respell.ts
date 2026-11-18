// Pronunciations typed as plain respellings, the way a dictionary or a
// newspaper shows how to say a name: "oo-SOO-ree" for Ussuri, "chang ky-SHEK"
// for Chiang Kai-shek. Hyphens separate syllables, spaces separate words, and
// the syllable in capitals is the stressed one. The result is in the symbols
// Kokoro takes (espeak-ng's British IPA), so it is said exactly as typed.
//
// Each spelling below stands for one sound. Longer spellings are tried first,
// so "oo" is one vowel and "ng" one consonant. A pronunciation written between
// slashes ("/uːsˈʊəɹi/") is taken as Kokoro's symbols directly.

/** Vowel spellings and their sounds, longest first. */
const VOWELS: Array<[string, string]> = [
  ["eye", "a\u026a"], ["igh", "a\u026a"], ["air", "e\u0259"], ["ear", "\u026a\u0259"], ["eer", "\u026a\u0259"],
  ["oor", "\u028a\u0259"], ["our", "a\u028a\u0259"],
  ["ah", "\u0251\u02d0"], ["ar", "\u0251\u02d0"], ["aw", "\u0254\u02d0"], ["or", "\u0254\u02d0"], ["ay", "e\u026a"],
  ["ee", "i\u02d0"], ["er", "\u025c\u02d0"], ["ur", "\u025c\u02d0"], ["ew", "ju\u02d0"], ["oh", "\u0259\u028a"], ["oa", "\u0259\u028a"],
  ["oo", "u\u02d0"], ["ow", "a\u028a"], ["oy", "\u0254\u026a"], ["uh", "\u0259"], ["uu", "\u028a"],
  ["a", "a"], ["e", "\u025b"], ["i", "\u026a"], ["o", "\u0252"], ["u", "\u028c"],
];

/** Consonant spellings and their sounds, longest first. */
const CONSONANTS: Array<[string, string]> = [
  ["tch", "t\u0283"], ["ch", "t\u0283"], ["sh", "\u0283"], ["zh", "\u0292"], ["th", "\u03b8"], ["dh", "\u00f0"],
  ["ng", "\u014b"], ["kh", "k"], ["j", "d\u0292"], ["g", "\u0261"], ["r", "\u0279"], ["x", "ks"], ["c", "k"], ["q", "k"],
  ["b", "b"], ["d", "d"], ["f", "f"], ["h", "h"], ["k", "k"], ["l", "l"], ["m", "m"], ["n", "n"], ["p", "p"],
  ["s", "s"], ["t", "t"], ["v", "v"], ["w", "w"], ["z", "z"],
];

const VOWEL_LETTER = /[aeiou]/;

/** One syllable's sounds, with the index of its first vowel sound, or null when a letter has no meaning here. */
function syllable(spelled: string): { sounds: string[]; vowelAt: number } | null {
  const s = spelled.toLowerCase();
  const sounds: string[] = [];
  let vowelAt = -1;
  let i = 0;
  while (i < s.length) {
    // "y" is a consonant before a vowel ("lyoh") and the vowel of "sky" anywhere else ("SY-noh").
    if (s[i] === "y") {
      if (VOWEL_LETTER.test(s[i + 1] ?? "")) sounds.push("j");
      else {
        if (vowelAt < 0) vowelAt = sounds.length;
        sounds.push("a\u026a");
      }
      i += 1;
      continue;
    }
    const vowel = VOWELS.find(([spelling]) => s.startsWith(spelling, i));
    if (vowel) {
      if (vowelAt < 0) vowelAt = sounds.length;
      sounds.push(vowel[1]);
      i += vowel[0].length;
      continue;
    }
    const consonant = CONSONANTS.find(([spelling]) => s.startsWith(spelling, i));
    if (!consonant) return null;
    sounds.push(consonant[1]);
    i += consonant[0].length;
  }
  return { sounds, vowelAt };
}

/** A respelled word's sounds, or null when it cannot be read. */
function word(spelled: string): string | null {
  const parts = spelled.split("-").filter((p) => p !== "");
  if (parts.length === 0) return null;
  const syllables = parts.map(syllable);
  if (syllables.some((s) => s === null)) return null;
  const stressed = parts.map((p) => /[A-Z]/.test(p) && p === p.toUpperCase());
  const anyStress = stressed.some(Boolean);
  return syllables
    .map((s, i) => {
      const { sounds, vowelAt } = s!;
      const stress = stressed[i] || (!anyStress && parts.length === 1);
      if (!stress || vowelAt < 0) return sounds.join("");
      return [...sounds.slice(0, vowelAt), "\u02c8", ...sounds.slice(vowelAt)].join("");
    })
    .join("");
}

/**
 * The sounds of a pronunciation as typed: a respelling, or Kokoro's symbols
 * between slashes. Words stay separated by single spaces. Null when any part
 * cannot be read, so the editor can say so before anything is saved.
 */
export function soundsOf(say: string): string | null {
  const trimmed = say.trim();
  const direct = /^\/(.+)\/$/.exec(trimmed);
  if (direct) return direct[1].trim().replace(/\s+/g, " ");
  const words = trimmed.split(/\s+/).filter((w) => w !== "");
  if (words.length === 0 || words.some((w) => !/^[A-Za-z-]+$/.test(w))) return null;
  const out = words.map(word);
  return out.some((w) => w === null) ? null : out.join(" ");
}

/** Why a dictionary entry cannot be saved, in words for the editor, or null when it can. */
export function respellingProblem(word: string, say: string): string | null {
  if (!word.trim()) return "Type the word as it is written.";
  if (!say.trim()) return "Type how the word sounds.";
  const sounds = soundsOf(say);
  if (!sounds) return "Use letters and hyphens only, such as oo-SOO-ree.";
  const words = word.trim().split(/\s+/).length;
  if (sounds.split(" ").length !== words) return `Give one respelling for each of the ${words} words, separated by spaces.`;
  return null;
}
