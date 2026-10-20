// Drawing PDF pages: the canvas, the text layer, highlights and find marks.

import * as pdfjs from "pdfjs-dist";
import type { PageViewport, PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { memo, useEffect, useRef, useState } from "react";
import type { HighlightRow } from "../../lib/types";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

export type Theme = "plain" | "sepia" | "dark";
export interface Size { width: number; height: number }
// The part of every page worth showing, in PDF points from the left edge.
export interface Crop { left: number; width: number }

export function screenRect(rect: number[], viewport: PageViewport) {
  const [a, b, c, d] = viewport.convertToViewportRectangle(rect);
  return { left: Math.min(a, c), top: Math.min(b, d), width: Math.abs(c - a), height: Math.abs(d - b) };
}

export function toPdfRect(rect: DOMRect, box: DOMRect, viewport: PageViewport): number[] {
  const [x1, y1] = viewport.convertToPdfPoint(rect.left - box.left, rect.top - box.top);
  const [x2, y2] = viewport.convertToPdfPoint(rect.right - box.left, rect.bottom - box.top);
  return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map((n) => Math.round(n * 100) / 100);
}

// Selections produce one rectangle per text span. Joining those on the same
// line keeps stored highlights small and draws them cleanly.
// The shape a highlight is drawn in: one band per line, joining the words
// on it whatever the gaps between them, as an OCR layer leaves wide ones;
// and neighbouring lines meeting halfway across the space between them, so
// the highlight reads as one smooth shape. Rects are PDF boxes [x0, y0, x1, y1].
export function smoothRects(rects: number[][]): number[][] {
  const rows: number[][] = [];
  for (const rect of [...rects].sort((a, b) => b[3] - a[3] || a[0] - b[0])) {
    const row = rows.find((r) => {
      const overlap = Math.min(r[3], rect[3]) - Math.max(r[1], rect[1]);
      const height = Math.min(r[3] - r[1], rect[3] - rect[1]);
      const gap = Math.max(rect[0] - r[2], r[0] - rect[2]);
      return overlap > height * 0.5 && gap < height * 2.5;
    });
    if (row) {
      row[0] = Math.min(row[0], rect[0]); row[1] = Math.min(row[1], rect[1]);
      row[2] = Math.max(row[2], rect[2]); row[3] = Math.max(row[3], rect[3]);
    } else rows.push([...rect]);
  }
  rows.sort((a, b) => b[3] - a[3]);
  for (let i = 0; i < rows.length - 1; i += 1) {
    const above = rows[i], below = rows[i + 1];
    const gap = above[1] - below[3];
    const height = Math.min(above[3] - above[1], below[3] - below[1]);
    const sideBySide = below[0] < above[2] && below[2] > above[0];
    if (gap > 0 && gap < height * 0.9 && sideBySide) {
      const middle = (above[1] + below[3]) / 2;
      above[1] = middle;
      below[3] = middle;
    }
  }
  return rows;
}

export function mergeRects(rects: number[][]): number[][] {
  const sorted = [...rects].sort((a, b) => b[3] - a[3] || a[0] - b[0]);
  const out: number[][] = [];
  for (const rect of sorted) {
    const last = out[out.length - 1];
    if (last) {
      const overlap = Math.min(last[3], rect[3]) - Math.max(last[1], rect[1]);
      const height = Math.min(last[3] - last[1], rect[3] - rect[1]);
      if (overlap > height * 0.5 && rect[0] <= last[2] + 3) {
        last[0] = Math.min(last[0], rect[0]);
        last[1] = Math.min(last[1], rect[1]);
        last[2] = Math.max(last[2], rect[2]);
        last[3] = Math.max(last[3], rect[3]);
        continue;
      }
    }
    out.push([...rect]);
  }
  return out;
}

// Finds the text column across the first pages, so a phone can trim the
// white margins either side. Returns null when there is little to gain.
export async function textColumn(doc: PDFDocumentProxy): Promise<Crop | null> {
  let left = Infinity;
  let right = -Infinity;
  let width = 0;
  for (let i = 1; i <= Math.min(doc.numPages, 6); i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    width = Math.max(width, viewport.width);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [x] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
      left = Math.min(left, x);
      right = Math.max(right, x + item.width);
    }
  }
  if (!Number.isFinite(left) || right <= left) return null;
  const margin = 10;
  const crop = { left: Math.max(0, left - margin), width: Math.min(width, right + margin) - Math.max(0, left - margin) };
  return crop.width < width * 0.9 ? crop : null;
}

// Where the photographs, maps and figures sit on a page, in screen space.
// Dark mode keeps these in their real colours. A picture covering most of
// the page is a scan, which reads better darkened, so it is left out.
async function imageBoxes(page: PDFPageProxy, viewport: PageViewport): Promise<{ left: number; top: number; width: number; height: number }[]> {
  const ops = await page.getOperatorList();
  const O = pdfjs.OPS;
  const stack: number[][] = [];
  let m = [1, 0, 0, 1, 0, 0];
  const times = (a: number[], b: number[]) => [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
  const boxes: { left: number; top: number; width: number; height: number }[] = [];
  const pageArea = viewport.width * viewport.height;
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === O.save) stack.push(m);
    else if (fn === O.restore) m = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.transform) m = times(m, args as number[]);
    else if (fn === O.paintFormXObjectBegin) {
      stack.push(m);
      if (Array.isArray(args?.[0])) m = times(m, args[0] as number[]);
    } else if (fn === O.paintFormXObjectEnd) m = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject) {
      const corners = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const rect = screenRect([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], viewport);
      const area = rect.width * rect.height;
      if (area > 400 && area < pageArea * 0.6) boxes.push(rect);
    }
  }
  return boxes;
}

// What to look for. A phrase is found as written. Several words without
// quotes are tried as a phrase first, and one at a time if that finds nothing.
export interface Needles { list: string[]; separate: boolean }

const clean = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

export function needlesFor(query: string, phraseFound: boolean): Needles {
  const text = clean(query);
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => clean(m[1])).filter((t) => t.length > 1);
  if (quoted.length) {
    const rest = clean(query.replace(/"[^"]*"?/g, " ")).split(" ").filter((w) => w.length > 1);
    return { list: [...quoted, ...rest], separate: rest.length > 0 || quoted.length > 1 };
  }
  const words = text.split(" ").filter((w) => w.length > 1);
  if (phraseFound || words.length < 2) return { list: text.length > 1 ? [text] : [], separate: false };
  return { list: words, separate: true };
}

// Finds each needle in a string, earliest first, without overlaps.
function positions(text: string, needles: string[]): [number, number][] {
  const found: [number, number][] = [];
  for (const needle of needles) {
    let at = text.indexOf(needle);
    while (at >= 0) {
      found.push([at, at + needle.length]);
      at = text.indexOf(needle, at + needle.length);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out: [number, number][] = [];
  for (const range of found) if (!out.length || range[0] >= out[out.length - 1][1]) out.push(range);
  return out;
}

// Wraps each match in the text layer in a mark.
function markMatches(container: HTMLElement, needles: string[]): HTMLElement[] {
  container.querySelectorAll("mark.find-hit").forEach((mark) => mark.replaceWith(...mark.childNodes));
  container.normalize();
  if (!needles.length) return [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const marks: HTMLElement[] = [];
  for (const node of nodes) {
    const ranges = positions(node.data.toLowerCase().replace(/\s/g, " "), needles);
    // Work from the end, so earlier offsets stay valid.
    const made: HTMLElement[] = [];
    for (let i = ranges.length - 1; i >= 0; i -= 1) {
      const [a, b] = ranges[i];
      const hit = node.splitText(a);
      hit.splitText(b - a);
      const mark = document.createElement("mark");
      mark.className = "find-hit";
      hit.replaceWith(mark);
      mark.append(hit);
      made.unshift(mark);
    }
    marks.push(...made);
  }
  return marks;
}

export const PageView = memo(function PageView({
  doc, index, size, scale, theme, crop, highlights, activeId, query, currentHit, onViewport, onHighlightClick,
}: {
  doc: PDFDocumentProxy;
  index: number;
  size: Size;
  scale: number;
  theme: Theme;
  crop: Crop | null;
  highlights: HighlightRow[];
  activeId: string | null;
  query: Needles;
  // Which match on this page is the current one, if any.
  currentHit: number | null;
  onViewport: (index: number, viewport: PageViewport | null) => void;
  onHighlightClick?: (id: string, x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const pictures = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [rendered, setRendered] = useState(0);
  const scrolledTo = useRef<string | null>(null);

  useEffect(() => {
    const element = ref.current!;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), {
      root: element.closest(".scroller"),
      rootMargin: "150% 0px",
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!near) {
      // Pages far from the screen give their memory back.
      for (const c of [canvas.current, pictures.current]) {
        if (c) { c.width = 0; c.height = 0; }
      }
      text.current?.replaceChildren();
      setViewport(null);
      onViewport(index, null);
      return;
    }
    let cancelled = false;
    let render: RenderTask | null = null;
    let layer: pdfjs.TextLayer | null = null;
    void (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const target = canvas.current!;
      target.width = Math.floor(vp.width * ratio);
      target.height = Math.floor(vp.height * ratio);
      render = page.render({
        canvasContext: target.getContext("2d")!,
        viewport: vp,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      });
      try {
        await render.promise;
      } catch {
        return;
      }
      if (cancelled) return;

      const overlay = pictures.current!;
      overlay.width = 0;
      overlay.height = 0;
      if (theme === "dark") {
        const boxes = await imageBoxes(page, vp).catch(() => []);
        if (cancelled) return;
        if (boxes.length) {
          overlay.width = target.width;
          overlay.height = target.height;
          const ctx = overlay.getContext("2d")!;
          for (const b of boxes) {
            const [x, y, w, h] = [b.left * ratio, b.top * ratio, b.width * ratio, b.height * ratio];
            ctx.drawImage(target, x, y, w, h, x, y, w, h);
          }
        }
      }

      const container = text.current!;
      container.replaceChildren();
      container.style.setProperty("--scale-factor", String(vp.scale));
      layer = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container, viewport: vp });
      try {
        await layer.render();
      } catch {
        return;
      }
      if (cancelled) return;
      const end = document.createElement("div");
      end.className = "endOfContent";
      container.append(end);
      setViewport(vp);
      setRendered((n) => n + 1);
      onViewport(index, vp);
    })();
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
  }, [near, scale, doc, index, onViewport, theme]);

  // Find marks, redrawn whenever the text layer or the query changes.
  useEffect(() => {
    const container = text.current;
    if (!container || !viewport) return;
    const marks = markMatches(container, query.list);
    if (currentHit !== null && marks.length) {
      const mark = marks[Math.min(currentHit, marks.length - 1)];
      mark.classList.add("current");
      // Scroll once per match, so a page redrawn later does not pull you back.
      const key = `${query.list.join("|")}:${currentHit}`;
      if (scrolledTo.current !== key) {
        scrolledTo.current = key;
        mark.scrollIntoView({ block: "center" });
      }
    } else if (currentHit === null) {
      scrolledTo.current = null;
    }
  }, [query, currentHit, viewport, rendered]);

  const shown = crop ? Math.min(crop.width, size.width - crop.left) : size.width;
  return (
    <div ref={ref} className="pdf-slot" style={{ width: shown * scale, height: size.height * scale }}>
      <div
        className="pdf-page"
        data-page={index}
        style={{ width: size.width * scale, height: size.height * scale, left: crop ? -crop.left * scale : 0 }}
      >
        <canvas ref={canvas} className="page-canvas" />
        <canvas ref={pictures} className="page-pictures" />
        <div className="hl-layer">
          {viewport &&
            highlights.flatMap((h) =>
              smoothRects(h.rects).map((rect, i) => (
                <button
                  type="button"
                  key={`${h.id}-${i}`}
                  data-id={h.id}
                  tabIndex={i === 0 ? 0 : -1}
                  role="button"
                  aria-label={`Highlight: ${h.body ? h.body.slice(0, 50) : "highlight"}`}
                  className={`hl${h.id === activeId ? " active" : ""}`}
                  style={{ ...screenRect(rect, viewport), background: h.colour }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    onHighlightClick?.(h.id, r.left + r.width / 2, r.bottom);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      const r = e.currentTarget.getBoundingClientRect();
                      onHighlightClick?.(h.id, r.left + r.width / 2, r.bottom);
                    }
                  }}
                />
              )),
            )}
        </div>
        <div
          ref={text}
          className="textLayer"
          onPointerDown={(e) => e.currentTarget.classList.add("selecting")}
        />
      </div>
    </div>
  );
});

// Counts matches page by page, from the text pdf.js extracts.
export async function findInDocument(doc: PDFDocumentProxy, texts: Map<number, string>, query: string): Promise<{ hits: { page: number; n: number }[]; needles: Needles }> {
  for (let i = 0; i < doc.numPages; i += 1) {
    if (texts.has(i)) continue;
    const content = await (await doc.getPage(i + 1)).getTextContent();
    // Items are joined as the text layer splits its spans, so counts line up
    // with the marks drawn on the page.
    texts.set(i, content.items.map((item) => ("str" in item ? item.str : "")).join("\u0000").toLowerCase().replace(/\s/g, " "));
  }
  const count = (needles: Needles) => {
    const hits: { page: number; n: number }[] = [];
    for (let i = 0; i < doc.numPages; i += 1) {
      let n = 0;
      for (const part of texts.get(i)!.split("\u0000")) {
        for (let k = positions(part, needles.list).length; k > 0; k -= 1) hits.push({ page: i, n: n++ });
      }
    }
    return hits;
  };
  const phrase = needlesFor(query, true);
  const hits = count(phrase);
  if (hits.length || phrase.separate) return { hits, needles: phrase };
  const words = needlesFor(query, false);
  return words.separate ? { hits: count(words), needles: words } : { hits, needles: phrase };
}
