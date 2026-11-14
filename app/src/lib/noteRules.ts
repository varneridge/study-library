// Which editing tools each kind of note offers. Kept apart from the editor so
// the rules can be tested without a browser, and so the slash menu, the
// formatting toolbar and the clean-up after pasting all read one source.
//
// Session notes:  collapsible headings 1 to 3, quote, numbered and bullet lists,
//                 divider, table and normal text.
// Reading notes:  normal text, bullet and numbered lists, with bold, italic and
//                 underline. No headings, one font size.
// Other notes:    as session notes, with pictures as well.
// Quotations (the "highlight" block) are inserted by the app, never from a
// menu, so every kind of note keeps them.

export type NoteVariant = "session" | "reading" | "general";

export function noteVariant(target: object): NoteVariant {
  if ("item_id" in target) return "reading";
  if ("session_id" in target) return "session";
  return "general";
}

const SESSION_SLASH = [
  "toggle_heading", "toggle_heading_2", "toggle_heading_3",
  "quote", "numbered_list", "bullet_list", "paragraph", "table", "divider",
] as const;

export const SLASH_KEYS: Record<NoteVariant, ReadonlySet<string>> = {
  session: new Set(SESSION_SLASH),
  general: new Set([...SESSION_SLASH, "image"]),
  reading: new Set(["paragraph", "bullet_list", "numbered_list"]),
};

const SESSION_TYPES = ["paragraph", "heading", "quote", "numberedListItem", "bulletListItem", "divider", "table", "highlight"] as const;

export const BLOCK_TYPES: Record<NoteVariant, ReadonlySet<string>> = {
  session: new Set(SESSION_TYPES),
  general: new Set([...SESSION_TYPES, "image"]),
  reading: new Set(["paragraph", "bulletListItem", "numberedListItem", "highlight"]),
};

// Block types whose words survive being turned into normal text.
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "heading", "quote", "checkListItem", "toggleListItem", "codeBlock", "numberedListItem", "bulletListItem", "paragraph",
]);

export const MAX_HEADING_LEVEL = 3;

// What a menu or a paste may leave behind, and what to make of it.
export interface RuleBlock {
  id: string;
  type: string;
  props?: { level?: number; isToggleable?: boolean } & Record<string, unknown>;
  children?: readonly RuleBlock[];
}

export interface RuleChange {
  type: "insert" | "update" | "delete" | "move";
  block: RuleBlock;
  source?: { type: string };
}

export type NoteFix =
  | { op: "update"; id: string; type?: string; props?: Record<string, unknown> }
  | { op: "remove"; id: string; blockType: string };

// Undo and redo are left alone, so undoing a clean-up never fights the
// clean-up; remote edits are left alone because their author's editor has
// already applied its own rules.
const IGNORED_SOURCES: ReadonlySet<string> = new Set(["undo", "redo", "undo-redo", "yjs-remote"]);

function fixFor(variant: NoteVariant, block: RuleBlock): NoteFix | null {
  if (block.type === "heading") {
    if (variant === "reading") return { op: "update", id: block.id, type: "paragraph", props: {} };
    const level = Math.min(block.props?.level ?? 1, MAX_HEADING_LEVEL);
    if (block.props?.isToggleable === true && block.props?.level === level) return null;
    return { op: "update", id: block.id, props: { level, isToggleable: true } };
  }
  if (BLOCK_TYPES[variant].has(block.type)) return null;
  if (TEXT_TYPES.has(block.type)) return { op: "update", id: block.id, type: "paragraph", props: {} };
  return { op: "remove", id: block.id, blockType: block.type };
}

// The fixes that bring newly inserted or changed blocks within a variant's
// rules. Each block is fixed at most once, and nested blocks are checked too,
// because a pasted list arrives with its children inside it.
export function blockFixes(variant: NoteVariant, changes: readonly RuleChange[]): NoteFix[] {
  const fixes = new Map<string, NoteFix>();
  const removed = new Set<string>();
  const visit = (block: RuleBlock) => {
    if (fixes.has(block.id)) return;
    const fix = fixFor(variant, block);
    if (fix) fixes.set(block.id, fix);
    // A removed block takes its children with it, so they need no fix of their own.
    if (fix?.op === "remove") {
      removed.add(block.id);
      return;
    }
    for (const child of block.children ?? []) visit(child);
  };
  for (const change of changes) {
    if (change.type !== "insert" && change.type !== "update") continue;
    if (change.source && IGNORED_SOURCES.has(change.source.type)) continue;
    visit(change.block);
  }
  return [...fixes.values()];
}

// Headings already in a note when it opens become collapsible, so every
// heading folds. Only headings are touched; nothing else in an old note is
// rewritten, so opening a note never loses anything.
export function headingUpgrades(variant: NoteVariant, blocks: readonly RuleBlock[]): NoteFix[] {
  if (variant === "reading") return [];
  const fixes: NoteFix[] = [];
  const walk = (list: readonly RuleBlock[]) => {
    for (const block of list) {
      if (block.type === "heading") {
        const fix = fixFor(variant, block);
        if (fix) fixes.push(fix);
      }
      walk(block.children ?? []);
    }
  };
  walk(blocks);
  return fixes;
}

// BlockNote moves the current block with Ctrl+Shift+Up and Ctrl+Shift+Down
// (Cmd on a Mac). Every Ctrl or Cmd arrow is kept from the editor's own
// shortcuts, so the browser's word and paragraph jumps and selection apply.
const ARROWS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);

export function isBlockMoveShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return ARROWS.has(e.key) && (e.ctrlKey || e.metaKey) && !e.altKey;
}

// The block type select's choices, narrowed to what a variant allows. Each
// heading level appears once, as the collapsible kind, named plainly.
export interface TypeItem {
  name: string;
  type: string;
  props?: Record<string, boolean | number | string>;
}

const SELECT_TYPES: Record<NoteVariant, ReadonlySet<string>> = {
  session: new Set(["paragraph", "heading", "quote", "bulletListItem", "numberedListItem"]),
  general: new Set(["paragraph", "heading", "quote", "bulletListItem", "numberedListItem"]),
  reading: new Set(["paragraph", "bulletListItem", "numberedListItem"]),
};

export function typeSelectItems<T extends TypeItem>(variant: NoteVariant, items: readonly T[]): T[] {
  const allowed = SELECT_TYPES[variant];
  const out: T[] = [];
  for (const item of items) {
    if (!allowed.has(item.type)) continue;
    if (item.type === "heading") {
      const level = Number(item.props?.level ?? 1);
      if (level > MAX_HEADING_LEVEL || item.props?.isToggleable !== true) continue;
      out.push({ ...item, name: `Heading ${level}` });
      continue;
    }
    out.push(item);
  }
  return out;
}

// The slash menu's names for the three headings: plain, since every heading folds.
export const HEADING_TITLES: Record<"toggle_heading" | "toggle_heading_2" | "toggle_heading_3", { title: string; subtext: string }> = {
  toggle_heading: { title: "Heading 1", subtext: "A top-level heading whose section folds away" },
  toggle_heading_2: { title: "Heading 2", subtext: "A section heading that folds away" },
  toggle_heading_3: { title: "Heading 3", subtext: "A subheading that folds away" },
};

export const PLACEHOLDERS: Record<NoteVariant, string> = {
  session: "Write here. Type / for headings, lists and tables, or @ to cite a reading.",
  general: "Write here. Type / for headings, lists and pictures, or @ to cite a reading.",
  reading: "Write here. Type / for a list, or @ to cite a reading.",
};

const NAMES: Record<string, string> = {
  image: "Pictures", table: "Tables", divider: "Dividers", audio: "Audio", video: "Video", file: "Files", pageBreak: "Page breaks",
};

export function removedMessage(variant: NoteVariant, blockType: string): string {
  const what = NAMES[blockType] ?? "That kind of block";
  const where = variant === "reading" ? "reading notes" : variant === "session" ? "session notes" : "these notes";
  return `${what} are not used in ${where}, so it was left out.`;
}
