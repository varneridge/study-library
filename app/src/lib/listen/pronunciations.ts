// The course dictionary: your own pronunciations, kept in the synced settings
// table as one row per word ("pronounce:ussuri"), so an entry made on the phone
// reaches the laptop like any other setting, and two entries never overwrite
// each other. annotate.ts applies them before every paragraph is read.

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";
import { commit } from "../sync";
import type { PronunciationEntry } from "./annotate";

const PREFIX = "pronounce:";

export function pronunciationId(word: string): string {
  return PREFIX + word.trim().toLowerCase().replace(/\s+/g, " ");
}

function isEntry(value: unknown): value is PronunciationEntry {
  const v = value as PronunciationEntry | null;
  return !!v && typeof v.word === "string" && typeof v.say === "string" && v.word.trim() !== "" && v.say.trim() !== "";
}

/** Every entry in the dictionary, in alphabetical order. */
export async function loadPronunciations(): Promise<PronunciationEntry[]> {
  const rows = await db.settings.where("id").startsWith(PREFIX).toArray();
  return rows
    .filter((r) => !r.deleted && isEntry(r.value))
    .map((r) => r.value as PronunciationEntry)
    .sort((a, b) => a.word.localeCompare(b.word, "en-GB", { sensitivity: "base" }));
}

export function usePronunciations(): PronunciationEntry[] | undefined {
  return useLiveQuery(loadPronunciations, []);
}

export async function savePronunciation(entry: PronunciationEntry, replacing?: string): Promise<void> {
  const word = entry.word.trim().replace(/\s+/g, " ");
  const id = pronunciationId(word);
  const changes = [];
  if (replacing && pronunciationId(replacing) !== id) {
    const old = await db.settings.get(pronunciationId(replacing));
    if (old) changes.push({ table: "settings" as const, row: { ...old, deleted: true } });
  }
  const current = await db.settings.get(id);
  changes.push({ table: "settings" as const, row: { ...(current ?? {}), id, value: { word, say: entry.say.trim() }, deleted: false } });
  await commit(changes);
}

export async function deletePronunciation(word: string): Promise<void> {
  const current = await db.settings.get(pronunciationId(word));
  if (current) await commit([{ table: "settings", row: { ...current, deleted: true } }]);
}
