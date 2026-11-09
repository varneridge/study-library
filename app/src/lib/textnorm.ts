/**
 * Ligature repair and search folding for extracted text.
 *
 * repairText mirrors backend/study/textnorm.py exactly, so a change to either
 * table must be made in both files and covered by both test suites.
 */

export const LIGATURES: Readonly<Record<string, string>> = {
  '\ufb00': 'ff',
  '\ufb01': 'fi',
  '\ufb02': 'fl',
  '\ufb03': 'ffi',
  '\ufb04': 'ffl',
  '\ufb05': 'st',
  '\ufb06': 'st',
  '\u017f': 's',
};

export const CONTEXT_GLYPHS: Readonly<Record<string, string>> = {
  '\u019f': 'ti',
  '\u014c': 'ft',
};

const LIGATURE_RE = /[\ufb00-\ufb06\u017f]/g;
const CONTEXT_GLYPH_RE = /[\u019f\u014c]/;
const COMBINING_MARK_RE = /\p{Mn}/gu;

const hasOwn = (table: Readonly<Record<string, string>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(table, key);

/**
 * Lowercase Latin letters, plus the glyphs themselves so that runs such as
 * "aŌŌ" are repaired in one pass, which keeps repairText idempotent.
 */
function isContextPreceder(ch: string): boolean {
  if (hasOwn(CONTEXT_GLYPHS, ch)) return true;
  const code = ch.charCodeAt(0);
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0xe0 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0xff)
  );
}

/** Repair ligatures and CMap glyph faults; safe to apply more than once. */
export function repairText(text: string): string {
  if (!text) return text;

  const expanded = text.replace(LIGATURE_RE, (ch) => LIGATURES[ch] ?? ch);
  if (!CONTEXT_GLYPH_RE.test(expanded)) return expanded;

  const out: string[] = [];
  let previous = '';
  for (const ch of expanded) {
    const replacement = hasOwn(CONTEXT_GLYPHS, ch) ? CONTEXT_GLYPHS[ch] : undefined;
    out.push(replacement !== undefined && isContextPreceder(previous) ? replacement : ch);
    previous = ch;
  }
  return out.join('');
}

/**
 * Build an accent- and ligature-insensitive search key. Lowercasing happens
 * before marks are stripped because lowercasing "İ" reintroduces a mark.
 */
export function searchFold(text: string): string {
  if (!text) return '';
  return repairText(text)
    .normalize('NFKD')
    .toLowerCase()
    .replace(COMBINING_MARK_RE, '')
    .replace(/ß/g, 'ss');
}
