import type { SessionKind } from "./types";

// What a session card on the week page offers beneath its notes. Each kind
// gets placeholders only for its own materials: a lecture invites slides, a
// seminar invites questions, and nothing else invites anything. Whatever a
// session already holds is always shown, whatever its kind, so changing a
// session's kind never hides work.
export type Material =
  | { kind: "slides"; count: number }
  | { kind: "add-slides"; more: boolean }
  | { kind: "recordings"; count: number }
  | { kind: "questions"; count: number };

export interface MaterialCounts { slides: number; recordings: number; questions: number }

export function takesSlides(kind: SessionKind | string): boolean {
  return kind === "lecture";
}

export function sessionMaterials(kind: SessionKind | string, counts: MaterialCounts): Material[] {
  const out: Material[] = [];
  if (counts.slides > 0) out.push({ kind: "slides", count: counts.slides });
  if (takesSlides(kind)) out.push({ kind: "add-slides", more: counts.slides > 0 });
  if (counts.recordings > 0) out.push({ kind: "recordings", count: counts.recordings });
  if (kind === "seminar" || counts.questions > 0) out.push({ kind: "questions", count: counts.questions });
  return out;
}
