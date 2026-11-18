// Folders on Library shelves, such as a book series. A folder belongs to one
// shelf and is one level deep. A reading is in a folder when its week_items
// row names it; every other reading stays loose on the shelf, exactly as
// before, so a shelf can hold folders and standalone readings side by side.

import { db } from "./db";
import { byPosition, keyBetween, keysAfter } from "./keys";
import { commit, newId, update } from "./sync";
import type { FolderRow, WeekItemRow } from "./types";

export const NEW_FOLDER_TITLE = "New folder";

/** A shelf's folders, in their order. */
export async function shelfFolders(weekId: string): Promise<FolderRow[]> {
  return (await db.folders.where("week_id").equals(weekId).toArray()).filter((f) => !f.deleted).sort(byPosition);
}

/** The folder a reading's link is in, if that folder still exists. */
export function folderOf(link: Pick<WeekItemRow, "folder_id"> | null | undefined, folders: FolderRow[]): FolderRow | null {
  if (!link?.folder_id) return null;
  return folders.find((f) => f.id === link.folder_id) ?? null;
}

/**
 * The links that belong at one place: loose on the shelf when `folderId` is
 * null, or in that folder. A link naming a folder that has been deleted counts
 * as loose, so nothing is ever hidden by a folder that is gone.
 */
export function linksAt<T extends Pick<WeekItemRow, "folder_id">>(links: T[], folders: FolderRow[], folderId: string | null): T[] {
  const live = new Set(folders.filter((f) => !f.deleted).map((f) => f.id));
  return links.filter((l) => {
    const at = l.folder_id && live.has(l.folder_id) ? l.folder_id : null;
    return at === folderId;
  });
}

/** Make a folder at the end of a shelf's folders and return its id, so its name can be edited at once. */
export async function createFolder(weekId: string, title: string = NEW_FOLDER_TITLE): Promise<string> {
  const existing = await shelfFolders(weekId);
  const id = newId();
  const position = keysAfter(existing.at(-1)?.position ?? null, 1)[0];
  await commit([{ table: "folders", row: { id, week_id: weekId, title, position } }]);
  return id;
}

export async function renameFolder(id: string, title: string): Promise<void> {
  await update("folders", id, { title: title.trim() || NEW_FOLDER_TITLE });
}

/** Put a reading in a folder, or with null take it out onto the shelf, at the end of where it lands. */
export async function moveToFolder(link: WeekItemRow, folderId: string | null): Promise<void> {
  if ((link.folder_id ?? null) === folderId) return;
  const siblings = (await db.week_items.where("week_id").equals(link.week_id).toArray()).filter(
    (l) => !l.deleted && l.id !== link.id && (l.folder_id ?? null) === folderId,
  );
  const last = siblings.sort(byPosition).at(-1)?.position ?? null;
  await update("week_items", link.id, { folder_id: folderId, position: keyBetween(last, null) });
}

/**
 * Delete a folder. Its readings are never deleted: they go back onto the
 * shelf. Returns a function that undoes it, folder and readings both.
 */
export async function deleteFolder(folder: FolderRow): Promise<() => Promise<void>> {
  const inside = (await db.week_items.where("folder_id").equals(folder.id).toArray()).filter((l) => !l.deleted);
  await commit([
    { table: "folders", row: { id: folder.id, deleted: true }, patch: true },
    ...inside.map((l) => ({ table: "week_items" as const, row: { id: l.id, folder_id: null }, patch: true })),
  ]);
  return async () => {
    await commit([
      { table: "folders", row: { id: folder.id, deleted: false }, patch: true },
      ...inside.map((l) => ({ table: "week_items" as const, row: { id: l.id, folder_id: folder.id }, patch: true })),
    ]);
  };
}

const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });

/** Titles compared as a person would, with numbers by value: "Volume 2" before "Volume 10". */
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

/** Put a folder's readings in title order, numbers by value, as most series want. */
export async function sortFolderByTitle(folderId: string): Promise<void> {
  const links = (await db.week_items.where("folder_id").equals(folderId).toArray()).filter((l) => !l.deleted);
  const items = await db.items.bulkGet(links.map((l) => l.item_id));
  const titleOf = new Map(links.map((l, i) => [l.id, items[i]?.title ?? ""]));
  const sorted = [...links].sort((a, b) => naturalCompare(titleOf.get(a.id) ?? "", titleOf.get(b.id) ?? ""));
  const keys = keysAfter(null, sorted.length);
  await commit(sorted.map((l, i) => ({ table: "week_items" as const, row: { id: l.id, position: keys[i] }, patch: true })));
}
