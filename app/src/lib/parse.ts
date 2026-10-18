// Parse titles written in the (AT1) naming convention.
// Mirrors backend/study/parser.py. Both are tested against shared/title-fixtures.json.

import type { Term } from "./types";

export interface Parsed {
  kind: "module" | "session" | "primary" | "secondary" | "unmatched";
  title: string;
  review: boolean;
  term?: Term;
  week?: number;
  order?: number;
  author?: string;
  year?: number;
  source?: string;
  pages?: string;
  doc_date?: string;
}

const Q = "['\u2018\u2019]";
const MODULE_NOTE = /^\(00\)\s+(?<title>.+)$/;
const PREFIX = /^\((?<term>AT|WT)(?<week>\d{1,2})\)\s+(?:(?<session>00)\s+|P(?<primary>\d+)\s+)?(?<rest>.+)$/;
const SECONDARY = new RegExp(
  `^(?<author>.+?) \\((?<year>\\d{4})\\) ${Q}(?<title>.+?)${Q}` +
    // The source is tried last, so "pp. 1-24" with no source is read as pages.
    `(?:, (?<source>.+?))??(?:, pp?\\. (?<pages>[\\d-]+))?$`,
);
const PRIMARY = new RegExp(`^(?<author>[^'\u2018\u2019]+?), ${Q}(?<title>.+)${Q}(?:, (?<detail>.+))?$`);
const TRAILING_DATE = /^(?<title>.+), (?<date>\d{1,2} [A-Z][a-z]{2,8}\.? \d{4})$/;
const DATE_LIKE = /^(\d{1,2} )?([A-Z][a-z]{2,8}\.? )?\d{4}$/;

export function parseTitle(raw: string): Parsed {
  const text = raw.split(/\s+/).filter(Boolean).join(" ");

  const module = MODULE_NOTE.exec(text);
  if (module?.groups) return { kind: "module", title: module.groups.title, review: false };

  const prefix = PREFIX.exec(text);
  if (!prefix?.groups) return { kind: "unmatched", title: text, review: true };

  const term = prefix.groups.term as Term;
  const week = Number(prefix.groups.week);
  const rest = prefix.groups.rest.trim();
  if (week < 1 || week > 11) return { kind: "unmatched", title: text, review: true };

  if (prefix.groups.session) return { kind: "session", term, week, title: rest, review: false };
  if (prefix.groups.primary) return primary(rest, term, week, Number(prefix.groups.primary));
  return secondary(rest, term, week);
}

function primary(rest: string, term: Term, week: number, order: number): Parsed {
  const match = PRIMARY.exec(rest);
  if (match?.groups) {
    const parsed: Parsed = {
      kind: "primary", term, week, order,
      author: match.groups.author.trim(), title: match.groups.title.trim(), review: false,
    };
    const detail = match.groups.detail?.trim();
    if (detail) {
      if (DATE_LIKE.test(detail)) parsed.doc_date = detail;
      else parsed.source = detail;
    }
    return parsed;
  }
  const dated = TRAILING_DATE.exec(rest);
  if (dated?.groups) {
    return {
      kind: "primary", term, week, order,
      title: dated.groups.title.trim(), doc_date: dated.groups.date, review: true,
    };
  }
  return { kind: "primary", term, week, order, title: rest, review: true };
}

function secondary(rest: string, term: Term, week: number): Parsed {
  const match = SECONDARY.exec(rest);
  if (!match?.groups) return { kind: "secondary", term, week, title: rest, review: true };
  const parsed: Parsed = {
    kind: "secondary", term, week,
    author: match.groups.author.trim(),
    year: Number(match.groups.year),
    title: match.groups.title.trim(),
    review: false,
  };
  const source = match.groups.source?.trim();
  if (source) parsed.source = source;
  if (match.groups.pages) parsed.pages = match.groups.pages;
  return parsed;
}

// Strip a file extension before parsing a filename.
export function stripExtension(name: string): string {
  return name.replace(/\.(pdf|pptx?|docx?)$/i, "");
}
