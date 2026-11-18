// Tests for folders on Library shelves (src/lib/folders.ts) against a real
// Dexie database. Runs on its own with `npx tsx tests/folders.ts` from app/,
// like tests/gcal.ts, using fake-indexeddb; nothing leaves the machine.

import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { createFolder, deleteFolder, linksAt, moveToFolder, naturalCompare, renameFolder, shelfFolders, sortFolderByTitle } from "../src/lib/folders";
import { keysAfter } from "../src/lib/keys";
import type { WeekItemRow } from "../src/lib/types";

// Changes are queued to sync; the queue's network calls go nowhere.
globalThis.fetch = (async () => new Response("{}", { status: 503 })) as typeof fetch;

const WEEK = "shelf-1";
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await db.week_items.clear();
  await db.folders.clear();
  await db.items.clear();
  try {
    await fn();
    console.log(`ok   folders: ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL folders: ${name}`);
    console.error(error);
  }
}

async function shelf(titles: string[]): Promise<WeekItemRow[]> {
  const keys = keysAfter(null, titles.length);
  const links = titles.map((t, i) => ({
    id: `link-${i}`, week_id: WEEK, item_id: `item-${i}`, session_id: null, position: keys[i], folder_id: null,
    modified_at: "2026-01-01T00:00:00Z", seq: 0, deleted: false,
  }));
  await db.items.bulkPut(titles.map((t, i) => ({ id: `item-${i}`, title: t, kind: "summary", deleted: false }) as never));
  await db.week_items.bulkPut(links as never);
  return links as WeekItemRow[];
}

const linkNow = async (id: string) => (await db.week_items.get(id))!;

async function main() {
  await test("a new folder sits at the end of the shelf's folders, with its own name", async () => {
    const a = await createFolder(WEEK);
    const b = await createFolder(WEEK, "Discworld");
    const folders = await shelfFolders(WEEK);
    assert.deepEqual(folders.map((f) => f.id), [a, b]);
    assert.equal(folders[0].title, "New folder");
    await renameFolder(a, "  The Expanse ");
    assert.equal((await shelfFolders(WEEK))[0].title, "The Expanse");
    await renameFolder(a, "   ");
    assert.equal((await shelfFolders(WEEK))[0].title, "New folder", "a blank name keeps a name");
  });

  await test("readings go into a folder and out again, and loose readings stay on the shelf", async () => {
    const links = await shelf(["Leviathan Wakes", "Caliban's War", "A standalone book"]);
    const folder = await createFolder(WEEK, "The Expanse");
    await moveToFolder(await linkNow(links[0].id), folder);
    await moveToFolder(await linkNow(links[1].id), folder);
    const all = await db.week_items.toArray();
    const folders = await shelfFolders(WEEK);
    assert.deepEqual(linksAt(all, folders, folder).map((l) => l.id).sort(), ["link-0", "link-1"]);
    assert.deepEqual(linksAt(all, folders, null).map((l) => l.id), ["link-2"], "the standalone book stays loose");
    await moveToFolder(await linkNow("link-0"), null);
    assert.deepEqual(linksAt(await db.week_items.toArray(), folders, null).map((l) => l.id).sort(), ["link-0", "link-2"]);
  });

  await test("deleting a folder never deletes its readings, and Undo puts everything back", async () => {
    const links = await shelf(["One", "Two"]);
    const folder = await createFolder(WEEK, "Series");
    await moveToFolder(await linkNow(links[0].id), folder);
    const undo = await deleteFolder((await shelfFolders(WEEK))[0]);
    assert.equal((await shelfFolders(WEEK)).length, 0);
    const after = await db.week_items.toArray();
    assert.ok(after.every((l) => !l.deleted && !l.folder_id), "every reading is back on the shelf");
    await undo();
    assert.equal((await shelfFolders(WEEK)).length, 1);
    assert.equal((await linkNow(links[0].id)).folder_id, folder);
  });

  await test("a reading naming a folder that is gone counts as loose, so nothing is hidden", async () => {
    const links = await shelf(["Orphan"]);
    await db.week_items.update(links[0].id, { folder_id: "gone" });
    assert.deepEqual(linksAt(await db.week_items.toArray(), await shelfFolders(WEEK), null).map((l) => l.id), [links[0].id]);
  });

  await test("sort by title puts numbers in order of value", async () => {
    const links = await shelf(["Volume 10", "Volume 2", "Volume 1"]);
    const folder = await createFolder(WEEK, "Series");
    for (const l of links) await moveToFolder(await linkNow(l.id), folder);
    await sortFolderByTitle(folder);
    const inside = (await db.week_items.where("folder_id").equals(folder).toArray()).sort((a, b) => (a.position < b.position ? -1 : 1));
    assert.deepEqual(inside.map((l) => l.item_id), ["item-2", "item-1", "item-0"]);
    assert.ok(naturalCompare("Book 9", "Book 10") < 0 && naturalCompare("a", "B") < 0);
  });

  if (failed) {
    console.log(`\n${failed} failed`);
    process.exit(1);
  }
  console.log("\nall folder tests passed");
  process.exit(0);
}

void main();
