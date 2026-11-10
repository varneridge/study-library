// Speechify-style highlighting and following for Listen, in either layout of
// the Reader, without re-rendering React.
//
// Text layout: TextView renders every run of page text as an element carrying
// data-p (the page) and data-o (the page offset of its first character), and in
// listen mode every word and every space as its own such element, and keeps
// those offsets even where it hides a line-end hyphen, so a page span maps to a
// DOM Range exactly (RunIndex). The sentence is painted with the CSS Custom
// Highlight API where the browser has it, which needs no DOM changes and so
// never disturbs TextView's selection or reflow anchoring; the word is a rounded
// pill in an overlay (createPainter).
//
// Page layout: the same page spans are turned into boxes on each PDF page by the
// Reader, which knows the reflowed text and the page viewports, and drawn in an
// overlay inside that page (createPageSurface).
//
// Both are a ListenSurface, so the controller paints and follows the spoken word
// in whichever layout is on screen, and can be handed a new one when the layout
// changes while it plays.

export interface PageSpan {
  page: number;
  start: number;
  end: number;
}

/** A box on screen, in client coordinates. */
export interface ScreenBox {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A box within one PDF page element, in that element's CSS pixels. */
export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where Listen paints and finds the spoken text. `show` paints the word and its
 * sentence (null clears a layer) and returns the word's box on screen, so the
 * controller can follow it; `locate` finds a span's box again after a scroll.
 * Every method is harmless after `dispose`, as the controller may still hold a
 * surface for a moment after the Reader has replaced it.
 */
export interface ListenSurface {
  readonly kind: "text" | "pages";
  show(word: PageSpan[] | null, sentence: PageSpan[] | null): ScreenBox | null;
  locate(spans: PageSpan[]): ScreenBox | null;
  clear(): void;
  dispose(): void;
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
    // The painter's own boxes live in `.listen-overlay` inside the article;
    // changes there are not text changes and are ignored, or every painted
    // frame would force a rebuild.
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
    this.stale = true;
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

  /** One Range from the start of the first span to the end of the last, or null when it is not in the article. */
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

function sameRange(a: Range | null, b: Range | null): boolean {
  if (!a || !b) return a === b;
  return a.startContainer === b.startContainer && a.startOffset === b.startOffset && a.endContainer === b.endContainer && a.endOffset === b.endOffset;
}

/** How far a word pill reaches past the word's own box, in CSS pixels, so it reads as a pill rather than a tight box. */
export const WORD_PILL_PAD = { x: 3, y: 1 };

/** A box for the overlay, relative to the root: the word's rectangle, grown by `pad` for the pill. */
export function boxFor(rect: { left: number; top: number; width: number; height: number }, base: { left: number; top: number }, pad = { x: 0, y: 0 }): { x: number; y: number; w: number; h: number } {
  return { x: rect.left - base.left - pad.x, y: rect.top - base.top - pad.y, w: rect.width + pad.x * 2, h: rect.height + pad.y * 2 };
}

/**
 * Lays one layer's boxes into an overlay, reusing the elements already there,
 * so the word pill glides along a line and jumps, with no glide, to a new line.
 * Sentence boxes go before word boxes, so the pill is always drawn on top.
 */
function layBoxes(
  doc: Document,
  pool: HTMLElement[],
  layer: HighlightLayer,
  wanted: Array<{ overlay: HTMLElement; box: { x: number; y: number; w: number; h: number } }>,
  glide: boolean,
): void {
  while (pool.length > wanted.length) pool.pop()!.remove();
  wanted.forEach(({ overlay, box: b }, i) => {
    let box = pool[i];
    let fresh = !box;
    if (box && box.parentElement !== overlay) {
      box.remove();
      fresh = true;
    }
    if (!box) {
      box = doc.createElement("div");
      box.className = "listen-box";
      box.dataset.layer = layer;
      pool[i] = box;
    }
    if (!box.isConnected) {
      if (layer === "sentence") overlay.prepend(box);
      else overlay.append(box);
    }
    const sameLine = !fresh && Math.abs(Number(box.dataset.y) - b.y) < 2;
    box.dataset.glide = glide && sameLine ? "1" : "0";
    box.dataset.y = String(b.y);
    box.style.width = `${b.w}px`;
    box.style.height = `${b.h}px`;
    box.style.transform = `translate(${b.x}px, ${b.y}px)`;
  });
}

/**
 * Paints the spoken word and its sentence in TextView, as Speechify does: the
 * sentence as a soft wash over its text, the word as a rounded pill.
 *
 * The sentence uses the CSS Custom Highlight API (`::highlight(listen-sentence)`)
 * where the browser has it, which needs no DOM changes and wraps across lines
 * cleanly. `::highlight` cannot round corners, so the word is always a box in
 * `.listen-overlay` (`.listen-box[data-layer="word"]`). Without the API the
 * sentence is boxes too. The overlay sits inside `root`, which must be
 * `position: relative` (listen.css), and is drawn over the text with a
 * translucent tint, as an overlay under the text would be hidden by any
 * background the article's own blocks have.
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
    if (!overlay.isConnected) root.appendChild(overlay);
    const rootRect = root.getBoundingClientRect();
    // The overlay is placed from the root's padding box, inside its border.
    const base = { left: rootRect.left + root.clientLeft, top: rootRect.top + root.clientTop };
    const pad = layer === "word" ? WORD_PILL_PAD : { x: 0, y: 0 };
    const rects = range ? Array.from(range.getClientRects()).filter((r) => r.width >= 0.5 && r.height >= 0.5) : [];
    layBoxes(doc, boxes[layer], layer, rects.map((rect) => ({ overlay, box: boxFor(rect, base, pad) })), glide);
  };

  const show = (layer: HighlightLayer, range: Range | null) => {
    if (layer === "sentence" && native) {
      if (sameRange(shown.sentence, range)) return;
      shown.sentence = range;
      if (range) native.reg.set(NAMES.sentence, native.make(range));
      else native.reg.delete(NAMES.sentence);
      return;
    }
    shown[layer] = range;
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

function screenBoxOf(rect: { top: number; bottom: number; left: number; right: number; width: number; height: number }): ScreenBox | null {
  if (rect.width < 0.5 && rect.height < 0.5) return null;
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

/** Listen in TextView: the article's runs (RunIndex) and its painter, as one surface. */
export function createTextSurface(root: HTMLElement): ListenSurface {
  const index = new RunIndex(root);
  const painter = createPainter(root);
  let live = true;
  const boxOf = (range: Range | null) => (range ? screenBoxOf(range.getBoundingClientRect()) : null);
  return {
    kind: "text",
    show(word, sentence) {
      if (!live) return null;
      const w = word?.length ? index.range(word) : null;
      painter.show("sentence", sentence?.length ? index.range(sentence) : null);
      painter.show("word", w);
      return boxOf(w);
    },
    locate(spans) {
      return live && spans.length ? boxOf(index.range(spans)) : null;
    },
    clear() {
      if (live) painter.clear();
    },
    dispose() {
      if (!live) return;
      live = false;
      painter.dispose();
      index.dispose();
    },
  };
}

/**
 * Listen on the PDF pages. `pageElement` finds the element a page is drawn in
 * (`.pdf-page`), and `boxes` turns a page span into boxes within it, from the
 * reflowed text and the page's viewport, which only the Reader knows. Each page
 * holds its own overlay, drawn over the canvas and the text layer and passing
 * presses through to them, so selecting and tapping on the page still work.
 * The overlays are redrawn when the pages change size (a zoom, a new width, a
 * trimmed margin).
 */
export function createPageSurface(opts: {
  root: HTMLElement;
  pageElement: (page: number) => HTMLElement | null;
  boxes: (span: PageSpan) => PageBox[];
}): ListenSurface {
  const { root, pageElement } = opts;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const overlays = new Map<HTMLElement, HTMLElement>();
  const pools: Record<HighlightLayer, HTMLElement[]> = { word: [], sentence: [] };
  let last: { word: PageSpan[] | null; sentence: PageSpan[] | null } = { word: null, sentence: null };
  let live = true;

  const overlayFor = (page: HTMLElement) => {
    let overlay = overlays.get(page);
    if (overlay && overlay.parentElement === page) return overlay;
    overlay = doc.createElement("div");
    overlay.className = "listen-overlay listen-overlay--page";
    overlay.setAttribute("aria-hidden", "true");
    if (win && win.getComputedStyle(page).position === "static") page.style.position = "relative";
    page.appendChild(overlay);
    overlays.set(page, overlay);
    return overlay;
  };

  /** Every box of the spans, with the page element it belongs to. */
  const measure = (spans: PageSpan[]) => {
    const out: Array<{ page: HTMLElement; box: PageBox }> = [];
    for (const span of spans) {
      const page = pageElement(span.page);
      if (!page) continue;
      for (const box of opts.boxes(span)) if (box.width > 0 && box.height > 0) out.push({ page, box });
    }
    return out;
  };

  const union = (measured: Array<{ page: HTMLElement; box: PageBox }>): ScreenBox | null => {
    let found: ScreenBox | null = null;
    const bases = new Map<HTMLElement, DOMRect>();
    for (const { page, box } of measured) {
      const base = bases.get(page) ?? page.getBoundingClientRect();
      bases.set(page, base);
      const b = { top: base.top + box.top, bottom: base.top + box.top + box.height, left: base.left + box.left, right: base.left + box.left + box.width };
      found = found
        ? { top: Math.min(found.top, b.top), bottom: Math.max(found.bottom, b.bottom), left: Math.min(found.left, b.left), right: Math.max(found.right, b.right) }
        : b;
    }
    return found;
  };

  const paint = (layer: HighlightLayer, spans: PageSpan[] | null, glide: boolean) => {
    const measured = spans ? measure(spans) : [];
    const pad = layer === "word" ? WORD_PILL_PAD : { x: 0, y: 0 };
    layBoxes(
      doc,
      pools[layer],
      layer,
      measured.map(({ page, box }) => ({ overlay: overlayFor(page), box: boxFor(box, { left: 0, top: 0 }, pad) })),
      glide,
    );
    return measured;
  };

  const Observer = win ? (win as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver : undefined;
  const resize = Observer
    ? new Observer(() => {
        if (!live) return;
        paint("sentence", last.sentence, false);
        paint("word", last.word, false);
      })
    : null;
  resize?.observe(root);

  const clear = () => {
    if (!live) return;
    last = { word: null, sentence: null };
    paint("sentence", null, false);
    paint("word", null, false);
  };

  return {
    kind: "pages",
    show(word, sentence) {
      if (!live) return null;
      last = { word, sentence };
      paint("sentence", sentence, true);
      return union(paint("word", word, true));
    },
    locate(spans) {
      return live && spans.length ? union(measure(spans)) : null;
    },
    clear,
    dispose() {
      if (!live) return;
      clear();
      live = false;
      resize?.disconnect();
      for (const overlay of overlays.values()) overlay.remove();
      overlays.clear();
    },
  };
}

/**
 * Whether the reader should scroll to keep the spoken word in view. Following
 * stops the moment the reader scrolls themselves and stays off, so they can
 * read elsewhere in peace, until they press Recentre, tap a word, or press
 * play. It also comes back by itself once they have kept still for `holdMs`
 * and the spoken word is where they are looking (`settled`).
 */
export class FollowGate {
  private lastUserScroll = Number.NEGATIVE_INFINITY;
  private paused = false;
  private readonly holdMs: number;

  constructor(holdMs = 4000) {
    this.holdMs = holdMs;
  }

  userScrolled(now: number): void {
    this.lastUserScroll = now;
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  follows(): boolean {
    return !this.paused;
  }

  /** The reader has not scrolled for `holdMs`. */
  settled(now: number): boolean {
    return now - this.lastUserScroll >= this.holdMs;
  }
}

/** The comfortable band for the spoken word: the middle third of the scroller, below its scroll padding. */
export const FOLLOW_BAND = { top: 1 / 3, bottom: 2 / 3 };

/**
 * How far to scroll so the spoken word sits in the comfortable band, or 0 when
 * it already does. A word that has left the band is brought to the band's top,
 * so the reading then has the whole band to run down before the next scroll,
 * and the page moves in calm steps rather than line by line. `inset` is the
 * scroller's scroll-padding-top (a toolbar over the text). Pure, so the band can
 * be tested without layout.
 */
export function followDelta(word: { top: number; bottom: number }, view: { top: number; height: number }, inset = 0, band = FOLLOW_BAND): number {
  const top = view.top + inset;
  const usable = Math.max(0, view.height - inset);
  const upper = top + usable * band.top;
  const lower = top + usable * band.bottom;
  if (word.top >= upper - 0.5 && word.bottom <= lower + 0.5) return 0;
  const delta = word.top - upper;
  return Math.abs(delta) < 1 ? 0 : delta;
}

/** Where the spoken word is when it is out of sight: above the view, below it, or null while any of it shows. */
export function offView(word: { top: number; bottom: number }, view: { top: number; height: number }, inset = 0): "above" | "below" | null {
  if (word.bottom <= view.top + inset) return "above";
  if (word.top >= view.top + view.height) return "below";
  return null;
}
