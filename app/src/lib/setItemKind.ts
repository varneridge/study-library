// Changes a reading's kind between primary, secondary and summary.
// Updating an item updates it in every week that lists it.

import { db } from "./db";
import { KIND_GROUP } from "./kinds";
import type { ReadingKind } from "./readingKinds";
import { update } from "./sync";
import { showToast } from "./ui";

export async function setItemKind(itemId: string, kind: ReadingKind): Promise<void> {
  const item = await db.items.get(itemId);
  if (!item || item.kind === kind) return;
  const previous = item.kind;
  await update("items", itemId, { kind });
  const label = KIND_GROUP[kind] ?? kind;
  showToast(`Moved to ${label.toLowerCase()}.`, {
    label: "Undo",
    run: () => void update("items", itemId, { kind: previous }),
  });
}
