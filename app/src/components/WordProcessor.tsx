import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import {
  coalesceRuns,
  countDocxWords,
  computeFootnoteNumbers,
  formatRunsInRange,
  insertRunAtOffset,
  spliceRunsOnTextEdit,
  splitBlockRunsAtOffset,
  type DocxBlock,
  type DocxBlockType,
  type DocxComment,
  type DocxDocument,
  type DocxFootnote,
  type DocxRun,
} from "../lib/docx";
import {
  downloadDocxFile,
  formatChicagoFootnote,
  getModuleAssessment,
  importAssessmentDocxFile,
  saveDraftSnapshot,
  saveModuleAssessment,
  useModuleAssessment,
} from "../lib/assessment";
import { db } from "../lib/db";
import { newId } from "../lib/sync";
import { fullTitle, shortTitle } from "../lib/titles";
import type { ItemRow } from "../lib/types";
import { showToast, useCloseOnBack, useTitle } from "../lib/ui";

interface EditableBlockProps {
  block: DocxBlock;
  index: number;
  fnNumbers: Map<string, number>;
  active: boolean;
  searchQuery?: string;
  onFocusBlock: (blockId: string) => void;
  onUpdateText: (blockId: string, text: string) => void;
  onSplitBlock: (blockId: string, offset: number) => void;
  onMergePrev: (blockId: string) => void;
  onJumpToFootnote: (footnoteId: string) => void;
  onSelectComment: (commentId: string) => void;
  onSelectionChange: (sel: {
    blockId: string;
    startOffset: number;
    endOffset: number;
    selectedText: string;
  }) => void;
}

function EditableBlock({
  block,
  index,
  fnNumbers,
  active,
  searchQuery,
  onFocusBlock,
  onUpdateText,
  onSplitBlock,
  onMergePrev,
  onJumpToFootnote,
  onSelectComment,
  onSelectionChange,
}: EditableBlockProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const blockText = useMemo(
    () =>
      block.runs
        .filter((r) => r.type === "text")
        .map((r) => r.text ?? "")
        .join(""),
    [block.runs],
  );

  const fnRefs = useMemo(
    () => block.runs.filter((r) => r.type === "footnote_ref" && r.footnoteId),
    [block.runs],
  );

  const commentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const r of block.runs) {
      for (const cid of r.commentIds ?? []) ids.add(cid);
    }
    return [...ids];
  }, [block.runs]);

  const hasBold = useMemo(() => block.runs.some((r) => r.type === "text" && r.bold), [block.runs]);
  const hasItalic = useMemo(() => block.runs.some((r) => r.type === "text" && r.italic), [block.runs]);
  const hasUnderline = useMemo(() => block.runs.some((r) => r.type === "text" && r.underline), [block.runs]);
  const hasStrike = useMemo(() => block.runs.some((r) => r.type === "text" && r.strike), [block.runs]);
  const highlightColour = useMemo(
    () => block.runs.find((r) => r.type === "text" && r.highlight)?.highlight,
    [block.runs],
  );

  // Auto-resize textarea height to content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 28)}px`;
  }, [blockText, block.type]);

  if (block.type === "page_break") {
    return (
      <div
        className={`word-page-break${active ? " active" : ""}`}
        onClick={() => onFocusBlock(block.id)}
        role="separator"
        aria-label="Page break"
      >
        <span>Page break</span>
      </div>
    );
  }

  const blockClass = [
    "word-block",
    `word-block-${block.type}`,
    block.align ? `align-${block.align}` : "",
    hasBold ? "word-run is-bold" : "",
    hasItalic ? "word-run is-italic" : "",
    hasUnderline ? "word-run is-underline" : "",
    hasStrike ? "word-run is-strike" : "",
    highlightColour ? `word-run is-highlight-${highlightColour}` : "",
    commentIds.length > 0 ? "word-run is-commented" : "",
    active ? "is-active" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const captureSel = (el: HTMLTextAreaElement) => {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? start;
    onSelectionChange({
      blockId: block.id,
      startOffset: start,
      endOffset: end,
      selectedText: el.value.slice(start, end),
    });
  };

  const hasSearchHit = Boolean(
    searchQuery?.trim() && blockText.toLowerCase().includes(searchQuery.trim().toLowerCase()),
  );

  return (
    <div className="word-block-wrap">
      <textarea
        ref={textareaRef}
        className={blockClass}
        rows={1}
        aria-label={index === 0 ? "Essay body" : `Paragraph ${index + 1}`}
        data-block-id={block.id}
        value={blockText}
        placeholder={index === 0 ? "Begin writing your essay…" : ""}
        onFocus={(e) => {
          onFocusBlock(block.id);
          captureSel(e.currentTarget);
        }}
        onSelect={(e) => captureSel(e.currentTarget)}
        onKeyUp={(e) => captureSel(e.currentTarget)}
        onMouseUp={(e) => captureSel(e.currentTarget)}
        onChange={(e) => {
          onUpdateText(block.id, e.target.value);
          captureSel(e.currentTarget);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const pos = e.currentTarget.selectionStart ?? blockText.length;
            onSplitBlock(block.id, pos);
          } else if (e.key === "Backspace" && !blockText && fnRefs.length === 0 && index > 0) {
            e.preventDefault();
            onMergePrev(block.id);
          }
        }}
      />
      {(fnRefs.length > 0 || commentIds.length > 0 || hasSearchHit) && (
        <div className="word-block-markers">
          {fnRefs.map((fn) => {
            const num = fnNumbers.get(fn.footnoteId!) ?? 1;
            return (
              <sup
                key={fn.footnoteId}
                className="word-fn-ref"
                data-footnote-id={fn.footnoteId}
                role="button"
                tabIndex={0}
                title={`Jump to footnote ${num}`}
                aria-label={`Jump to footnote ${num}`}
                onClick={() => onJumpToFootnote(fn.footnoteId!)}
              >
                {num}
              </sup>
            );
          })}
          {commentIds.map((cid, idx) => (
            <button
              key={cid}
              type="button"
              className="quiet small"
              onClick={() => onSelectComment(cid)}
            >
              Comment {idx + 1}
            </button>
          ))}
          {hasSearchHit && searchQuery && (
            <mark className="find-hit current">{searchQuery.trim()}</mark>
          )}
        </div>
      )}
    </div>
  );
}

export function WordProcessor({ id, q }: { id: string; q?: string }) {
  const module = useLiveQuery(() => db.modules.get(id), [id]);
  const storedRow = useLiveQuery(() => db.settings.get(`assessment:${id}`), [id]);
  const assessment = useModuleAssessment(id, module?.code);

  const [title, setTitle] = useState(assessment.title);
  const [doc, setDoc] = useState<DocxDocument>(assessment.draft);
  const [mode, setMode] = useState<"edit" | "review">("edit");
  const [activeBlockId, setActiveBlockId] = useState<string>(assessment.draft.blocks[0]?.id ?? "b-1");
  const [showWordCount, setShowWordCount] = useState(false);
  const [showCiteModal, setShowCiteModal] = useState(false);
  const [citeQuery, setCiteQuery] = useState("");
  const [citeLocator, setCiteLocator] = useState("");
  const [excludeResolved, setExcludeResolved] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState<"saved" | "saving">("saved");

  const dirtyRef = useRef(false);
  const hydratedRef = useRef(false);
  const titleRef = useRef(title);
  titleRef.current = title;
  const docRef = useRef(doc);
  docRef.current = doc;

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseRevRef = useRef<number>(assessment.rev);
  const importInputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<{
    blockId: string;
    startOffset: number;
    endOffset: number;
    selectedText: string;
  } | null>(null);

  useTitle(title ? `${title} - Word processor` : "Word processor");
  useCloseOnBack(showWordCount, () => setShowWordCount(false));
  useCloseOnBack(showCiteModal, () => setShowCiteModal(false));

  // Hydrate once from IndexedDB if the user hasn't typed yet
  useEffect(() => {
    if (dirtyRef.current || hydratedRef.current) return;
    if (storedRow !== undefined) {
      hydratedRef.current = true;
      setTitle(assessment.title);
      setDoc(assessment.draft);
      baseRevRef.current = assessment.rev;
    }
  }, [storedRow, assessment]);

  const refIdsKey = assessment.referenceItemIds.join(",");

  const moduleReadings = useLiveQuery(async () => {
    const weeks = (await db.weeks.where("module_id").equals(id).toArray()).filter((w) => !w.deleted);
    const weekIds = new Set(weeks.map((w) => w.id));
    const weekItems = (await db.week_items.toArray()).filter((wi) => !wi.deleted && weekIds.has(wi.week_id));
    const itemIds = new Set(weekItems.map((wi) => wi.item_id));
    for (const refId of assessment.referenceItemIds) itemIds.add(refId);
    const allItems = (await db.items.toArray()).filter((i) => !i.deleted && (itemIds.has(i.id) || i.tray_module_id === id));
    return allItems.sort((a, b) => fullTitle(a).localeCompare(fullTitle(b)));
  }, [id, refIdsKey], [] as ItemRow[]);

  const persistDraft = useCallback(
    (nextDoc: DocxDocument, nextTitle: string) => {
      dirtyRef.current = true;
      setSavingStatus("saving");
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        saveTimerRef.current = null;
        const saved = await saveModuleAssessment(
          id,
          {
            title: nextTitle,
            draft: nextDoc,
          },
          { expectedBaseRev: baseRevRef.current, moduleCode: module?.code },
        );
        baseRevRef.current = saved.rev;
        setSavingStatus("saved");
      }, 250);
    },
    [id, module?.code],
  );

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        void saveModuleAssessment(
          id,
          { title: titleRef.current, draft: docRef.current },
          { expectedBaseRev: baseRevRef.current, moduleCode: module?.code },
        );
      }
    };
  }, [id, module?.code]);

  const updateDoc = useCallback(
    (updater: (prev: DocxDocument) => DocxDocument) => {
      const next = updater(docRef.current);
      docRef.current = next;
      setDoc(next);
      persistDraft(next, titleRef.current);
    },
    [persistDraft],
  );

  const fnNumbers = useMemo(() => computeFootnoteNumbers(doc), [doc]);
  const wordCounts = useMemo(() => countDocxWords(doc), [doc]);

  const activeBlock = useMemo(
    () => doc.blocks.find((b) => b.id === activeBlockId) ?? doc.blocks[0],
    [doc.blocks, activeBlockId],
  );

  const applyInlineFormat = (
    prop: "bold" | "italic" | "underline" | "strike" | "highlight",
    value?: string,
  ) => {
    const sel = selectionRef.current;
    const targetBlockId = sel?.blockId ?? activeBlock?.id ?? doc.blocks[0]?.id;
    if (!targetBlockId) return;
    const startOffset = sel?.blockId === targetBlockId ? sel.startOffset : 0;
    const endOffset = sel?.blockId === targetBlockId ? sel.endOffset : 0;

    updateDoc((prev) => {
      const blocks: DocxBlock[] = prev.blocks.map((b) => {
        if (b.id !== targetBlockId) return b;
        const textRuns = b.runs.filter((r) => r.type === "text");
        const allHave =
          textRuns.length > 0 &&
          textRuns.every((r) => (prop === "highlight" ? Boolean(r.highlight) : Boolean(r[prop])));
        return {
          ...b,
          runs: formatRunsInRange(b.runs, startOffset, endOffset, (r) => ({
            ...r,
            ...(prop === "highlight"
              ? { highlight: allHave ? undefined : (value ?? "yellow") }
              : { [prop]: !allHave }),
          })),
        };
      });
      return { ...prev, blocks };
    });
  };

  const handleInsertFootnote = (initialText = "") => {
    const fnId = `fn-${newId()}`;
    const sel = selectionRef.current;
    const targetBlockId = sel?.blockId ?? activeBlock?.id ?? doc.blocks[0]?.id;
    if (!targetBlockId) return;

    updateDoc((prev) => {
      const blocks: DocxBlock[] = prev.blocks.map((b) => {
        if (b.id !== targetBlockId) return b;
        const totalLen = b.runs
          .filter((r) => r.type === "text")
          .reduce((acc, r) => acc + (r.text ?? "").length, 0);
        const offset = sel?.blockId === targetBlockId ? sel.endOffset : totalLen;
        return {
          ...b,
          runs: insertRunAtOffset(b.runs, offset, { type: "footnote_ref", footnoteId: fnId }),
        };
      });
      const newFn: DocxFootnote = {
        id: fnId,
        text: initialText,
      };
      return {
        ...prev,
        blocks,
        footnotes: [...prev.footnotes, newFn],
      };
    });

    setTimeout(() => {
      const fnInput = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-footnote-input="${fnId}"]`);
      fnInput?.focus();
    }, 40);
  };

  const handleInsertCitationFootnote = (item: ItemRow) => {
    const surname = item.author ? item.author.split(",")[0].trim().toLowerCase() : "";
    const alreadyCited = surname
      ? doc.footnotes.some((fn) => fn.text.toLowerCase().includes(surname))
      : false;
    const noteText = formatChicagoFootnote(item, citeLocator, alreadyCited);
    setShowCiteModal(false);
    setCiteLocator("");
    handleInsertFootnote(noteText);
    showToast("Footnote citation inserted.");
  };

  const handleDeleteFootnote = (footnoteId: string) => {
    updateDoc((prev) => ({
      ...prev,
      blocks: prev.blocks.map((b) => ({
        ...b,
        runs: b.runs.filter((r) => !(r.type === "footnote_ref" && r.footnoteId === footnoteId)),
      })),
      footnotes: prev.footnotes.filter((f) => f.id !== footnoteId),
    }));
  };

  const handleAddComment = () => {
    const commentId = `c-${newId()}`;
    const sel = selectionRef.current;
    const targetBlockId = sel?.blockId ?? activeBlock?.id ?? doc.blocks[0]?.id;
    if (!targetBlockId) return;
    const startOffset = sel?.blockId === targetBlockId ? sel.startOffset : 0;
    const endOffset = sel?.blockId === targetBlockId ? sel.endOffset : 0;

    updateDoc((prev) => {
      const blocks: DocxBlock[] = prev.blocks.map((b) => {
        if (b.id !== targetBlockId) return b;
        const nextRuns = formatRunsInRange(b.runs, startOffset, endOffset, (r) => ({
          ...r,
          commentIds: [...(r.commentIds ?? []), commentId],
        }));
        return { ...b, runs: nextRuns };
      });
      const newComment: DocxComment = {
        id: commentId,
        author: "Reviewer",
        date: new Date().toISOString(),
        text: "",
        resolved: false,
      };
      return {
        ...prev,
        blocks,
        comments: [...prev.comments, newComment],
      };
    });

    setMode("review");
    setActiveCommentId(commentId);
    setTimeout(() => {
      const el = document.querySelector<HTMLTextAreaElement>(`[data-comment-input="${commentId}"]`);
      el?.focus();
    }, 40);
  };

  const handleDeleteComment = (commentId: string) => {
    updateDoc((prev) => ({
      ...prev,
      blocks: prev.blocks.map((b) => ({
        ...b,
        runs: b.runs.map((r) =>
          r.commentIds
            ? { ...r, commentIds: r.commentIds.filter((id) => id !== commentId) }
            : r,
        ),
      })),
      comments: prev.comments.filter((c) => c.id !== commentId),
    }));
  };

  const orderedFootnotes = useMemo(() => {
    return [...doc.footnotes].sort((a, b) => {
      const na = fnNumbers.get(a.id) ?? 9999;
      const nb = fnNumbers.get(b.id) ?? 9999;
      return na - nb;
    });
  }, [doc.footnotes, fnNumbers]);

  const filteredReadings = useMemo(() => {
    const qLower = citeQuery.trim().toLowerCase();
    const list = qLower
      ? moduleReadings.filter((i) => fullTitle(i).toLowerCase().includes(qLower))
      : moduleReadings;
    const refSet = new Set(assessment.referenceItemIds);
    return [...list].sort((a, b) => {
      const aRef = refSet.has(a.id) ? 0 : 1;
      const bRef = refSet.has(b.id) ? 0 : 1;
      return aRef - bRef || fullTitle(a).localeCompare(fullTitle(b));
    });
  }, [moduleReadings, citeQuery, assessment.referenceItemIds]);

  return (
    <div className="word-processor">
      <header className="word-topbar">
        <div className="word-topbar-left">
          <Link to={{ view: "module", id }} className="button quiet small">
            ← {module?.code ?? "Module"}
          </Link>
          <input
            type="text"
            className="word-title-input"
            aria-label="Essay title"
            value={title}
            onChange={(e) => {
              const nextTitle = e.target.value;
              setTitle(nextTitle);
              titleRef.current = nextTitle;
              persistDraft(docRef.current, nextTitle);
            }}
            placeholder="Essay title"
          />
          <span className="small muted word-save-status" aria-live="polite">
            {savingStatus === "saving" ? "Saving…" : "Saved"}
          </span>
        </div>

        <div className="word-topbar-right">
          <div className="word-mode-switch" role="group" aria-label="Editor mode">
            <button
              type="button"
              className={`button small${mode === "edit" ? " primary" : " quiet"}`}
              aria-pressed={mode === "edit"}
              onClick={() => setMode("edit")}
            >
              Editing
            </button>
            <button
              type="button"
              className={`button small${mode === "review" ? " primary" : " quiet"}`}
              aria-pressed={mode === "review"}
              onClick={() => setMode("review")}
            >
              Review ({doc.comments.length})
            </button>
          </div>

          <div className="menu">
            <button
              type="button"
              className="button quiet small"
              aria-expanded={showWordCount}
              onClick={() => setShowWordCount((v) => !v)}
            >
              {wordCounts.total.toLocaleString()} {wordCounts.total === 1 ? "word" : "words"}
              {assessment.wordTarget ? ` / ${assessment.wordTarget.toLocaleString()}` : ""}
            </button>
            {showWordCount && (
              <div className="menu-panel word-count-panel" role="dialog" aria-label="Word count">
                <h3>Word count</h3>
                <dl className="word-count-list">
                  <div>
                    <dt>Total counted</dt>
                    <dd><strong>{wordCounts.total.toLocaleString()}</strong></dd>
                  </div>
                  <div>
                    <dt>Main body</dt>
                    <dd>{wordCounts.body.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Block quotations</dt>
                    <dd>{wordCounts.quotes.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Footnotes</dt>
                    <dd>{wordCounts.footnotes.toLocaleString()}</dd>
                  </div>
                </dl>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={doc.settings?.includeFootnotesInCount ?? true}
                    onChange={(e) =>
                      updateDoc((prev) => ({
                        ...prev,
                        settings: { ...prev.settings, includeFootnotesInCount: e.target.checked },
                      }))
                    }
                  />
                  <span>Include footnotes in word count</span>
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={doc.settings?.includeQuotesInCount ?? true}
                    onChange={(e) =>
                      updateDoc((prev) => ({
                        ...prev,
                        settings: { ...prev.settings, includeQuotesInCount: e.target.checked },
                      }))
                    }
                  />
                  <span>Include block quotations in word count</span>
                </label>
              </div>
            )}
          </div>

          <button
            type="button"
            className="button quiet small"
            onClick={async () => {
              if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
              }
              await saveModuleAssessment(
                id,
                { title: titleRef.current, draft: docRef.current },
                { expectedBaseRev: baseRevRef.current, moduleCode: module?.code },
              );
              await saveDraftSnapshot(id, undefined, module?.code);
              const refreshed = await getModuleAssessment(id, module?.code);
              baseRevRef.current = refreshed.rev;
              setSavingStatus("saved");
              showToast("Snapshot saved to Previous drafts.");
            }}
          >
            Save snapshot
          </button>

          <button
            type="button"
            className="button quiet small"
            onClick={() => importInputRef.current?.click()}
          >
            Import .docx
          </button>
          <input
            ref={importInputRef}
            type="file"
            hidden
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                if (saveTimerRef.current) {
                  clearTimeout(saveTimerRef.current);
                  saveTimerRef.current = null;
                }
                const imported = await importAssessmentDocxFile(id, file, module?.code);
                const refreshed = await getModuleAssessment(id, module?.code);
                baseRevRef.current = refreshed.rev;
                const nextTitle = file.name.replace(/\.docx$/i, "").trim() || titleRef.current;
                dirtyRef.current = true;
                setDoc(imported);
                docRef.current = imported;
                setTitle(nextTitle);
                titleRef.current = nextTitle;
                showToast(`Imported ${file.name}.`);
              } catch (err) {
                showToast(err instanceof Error ? err.message : "Could not import Word document.");
              }
            }}
          />

          <button
            type="button"
            className="button primary small"
            onClick={() => {
              downloadDocxFile(docRef.current, titleRef.current, {
                excludeResolvedComments: excludeResolved,
              });
              showToast("Exported Word (.docx) file.");
            }}
          >
            Export .docx
          </button>
        </div>
      </header>

      <div className="word-ribbon" role="toolbar" aria-label="Formatting and insert tools">
        <select
          className="word-ribbon-select"
          aria-label="Paragraph style"
          value={activeBlock?.type ?? "paragraph"}
          onChange={(e) => {
            const nextType = e.target.value as DocxBlockType;
            if (!activeBlock) return;
            updateDoc((prev) => ({
              ...prev,
              blocks: prev.blocks.map((b) => (b.id === activeBlock.id ? { ...b, type: nextType } : b)),
            }));
          }}
        >
          <option value="paragraph">Normal paragraph</option>
          <option value="heading1">Heading 1</option>
          <option value="heading2">Heading 2</option>
          <option value="heading3">Heading 3</option>
          <option value="blockquote">Block quotation</option>
          <option value="bullet">Bullet list</option>
          <option value="ordered">Numbered list</option>
        </select>

        <select
          className="word-ribbon-select"
          aria-label="Font family"
          value={doc.settings?.font ?? "Times New Roman"}
          onChange={(e) =>
            updateDoc((prev) => ({
              ...prev,
              settings: { ...prev.settings, font: e.target.value as "Times New Roman" | "Literata" },
            }))
          }
        >
          <option value="Times New Roman">Times New Roman</option>
          <option value="Literata">Literata</option>
        </select>

        <select
          className="word-ribbon-select"
          aria-label="Line spacing"
          value={String(doc.settings?.lineSpacing ?? 1.5)}
          onChange={(e) =>
            updateDoc((prev) => ({
              ...prev,
              settings: { ...prev.settings, lineSpacing: (Number(e.target.value) || 1.5) as 1.15 | 1.5 | 2 },
            }))
          }
        >
          <option value="1.15">1.15 spacing</option>
          <option value="1.5">1.5 spacing</option>
          <option value="2">Double spacing</option>
        </select>

        <span className="word-ribbon-sep" aria-hidden="true" />

        <button
          type="button"
          className="word-ribbon-btn"
          title="Bold"
          aria-label="Bold"
          onMouseDown={(e) => {
            e.preventDefault();
            applyInlineFormat("bold");
          }}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className="word-ribbon-btn"
          title="Italic"
          aria-label="Italic"
          onMouseDown={(e) => {
            e.preventDefault();
            applyInlineFormat("italic");
          }}
        >
          <em>I</em>
        </button>
        <button
          type="button"
          className="word-ribbon-btn"
          title="Underline"
          aria-label="Underline"
          onMouseDown={(e) => {
            e.preventDefault();
            applyInlineFormat("underline");
          }}
        >
          <u>U</u>
        </button>
        <button
          type="button"
          className="word-ribbon-btn"
          title="Strikethrough"
          aria-label="Strikethrough"
          onMouseDown={(e) => {
            e.preventDefault();
            applyInlineFormat("strike");
          }}
        >
          <s>S</s>
        </button>
        <button
          type="button"
          className="word-ribbon-btn"
          title="Highlight text"
          aria-label="Highlight"
          onMouseDown={(e) => {
            e.preventDefault();
            applyInlineFormat("highlight", "yellow");
          }}
        >
          Highlight
        </button>

        <span className="word-ribbon-sep" aria-hidden="true" />

        <button
          type="button"
          className="word-ribbon-btn"
          onClick={() => handleInsertFootnote("")}
        >
          Insert footnote
        </button>

        <button
          type="button"
          className="word-ribbon-btn"
          onClick={() => setShowCiteModal(true)}
        >
          Insert citation
        </button>

        <button
          type="button"
          className="word-ribbon-btn"
          onClick={() => handleAddComment()}
        >
          Add comment
        </button>

        <button
          type="button"
          className="word-ribbon-btn"
          onClick={() => {
            const targetId = activeBlock?.id ?? doc.blocks[doc.blocks.length - 1]?.id;
            updateDoc((prev) => {
              const idx = prev.blocks.findIndex((b) => b.id === targetId);
              const insertAt = idx >= 0 ? idx + 1 : prev.blocks.length;
              const nextBlocks = [...prev.blocks];
              nextBlocks.splice(
                insertAt,
                0,
                { id: `b-${newId()}`, type: "page_break", runs: [] },
                { id: `b-${newId()}`, type: "paragraph", runs: [{ type: "text", text: "" }] },
              );
              return { ...prev, blocks: nextBlocks };
            });
          }}
        >
          Page break
        </button>
      </div>

      <div className="word-workspace">
        <div className="word-canvas-scroll">
          <article
            className="word-page-canvas"
            style={{
              fontFamily:
                doc.settings?.font === "Literata"
                  ? "var(--serif)"
                  : `"${doc.settings?.font ?? "Times New Roman"}", Times, serif`,
              fontSize: `${doc.settings?.fontSizePt ?? 12}pt`,
              lineHeight: doc.settings?.lineSpacing ?? 1.5,
            }}
          >
            <div className="word-body-blocks">
              {doc.blocks.map((block, idx) => (
                <EditableBlock
                  key={block.id}
                  block={block}
                  index={idx}
                  fnNumbers={fnNumbers}
                  active={block.id === activeBlockId}
                  searchQuery={q}
                  onFocusBlock={setActiveBlockId}
                  onUpdateText={(blockId, text) => {
                    updateDoc((prev) => ({
                      ...prev,
                      blocks: prev.blocks.map((b) =>
                        b.id === blockId ? { ...b, runs: spliceRunsOnTextEdit(b.runs, text) } : b,
                      ),
                    }));
                  }}
                  onSplitBlock={(blockId, offset) => {
                    const newBlockId = `b-${newId()}`;
                    updateDoc((prev) => {
                      const bIdx = prev.blocks.findIndex((b) => b.id === blockId);
                      if (bIdx < 0) return prev;
                      const cur = prev.blocks[bIdx];
                      const { before, after } = splitBlockRunsAtOffset(cur.runs, offset);
                      const nextBlocks = [...prev.blocks];
                      nextBlocks[bIdx] = {
                        ...cur,
                        runs: before,
                      };
                      nextBlocks.splice(bIdx + 1, 0, {
                        id: newBlockId,
                        type: "paragraph",
                        runs: after,
                      });
                      return { ...prev, blocks: nextBlocks };
                    });
                    setActiveBlockId(newBlockId);
                    setTimeout(() => {
                      const el = document.querySelector<HTMLElement>(`[data-block-id="${newBlockId}"]`);
                      el?.focus();
                    }, 20);
                  }}
                  onMergePrev={(blockId) => {
                    const curIdx = docRef.current.blocks.findIndex((b) => b.id === blockId);
                    const prevId = curIdx > 0 ? docRef.current.blocks[curIdx - 1].id : null;
                    updateDoc((prev) => {
                      const bIdx = prev.blocks.findIndex((b) => b.id === blockId);
                      if (bIdx <= 0) return prev;
                      const prevBlock = prev.blocks[bIdx - 1];
                      const curBlock = prev.blocks[bIdx];
                      const nextBlocks = [...prev.blocks];
                      nextBlocks[bIdx - 1] = {
                        ...prevBlock,
                        runs: coalesceRuns([...prevBlock.runs, ...curBlock.runs]),
                      };
                      nextBlocks.splice(bIdx, 1);
                      return { ...prev, blocks: nextBlocks };
                    });
                    if (prevId) {
                      setTimeout(() => {
                        setActiveBlockId(prevId);
                        document.querySelector<HTMLElement>(`[data-block-id="${prevId}"]`)?.focus();
                      }, 20);
                    }
                  }}
                  onJumpToFootnote={(fnId) => {
                    const el = document.querySelector<HTMLElement>(`[data-footnote-input="${fnId}"]`);
                    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                    el?.focus();
                  }}
                  onSelectComment={(commentId) => {
                    setMode("review");
                    setActiveCommentId(commentId);
                  }}
                  onSelectionChange={(sel) => {
                    selectionRef.current = sel;
                  }}
                />
              ))}
            </div>

            <footer className="word-footnotes-area" aria-label="Footnotes">
              <div className="word-footnotes-Rule" />
              <div className="word-footnotes-head">
                <span className="small muted">Footnotes ({orderedFootnotes.length})</span>
                <button
                  type="button"
                  className="quiet small"
                  onClick={() => handleInsertFootnote("")}
                >
                  + Add footnote
                </button>
              </div>
              {orderedFootnotes.length === 0 ? (
                <p className="small muted" style={{ margin: "0.25rem 0 0" }}>
                  No footnotes yet. Place the cursor in the text and click Insert footnote or Insert citation.
                </p>
              ) : (
                <ol className="word-footnotes-list">
                  {orderedFootnotes.map((fn) => {
                    const num = fnNumbers.get(fn.id) ?? 1;
                    const text = fn.text;
                    return (
                      <li key={fn.id} className="word-footnote-row">
                        <button
                          type="button"
                          className="word-fn-badge"
                          title={`Jump to reference ${num} in body`}
                          onClick={() => {
                            const refEl = document.querySelector<HTMLElement>(`sup[data-footnote-id="${fn.id}"]`);
                            refEl?.scrollIntoView({ behavior: "smooth", block: "center" });
                          }}
                        >
                          {num}
                        </button>
                        <input
                          type="text"
                          className="word-fn-input"
                          data-footnote-input={fn.id}
                          aria-label={`Footnote ${num} text`}
                          value={text}
                          placeholder={`Footnote ${num} text…`}
                          onChange={(e) => {
                            const val = e.target.value;
                            updateDoc((prev) => ({
                              ...prev,
                              footnotes: prev.footnotes.map((item) =>
                                item.id === fn.id ? { ...item, text: val } : item,
                              ),
                            }));
                          }}
                        />
                        <button
                          type="button"
                          className="quiet small"
                          aria-label={`Delete footnote ${num}`}
                          onClick={() => handleDeleteFootnote(fn.id)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </footer>
          </article>
        </div>

        {mode === "review" && (
          <aside className="word-comments-pane" aria-label="Review comments">
            <div className="word-comments-head">
              <h2>Comments ({doc.comments.length})</h2>
              <button type="button" className="button small" onClick={handleAddComment}>
                New comment
              </button>
            </div>
            <label className="check-row small" style={{ marginBottom: "0.75rem" }}>
              <input
                type="checkbox"
                checked={excludeResolved}
                onChange={(e) => setExcludeResolved(e.target.checked)}
              />
              <span>Exclude resolved comments on export</span>
            </label>

            {doc.comments.length === 0 ? (
              <p className="small muted">
                Select text in the essay and click Add comment or Highlight to annotate your draft. Comments export directly to Microsoft Word.
              </p>
            ) : (
              <ul className="word-comments-list">
                {doc.comments.map((c) => (
                  <li
                    key={c.id}
                    className={`word-comment-card${c.resolved ? " is-resolved" : ""}${activeCommentId === c.id ? " is-selected" : ""}`}
                    onClick={() => setActiveCommentId(c.id)}
                  >
                    <div className="word-comment-meta">
                      <strong>{c.author || "Reviewer"}</strong>
                      <span className="small muted">
                        {new Date(c.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                      </span>
                      {c.resolved && <span className="pill small">Resolved</span>}
                    </div>
                    <textarea
                      className="word-comment-input"
                      data-comment-input={c.id}
                      aria-label="Comment text"
                      rows={2}
                      value={c.text}
                      placeholder="Write a review comment…"
                      onChange={(e) => {
                        const val = e.target.value;
                        updateDoc((prev) => ({
                          ...prev,
                          comments: prev.comments.map((item) => (item.id === c.id ? { ...item, text: val } : item)),
                        }));
                      }}
                    />
                    <div className="row" style={{ justifyContent: "flex-end", gap: "0.5rem" }}>
                      <button
                        type="button"
                        className="quiet small"
                        onClick={() =>
                          updateDoc((prev) => ({
                            ...prev,
                            comments: prev.comments.map((item) =>
                              item.id === c.id ? { ...item, resolved: !item.resolved } : item,
                            ),
                          }))
                        }
                      >
                        {c.resolved ? "Reopen" : "Resolve"}
                      </button>
                      <button
                        type="button"
                        className="quiet small danger"
                        aria-label="Delete comment"
                        onClick={() => handleDeleteComment(c.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        )}
      </div>

      {showCiteModal && (
        <div className="modal-backdrop" onClick={() => setShowCiteModal(false)}>
          <div
            className="dialog word-cite-dialog"
            role="dialog"
            aria-label="Insert Chicago footnote citation"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="section-head" style={{ marginBottom: "0.75rem" }}>
              <h2 style={{ margin: 0 }}>Insert footnote citation</h2>
              <span className="spacer" />
              <button type="button" className="quiet" onClick={() => setShowCiteModal(false)}>
                Cancel
              </button>
            </div>
            <div className="row" style={{ gap: "0.75rem", marginBottom: "0.75rem" }}>
              <input
                type="search"
                style={{ flex: 2 }}
                placeholder="Filter readings…"
                aria-label="Filter readings"
                value={citeQuery}
                onChange={(e) => setCiteQuery(e.target.value)}
                autoFocus
              />
              <input
                type="text"
                style={{ flex: 1 }}
                placeholder="Page / locator (e.g. p. 42)"
                aria-label="Page or locator"
                value={citeLocator}
                onChange={(e) => setCiteLocator(e.target.value)}
              />
            </div>
            {filteredReadings.length === 0 ? (
              <p className="small muted">No readings found in this module.</p>
            ) : (
              <ul className="word-cite-list">
                {filteredReadings.map((item) => (
                  <li key={item.id} className="word-cite-row">
                    <div className="word-cite-info">
                      <strong>{shortTitle(item)}</strong>
                      <span className="small muted">{fullTitle(item)}</span>
                    </div>
                    <button
                      type="button"
                      className="button small"
                      onClick={() => handleInsertCitationFootnote(item)}
                    >
                      Cite in footnote
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
