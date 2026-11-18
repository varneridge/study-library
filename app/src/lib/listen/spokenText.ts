// What a reading should sound like, written out before a speech engine sees it.
//
// Kokoro's text front end (kokoro-js in the browser, misaki on the local
// server) reads a range only when it is joined by an ordinary hyphen, so the en
// dash that typeset PDFs use between numbers is read as nothing at all, and it
// leaves academic abbreviations such as "c.", "pp." and "cf." to espeak-ng,
// which spells them out as letters. The full stop in "c. 1945" also ends a
// sentence for kokoro-js's splitter, which makes the voice pause mid-phrase.
// Every rule here was checked against kokoro-js's own phonemiser, so each
// rewrite is the spelling that comes out as the intended sounds.
//
// Highlighting does not depend on these rewrites: align.ts matches the engine's
// spoken words back to the written ones, by text where it can and by spoken
// length where it cannot, so "1975 to 1980" still lights up "1975" and "1980".
//
// Dashes are written as escapes, because the project keeps en and em dashes
// out of its source files.

/**
 * The version of every pronunciation rule (this file, pinyin.ts and their Python
 * twin, backend/tts/pronounce.py). Raising it gives every paragraph a new
 * prepared audio key (preparedKey.ts), so audio made under old rules is replaced.
 * shared/pronunciation-fixtures.json records it, and both test suites check it.
 */
export const PRONUNCIATION_VERSION = 1;

/** Any dash a PDF may put between two numbers: hyphen, non-breaking hyphen, figure, en and em dashes, minus. */
const ANY_DASH = "[-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212]";
/** The same without the plain hyphen, which kokoro-js already reads as "to" between digits. */
const TYPESET_DASH = "[\\u2010\\u2011\\u2012\\u2013\\u2014\\u2212]";

const UNITS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty"];
const UNIT_ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth"];

/** A number from 1 to 39 in words: "twenty-three". */
export function cardinalWords(n: number): string {
  if (n < 10) return UNITS[n];
  if (n < 20) return TEENS[n - 10];
  const unit = n % 10;
  return unit ? `${TENS[Math.floor(n / 10)]}-${UNITS[unit]}` : TENS[n / 10];
}

/** A number from 1 to 39 as an ordinal: "twenty-third". */
export function ordinalWords(n: number): string {
  if (n < 10) return UNIT_ORDINALS[n];
  if (n === 12) return "twelfth";
  if (n < 20) return `${TEENS[n - 10]}th`;
  const unit = n % 10;
  if (unit) return `${TENS[Math.floor(n / 10)]}-${UNIT_ORDINALS[unit]}`;
  return `${TENS[n / 10].slice(0, -1)}ieth`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The value of a Roman numeral from I to XXXIX, or null for anything else. */
export function romanValue(s: string): number | null {
  const m = /^(X{0,3})(IX|IV|V?I{0,3})$/.exec(s);
  if (!m || s === "") return null;
  const ones: Record<string, number> = { "": 0, I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9 };
  const value = m[1].length * 10 + ones[m[2]];
  return value > 0 ? value : null;
}

// Words after which a numeral is a count ("Part Two"), compared in lower case.
const COUNTED = new Set([
  "act", "appendix", "article", "book", "chapter", "class", "figure", "mark", "part", "phase",
  "plate", "section", "stage", "table", "title", "type", "vatican", "volume",
]);

// Rulers and popes whose numeral can be a single letter ("Elizabeth I", "Pius V").
// A single I, V or X anywhere else is left alone, so "Malcolm X" and the pronoun stay as written.
const REGNAL = new Set([
  "Alexander", "Benedict", "Catherine", "Charles", "Edward", "Elizabeth", "Ferdinand", "Francis",
  "Frederick", "George", "Gregory", "Gustav", "Henry", "Isabella", "Ivan", "James", "John", "Joseph",
  "Karl", "Leo", "Leopold", "Louis", "Ludwig", "Mary", "Mehmed", "Napoleon", "Nicholas", "Paul",
  "Peter", "Philip", "Pius", "Richard", "Selim", "Suleiman", "Victor", "Wilhelm", "William",
]);

// Capitalised words that start sentences or titles rather than naming a ruler.
const NOT_A_NAME = new Set(["A", "An", "And", "As", "At", "But", "By", "For", "From", "If", "In", "Of", "On", "Or", "The", "To", "With"]);

function readNumerals(text: string): string {
  return text.replace(/\b([A-Za-z]+)(\s+)(?:([A-Za-z]+)\s+)?([IVX]+)(?=$|[^A-Za-z0-9])/g, (whole, first: string, gap: string, second: string | undefined, numeral: string) => {
    const value = romanValue(numeral);
    if (value === null) return whole;
    const before = second ?? first;
    const lead = second ? `${first}${gap}${second} ` : `${first}${gap}`;
    const war = second !== undefined && first.toLowerCase() === "world" && second.toLowerCase() === "war";
    if (war || COUNTED.has(before.toLowerCase())) return `${lead}${capitalise(cardinalWords(value))}`;
    const capitalised = /^[A-Z][a-z]+$/.test(before) && !NOT_A_NAME.has(before);
    if (!capitalised) return whole;
    if (numeral.length === 1 && !REGNAL.has(before)) return whole;
    return `${lead}the ${capitalise(ordinalWords(value))}`;
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

type Rule = [RegExp, string | ((...groups: string[]) => string)];

// In order: dates and ranges first, so the abbreviation rules see plain numbers.
const RULES: Rule[] = [
  // 2020-05-17, read the British way.
  [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, y, m, d) => {
    const month = MONTHS[Number(m) - 1];
    const day = Number(d);
    return month && day >= 1 && day <= 31 ? `the ${ordinalWords(day)} of ${month} ${y}` : whole;
  }],
  // 1950s-60s and 1950s-1960s.
  [new RegExp(`\\b(\\d{3}0s)\\s*${ANY_DASH}\\s*(\\d0s|\\d{3}0s)\\b`, "g"), "$1 to $2"],
  // 1949-present, 1949-today.
  [new RegExp(`\\b(\\d{4})\\s*${ANY_DASH}\\s*(present|today|now)\\b`, "gi"), "$1 to $2"],
  // (1949-) and "1949- ": a range still open.
  [new RegExp(`\\b(\\d{4})\\s*${ANY_DASH}(?=\\s*(?:[)\\],;:.]|$))`, "g"), "$1 onwards"],
  // 1950-53: the second year shortened.
  [new RegExp(`\\b(\\d{2})(\\d{2})\\s*${ANY_DASH}\\s*(\\d{2})\\b(?!\\d)`, "g"), (whole, century, year, end) =>
    Number(end) > Number(year) ? `${century}${year} to ${end}` : whole],
  // 1975-1980, 12-15 and any other numbers joined by a typeset dash.
  [new RegExp(`(\\d)\\s*${TYPESET_DASH}\\s*(?=\\d)`, "g"), "$1 to "],

  // Abbreviations before a number. Each drops its full stop, so no sentence ends there.
  [/\b(?:c|ca)\.\s*(?=\d)/g, "circa "],
  [/\bpp\.\s*(?=\d)/g, "pages "],
  [/\bp\.\s*(?=\d)/g, "page "],
  [/\b(\d+)\s*ff\./g, "$1 and following"],
  [/\b[Vv]ols\.\s*/g, "volumes "],
  [/\b[Vv]ol\.\s*/g, "volume "],
  [/\b[Cc]hs\.\s*(?=\d)/g, "chapters "],
  [/\b[Cc]h\.\s*(?=\d)/g, "chapter "],
  [/\b[Nn]os\.\s*(?=\d)/g, "numbers "],
  [/\b[Nn]o\.\s*(?=\d)/g, "number "],
  [/\bnn\.\s*(?=\d)/g, "notes "],
  [/\bn\.\s*(?=\d)/g, "note "],
  [/\b[Ff]igs\.\s*(?=\d)/g, "figures "],
  [/\b[Ff]ig\.\s*(?=\d)/g, "figure "],
  [/\bd\.\s*(?=\d)/g, "died "],
  [/\bb\.\s*(?=\d)/g, "born "],
  [/\br\.\s*(?=\d)/g, "reigned "],

  // Latin and bibliographic abbreviations.
  [/\be\.\s?g\.(?!\w)/gi, "for example"],
  [/\bi\.\s?e\.(?!\w)/gi, "that is"],
  [/\bcf\.(?!\w)/gi, "compare"],
  [/\bet al\.?(?!\w)/g, "and others"],
  [/\bviz\.(?!\w)/g, "namely"],
  [/\(eds\.\)/g, "(editors)"],
  [/\(ed\.\)/g, "(editor)"],
  [/\beds?\.\s+by\b/g, "edited by"],
  [/\btrans\.\s+by\b/g, "translated by"],

  // Eras: espeak-ng reads "AD" as the word "ad" and "CE" as one letter.
  [/\bAD(?=\s+\d)/g, "A-D"],
  [/(\d)\s*AD\b/g, "$1 A-D"],
  [/(\d)\s*CE\b/g, "$1 C-E"],

  // The British "SY-noh" in Sino-Soviet and Sino-Japanese, where espeak-ng says "SEE-no".
  [/\bSino-(?=[A-Z])/g, "Sighno-"],
];

/** The text as it should be spoken, for a speech engine. Text needing no change comes back as it was. */
export function spokenText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement as (substring: string, ...args: string[]) => string);
  }
  return readNumerals(out);
}
