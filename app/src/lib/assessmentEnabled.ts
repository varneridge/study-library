/**
 * Decides whether a module's assessment section should be shown.
 *
 * Rows written before assessments became optional carry no enabled flag, so
 * for those the section is shown only when the student has already put work
 * into it. An explicit flag always wins, which is what makes a removal stick
 * even when the old row still holds content.
 */

/** Keep these in step with the values used when a fresh assessment is created. */
export const ASSESSMENT_DEFAULTS = {
  title: 'Assessment',
  wordTarget: 2000,
} as const;

export type AssessmentDefaults = { title: string; wordTarget: number };

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Treat markup and non-breaking spaces as empty, so "<p>&nbsp;</p>" is not content. */
function hasText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (
    value
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .trim().length > 0
  );
}

function hasBytes(value: unknown): boolean {
  if (value instanceof ArrayBuffer) return value.byteLength > 0;
  if (ArrayBuffer.isView(value)) return value.byteLength > 0;
  return false;
}

function draftHasContent(data: UnknownRecord): boolean {
  const { draft } = data;
  if (hasText(draft) || hasBytes(draft)) return true;
  if (isRecord(draft) && (hasText(draft.text) || hasText(draft.html) || hasBytes(draft.docx))) {
    return true;
  }
  if (hasBytes(data.docx)) return true;
  return typeof data.wordCount === 'number' && data.wordCount > 0;
}

function hasReferences(data: UnknownRecord): boolean {
  return [data.references, data.referenceItems].some(
    (list) => Array.isArray(list) && list.length > 0,
  );
}

/** Accepts either the stored settings row ({ id/key, value }) or the assessment data itself. */
function unwrap(raw: unknown): UnknownRecord | null {
  if (!isRecord(raw)) return null;
  if ('value' in raw && isRecord(raw.value)) return raw.value;
  return raw;
}

export function isAssessmentEnabled(
  raw: unknown,
  defaults: AssessmentDefaults = ASSESSMENT_DEFAULTS,
): boolean {
  const data = unwrap(raw);
  if (!data) return false;

  if (data.enabled === true) return true;
  if (data.enabled === false) return false;

  if (draftHasContent(data) || hasReferences(data)) return true;

  if (typeof data.wordTarget === 'number' && data.wordTarget !== defaults.wordTarget) {
    return true;
  }

  if (typeof data.title === 'string') {
    const title = data.title.trim();
    if (title !== '' && title !== defaults.title) return true;
  }

  return false;
}
