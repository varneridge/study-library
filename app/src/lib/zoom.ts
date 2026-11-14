// Zoom arithmetic for every PDF surface (reader pages, slide previews,
// transcripts, document previews). The outer frame never changes size, so
// these functions only ever decide how large the pages are drawn inside it
// and where the frame should scroll so that the point under focus stays put.

export type FitMode = "page" | "width";

export interface Box {
  width: number;
  height: number;
}

export interface Scroll {
  left: number;
  top: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEPS: readonly number[] = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
// iOS Safari refuses canvases above roughly 16.7 million pixels, and desktop
// browsers slow badly beyond it, so a page is never rasterised larger.
export const MAX_CANVAS_PIXELS = 16_777_216;
const EPSILON = 0.001;

function finitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

// Clamps a requested scale into the supported range, treating anything that
// is not a positive finite number as 100 per cent rather than propagating NaN
// into layout, where it would collapse the stage to nothing.
export function clampZoom(z: number): number {
  if (!finitePositive(z)) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

// The scale at which the widest page fits the frame's width ("width"), or at
// which the largest page fits wholly inside the frame ("page"), after leaving
// a gutter on each side. An unmeasured frame yields 1 so that the first paint
// is sensible until the ResizeObserver reports a real size.
export function fitScale(frame: Box, page: Box, mode: FitMode, gutter = 16): number {
  if (!finitePositive(frame.width) || !finitePositive(frame.height)) return 1;
  if (!finitePositive(page.width) || !finitePositive(page.height)) return 1;
  const usableW = Math.max(1, frame.width - gutter * 2);
  const usableH = Math.max(1, frame.height - gutter * 2);
  const byWidth = usableW / page.width;
  if (mode === "width") return clampZoom(byWidth);
  return clampZoom(Math.min(byWidth, usableH / page.height));
}

// The largest page across a document, which is what fitting is measured
// against so that mixed-size documents never overflow in fit mode.
export function largestPage(pages: readonly Box[]): Box {
  let width = 0;
  let height = 0;
  for (const p of pages) {
    if (finitePositive(p.width)) width = Math.max(width, p.width);
    if (finitePositive(p.height)) height = Math.max(height, p.height);
  }
  return { width: width || 1, height: height || 1 };
}

// The next zoom step above or below the current scale. A scale that sits
// between steps (because it came from fitting) moves to the nearest step in
// the requested direction rather than skipping one.
export function stepZoom(current: number, direction: 1 | -1): number {
  const z = clampZoom(current);
  if (direction === 1) {
    const next = ZOOM_STEPS.find((s) => s > z + EPSILON);
    return next ?? ZOOM_MAX;
  }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) {
    if (ZOOM_STEPS[i] < z - EPSILON) return ZOOM_STEPS[i];
  }
  return ZOOM_STEPS[0];
}

// Where the frame should scroll after a change of scale so that the content
// point currently under `focal` (a position within the frame's visible area,
// in CSS pixels) is still under it afterwards.
export function anchorScroll(scroll: Scroll, focal: { x: number; y: number }, from: number, to: number): Scroll {
  if (!finitePositive(from) || !finitePositive(to)) return { left: Math.max(0, scroll.left), top: Math.max(0, scroll.top) };
  const ratio = to / from;
  return {
    left: Math.max(0, (scroll.left + focal.x) * ratio - focal.x),
    top: Math.max(0, (scroll.top + focal.y) * ratio - focal.y),
  };
}

// The resolution at which a page's canvas is rasterised: the display scale
// times the device pixel ratio, reduced where necessary so that the canvas
// stays under MAX_CANVAS_PIXELS. The canvas is then stretched by CSS to the
// display size, which costs sharpness at extreme zoom rather than a crash.
export function canvasScale(page: Box, scale: number, dpr: number, maxPixels = MAX_CANVAS_PIXELS): number {
  const wanted = clampZoom(scale) * (finitePositive(dpr) ? dpr : 1);
  if (!finitePositive(page.width) || !finitePositive(page.height)) return wanted;
  const ceiling = Math.sqrt(maxPixels / (page.width * page.height));
  return Math.min(wanted, ceiling);
}
