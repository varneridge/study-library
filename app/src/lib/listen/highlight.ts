// Speechify-style highlighting in TextView without re-rendering React. TextView
// renders every run of page text as an element carrying data-p (the page) and
// data-o (the page offset of its first character), and in listen mode every
// word and every space as its own such element, and keeps those offsets even
// where it hides a line-end hyphen, so a page span maps to a DOM Range exactly.
// The sentence is painted with the CSS Custom Highlight API where the browser
// has it, which needs no DOM changes and so never disturbs TextView's selection
// or reflow anchoring; the word is a rounded box in an overlay (createPainter).

export interface PageSpan {
  page: number;
  start: number;
  end: number;
}

interface Run {
  o: number;
  len: number;
  node: Text;
}

/** The text runs of a TextView, indexed by page, rebuilt lazily after the DOM changes. */
export class RunIndex {
  private readonly root: HTMLElement;
  private byPage = new Map<number, Run[]>();
  private stale = true;
  private readonly observer: MutationObserver | null;

  constructor(root: HTMLElement) {
    this.root = root;
    // Highlights and Find split runs into new elements, so any change in the
    // article's subtree makes the index stale; it is rebuilt on next use.
    // The fallback painter's own boxes live in `.listen-overlay` inside the
    // article; changes there are not text changes and are ignored, or every
    // painted frame would force a rebuild.
    const ours = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest(".listen-overlay") != null;
    this.observer = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          if (records.some((r) => !ours(r.target))) this.stale = true;
        });
    this.observer?.observe(root, { childList: true, subtree: true, characterData: true });
  }

  invalidate(): void {
    this.stale = true;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.byPage.clear();
  }

  private rebuild(): void {
    this.byPage = new Map();
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-p][data-o]")) {
      const node = [...el.childNodes].find((n): n is Text => n.nodeType === 3);
      if (!node || !node.data.length) continue;
      const page = Number(el.dataset.p);
      const o = Number(el.dataset.o);
      if (!Number.isFinite(page) || !Number.isFinite(o)) continue;
      const list = this.byPage.get(page) ?? [];
      list.push({ o, len: node.data.length, node });
      this.byPage.set(page, list);
    }
    for (const list of this.byPage.values()) list.sort((a, b) => a.o - b.o);
    this.stale = false;
  }

  runs(page: number): Run[] {
    if (this.stale) this.rebuild();
    return this.byPage.get(page) ?? [];
  }

  /**
   * The DOM position of a page offset. A start falling between runs (on a
   * hidden hyphen or a line-end space) moves to the next run's start; an end
   * falling between runs moves back to the previous run's end, so a range never
   * swallows text it should not.
   */
  point(page: number, at: number, side: "start" | "end"): { node: Text; offset: number } | null {
    const runs = this.runs(page);
    if (!runs.length) return null;
    let lo = 0;
    let hi = runs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (runs[mid].o <= (side === "end" ? at - 1 : at)) lo = mid;
      else hi = mid - 1;
    }
    const r = runs[lo];
    if (side === "start") {
      if (at < r.o) return { node: r.node, offset: 0 };
      if (at < r.o + r.len) return { node: r.node, offset: at - r.o };
      const next = runs[lo + 1];
      return next ? { node: next.node, offset: 0 } : { node: r.node, offset: r.len };
    }
    if (at <= r.o) return { node: r.node, offset: 0 };
    return { node: r.node, offset: Math.min(at - r.o, r.len) };
  }

  /** One Range from the start of the first span to the end of the last, or null when off screen. */
  range(spans: PageSpan[], doc: Document = this.root.ownerDocument): Range | null {
    if (!spans.length) return null;
    const first = spans[0];
    const last = spans[spans.length - 1];
    const a = this.point(first.page, first.start, "start");
    const b = this.point(last.page, last.end, "end");
    if (!a || !b) return null;
    const range = doc.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch {
      return null;
    }
    return range.collapsed ? null : range;
  }
}

export type HighlightLayer = "word" | "sentence";

export interface HighlightPainter {
  show(layer: HighlightLayer, range: Range | null): void;
  clear(): void;
  dispose(): void;
  readonly native: boolean;
}

const NAMES: Record<HighlightLayer, string> = { word: "listen-word", sentence: "listen-sentence" };

interface HighlightRegistry {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}

function registry(win: Window): { reg: HighlightRegistry; make: (r: Range) => unknown } | null {
  const css = (win as unknown as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (win as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!css?.highlights || typeof Ctor !== "function") return null;
  return { reg: css.highlights, make: (r) => new Ctor(r) };
}

/** How far a word pill reaches past the word's own box, in CSS pixels, so it reads as a pill rather than a tight box. */
export const WORD_PILL_PAD = { x: 3, y: 1 };

/** A box for the overlay, relative to the root: the word's rectangle, grown by `pad` for the pill. */
export function boxFor(rect: { left: number; top: number; width: number; height: number }, base: { left: number; top: number }, pad = { x: 0, y: 0 }): { x: number; y: number; w: number; h: number } {
  return { x: rect.left - base.left - pad.x, y: rect.top - base.top - pad.y, w: rect.width + pad.x * 2, h: rect.height + pad.y * 2 };
}

/**
 * Paints the spoken word and its sentence, as Speechify does: the sentence as a
 * soft wash over its text, the word as a rounded pill.
 *
 * The sentence uses the CSS Custom Highlight API (`::highlight(listen-sentence)`)
 * where the browser has it, which needs no DOM changes and wraps across lines
 * cleanly. `::highlight` cannot round corners, so the word is always a box in
 * `.listen-overlay` (`.listen-box[data-layer="word"]`), drawn under the text.
 * Without the API the sentence is boxes too. The overlay sits inside `root`,
 * which must be `position: relative` (listen.css). Word boxes are reused, so the
 * pill glides along a line; it jumps, with no glide, to a new line.
 */
export function createPainter(root: HTMLElement, win: Window = root.ownerDocument.defaultView ?? window): HighlightPainter {
  const native = registry(win);
  const doc = root.ownerDocument;
  const overlay = doc.createElement("div");
  overlay.className = "listen-overlay";
  overlay.setAttribute("aria-hidden", "true");
  root.appendChild(overlay);
  const boxes: Record<HighlightLayer, HTMLElement[]> = { word: [], sentence: [] };
  const shown: Record<HighlightLayer, Range | null> = { word: null, sentence: null };

  const paintBoxes = (layer: HighlightLayer, range: Range | null, glide: boolean) => {
    const base = root.getBoundingClientRect();
    const pad = layer === "word" ? WORD_PILL_PAD : { x: 0, y: 0 };
    const rects = range ? Array.from(range.getClientRects()).filter((r) => r.width >= 0.5 && r.height >= 0.5) : [];
    const pool = boxes[layer];
    while (pool.length > rects.length) pool.pop()!.remove();
    rects.forEach((rect, i) => {
      const b = boxFor(rect, base, pad);
      let box = pool[i];
      const fresh = !box;
      if (!box) {
        box = doc.createElement("div");
        box.className = "listen-box";
        box.dataset.layer = layer;
        // Sentence boxes go under word boxes.
        if (layer === "sentence") overlay.prepend(box);
        else overlay.append(box);
        pool.push(box);
      }
      const sameLine = !fresh && Math.abs(Number(box.dataset.y) - b.y) < 2;
      box.dataset.glide = glide && sameLine ? "1" : "0";
      box.dataset.y = String(b.y);
      box.style.width = `${b.w}px`;
      box.style.height = `${b.h}px`;
      box.style.transform = `translate(${b.x}px, ${b.y}px)`;
    });
  };

  const show = (layer: HighlightLayer, range: Range | null) => {
    shown[layer] = range;
    if (layer === "sentence" && native) {
      if (range) native.reg.set(NAMES.sentence, native.make(range));
      else native.reg.delete(NAMES.sentence);
      return;
    }
    paintBoxes(layer, range, true);
  };

  // A reflow (a turned phone, a new text size) moves the words under the boxes;
  // the boxes are redrawn where the same ranges now are.
  const Observer = (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  const resize = Observer
    ? new Observer(() => {
        paintBoxes("word", shown.word, false);
        if (!native) paintBoxes("sentence", shown.sentence, false);
      })
    : null;
  resize?.observe(root);

  const clear = () => {
    show("word", null);
    show("sentence", null);
  };

  return {
    native: Boolean(native),
    show,
    clear,
    dispose() {
      clear();
      resize?.disconnect();
      overlay.remove();
    },
  };
}

/**
 * Whether the reader should scroll to keep the spoken word in view. Following
 * pauses for `holdMs` after the reader scrolls themselves, as Speechify does,
 * and resumes on its own; a tap on "Follow" resumes it at once.
 */
export class FollowGate {
  private lastUserScroll = Number.NEGATIVE_INFINITY;
  private readonly holdMs: number;

  constructor(holdMs = 4000) {
    this.holdMs = holdMs;
  }

  userScrolled(now: number): void {
    this.lastUserScroll = now;
  }

  resume(): void {
    this.lastUserScroll = Number.NEGATIVE_INFINITY;
  }

  follows(now: number): boolean {
    return now - this.lastUserScroll >= this.holdMs;
  }
}

/**
 * How far to scroll so a word's box sits in the comfortable band of the
 * scroller (from `top` to `bottom`, as fractions of its height), or 0 when it
 * already does. Pure, so the band can be tested without layout.
 */
export function scrollDelta(word: { top: number; bottom: number }, view: { top: number; height: number }, band = { top: 0.2, bottom: 0.7 }): number {
  const upper = view.top + view.height * band.top;
  const lower = view.top + view.height * band.bottom;
  if (word.top < upper) return word.top - upper;
  if (word.bottom > lower) return word.top - upper;
  return 0;
}

/**
 * How far to scroll so a new paragraph's first line sits at the top of the
 * scroller, below its scroll-padding-top (`inset`), or 0 when it already does.
 * The top of the screen is then always the start of a paragraph, so the place
 * TextView saves from it is a paragraph start.
 */
export function paragraphTopDelta(paragraphTop: number, view: { top: number; height: number }, inset = 0): number {
  const delta = paragraphTop - (view.top + inset);
  return Math.abs(delta) < 1 ? 0 : delta;
}

/**
 * How far to scroll while a paragraph is read, or 0. Unlike scrollDelta, a word
 * near the top is left alone, so the paragraph alignment above is not undone;
 * only a word that has left the view, or is near its bottom in a paragraph
 * taller than the view, moves it, and then it moves by whole lines to put the
 * word a sixth of the way down.
 */
export function followWordDelta(word: { top: number; bottom: number }, view: { top: number; height: number }, inset = 0): number {
  const top = view.top + inset;
  const usable = view.height - inset;
  if (word.top < top || word.bottom > top + usable * 0.85) return word.top - (top + usable / 6);
  return 0;
}
