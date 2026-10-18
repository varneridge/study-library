import { db } from "./db";
import { keysAfter } from "./keys";
import { commit, newId, type Change } from "./sync";
import type { SessionKind, Term, WeekRow } from "./types";

export const TERMS: Term[] = ["AT", "WT"];
export const WEEK_NUMBERS = Array.from({ length: 11 }, (_, i) => i + 1);

export const PATTERNS: { label: string; value: SessionKind[] }[] = [
  { label: "Lecture and seminar", value: ["lecture", "seminar"] },
  { label: "One combined session", value: ["combined"] },
  { label: "Lecture only", value: ["lecture"] },
  { label: "Seminar only", value: ["seminar"] },
];

// How a week is named: "AT3", or a dissertation section by its own name.
export function weekCode(week: Pick<WeekRow, "term" | "number"> & { title?: string | null }): string {
  if (week.term === "S") return week.title?.trim() || `Section ${week.number}`;
  return `${week.term}${week.number}`;
}

// A taught week's title after its code, as in "AT3, The Consulate". A
// section's name is already its code, so nothing is added.
export function titleAfter(week: Pick<WeekRow, "term" | "title">, separator = " "): string {
  return week.term !== "S" && week.title ? `${separator}${week.title}` : "";
}

export const isSection = (week: Pick<WeekRow, "term">) => week.term === "S";

export function weekOrder(week: Pick<WeekRow, "term" | "number">): number {
  if (week.term === "S") return 100 + week.number;
  return (week.term === "AT" ? 0 : 11) + week.number;
}

export function byWeek<T extends Pick<WeekRow, "term" | "number">>(a: T, b: T): number {
  return weekOrder(a) - weekOrder(b);
}

// The kinds of session, in the order they are offered.
export const SESSION_KINDS: { value: SessionKind; label: string }[] = [
  { value: "lecture", label: "Lecture" },
  { value: "seminar", label: "Seminar" },
  { value: "combined", label: "Combined session" },
];

export function sessionLabel(kind: SessionKind): string {
  return kind === "lecture" ? "Lecture" : kind === "seminar" ? "Seminar" : kind === "supervision" ? "Supervision" : "Session";
}

export interface NewModule {
  code: string;
  title: string;
  pattern: SessionKind[];
  readingWeeks: string[];
  // A dissertation has one empty section to start, and no weeks of term.
  kind?: "taught" | "dissertation";
}

// Creates the module with all 22 weeks and their sessions in one commit.
export async function createModule(input: NewModule): Promise<string> {
  const existing = (await db.modules.toArray()).filter((m) => !m.deleted);
  const last = existing.map((m) => m.position).sort().pop() ?? null;
  const moduleId = newId();
  const changes: Change[] = [
    {
      table: "modules",
      row: {
        id: moduleId,
        code: input.code.trim(),
        title: input.title.trim() || null,
        session_pattern: input.pattern,
        description: null,
        last_opened_week_id: null,
        position: keysAfter(last, 1)[0],
        kind: input.kind ?? "taught",
        key_dates: input.kind === "dissertation" ? [] : null,
      },
    },
  ];

  if (input.kind === "dissertation") {
    changes.push({ table: "weeks", row: { id: newId(), module_id: moduleId, term: "S" as const, number: 1, title: null, is_reading_week: false } });
    await commit(changes);
    return moduleId;
  }

  const sessionKeys = keysAfter(null, input.pattern.length);
  for (const term of TERMS) {
    for (const number of WEEK_NUMBERS) {
      const weekId = newId();
      const isReadingWeek = input.readingWeeks.includes(`${term}${number}`);
      changes.push({
        table: "weeks",
        row: { id: weekId, module_id: moduleId, term, number, title: null, is_reading_week: isReadingWeek },
      });
      if (isReadingWeek) continue;
      input.pattern.forEach((kind, index) => {
        changes.push({
          table: "sessions",
          row: { id: newId(), week_id: weekId, kind, title: null, position: sessionKeys[index] },
        });
      });
    }
  }
  await commit(changes);
  return moduleId;
}
