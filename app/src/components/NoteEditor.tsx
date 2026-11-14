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
import { commentWriter } from "../lib/highlightComments";
import { placesOf } from "../lib/library";
import { update } from "../lib/sync";
import { citable } from "../lib/progress";
import { matches } from "../lib/search";
import { uploadImage } from "../lib/uploads";
import { showToast } from "../lib/ui";
import { useDark } from "../lib/appearance";
import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useContext, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { foldedBlockIds, foldStyles } from "../lib/folds";
import { colourLabel, useColourNames } from "../lib/settings";
import { blockText, findNote, mergeDuplicateNotes, noteBlocks, saveNote, targetKey, type NoteTarget, type Saved } from "../lib/notes";
import { href, navigate } from "../lib/router";
import { fullTitle, shortTitle } from "../lib/titles";
import type { Block, HighlightRow, ItemRow, NoteBlockRow, NoteRow } from "../lib/types";

// Inside a reading's own notes, a quotation's page link moves the reader to
// the passage instead of opening the reading again.
import { QuoteContext } from "./quoteContext";

// Outside the reader there is no shared writer, so notes elsewhere use this one.
const fallbackComments = commentWriter((highlightId, comment) => update("highlights", highlightId, { comment }));

const COMMENT_FIELD = "[data-highlight-comment]";

function fitHeight(field: HTMLTextAreaElement | null) {
  if (!field) return;
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight}px`;
}

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
  const { readingId, open, highlights, comments } = useContext(QuoteContext);
  const names = useColourNames();
  const here = readingId && props.itemId === readingId;
  const to = { view: "reader" as const, id: props.itemId, page: props.page };
  const named = names[props.colour.toLowerCase()];

  // The comment lives on the highlight itself. The reader hands its highlights
  // down; anywhere else the card looks its own highlight up.
  const shared = highlights?.get(props.highlightId);
  const looked = useLiveQuery(
    async () => (highlights || !props.highlightId ? null : (await db.highlights.get(props.highlightId)) ?? null),
    [props.highlightId, Boolean(highlights)],
    null,
  );
  const stored = (shared ?? looked)?.comment ?? "";
  const writer = comments ?? fallbackComments;
  const field = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(stored);
  const focused = useRef(false);
  // Changes from elsewhere show at once, except while you are typing here.
  useEffect(() => {
    if (!focused.current) setDraft(stored);
  }, [stored]);
  useEffect(() => fitHeight(field.current), [draft]);
  // Keystrokes reach the field, never the editor around it.
  const keep = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <div className="note-highlight" data-highlight-card="" data-highlight-id={props.highlightId} style={{ borderLeftColor: props.colour }} contentEditable={false}>
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
            className="plain quiet quote-delete"
            aria-label="Delete quotation"
            title="Delete quotation"
            onClick={() => editor.removeBlocks([block])}
          >
            Delete
          </button>
        )}
      </span>
      {props.highlightId && (
        <textarea
          ref={field}
          data-highlight-comment=""
          className="quote-comment"
          rows={1}
          aria-label="Comment on this highlight"
          placeholder="Add a comment"
          value={draft}
          onFocus={() => { focused.current = true; }}
          onChange={(e) => {
            setDraft(e.target.value);
            writer.set(props.highlightId, e.target.value);
          }}
          onBlur={() => {
            focused.current = false;
            void writer.flush(props.highlightId).catch(() => showToast("Your comment could not be saved yet. It will be retried."));
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            // Escape leaves the comment and goes back to the notes around it.
            if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.blur();
              if (editor && block) {
                try { editor.setTextCursorPosition(block, "end"); } catch { /* the block may have gone */ }
                editor.focus();
              }
            }
          }}
          onKeyUp={keep}
          onPaste={keep}
          onCopy={keep}
          onCut={keep}
        />
      )}
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
  /** @deprecated Delegates to focusComment. */
  writeUnder(highlightId: string): boolean;
  // Puts the cursor in a quotation's comment, ready to write about it.
  focusComment(highlightId: string): boolean;
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

// The block menu keeps what notes on history need, collapsible headings among them.
const KEPT = new Set([
  "heading", "heading_2", "heading_3", "toggle_heading", "toggle_heading_2", "toggle_heading_3",
  "quote", "numbered_list", "bullet_list", "paragraph", "table", "image", "divider",
]);

// Collapsible headings, named for what they do, in sentence case.
const SLASH_MENU = {
  ...en.slash_menu,
  toggle_heading: { ...en.slash_menu.toggle_heading, title: "Collapsible heading 1", subtext: "A heading whose section folds away" },
  toggle_heading_2: { ...en.slash_menu.toggle_heading_2, title: "Collapsible heading 2", subtext: "A section heading that folds away" },
  toggle_heading_3: { ...en.slash_menu.toggle_heading_3, title: "Collapsible heading 3", subtext: "A subheading that folds away" },
};

// Typing @ offers readings to cite, most recently opened first.
async function readingSuggestions(
  query: string,
  insert: (text: string, url: string) => void,
): Promise<DefaultReactSuggestionItem[]> {
  const items = (await db.items.toArray())
    .filter((i) => !i.deleted && citable(i) && (!query || matches(fullTitle(i), query)))
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
  const foldScope = useId();
  const [foldCss, setFoldCss] = useState("");

  const editor = useCreateBlockNote(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      schema,
      dictionary: {
        ...en,
        slash_menu: SLASH_MENU,
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
        timer.current = setTimeout(() => {
          timer.current = null;
          void persist();
        }, 400);
      }),
    [editor, persist, onQuoteRemoved, onQuoteRestored, target],
  );

  // Save straight away when leaving or hiding the page.
  useEffect(() => {
    const flush = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void persist();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
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

  useImperativeHandle(handle, () => {
    const focusComment = (highlightId: string): boolean => {
      const target = container.current?.querySelector<HTMLTextAreaElement>(
        `[data-highlight-card][data-highlight-id="${CSS.escape(highlightId)}"] ${COMMENT_FIELD}`,
      );
      if (!target) return false;
      target.scrollIntoView({ block: "nearest" });
      target.focus();
      const end = target.value.length;
      target.setSelectionRange(end, end);
      return true;
    };
    return {
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
    focusComment,
    writeUnder: focusComment,
    };
  }, [editor]);

  // Intercept Backspace and Enter on quotations:
  // Backspacing does not delete the quotation, and pressing Enter starts a note beneath it.
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Typing in a quotation's comment, or in any other field, is ordinary typing.
      if ((e.target as HTMLElement | null)?.closest?.(`${COMMENT_FIELD}, textarea, input`)) return;
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

  // A folded collapsible heading hides its whole section. Which headings are
  // open is read from BlockNote's own toggle buttons, so a fold stays as it
  // was left on this device; a new collapsible heading starts open, so
  // turning a heading into one never makes the writing beneath it vanish.
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const blocks = (editor.document as unknown as { id: string; type: string; props?: { level?: number; isToggleable?: boolean } }[]).map((b) => {
          const toggleable = b.type === "heading" && Boolean(b.props?.isToggleable);
          let open: boolean | undefined;
          if (toggleable) {
            const wrapper = root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${b.id}"] .bn-toggle-wrapper`);
            let known = true;
            try { known = localStorage.getItem(`toggle-${b.id}`) !== null; } catch { /* private browsing */ }
            if (wrapper && !known) {
              try { localStorage.setItem(`toggle-${b.id}`, "true"); } catch { /* private browsing */ }
              wrapper.setAttribute("data-show-children", "true");
            }
            open = wrapper ? wrapper.getAttribute("data-show-children") !== "false" : true;
          }
          return { id: b.id, type: b.type, level: b.props?.level, toggleable, open };
        });
        const next = foldStyles(foldScope, foldedBlockIds(blocks));
        setFoldCss((was) => (was === next ? was : next));
      });
    };
    refresh();
    const stop = editor.onChange(refresh);
    const observer = new MutationObserver(refresh);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["data-show-children"] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (typeof stop === "function") stop();
    };
  }, [editor, foldScope]);

  return (
    <div
      ref={container}
      data-fold-scope={foldScope}
      data-note-editor=""
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
      {foldCss && <style>{foldCss}</style>}
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
  useEffect(() => {
    void mergeDuplicateNotes(props.target);
  }, [key]);
  const live = useLiveQuery(async () => {
    const note = await findNote(props.target);
    return { note, rows: note ? await noteBlocks(note.id) : [] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!live) return null;
  return <Inner key={key} {...props} live={live} />;
}
