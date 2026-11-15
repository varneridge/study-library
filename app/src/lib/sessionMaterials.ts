import type { SessionKind } from "./types";

// What a session card on the week page offers beneath its notes. A lecture
// without slides invites them; nothing else invites anything. A session holds
// one deck, so once it has slides it is not offered more; new slides dropped
// on it replace the deck instead. Whatever a session already holds is always
// shown, whatever its kind, so changing a session's kind never hides work.
export type Material =
  | { kind: "slides"; count: number }
  | { kind: "add-slides" }
  | { kind: "recordings"; count: number };

export interface MaterialCounts { slides: number; recordings: number }

export function takesSlides(kind: SessionKind | string): boolean {
  return kind === "lecture";
}

export function sessionMaterials(kind: SessionKind | string, counts: MaterialCounts): Material[] {
  const out: Material[] = [];
  if (counts.slides > 0) out.push({ kind: "slides", count: counts.slides });
  if (counts.slides === 0 && takesSlides(kind)) out.push({ kind: "add-slides" });
  if (counts.recordings > 0) out.push({ kind: "recordings", count: counts.recordings });
  return out;
}
