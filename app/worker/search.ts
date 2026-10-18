import type { Env } from "./env";

// Splits typed text into words and "quoted phrases".
export function tokens(input: string): { text: string; phrase: boolean }[] {
  const out: { text: string; phrase: boolean }[] = [];
  for (const match of input.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const phrase = match[1] !== undefined;
    const text = (match[1] ?? match[2] ?? "").replace(/["*^():]/g, " ").replace(/\s+/g, " ").trim();
    if (text) out.push({ text, phrase });
  }
  return out.slice(0, 8);
}

// Turns typed text into an FTS5 query. Every word and phrase must match.
// A last bare word matches as a prefix, so results appear while typing.
export function ftsQuery(input: string): string | null {
  const parts = tokens(input);
  if (parts.length === 0) return null;
  return parts
    .map((p, i) => (p.phrase || i < parts.length - 1 ? `"${p.text}"` : `"${p.text}"*`))
    .join(" ");
}

const START = "\u0001";
const END = "\u0002";

export async function search(env: Env, input: string, limit = 40) {
  const query = ftsQuery(input);
  if (!query) return { pages: [], transcripts: [], more: false };
  const take = Math.min(Math.max(limit, 1), 400);
  const [pages, transcripts] = await env.DB.batch([
    env.DB.prepare(
      `SELECT file_id, CAST(page AS INTEGER) AS page,
              snippet(page_text, 0, ?2, ?3, '…', 14) AS snippet
         FROM page_text WHERE page_text MATCH ?1 ORDER BY bm25(page_text) LIMIT ?4`,
    ).bind(query, START, END, take + 1),
    env.DB.prepare(
      `SELECT recording_id, CAST(start_seconds AS REAL) AS start,
              snippet(transcript_text, 0, ?2, ?3, '…', 14) AS snippet
         FROM transcript_text WHERE transcript_text MATCH ?1 ORDER BY bm25(transcript_text) LIMIT ?4`,
    ).bind(query, START, END, take + 1),
  ]);
  const p = pages.results ?? [];
  const t = transcripts.results ?? [];
  return { pages: p.slice(0, take), transcripts: t.slice(0, take), more: p.length > take || t.length > take };
}
