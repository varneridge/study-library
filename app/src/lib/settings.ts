// Settings that follow you across devices, kept in the synced settings table.

import { useLiveQuery } from "dexie-react-hooks";
import { db } from "./db";
import { commit } from "./sync";

export const COLOURS = [
  { value: "#ffd400", label: "Yellow" },
  { value: "#ff6666", label: "Red" },
  { value: "#5fb236", label: "Green" },
  { value: "#2ea8e5", label: "Blue" },
  { value: "#a28ae5", label: "Purple" },
];

export type ColourNames = Record<string, string>;

export function useSetting<T>(id: string, fallback: T): T {
  return useLiveQuery(async () => {
    const row = await db.settings.get(id);
    return row && !row.deleted ? (row.value as T) : fallback;
  }, [id], fallback);
}

export async function setSetting(id: string, value: unknown): Promise<void> {
  const current = await db.settings.get(id);
  await commit([{ table: "settings", row: { ...(current ?? {}), id, value, deleted: false } }]);
}

// What a highlight colour means, if you have named it.
export function colourLabel(value: string, names: ColourNames): string {
  const name = names[value.toLowerCase()]?.trim();
  return name || COLOURS.find((c) => c.value === value.toLowerCase())?.label || "Highlight";
}

export function useColourNames(): ColourNames {
  return useSetting<ColourNames>("highlight-colours", {});
}

// Remembers a session as opened, so the home page can offer it again.
export async function noteSessionOpened(sessionId: string): Promise<void> {
  const list = (((await db.settings.get("recent-sessions"))?.value ?? []) as { id: string; at: string }[]).filter((e) => e.id !== sessionId);
  await setSetting("recent-sessions", [{ id: sessionId, at: new Date().toISOString() }, ...list].slice(0, 12));
}
