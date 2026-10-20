// The reader's left pane: your notes on the reading, with its highlights
// in them as quotations, then page thumbnails and the PDF's contents list.

import { NotesLoading } from "../ErrorBoundary";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { lazy, memo, Suspense, useEffect, useRef, useState, type Ref } from "react";
import type { HighlightRow } from "../../lib/types";
import { Icon } from "../icons";
import type { NoteEditorHandle } from "../NoteEditor";
import { QuoteContext } from "../quoteContext";
import type { Size } from "./pages";

const NoteEditor = lazy(() => import("../NoteEditor"));

export type Tab = "notes" | "pages" | "contents";
export interface Heading { title: string; page: number; level: number }

const Thumb = memo(function Thumb({ doc, index, size, current, onGo }: {
  doc: PDFDocumentProxy; index: number; size: Size; current: boolean; onGo: (page: number) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const width = 132;
  const height = Math.round((size.height / size.width) * width);

  useEffect(() => {
    const element = ref.current!;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setNear(true); }, {
      root: element.closest(".pane-body"), rootMargin: "300px 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (current) ref.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  useEffect(() => {
    if (!near) return;
    let task: RenderTask | null = null;
    let cancelled = false;
    void (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (width / size.width) * ratio });
      const target = canvas.current!;
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      task = page.render({ canvasContext: target.getContext("2d")!, viewport });
      await task.promise.catch(() => undefined);
    })();
    return () => { cancelled = true; task?.cancel(); };
  }, [near, doc, index, size.width]);

  return (
    <button ref={ref} className={`thumb${current ? " current" : ""}`} onClick={() => onGo(index)} aria-label={`Page ${index + 1}`} aria-current={current ? "page" : undefined}>
      <canvas ref={canvas} style={{ width, height }} />
      <span>{index + 1}</span>
    </button>
  );
});

export function Sidebar({
  tab, setTab, doc, sizes, current, headings, itemId, highlights, noteHandle, onGoPage, onOpenHighlight, onQuoteRemoved, onQuoteRestored, onClose,
}: {
  tab: Tab; setTab: (tab: Tab) => void; doc: PDFDocumentProxy | null; sizes: Size[]; current: number;
  headings: Heading[]; itemId: string; highlights: HighlightRow[]; noteHandle: Ref<NoteEditorHandle>;
  onGoPage: (page: number) => void; onOpenHighlight: (highlightId: string, page: number) => void;
  onQuoteRemoved: (highlightId: string) => void; onQuoteRestored?: (highlightId: string) => void; onClose: () => void;
}) {
  const tabs: { value: Tab; label: string; icon: "notes" | "pages" | "outline"; hidden?: boolean }[] = [
    { value: "notes", label: "Notes", icon: "notes" },
    { value: "pages", label: "Pages", icon: "pages" },
    { value: "contents", label: "Contents", icon: "outline", hidden: headings.length === 0 },
  ];

  const visibleTabs = tabs.filter((t) => !t.hidden);
  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let nextIndex = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      nextIndex = (index + 1) % visibleTabs.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIndex = (index - 1 + visibleTabs.length) % visibleTabs.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = visibleTabs.length - 1;
    }
    if (nextIndex >= 0) {
      e.preventDefault();
      const targetTab = visibleTabs[nextIndex];
      setTab(targetTab.value);
      const tabButtons = e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button[role='tab']");
      tabButtons?.[nextIndex]?.focus();
    }
  };

  return (
    <aside className="pane left" aria-label="Reading sidebar">
      <div className="pane-tabs">
        <div role="tablist" aria-label="Sidebar" style={{ display: "contents" }}>
        {visibleTabs.map((t, i) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={tab === t.value}
            tabIndex={tab === t.value ? 0 : -1}
            className="pane-tab"
            title={t.label}
            onClick={() => setTab(t.value)}
            onKeyDown={(e) => onTabKeyDown(e, i)}
          >
            <Icon name={t.icon} size={18} /><span>{t.label}</span>
          </button>
        ))}
        </div>
        <span className="spacer" />
        <button className="icon-button small" aria-label="Close sidebar" title="Close sidebar" onClick={onClose}><Icon name="close" size={16} /></button>
      </div>

      <div className="pane-body">
        {tab === "notes" && (
          <div className="reading-notes">
            <p className="notes-hint small muted">
              {highlights.length
                ? `${highlights.length} ${highlights.length === 1 ? "highlight" : "highlights"}, in reading order. Write anywhere around them.`
                : "Write here as you read. Anything you highlight joins these notes as a quotation, in reading order."}
            </p>
            <QuoteContext.Provider value={{ readingId: itemId, open: onOpenHighlight }}>
              <Suspense fallback={<NotesLoading />}>
                <NoteEditor target={{ item_id: itemId }} handle={noteHandle} onQuoteRemoved={onQuoteRemoved} onQuoteRestored={onQuoteRestored} label="Reading notes" />
              </Suspense>
            </QuoteContext.Provider>
          </div>
        )}
        {tab === "pages" && doc && (
          <div className="thumbs">
            {sizes.map((size, i) => <Thumb key={i} doc={doc} index={i} size={size} current={i === current} onGo={onGoPage} />)}
          </div>
        )}
        {tab === "contents" && (
          <ol className="contents">
            {headings.map((h, i) => (
              <li key={i} style={{ paddingLeft: `${h.level}rem` }}>
                <button className="plain" aria-current={h.page === current ? "true" : undefined} onClick={() => onGoPage(h.page)}>
                  <span>{h.title}</span><span className="count">{h.page + 1}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  );
}
