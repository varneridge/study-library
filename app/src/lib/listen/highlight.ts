// Speechify-style highlighting in TextView without re-rendering React. TextView
// renders every run of page text as an element carrying data-p (the page) and
// data-o (the page offset of its first character) (TextView.tsx:33), and keeps
// those offsets even where it hides a line-end hyphen (TextView.tsx:16), so a
// page span maps to a DOM Range exactly. The Range is painted with the CSS
// Custom Highlight API where the browser has it, which needs no DOM changes and
// so never disturbs TextView's selection or reflow anchoring (TextView.tsx:291),
// and with absolutely positioned boxes elsewhere.

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

/**
 * Paints the spoken word and its sentence. The styles live in CSS:
 * `::highlight(listen-word)` and `::highlight(listen-sentence)` for the native
 * path, `.listen-box[data-layer]` for the fallback boxes, which sit in an
 * overlay inside `root` (which must be `position: relative`).
 */
export function createPainter(root: HTMLElement, win: Window = root.ownerDocument.defaultView ?? window): HighlightPainter {
  const native = registry(win);
  if (native) {
    return {
      native: true,
      show(layer, range) {
        if (range) native.reg.set(NAMES[layer], native.make(range));
        else native.reg.delete(NAMES[layer]);
      },
      clear() {
        native.reg.delete(NAMES.word);
        native.reg.delete(NAMES.sentence);
      },
      dispose() {
        this.clear();
      },
    };
  }
  const doc = root.ownerDocument;
  const overlay = doc.createElement("div");
  overlay.className = "listen-overlay";
  overlay.setAttribute("aria-hidden", "true");
  root.appendChild(overlay);
  const layers: Record<HighlightLayer, HTMLElement[]> = { word: [], sentence: [] };
  const paint = (layer: HighlightLayer, range: Range | null) => {
    for (const el of layers[layer]) el.remove();
    layers[layer] = [];
    if (!range) return;
    const base = root.getBoundingClientRect();
    for (const rect of range.getClientRects()) {
      if (rect.width < 0.5 || rect.height < 0.5) continue;
      const box = doc.createElement("div");
      box.className = "listen-box";
      box.dataset.layer = layer;
      box.style.cssText = `left:${rect.left - base.left}px;top:${rect.top - base.top}px;width:${rect.width}px;height:${rect.height}px`;
      // Sentence boxes go under word boxes.
      if (layer === "sentence") overlay.prepend(box);
      else overlay.append(box);
      layers[layer].push(box);
    }
  };
  return {
    native: false,
    show: paint,
    clear() {
      paint("word", null);
      paint("sentence", null);
    },
    dispose() {
      this.clear();
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
