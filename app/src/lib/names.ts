// Names the app gives things itself, so nobody has to type them.
//
// A deck of slides is named for where it is: "HY248 AT4 Lecture slides", or
// "HY300 Literature review Supervision slides" in a dissertation's section.
// A second deck in the same session is "HY248 AT4 Lecture slides 2". When a
// deck moves, a name the app gave it moves with it; a name you typed stays.
//
// Downloads are named for what they are, not for the file they came from:
// a reading by its short reference, slides by their name, and a recording by
// its session.

import { db, getMeta, setMeta } from "./db";
import { sessionLabel, weekCode } from "./modules";
import { parseTitle, stripExtension } from "./parse";
import { shortTitle, fullTitle } from "./titles";
import type { ItemRow, SessionKind, WeekRow } from "./types";

export function slidesBase(moduleCode: string, week: Pick<WeekRow, "term" | "number" | "title">, sessionKind: SessionKind | null): string {
  // A combined session is the whole week, so its slides need no session's name.
  const session = sessionKind && sessionKind !== "combined" ? sessionLabel(sessionKind) : null;
  return [moduleCode.trim(), weekCode(week), session, "slides"].filter(Boolean).join(" ");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Whether a title is one the app gave for this place: the base, or the base and a number.
export function isPlaceName(title: string, base: string): boolean {
  return title === base || new RegExp(`^${escape(base)} \\d+$`).test(title);
}

// The first of "base", "base 2", "base 3" that no other deck in the place has.
export function freeName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

// The name a file would have given a deck, so one renamed by hand is never renamed by the app.
export function fileGivenTitle(originalName: string | null | undefined): string[] {
  if (!originalName) return [];
  const stem = stripExtension(originalName);
  return [originalName, stem, parseTitle(stem).title].filter(Boolean);
}

interface Place { weekId: string; sessionId: string | null }

async function placeBase(place: Place): Promise<string | null> {
  const week = await db.weeks.get(place.weekId);
  const module = week ? await db.modules.get(week.module_id) : undefined;
  if (!week || !module) return null;
  const session = place.sessionId ? await db.sessions.get(place.sessionId) : undefined;
  return slidesBase(module.code, week, session && !session.deleted ? session.kind : null);
}

// Titles of the other decks already in a place.
async function titlesIn(place: Place, except: string | null): Promise<string[]> {
  const links = (await db.week_items.where("week_id").equals(place.weekId).toArray())
    .filter((l) => !l.deleted && (l.session_id ?? null) === place.sessionId && l.item_id !== except);
  const items = await db.items.bulkGet(links.map((l) => l.item_id));
  return items.filter((i): i is ItemRow => Boolean(i && !i.deleted && i.kind === "slides")).map((i) => i.title);
}

// The name for a new deck in a place, given names already chosen in the same batch.
export async function nameForNewSlides(place: Place, chosen: string[] = []): Promise<string | null> {
  const base = await placeBase(place);
  if (!base) return null;
  return freeName(base, [...(await titlesIn(place, null)), ...chosen]);
}

// The new name for a deck moving from one place to another, or null to keep its name.
export async function nameAfterMove(item: ItemRow, from: Place | null, to: Place): Promise<string | null> {
  if (item.kind !== "slides" || !from) return null;
  const before = await placeBase(from);
  if (!before || !isPlaceName(item.title, before)) return null;
  const base = await placeBase(to);
  if (!base) return null;
  return freeName(base, await titlesIn(to, item.id));
}

// Once on each device, decks that still carry their file's name take the
// name of their place. Decks you named yourself are left as they are.
export async function nameSlidesOnce(): Promise<number> {
  if (await getMeta<boolean>("slides-named")) return 0;
  // Only after a first sync, so a new device does not mark this done on an empty library.
  if (!((await getMeta<number>("cursor")) ?? 0)) return 0;
  const { commit } = await import("./sync");
  const decks = (await db.items.toArray()).filter((i) => i.kind === "slides" && !i.deleted);
  const links = (await db.week_items.toArray()).filter((l) => !l.deleted);
  const { byPosition } = await import("./keys");
  links.sort(byPosition);
  const chosen = new Map<string, string[]>();
  const changes = [];
  for (const link of links) {
    const item = decks.find((d) => d.id === link.item_id);
    if (!item) continue;
    const place = { weekId: link.week_id, sessionId: link.session_id ?? null };
    const base = await placeBase(place);
    if (!base || isPlaceName(item.title, base)) continue;
    const file = await db.files.get(item.original_file_id ?? item.file_id ?? "");
    if (!fileGivenTitle(file?.original_name).includes(item.title)) continue;
    const scope = `${place.weekId}:${place.sessionId ?? ""}`;
    const name = freeName(base, [...(await titlesIn(place, item.id)), ...(chosen.get(scope) ?? [])]);
    chosen.set(scope, [...(chosen.get(scope) ?? []), name]);
    changes.push({ table: "items" as const, row: { id: item.id, title: name }, patch: true as const });
  }
  if (changes.length) await commit(changes);
  await setMeta("slides-named", true);
  return changes.length;
}

// A name a file can be saved under on any computer: no characters Windows or
// macOS refuse, no full stop at the end, and not so long it is cut off.
export function safeFileName(name: string, extension: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120)
    .trim();
  return `${clean || "file"}.${extension.replace(/^\./, "")}`;
}

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "audio/ogg": "ogg", "audio/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav",
};

export function extensionFor(mime: string | null | undefined, originalName?: string | null): string {
  const fromName = originalName && /\.([a-z0-9]{2,5})$/i.exec(originalName)?.[1];
  return fromName?.toLowerCase() ?? (mime ? EXTENSIONS[mime.split(";")[0]] : undefined) ?? "pdf";
}

// A reading downloads as its short reference; slides by their name.
export function readingFileName(item: Pick<ItemRow, "kind" | "author" | "year" | "title" | "source" | "pages" | "doc_date">,
  file: { mime: string; original_name: string | null }): string {
  const name = item.kind === "slides" ? item.title : item.kind === "primary" ? fullTitle(item) : shortTitle(item);
  return safeFileName(name, extensionFor(file.mime, file.original_name));
}
