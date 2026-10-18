// Search runs locally over notes, highlights and titles, so it works offline.
// Page text and transcripts are searched on the server when online.
//
// Both halves read a query the same way: every word must match at the start
// of a word, and "quoted phrases" must match as written.

import { db } from "./db";
import { placesOf, type Place } from "./library";
import { weekCode } from "./modules";
import { blockText } from "./notes";
import { api } from "./sync";
import { fullTitle } from "./titles";
import { speakerLabel } from "./transcriptImport";
import type { HighlightRow, ItemRow, ModuleRow, NoteRow } from "./types";

export const MARK_START = "\u0001";
export const MARK_END = "\u0002";

// Folds case and accents, so "Etat" finds "État".
// Curly quotes match straight ones, one character for one, so excerpts line up.
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[\u2018\u2019]/g, "'").toLowerCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function tokens(input: string): { text: string; phrase: boolean }[] {
  const out: { text: string; phrase: boolean }[] = [];
  for (const match of input.matchAll(/"([^"]*)"?|(\S+)/g)) {
    const phrase = match[1] !== undefined;
    const text = fold((match[1] ?? match[2] ?? "").replace(/\s+/g, " ").trim());
    if (text) out.push({ text, phrase });
  }
  return out.slice(0, 8);
}

function patterns(query: string): RegExp[] {
  return tokens(query).map((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(t.text).replace(/ /g, "\\s+")}`, "gu"));
}

export function matches(text: string, query: string): boolean {
  const folded = fold(text);
  const all = patterns(query);
  return all.length > 0 && all.every((p) => p.test(folded));
}

// A short excerpt around the first match, with every match marked. Folding
// keeps string lengths for most text, so positions carry across. When it
// does not, the excerpt is shown unmarked.
export function marked(text: string, query: string, width = 200): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const folded = fold(clean);
  if (folded.length !== clean.length) return clean.slice(0, width);
  const ranges: [number, number][] = [];
  for (const p of patterns(query)) {
    for (const m of folded.matchAll(p)) ranges.push([m.index!, m.index! + m[0].length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const first = ranges[0]?.[0] ?? 0;
  const from = Math.max(0, first - 60);
  const to = Math.min(clean.length, from + width);
  let out = from > 0 ? "…" : "";
  let at = from;
  for (const [a, b] of ranges) {
    if (a < at || a >= to) continue;
    out += clean.slice(at, a) + MARK_START + clean.slice(a, Math.min(b, to)) + MARK_END;
    at = Math.min(b, to);
  }
  return out + clean.slice(at, to) + (to < clean.length ? "…" : "");
}

export interface TitleHit { item: ItemRow; place: Place | null }
export interface HighlightGroup { item: ItemRow; place: Place | null; highlights: { highlight: HighlightRow; text: string }[] }
export interface NoteGroup {
  key: string;
  label: string;
  route: { view: "session" | "reader" | "question" | "week"; id: string };
  module: ModuleRow | null;
  snippets: string[];
  count: number;
}
export interface PageGroup { item: ItemRow; place: Place | null; pages: { page: number; snippet: string }[] }
// An imported transcript has no times, so its hits are counted in turns.
export interface TranscriptGroup { recordingId: string; sessionId: string; label: string; module: ModuleRow | null; imported: boolean; hits: { start: number; snippet: string; who?: string }[] }

export interface LocalResults { titles: TitleHit[]; highlights: HighlightGroup[]; notes: NoteGroup[] }
export interface RemoteResults { pages: PageGroup[]; transcripts: TranscriptGroup[]; more: boolean }

async function sessionPlace(sessionId: string): Promise<{ label: string; module: ModuleRow | null; kind: string }> {
  const session = await db.sessions.get(sessionId);
  const week = session ? await db.weeks.get(session.week_id) : undefined;
  const module = week ? (await db.modules.get(week.module_id)) ?? null : null;
  const kind = session?.title || (session?.kind === "lecture" ? "Lecture" : session?.kind === "seminar" ? "Seminar" : "Session");
  return { label: [module?.code, week && weekCode(week)].filter(Boolean).join(" "), module, kind };
}

export async function searchLocal(query: string): Promise<LocalResults> {
  if (!tokens(query).length) return { titles: [], highlights: [], notes: [] };
  const items = new Map((await db.items.toArray()).filter((i) => !i.deleted).map((i) => [i.id, i]));

  const titleItems = [...items.values()].filter((item) => matches(fullTitle(item), query));
  const byItem = new Map<string, { highlight: HighlightRow; text: string }[]>();
  for (const highlight of await db.highlights.toArray()) {
    if (highlight.deleted || !items.has(highlight.item_id)) continue;
    const body = `${highlight.body ?? ""}${highlight.comment ? ` (${highlight.comment})` : ""}`;
    if (!matches(body, query)) continue;
    byItem.set(highlight.item_id, [...(byItem.get(highlight.item_id) ?? []), { highlight, text: marked(body, query, 260) }]);
  }

  const notes = new Map((await db.notes.toArray()).filter((n) => !n.deleted).map((n) => [n.id, n]));
  const byNote = new Map<string, { note: NoteRow; snippets: string[] }>();
  for (const block of await db.note_blocks.toArray()) {
    if (block.deleted) continue;
    const note = notes.get(block.note_id);
    const text = blockText(block.content);
    if (!note || !matches(text, query)) continue;
    const entry = byNote.get(note.id) ?? { note, snippets: [] };
    entry.snippets.push(marked(text, query));
    byNote.set(note.id, entry);
  }

  const places = await placesOf([...new Set([...titleItems.map((i) => i.id), ...byItem.keys()])]);
  const noteGroups: NoteGroup[] = [];
  for (const { note, snippets } of byNote.values()) {
    let label = "Note";
    let route: NoteGroup["route"];
    let module: ModuleRow | null = null;
    if (note.session_id) {
      const place = await sessionPlace(note.session_id);
      label = `${place.kind} notes, ${place.label}`;
      module = place.module;
      route = { view: "session", id: note.session_id };
    } else if (note.item_id) {
      const item = items.get(note.item_id);
      const place = (await placesOf([note.item_id])).get(note.item_id);
      label = `Notes on ${item ? fullTitle(item) : "a reading"}${place ? `, ${place.label}` : ""}`;
      module = place?.module ?? null;
      route = { view: "reader", id: note.item_id };
    } else if (note.week_id) {
      // A dissertation section's own notes.
      const week = await db.weeks.get(note.week_id);
      if (!week || week.deleted) continue;
      module = (await db.modules.get(week.module_id)) ?? null;
      label = `Notes on ${weekCode(week)}${module ? `, ${module.code}` : ""}`;
      route = { view: "week", id: week.id };
    } else {
      const question = await db.questions.get(note.question_id!);
      const place = question ? await sessionPlace(question.session_id) : null;
      label = `Seminar answer${place ? `, ${place.label}` : ""}`;
      module = place?.module ?? null;
      if (!question) continue;
      route = { view: "session", id: question.session_id };
    }
    noteGroups.push({ key: note.id, label, route, module, snippets: snippets.slice(0, 3), count: snippets.length });
  }

  return {
    titles: titleItems.map((item) => ({ item, place: places.get(item.id) ?? null })),
    highlights: [...byItem.entries()].map(([itemId, list]) => ({
      item: items.get(itemId)!,
      place: places.get(itemId) ?? null,
      highlights: list.sort((a, b) => a.highlight.page - b.highlight.page),
    })),
    notes: noteGroups,
  };
}

export async function searchRemote(query: string, limit = 40): Promise<RemoteResults> {
  if (!navigator.onLine || !tokens(query).length) return { pages: [], transcripts: [], more: false };
  const result = await (await api(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`)).json() as {
    pages: { file_id: string; page: number; snippet: string }[];
    transcripts: { recording_id: string; start: number; snippet: string }[];
    more?: boolean;
  };

  // Results arrive best first, so readings keep the order of their best page.
  const groups = new Map<string, PageGroup>();
  for (const page of result.pages) {
    const items = (await db.items.where("file_id").equals(page.file_id).toArray()).filter((i) => !i.deleted);
    for (const item of items) {
      const group = groups.get(item.id) ?? { item, place: null, pages: [] };
      group.pages.push({ page: page.page, snippet: page.snippet });
      groups.set(item.id, group);
    }
  }
  const places = await placesOf([...groups.keys()]);
  for (const group of groups.values()) {
    group.place = places.get(group.item.id) ?? null;
    group.pages.sort((a, b) => a.page - b.page);
  }

  const recordings = new Map<string, TranscriptGroup>();
  for (const t of result.transcripts) {
    const recording = await db.recordings.get(t.recording_id);
    if (!recording || recording.deleted) continue;
    let group = recordings.get(recording.id);
    if (!group) {
      const place = await sessionPlace(recording.session_id);
      group = {
        recordingId: recording.id, sessionId: recording.session_id, module: place.module, hits: [], imported: Boolean(recording.turns),
        label: `${place.kind}${recording.turns ? " transcript" : ""}, ${place.label}`,
      };
      recordings.set(recording.id, group);
    }
    // An imported transcript's hit is labelled with who was speaking.
    let who: string | undefined;
    if (recording.turns) {
      const names = ((await db.settings.get(`speakers:${recording.id}`))?.value ?? {}) as Record<string, string>;
      const turn = recording.turns[t.start];
      if (turn) who = speakerLabel(turn.speaker, names);
    }
    group.hits.push({ start: t.start, snippet: t.snippet, who });
  }
  for (const group of recordings.values()) group.hits.sort((a, b) => a.start - b.start);

  return { pages: [...groups.values()], transcripts: [...recordings.values()], more: Boolean(result.more) };
}
