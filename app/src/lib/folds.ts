// Collapsible headings that fold their whole section, as in Word and Notion.
// A folded heading hides every block after it up to the next heading of the
// same level or higher, so folding "Causes" hides its paragraphs and its
// subheadings but stops at "Consequences". BlockNote's own toggle heading
// folds only the blocks nested beneath it, which is not how a section works.

export interface FoldBlock {
  id: string;
  type: string;
  level?: number;
  toggleable?: boolean;
  // Whether a collapsible heading is open. Only a false closes its section.
  open?: boolean;
}

export function foldedBlockIds(blocks: readonly FoldBlock[]): string[] {
  const hidden: string[] = [];
  let foldedAt: number | null = null;
  for (const block of blocks) {
    const level = block.type === "heading" ? block.level ?? 1 : null;
    if (foldedAt !== null) {
      if (level !== null && level <= foldedAt) foldedAt = null;
      else {
        hidden.push(block.id);
        continue;
      }
    }
    if (level !== null && block.toggleable && block.open === false) foldedAt = level;
  }
  return hidden;
}

// Maps each hidden block to the heading that folded it, so moving the cursor
// into that block or searching for it can unfold its section.
export function foldOwners(blocks: readonly FoldBlock[]): Map<string, string> {
  const owners = new Map<string, string>();
  let foldedAt: number | null = null;
  let ownerId: string | null = null;
  for (const block of blocks) {
    const level = block.type === "heading" ? block.level ?? 1 : null;
    if (foldedAt !== null) {
      if (level !== null && level <= foldedAt) {
        foldedAt = null;
        ownerId = null;
      } else {
        if (ownerId) owners.set(block.id, ownerId);
        continue;
      }
    }
    if (level !== null && block.toggleable && block.open === false) {
      foldedAt = level;
      ownerId = block.id;
    }
  }
  return owners;
}

// The rule that hides a folded section, kept to one editor by its scope.
export function foldStyles(scope: string, ids: readonly string[]): string {
  if (!ids.length) return "";
  const quote = (value: string) => value.replace(/["\\]/g, "\\$&");
  const selectors = ids.map((id) => `[data-fold-scope="${quote(scope)}"] .bn-block-outer[data-id="${quote(id)}"]`);
  return `${selectors.join(",\n")} { display: none; }`;
}
