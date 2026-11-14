// The notes editor. Loaded on demand, because the editor is large.

import "@blocknote/mantine/style.css";
import "./noteEditor.css";
import { BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { en } from "@blocknote/core/locales";
import {
  createReactBlockSpec, FormattingToolbarController, getDefaultReactSlashMenuItems,
  SideMenuController, SuggestionMenuController, useCreateBlockNote,
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
import { foldedBlockIds, foldOwners, foldStyles, type FoldBlock } from "../lib/folds";
import { FOLD_ATTRIBUTES, foldParts, openFold, openIfNew, readOpen, rememberOpen } from "../lib/foldDom";
import {
  blockFixes, headingUpgrades, HEADING_TITLES, isBlockMoveShortcut, noteVariant,
  PLACEHOLDERS, removedMessage, SLASH_KEYS, type NoteVariant, type RuleBlock, type RuleChange,
} from "../lib/noteRules";
import { colourLabel, useColourNames } from "../lib/settings";
import { blockText, findNote, mergeDuplicateNotes, noteBlocks, saveNote, targetKey, type NoteTarget, type Saved } from "../lib/notes";
import { href, navigate } from "../lib/router";
import { fullTitle, shortTitle } from "../lib/titles";
import type { Block, HighlightRow, ItemRow, NoteBlockRow, NoteRow } from "../lib/types";
import { DragOnlySideMenu, NotesFormattingToolbar } from "./NoteToolbars";

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
  // Variant override if not derived from target.
  variant?: NoteVariant;
}

interface Loaded {
  note: NoteRow | null;
  rows: NoteBlockRow[];
}

// Collapsible headings offered in the notes' block menu:
// "toggle_heading", "toggle_heading_2", "toggle_heading_3" (Collapsible heading 1)
const SLASH_MENU = {
  ...en.slash_menu,
  toggle_heading: { ...en.slash_menu.toggle_heading, ...HEADING_TITLES.toggle_heading },
  toggle_heading_2: { ...en.slash_menu.toggle_heading_2, ...HEADING_TITLES.toggle_heading_2 },
  toggle_heading_3: { ...en.slash_menu.toggle_heading_3, ...HEADING_TITLES.toggle_heading_3 },
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

function Inner({ target, handle, live, onQuoteRemoved, onQuoteRestored, placeholder, compact, label = "Notes", variant: explicitVariant }: Props & { live: Loaded }) {
  const variant = explicitVariant ?? noteVariant(target);
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
        placeholders: {
          ...en.placeholders,
          emptyDocument: placeholder ?? PLACEHOLDERS[variant],
          default: PLACEHOLDERS[variant],
        },
      },
      // Pasted, dropped or chosen pictures are stored, only allowed in general notes.
      uploadFile: variant === "general" ? async (file: File) => {
        try {
          return await uploadImage(file);
        } catch (error) {
          showToast(error instanceof Error ? error.message : "The picture could not be added.");
          throw error;
        }
      } : undefined,
      initialContent: live.rows.length ? (live.rows.map((r) => r.content) as any) : undefined,
    },
    [variant],
  );

  const upgradeHeadings = useCallback(() => {
    const upgrades = headingUpgrades(variant, editor.document as unknown as RuleBlock[]);
    if (upgrades.length) {
      editor.transact(() => {
        for (const u of upgrades) {
          if (u.op === "update") {
            rememberOpen(u.id);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            editor.updateBlock(u.id, { props: u.props } as any);
          }
        }
      });
    }
  }, [editor, variant]);

  // Upgrade headings on mount
  useEffect(() => {
    upgradeHeadings();
  }, [upgradeHeadings]);

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
        const targetBlock = doc.find((b: any) => b.id === cursor!.blockId);
        if (targetBlock) {
          editor.setTextCursorPosition(targetBlock, cursor.placement);
        }
      } catch {
        // ignore
      }
    }

    upgradeHeadings();
    applying.current = false;
    stale.current = false;
  }, [editor, live, upgradeHeadings]);

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
        const changes = getChanges();
        if ("item_id" in target) {
          for (const change of changes) {
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

        // Apply rules to clean up pasted/inserted blocks
        const fixes = blockFixes(variant, changes as unknown as RuleChange[]);
        if (fixes.length) {
          queueMicrotask(() => {
            editor.transact(() => {
              for (const fix of fixes) {
                if (fix.op === "update") {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  editor.updateBlock(fix.id, { type: fix.type, props: fix.props } as any);
                } else if (fix.op === "remove") {
                  editor.removeBlocks([fix.id]);
                  showToast(removedMessage(variant, fix.blockType));
                }
              }
            });
          });
        }

        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          void persist();
        }, 400);
      }),
    [editor, persist, onQuoteRemoved, onQuoteRestored, target, variant],
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
      const targetEl = container.current?.querySelector<HTMLTextAreaElement>(
        `[data-highlight-card][data-highlight-id="${CSS.escape(highlightId)}"] ${COMMENT_FIELD}`,
      );
      if (!targetEl) return false;
      targetEl.scrollIntoView({ block: "nearest" });
      targetEl.focus();
      const end = targetEl.value.length;
      targetEl.setSelectionRange(end, end);
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

  // Intercept Backspace and Enter on quotations, and stop BlockNote from moving blocks on Ctrl+Arrow:
  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Stop block relocation shortcuts so normal word jumping and selection work smoothly
      if (isBlockMoveShortcut(e)) {
        e.stopPropagation();
        return;
      }

      // Restrict code or strike formatting in reading notes
      if (variant === "reading" && (e.ctrlKey || e.metaKey)) {
        if ((e.shiftKey && (e.key === "S" || e.key === "s")) || e.key === "e" || e.key === "E") {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
      }

      // Typing in a quotation's comment, or in any other field, is ordinary typing.
      if ((e.target as HTMLElement | null)?.closest?.(`${COMMENT_FIELD}, textarea, input`)) return;
      if (e.key === "Backspace") {
        try {
          const sel = editor.getSelection();
          if (sel && sel.blocks.length === 1 && (sel.blocks[0] as any).type === "highlight") {
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
          if (sel && sel.blocks.length === 1 && (sel.blocks[0] as any).type === "highlight") {
            e.preventDefault();
            e.stopPropagation();
            const hl = sel.blocks[0] as any;
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
  }, [editor, variant]);

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
        const blocks: FoldBlock[] = (editor.document as unknown as { id: string; type: string; props?: { level?: number; isToggleable?: boolean } }[]).map((b) => {
          const toggleable = b.type === "heading" && Boolean(b.props?.isToggleable);
          let open: boolean | undefined;
          if (toggleable) {
            const parts = foldParts(root, b.id);
            openIfNew(parts, b.id);
            open = readOpen(parts);
          }
          return { id: b.id, type: b.type, level: b.props?.level, toggleable, open };
        });
        const next = foldStyles(foldScope, foldedBlockIds(blocks));
        setFoldCss((was) => (was === next ? was : next));
      });
    };
    refresh();
    const stop = editor.onChange(refresh);
    const stopSel = editor.onSelectionChange?.(() => {
      const sel = editor.getTextCursorPosition?.();
      if (!sel?.block?.id) return;
      const blocks: FoldBlock[] = (editor.document as unknown as { id: string; type: string; props?: { level?: number; isToggleable?: boolean } }[]).map((b) => ({
        id: b.id,
        type: b.type,
        level: b.props?.level,
        toggleable: b.type === "heading" && Boolean(b.props?.isToggleable),
        open: readOpen(foldParts(root, b.id)),
      }));
      const owners = foldOwners(blocks);
      const ownerId = owners.get(sel.block.id);
      if (ownerId) {
        openFold(foldParts(root, ownerId));
      }
    });
    const observer = new MutationObserver(refresh);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: [...FOLD_ATTRIBUTES] });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (typeof stop === "function") stop();
      if (typeof stopSel === "function") stopSel();
    };
  }, [editor, foldScope]);

  return (
    <div
      ref={container}
      data-fold-scope={foldScope}
      data-note-editor=""
      data-variant={variant}
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
      <BlockNoteView
        editor={editor}
        theme={dark ? "dark" : "light"}
        slashMenu={false}
        formattingToolbar={false}
        sideMenu={false}
      >
        <FormattingToolbarController formattingToolbar={() => <NotesFormattingToolbar variant={variant} />} />
        <SideMenuController sideMenu={DragOnlySideMenu} />
        <SuggestionMenuController
          triggerCharacter="/"
          getItems={async (query) =>
            filterSuggestionItems(
              getDefaultReactSlashMenuItems(editor).filter((item) => SLASH_KEYS[variant].has((item as { key?: string }).key ?? "")),
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
