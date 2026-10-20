// The notes editor. Loaded on demand, because the editor is large.

import "@blocknote/mantine/style.css";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { en } from "@blocknote/core/locales";
import {
  createReactBlockSpec, getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote,
  type DefaultReactSuggestionItem,
} from "@blocknote/react";
import { db } from "../lib/db";
import { placesOf } from "../lib/library";
import { matches } from "../lib/search";
import { uploadImage } from "../lib/uploads";
import { showToast } from "../lib/ui";
import { useDark } from "../lib/appearance";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { colourLabel, useColourNames } from "../lib/settings";
import { blockText, findNote, noteBlocks, saveNote, targetKey, type NoteTarget, type Saved } from "../lib/notes";
import { href, navigate } from "../lib/router";
import { fullTitle, shortTitle } from "../lib/titles";
import type { Block, HighlightRow, ItemRow, NoteBlockRow, NoteRow } from "../lib/types";

// Inside a reading's own notes, a quotation's page link moves the reader to
// the passage instead of opening the reading again.
import { QuoteContext } from "./quoteContext";

function Quote({
  block,
  editor,
  props,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  editor?: any;
  props: { highlightId: string; itemId: string; page: number; text: string; colour: string; source: string };
}) {
  const { readingId, open } = useContext(QuoteContext);
  const names = useColourNames();
  const here = readingId && props.itemId === readingId;
  const to = { view: "reader" as const, id: props.itemId, page: props.page };
  const named = names[props.colour.toLowerCase()];
  const write = () => {
    if (!editor || !block) return;
    const doc = editor.document;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const index = doc.findIndex((b: any) => b.id === block.id);
    if (index < 0) return;
    const next = doc[index + 1];
    const empty = next && next.type === "paragraph" && !blockText(next as unknown as Block).trim();
    if (empty) {
      editor.setTextCursorPosition(next, "start");
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const [inserted] = editor.insertBlocks([{ type: "paragraph" } as any], doc[index], "after");
      editor.setTextCursorPosition(inserted, "start");
    }
    editor.focus();
  };

  return (
    <div className="note-highlight" style={{ borderLeftColor: props.colour }} contentEditable={false}>
      <span className="quote">{props.text}</span>
      <span className="quote-meta">
        {here ? (
          <button type="button" className="plain" onClick={() => open?.(props.highlightId, props.page)}>p. {props.page + 1}</button>
        ) : (
          <a href={href(to)} onClick={(e) => { e.preventDefault(); navigate(to); }}>{props.source}, p. {props.page + 1}</a>
        )}
        {named && <span className="quote-tag">{colourLabel(props.colour, names)}</span>}
        {editor && block && (
          <button
            type="button"
            className="plain quiet quote-write"
            aria-label="Write note"
            title="Write note"
            onClick={write}
          >
            Write note
          </button>
        )}
        {editor && block && (
          <button
            type="button"
            className="plain quiet quote-delete"
            aria-label="Delete quotation"
            title="Delete quotation"
            onClick={() => editor.removeBlocks([block])}
          >
            Delete
          </button>
        )}
      </span>
    </div>
  );
}

const createHighlight = createReactBlockSpec(
  {
    type: "highlight",
    propSchema: {
      highlightId: { default: "" },
      itemId: { default: "" },
      page: { default: 0 },
      text: { default: "" },
      colour: { default: "#ffd400" },
      source: { default: "" },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) => <Quote block={block} editor={editor} props={block.props} />,
  },
);

// Pictures are allowed in notes. Audio, video and other files are left out,
// because those belong in the library.
const { audio: _a, video: _v, file: _f, ...textBlocks } = defaultBlockSpecs;
const schema = BlockNoteSchema.create({ blockSpecs: { ...textBlocks, highlight: createHighlight() } });

export interface NoteEditorHandle {
  insertHighlight(highlight: HighlightRow, item: ItemRow): void;
  // Puts the cursor on the line beneath a quotation, ready to write about it.
  writeUnder(highlightId: string): boolean;
  // Puts the cursor at the start of the notes.
  focus(): void;
}

interface Props {
  target: NoteTarget;
  handle?: Ref<NoteEditorHandle>;
  // Removing a quotation from a reading's notes removes its highlight.
  onQuoteRemoved?: (highlightId: string) => void;
  // Undoing the deletion of a quotation restores its highlight.
  onQuoteRestored?: (highlightId: string) => void;
  // What an empty editor says, in place of the general hint.
  placeholder?: string;
  // A short editor, such as a seminar question's answer.
  compact?: boolean;
  // What a screen reader calls the editor, such as "Lecture notes".
  label?: string;
}

interface Loaded {
  note: NoteRow | null;
  rows: NoteBlockRow[];
}

// What an empty line says, so the editor explains itself.
const PLACEHOLDER = "Write here. Type / for headings, lists and pictures, or @ to cite a reading.";

// The block menu keeps what notes on history need.
const KEPT = new Set(["heading", "heading_2", "heading_3", "quote", "numbered_list", "bullet_list", "paragraph", "table", "image", "divider"]);

// Typing @ offers readings to cite, most recently opened first.
async function readingSuggestions(
  query: string,
  insert: (text: string, url: string) => void,
): Promise<DefaultReactSuggestionItem[]> {
  const items = (await db.items.toArray())
    .filter((i) => !i.deleted && i.kind !== "slides" && (!query || matches(fullTitle(i), query)))
    .sort((a, b) => (b.last_opened_at ?? "").localeCompare(a.last_opened_at ?? "") || a.title.localeCompare(b.title))
    .slice(0, 8);
  const places = await placesOf(items.map((i) => i.id));
  return items.map((item) => ({
    title: shortTitle(item),
    subtext: places.get(item.id)?.label,
    onItemClick: () => insert(shortTitle(item), href({ view: "reader", id: item.id })),
  }));
}


function snapshot(rows: NoteBlockRow[]): Map<string, Saved> {
  return new Map(rows.map((r) => [r.id, { position: r.position, json: JSON.stringify(r.content), row: r }]));
}

function Inner({ target, handle, live, onQuoteRemoved, onQuoteRestored, placeholder, compact, label = "Notes" }: Props & { live: Loaded }) {
  const noteId = useRef<string | null>(live.note?.id ?? null);
  const saved = useRef(snapshot(live.rows));
  const applying = useRef(false);
  const stale = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const dark = useDark();

  const editor = useCreateBlockNote(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      schema,
      dictionary: {
        ...en,
        // An empty editor says what it is for; each new empty line explains / and @.
        placeholders: { ...en.placeholders, emptyDocument: placeholder ?? PLACEHOLDER, default: PLACEHOLDER },
      },
      // Pasted, dropped or chosen pictures are stored, then shown from storage.
      uploadFile: async (file: File) => {
        try {
          return await uploadImage(file);
        } catch (error) {
          showToast(error instanceof Error ? error.message : "The picture could not be added.");
          throw error;
        }
      },
      initialContent: live.rows.length ? (live.rows.map((r) => r.content) as any) : undefined },
    [],
  );

  const applyRemote = useCallback(() => {
    // Never overwrite unsaved user edits in flight:
    if (timer.current) {
      stale.current = true;
      return;
    }
    // Never interrupt the user while writing or interacting with the note editor:
    if (editor.isFocused() || (container.current && container.current.contains(document.activeElement))) {
      stale.current = true;
      return;
    }

    applying.current = true;

    // Preserve text cursor position across remote block updates
    let cursor: { blockId: string; placement: "start" | "end" } | null = null;
    try {
      const pos = editor.getTextCursorPosition?.();
      if (pos?.block?.id) {
        cursor = { blockId: pos.block.id, placement: "end" };
      }
    } catch {
      // ignore
    }

    if (live.rows.length) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.replaceBlocks(editor.document, live.rows.map((r) => r.content) as any);
      saved.current = snapshot(live.rows);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      editor.replaceBlocks(editor.document, [{ type: "paragraph" } as any]);
      saved.current = new Map();
    }

    if (cursor) {
      try {
        const doc = editor.document;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const target = doc.find((b: any) => b.id === cursor!.blockId);
        if (target) {
          editor.setTextCursorPosition(target, cursor.placement);
        }
      } catch {
        // ignore
      }
    }

    applying.current = false;
    stale.current = false;
  }, [editor, live]);

  const persist = useCallback(async () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const id = await saveNote(target, noteId.current, editor.document as unknown as Block[], saved.current);
    if (id) noteId.current = id;
    if (stale.current && !editor.isFocused() && !(container.current && container.current.contains(document.activeElement))) {
      applyRemote();
    }
  }, [editor, target, applyRemote]);

  useEffect(
    () =>
      editor.onChange((_editor, { getChanges }) => {
        if (applying.current) return;
        if ("item_id" in target) {
          for (const change of getChanges()) {
            const block = change.block as unknown as Block;
            if (block.type === "highlight" && block.props?.itemId === target.item_id) {
              const hid = String(block.props.highlightId);
              if (change.type === "delete") {
                onQuoteRemoved?.(hid);
              } else if (change.type === "insert") {
                onQuoteRestored?.(hid);
              }
            }
          }
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void persist(), 400);
      }),
    [editor, persist, onQuoteRemoved, onQuoteRestored, target],
  );

  // Save straight away when leaving the page.
  useEffect(() => () => {
    if (timer.current) {
      clearTimeout(timer.current);
      void persist();
    }
  }, [persist]);

  // Edits from other devices arrive here. They wait while you are typing.
  useEffect(() => {
    if (live.note) noteId.current = live.note.id;
    let differs = live.rows.length !== saved.current.size;
    for (const row of live.rows) {
      const entry = saved.current.get(row.id);
      if (entry) entry.row = row;
      if (!entry || entry.position !== row.position || entry.json !== JSON.stringify(row.content)) differs = true;
    }
    if (differs) {
      if (editor.isFocused() || timer.current || (container.current && container.current.contains(document.activeElement))) {
        stale.current = true;
      } else {
        applyRemote();
      }
    }
  }, [live, editor, applyRemote]);

  // The editable area has no name of its own, so give it one.
  useEffect(() => {
    const area = container.current?.querySelector(".bn-editor, [contenteditable='true']");
    area?.setAttribute("aria-label", label);
  }, [label]);

  useImperativeHandle(handle, () => ({
    focus() {
      const first = editor.document[0];
      editor.focus();
      if (first) editor.setTextCursorPosition(first, "start");
    },
    insertHighlight(highlight, item) {
      const doc = editor.document;
      const reference = editor.isFocused() ? editor.getTextCursorPosition().block : doc[doc.length - 1];
      editor.insertBlocks(
        [{
          type: "highlight",
          props: {
            highlightId: highlight.id, itemId: item.id, page: highlight.page,
            text: highlight.body ?? "", colour: highlight.colour, source: shortTitle(item),
          },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any],
        reference,
        "after",
      );
    },
    writeUnder(highlightId) {
      const doc = editor.document;
      const index = doc.findIndex((b) => b.type === "highlight" && (b.props as { highlightId?: string }).highlightId === highlightId);
      if (index < 0) return false;
      const next = doc[index + 1];
      const empty = next && next.type === "paragraph" && !blockText(next as unknown as Block).trim();
      if (empty) editor.setTextCursorPosition(next, "start");
      else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const [inserted] = editor.insertBlocks([{ type: "paragraph" } as any], doc[index], "after");
        editor.setTextCursorPosition(inserted, "start");
      }
      editor.focus();
      return true;
    },
  }), [editor]);

  // Intercept Backspace and Enter on quotations:
  // Backspacing does not delete the quotation, and pressing Enter starts a note beneath it.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Backspace") {
        try {
          const sel = editor.getSelection();
          if (sel && sel.blocks.length === 1 && sel.blocks[0].type === "highlight") {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
        } catch {
          // ignore
        }
      } else if (e.key === "Enter" && !e.shiftKey) {
        try {
          const sel = editor.getSelection();
          if (sel && sel.blocks.length === 1 && sel.blocks[0].type === "highlight") {
            e.preventDefault();
            e.stopPropagation();
            const hl = sel.blocks[0];
            const doc = editor.document;
            const index = doc.findIndex((b) => b.id === hl.id);
            if (index >= 0) {
              const next = doc[index + 1];
              const empty = next && next.type === "paragraph" && !blockText(next as unknown as Block).trim();
              if (empty) editor.setTextCursorPosition(next, "start");
              else {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const [inserted] = editor.insertBlocks([{ type: "paragraph" } as any], doc[index], "after");
                editor.setTextCursorPosition(inserted, "start");
              }
              editor.focus();
            }
          }
        } catch {
          // ignore
        }
      }
    };
    el.addEventListener("keydown", handleKeyDown, true);
    return () => el.removeEventListener("keydown", handleKeyDown, true);
  }, [editor]);

  // Clicking empty space below notes allows typing at the end.
  const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    const doc = editor.document;
    if (!doc.length) return;
    const lastBlock = doc[doc.length - 1];
    const editorDom = container.current?.querySelector(".bn-editor");
    if (!editorDom) return;
    const blocks = editorDom.querySelectorAll(".bn-block");
    const lastEl = blocks[blocks.length - 1];
    if (lastEl) {
      const rect = lastEl.getBoundingClientRect();
      if (e.clientY > rect.bottom) {
        if (lastBlock.type === "paragraph" && !blockText(lastBlock as unknown as Block).trim()) {
          editor.setTextCursorPosition(lastBlock, "end");
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const [inserted] = editor.insertBlocks([{ type: "paragraph" } as any], lastBlock, "after");
          editor.setTextCursorPosition(inserted, "start");
        }
        editor.focus();
      }
    }
  };

  return (
    <div
      ref={container}
      className={`note-editor${compact ? " compact" : ""}`}
      aria-label={label}
      onClick={handleContainerClick}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
            void persist();
          } else if (stale.current) {
            applyRemote();
          }
        }
      }}
    >
      <BlockNoteView editor={editor} theme={dark ? "dark" : "light"} slashMenu={false}>
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              getDefaultReactSlashMenuItems(editor).filter((item) => KEPT.has((item as { key?: string }).key ?? "")),
              query,
            )
          }
        />
        <SuggestionMenuController
          triggerCharacter="@"
          getItems={(query) =>
            readingSuggestions(query, (text, url) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              editor.insertInlineContent([{ type: "link", href: url, content: text } as any, " "]);
            })
          }
        />
      </BlockNoteView>
    </div>
  );
}

export default function NoteEditor(props: Props) {
  const key = targetKey(props.target);
  const live = useLiveQuery(async () => {
    const note = await findNote(props.target);
    return { note, rows: note ? await noteBlocks(note.id) : [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!live) return null;
  return <Inner key={key} {...props} live={live} />;
}
