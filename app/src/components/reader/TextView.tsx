// A reading set as an article, the way a newspaper's app sets a story: one
// column of text sized for the screen, headings, notes in smaller type, and
// the original page numbers in the margin of the text so it can be cited.

import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { mergeRects } from "./pages";
import { atOf, fracOf, rangesFor, rectsFor, type Block, type Line, type Reflowed } from "../../lib/reflow";
import type { HighlightRow, Spot } from "../../lib/types";
import { caretAt, fingerDown, SETTLE_NOW, settleDelay, whenLifted } from "../../lib/selection";
import { paragraphStartFor } from "../../lib/listen/script";

export interface TextSelection { page: number; rects: number[][]; text: string; x: number; y: number }

interface Mark { start: number; end: number; kind: "hl" | "find"; id?: string; colour?: string }

// Splits a stretch of a line into words and the spaces between them, each its
// own element with its page offset, so in listen mode every word is a target of
// its own. The spaces keep data-o too, so every element carrying data-o still
// holds exactly one text node, which is what RunIndex (listen/highlight.ts), the
// place reader and the selection all rely on.
function Words({ page, start, text }: { page: number; start: number; text: string }) {
  const out: React.ReactNode[] = [];
  const parts = text.split(/(\s+)/);
  let at = start;
  for (const part of parts) {
    if (part) {
      const word = !/^\s+$/.test(part);
      out.push(<span key={at} data-p={page} data-o={at} className={word ? "tv-word" : undefined}>{part}</span>);
    }
    at += part.length;
  }
  return <>{out}</>;
}

function Run({ line, marks, onHighlight, words = false }: { line: Line; marks: Mark[]; onHighlight?: (id: string, x: number, y: number) => void; words?: boolean }) {
  // The text shown leaves off a line-end hyphen, but offsets stay those of the page.
  const shown = line.hyphen ? line.text.replace(/[-\u00ad\u2010\u2011\u2013]\s*$/, "") : line.text.replace(/\s+$/, "");
  const end = line.start + shown.length;
  const cuts = new Set<number>([line.start, end]);
  for (const m of marks) {
    if (m.end <= line.start || m.start >= end) continue;
    cuts.add(Math.max(m.start, line.start));
    cuts.add(Math.min(m.end, end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: React.ReactNode[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const [a, b] = [points[i], points[i + 1]];
    const text = shown.slice(a - line.start, b - line.start);
    if (!text) continue;
    const hl = marks.find((m) => m.kind === "hl" && m.start <= a && m.end >= b);
    const hit = marks.find((m) => m.kind === "find" && m.start <= a && m.end >= b);
    // In listen mode a mark holds word elements rather than text, so it keeps
    // only data-p (Find looks marks up by page) and its words carry the offsets.
    // The key is passed on its own, as React asks, rather than inside the spread.
    const props = words ? ({ "data-p": line.page } as const) : ({ "data-p": line.page, "data-o": a } as const);
    const content = words ? <Words page={line.page} start={a} text={text} /> : text;
    if (hl) {
      out.push(
        <mark
          key={a}
          {...props}
          tabIndex={0}
          role="button"
          aria-label={`Highlight: ${text}`}
          className={`hl-text${hit ? " find-hit" : ""}`}
          data-id={hl.id}
          style={{ background: `color-mix(in srgb, ${hl.colour} 45%, transparent)` }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              onHighlight?.(hl.id!, r.left + r.width / 2, r.bottom);
            }
          }}
        >
          {content}
        </mark>,
      );
    } else if (hit) {
      out.push(<mark key={a} {...props} className="find-hit">{content}</mark>);
    } else if (words) {
      out.push(<Words key={a} page={line.page} start={a} text={text} />);
    } else {
      out.push(<span key={a} {...props}>{text}</span>);
    }
  }
  return <>{out}</>;
}

// The space between two lines. Inside a highlight that runs on from one line
// to the next, it is highlighted too, so the highlight has no gap in it.
function Join({ line, next, marks }: { line: Line; next: Line | undefined; marks: Mark[] }) {
  const shownEnd = line.start + (line.hyphen ? line.text.replace(/[-\u00ad\u2010\u2011\u2013]\s*$/, "") : line.text.replace(/\s+$/, "")).length;
  const hl = next && next.page === line.page
    ? marks.find((m) => m.kind === "hl" && m.start < shownEnd && m.end >= shownEnd && m.end > next.start && m.start <= next.start)
    : undefined;
  if (!hl) return <>{" "}</>;
  return <mark className="hl-text" data-id={hl.id} style={{ background: `color-mix(in srgb, ${hl.colour} 45%, transparent)` }}>{" "}</mark>;
}

// Where in the page's text a point in the article falls.
function offsetAt(node: Node, offset: number): { page: number; at: number } | null {
  const el = (node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element))?.closest<HTMLElement>("[data-o]");
  if (!el) return null;
  const within = node.nodeType === Node.TEXT_NODE ? offset : 0;
  return { page: Number(el.dataset.p), at: Number(el.dataset.o) + within };
}

const Body = memo(function Body({
  blocks, marksByPage, notes, onHighlight, words,
}: {
  blocks: Block[]; marksByPage: Map<number, Mark[]>; notes: boolean; onHighlight?: (id: string, x: number, y: number) => void;
  /** Listen is open: every word is its own element, so each can be tapped and hovered. */
  words: boolean;
}) {
  let lastPage = -1;
  return (
    <>
      {blocks.map((block, bi) => {
        // Footnotes are excluded from text view: on a phone they break up the text.
        if (block.kind === "note") return null;
        const Tag = block.kind === "heading" ? "h2" : "p";
        // A heading that opens a page has its page number above it, not inside it.
        const opens = block.kind === "heading" && block.lines[0].page !== lastPage;
        if (opens) lastPage = block.lines[0].page;
        return (
          <Fragment key={bi}>
          {opens && <div className="pg-line"><span className="pg" data-pg={block.lines[0].page} aria-label={`Page ${block.lines[0].page + 1}`}>{block.lines[0].page + 1}</span></div>}
          <Tag>
            {block.lines.map((line, li) => {
              const marker = line.page !== lastPage;
              lastPage = line.page;
              // A hyphen, or a word the OCR layer split, runs on with no space.
              const join = li < block.lines.length - 1 && !line.hyphen && !line.glue ? " " : "";
              return (
                <Fragment key={li}>
                  {marker && <span className="pg" data-pg={line.page} aria-label={`Page ${line.page + 1}`}>{line.page + 1}</span>}
                  <Run line={line} marks={marksByPage.get(line.page) ?? []} onHighlight={onHighlight} words={words} />
                  {join && <Join line={line} next={block.lines[li + 1]} marks={marksByPage.get(line.page) ?? []} />}
                </Fragment>
              );
            })}
          </Tag>
          </Fragment>
        );
      })}
    </>
  );
});

/**
 * The page point under a tap, for Listen. A tap on a word is that word's start,
 * read straight from the word's own element, so it needs no hit testing and
 * cannot miss. Otherwise the character under the finger comes from caretAt, as
 * the place reader uses it, and a tap that lands between runs (the margin of a
 * paragraph, the space after it, a page number) falls back to the first run of
 * the paragraph or heading it is in, so a tap anywhere in a paragraph plays
 * from it.
 */
function tapPoint(target: EventTarget | null, x: number, y: number): { page: number; at: number } | null {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const word = el?.closest<HTMLElement>(".tv-word[data-o]");
  if (word) return { page: Number(word.dataset.p), at: Number(word.dataset.o) };
  const caret = caretAt(x, y);
  if (caret?.node) {
    const point = offsetAt(caret.node, caret.offset);
    if (point) return point;
  }
  const own = el?.closest<HTMLElement>("[data-o]");
  if (own) return { page: Number(own.dataset.p), at: Number(own.dataset.o) };
  const run = el?.closest("p, h2")?.querySelector<HTMLElement>("[data-o]");
  return run ? { page: Number(run.dataset.p), at: Number(run.dataset.o) } : null;
}

export function TextView({
  reflowed, kicker, title, byline, standfirst, highlights, needles, currentHit, start, onSpot, onSelect, onHighlight, notes = false,
  articleRef, onWordTap, listening = false,
}: {
  notes?: boolean;
  reflowed: Reflowed; kicker: string; title: string; byline: string | null; standfirst: string | null;
  highlights: HighlightRow[]; needles: string[]; currentHit: { page: number; n: number } | null;
  // Where to open. Only the first value counts: the text never jumps
  // because the saved place changed while you were reading.
  start: Spot | null;
  onSpot: (spot: Spot) => void; onSelect: (s: TextSelection | null) => void; onHighlight: (id: string, x: number, y: number) => void;
  articleRef?: (el: HTMLElement | null) => void;
  onWordTap?: (point: { page: number; at: number }) => void;
  /**
   * Listen is open: every word is a target, and a tap plays from the tapped
   * word, even on a highlight, whether playback is playing, paused or not yet
   * started. Pass true for as long as the listen bar is shown.
   */
  listening?: boolean;
}) {
  const listenMode = Boolean(listening);
  const root = useRef<HTMLElement>(null);
  const pageById = useMemo(() => new Map(reflowed.pages.map((p) => [p.page, p])), [reflowed]);

  const marksByPage = useMemo(() => {
    const map = new Map<number, Mark[]>();
    const add = (page: number, m: Mark) => map.set(page, [...(map.get(page) ?? []), m]);
    for (const h of highlights) {
      const page = pageById.get(h.page);
      if (!page) continue;
      for (const [start, end] of rangesFor(page, h.rects)) add(h.page, { start, end, kind: "hl", id: h.id, colour: h.colour });
    }
    if (needles.length) {
      for (const page of reflowed.pages) {
        const lower = page.text.toLowerCase();
        for (const n of needles) {
          let at = lower.indexOf(n);
          while (at >= 0) { add(page.page, { start: at, end: at + n.length, kind: "find" }); at = lower.indexOf(n, at + n.length); }
        }
      }
    }
    return map;
  }, [highlights, needles, reflowed, pageById]);

  const startRef = useRef(start);
  const ready = useRef(false);
  // The run of text at the top of the screen, and how far below the top it
  // sits. When the text reflows (a font arriving, a size change, a turned
  // phone), the screen is moved so that run stays exactly where it was.
  const anchor = useRef<{ node: Node; char: number; offset: number } | null>(null);
  // Where the reader itself last put the text, to tell its own scrolling
  // apart from yours.
  const ours = useRef<number | null>(null);

  // The top of a character on screen.
  const topOfChar = (node: Node, char: number) => {
    const range = document.createRange();
    const len = node.textContent?.length ?? 0;
    range.setStart(node, Math.min(char, len));
    range.setEnd(node, Math.min(char + 1, len));
    const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    return rect.top;
  };

  const geometry = () => {
    const scroller = root.current?.closest<HTMLElement>(".scroller");
    if (!scroller) return null;
    const inset = parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0;
    return { scroller, top: scroller.getBoundingClientRect().top + inset };
  };

  const goToSpot = (spot: Spot) => {
    const g = geometry();
    const page = pageById.get(spot.page);
    if (!g || !root.current) return;
    const runs = [...root.current.querySelectorAll<HTMLElement>(`[data-p="${spot.page}"][data-o]`)];
    if (runs.length && page) {
      // A place saved in page layout carries the words at the top of the
      // screen; finding them in the text is exact. Otherwise go by how far
      // down the page it was.
      // The saved words are matched on their opening, which survives small
      // differences in how the two layouts split the text into pieces.
      const opening = (spot.quote ?? "").trim().slice(0, 24);
      let found = opening.length >= 8 ? page.text.indexOf(opening) : -1;
      if (found < 0 && opening.length >= 8) {
        const loose = page.text.replace(/\s/g, " ");
        found = loose.indexOf(opening.replace(/\s+/g, " "));
      }
      const at = spot.at ?? (found >= 0 ? found : atOf(page, spot.frac));
      const run = runs.filter((r) => Number(r.dataset.o) <= at).pop() ?? runs[0];
      const node = run.firstChild;
      if (!node) return;
      const char = Math.max(0, at - Number(run.dataset.o));
      g.scroller.scrollTop += topOfChar(node, char) - g.top;
      ours.current = g.scroller.scrollTop;
      anchor.current = { node, char, offset: 0 };
      return;
    }
    const marker = root.current.querySelector<HTMLElement>(`.pg[data-pg="${spot.page}"]`);
    if (marker) g.scroller.scrollTop += marker.getBoundingClientRect().top - g.top;
  };

  // Open where you left off. The text can still settle after the first
  // drawing (a font arriving late, the page's own layout), so the place is
  // set again as it settles, until you start reading yourself.
  useLayoutEffect(() => {
    let cancelled = false;
    let touched = false;
    const s = startRef.current;
    const wanted = s && (s.page > 0 || s.frac > 0 || s.at);
    const scroller = root.current?.closest<HTMLElement>(".scroller");
    const mine = () => { touched = true; };
    // Any scroll the reader did not make itself is yours: a wheel, a thumb,
    // a key, the scroll bar, or a jump from the contents.
    const moved = () => {
      if (!scroller) return;
      if (ours.current === null || Math.abs(scroller.scrollTop - ours.current) > 3) touched = true;
    };
    scroller?.addEventListener("wheel", mine, { passive: true });
    scroller?.addEventListener("touchstart", mine, { passive: true });
    scroller?.addEventListener("keydown", mine);
    scroller?.addEventListener("scroll", moved, { passive: true });
    const place = () => { if (!cancelled && !touched && wanted) goToSpot(s!); };
    place();
    ready.current = true;
    void document.fonts?.ready.then(() => requestAnimationFrame(place));
    const timers = [150, 500, 1200].map((ms) => setTimeout(place, ms));
    // A font can arrive late, such as the italic when the first italic text
    // appears, and reflow the text after the place was set. Each one that
    // finishes loading sets the place again, until you scroll yourself.
    const fontLoaded = () => requestAnimationFrame(place);
    document.fonts?.addEventListener("loadingdone", fontLoaded);
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      document.fonts?.removeEventListener("loadingdone", fontLoaded);
      scroller?.removeEventListener("wheel", mine);
      scroller?.removeEventListener("touchstart", mine);
      scroller?.removeEventListener("keydown", mine);
      scroller?.removeEventListener("scroll", moved);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reading the place from the screen as you scroll.
  useEffect(() => {
    const g = geometry();
    if (!g) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      if (!ready.current || !root.current) return;
      const { top } = geometry()!;
      const box = root.current.getBoundingClientRect();
      const x = box.left + Math.min(40, box.width / 4);
      // The first character at the top of the screen, found exactly.
      let hit: { node: Node; char: number; el: HTMLElement } | null = null;
      for (let y = top + 4; y < top + 160 && !hit; y += 8) {
        for (const px of [x, box.left + box.width / 2]) {
          const caret = caretAt(px, y);
          const node = caret?.node;
          const el = node?.parentElement?.closest<HTMLElement>("[data-o]");
          if (caret && node && node.nodeType === Node.TEXT_NODE && el) { hit = { node, char: caret.offset, el }; break; }
        }
      }
      if (!hit) return;
      anchor.current = { node: hit.node, char: hit.char, offset: topOfChar(hit.node, hit.char) - top };
      // The place saved is the start of the paragraph at the top of the screen when listening,
      // so coming back starts at a fresh paragraph/page rather than midway through a sentence.
      const atTop = { page: Number(hit.el.dataset.p), at: Number(hit.el.dataset.o) + hit.char };
      const place = listenMode ? (paragraphStartFor(reflowed.blocks, atTop) ?? atTop) : atTop;
      const page = pageById.get(place.page);
      onSpot({ page: place.page, at: place.at, frac: page ? Math.round(fracOf(page, place.at) * 1000) / 1000 : 0 });
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read); };
    g.scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => { g.scroller.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSpot, pageById, reflowed]);

  // Holding the place through any reflow.
  useEffect(() => {
    if (!root.current) return;
    let last = root.current.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = root.current?.offsetHeight ?? 0;
      if (Math.abs(height - last) < 1) return;
      last = height;
      const a = anchor.current;
      const g = geometry();
      if (!a || !g || !a.node.isConnected) return;
      g.scroller.scrollTop += topOfChar(a.node, a.char) - g.top - a.offset;
      ours.current = g.scroller.scrollTop;
    });
    observer.observe(root.current);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selecting text offers the highlight colours, as on the pages.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      // A selection is not finished while a finger is still on the screen.
      if (fingerDown()) return;
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !root.current?.contains(sel.anchorNode)) return onSelect(null);
      const range = sel.getRangeAt(0);
      const a = offsetAt(range.startContainer, range.startOffset);
      const b = offsetAt(range.endContainer, range.endOffset);
      if (!a) return onSelect(null);
      const page = pageById.get(a.page);
      if (!page) return onSelect(null);
      // A highlight belongs to one page: a selection over a page turn stops there.
      const end = b && b.page === a.page ? b.at : page.text.length;
      const rects = rectsFor(page, a.at, end);
      if (!rects.length) return onSelect(null);
      const box = range.getBoundingClientRect();
      onSelect({ page: a.page, rects: mergeRects(rects), text: sel.toString().replace(/\s+/g, " ").trim(), x: box.right, y: box.bottom });
    };
    const onChange = () => { clearTimeout(timer); timer = setTimeout(check, settleDelay()); };
    const off = whenLifted(() => { clearTimeout(timer); timer = setTimeout(check, 150); });
    const now = () => { clearTimeout(timer); check(); };
    document.addEventListener("selectionchange", onChange);
    document.addEventListener(SETTLE_NOW, now);
    return () => { clearTimeout(timer); off(); document.removeEventListener("selectionchange", onChange); document.removeEventListener(SETTLE_NOW, now); };
  }, [onSelect, pageById]);

  // The current match in Find is brought into view.
  useEffect(() => {
    if (!currentHit || !root.current) return;
    const marks = root.current.querySelectorAll<HTMLElement>(`mark.find-hit[data-p="${currentHit.page}"]`);
    root.current.querySelectorAll(".find-hit.current").forEach((m) => m.classList.remove("current"));
    const mark = marks[Math.min(currentHit.n, marks.length - 1)];
    if (mark) { mark.classList.add("current"); mark.scrollIntoView({ block: "center" }); }
  }, [currentHit, marksByPage]);

  const minutes = Math.max(1, Math.round(reflowed.words / 230));
  return (
    <article
      ref={(el) => {
        (root as unknown as { current: HTMLElement | null }).current = el;
        articleRef?.(el);
      }}
      className={listenMode ? "text-view tv-listening" : "text-view"}
      onClick={(e) => {
        // A tap that ends a text selection is not a tap to play or to open a highlight.
        // Only a selection inside the article counts: one left elsewhere on the
        // page (in the notes, say) must not stop a word from being tapped.
        const sel = document.getSelection();
        const selecting = sel && !sel.isCollapsed && sel.rangeCount > 0 && root.current && sel.getRangeAt(0).intersectsNode(root.current);
        if (selecting) return;
        if (listenMode && onWordTap) {
          const point = tapPoint(e.target, e.clientX, e.clientY);
          if (point && Number.isFinite(point.page) && Number.isFinite(point.at)) {
            onWordTap(point);
            return;
          }
        }
        const mark = (e.target as Element).closest<HTMLElement>("mark.hl-text");
        if (mark) onHighlight(mark.dataset.id!, e.clientX, e.clientY);
      }}
    >
      <header className="tv-head">
        <p className="tv-kicker">{kicker}</p>
        <h1 className="tv-title">{title}</h1>
        {standfirst && <p className="tv-standfirst">{standfirst}</p>}
        <p className="tv-byline">
          {byline && <span>{byline}</span>}
          <span>{minutes} min read</span>
          <span>{reflowed.pages.length} pages in print</span>
        </p>
      </header>
      <div className="tv-body">
        <Body blocks={reflowed.blocks} marksByPage={marksByPage} notes={notes} onHighlight={onHighlight} words={listenMode} />
      </div>
    </article>
  );
}
