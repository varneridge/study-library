// Selecting text with a finger. Two problems a mouse never has: the finger
// stays down while a selection is still being made, and a precise selection
// is hard to drag. So the reader waits for the finger to lift, and offers to
// widen a rough selection to the whole sentence or paragraph.

let fingers = 0;
const lifted = new Set<() => void>();
// A mouse or pen button held down means the same as a finger on the screen:
// the selection may still be being dragged out, so it is not offered yet.
let held = false;
const released = new Set<() => void>();
// Where the latest press began, and when it ended (0 while it is held), so a
// selection change caused by pressing the reader's own controls can be told
// apart from one made in the text.
let pressedAt: Element | null = null;
let pressEnded = 0;
if (typeof document !== "undefined") {
  const capture = { passive: true, capture: true } as const;
  const track = (e: TouchEvent) => {
    const before = fingers;
    fingers = e.touches.length;
    if (before && !fingers) {
      lifted.forEach((fn) => fn());
      released.forEach((fn) => fn());
    }
  };
  document.addEventListener("touchstart", track, capture);
  document.addEventListener("touchend", track, capture);
  document.addEventListener("touchcancel", track, capture);

  const press = (e: PointerEvent) => {
    pressedAt = e.target instanceof Element ? e.target : null;
    pressEnded = 0;
    if (e.pointerType !== "touch" && e.button === 0) held = true;
  };
  const release = () => {
    pressEnded = Date.now();
    if (!held) return;
    held = false;
    released.forEach((fn) => fn());
  };
  document.addEventListener("pointerdown", press, capture);
  document.addEventListener("pointerup", release, capture);
  document.addEventListener("pointercancel", release, capture);
  // A button let go outside the window sends no pointerup, so the next move
  // with no button down, or the window losing focus, ends the press instead.
  document.addEventListener("pointermove", (e: PointerEvent) => {
    if (held && e.buttons === 0) release();
  }, capture);
  if (typeof window !== "undefined") window.addEventListener("blur", release);
}

export const fingerDown = () => fingers > 0;

// Whether any finger, mouse button or pen is pressed down at the moment.
export const pressing = () => held || fingers > 0;

// Whether the press that is held now, or one that ended within the last
// within milliseconds, began inside an element matching selector.
export function pressInside(selector: string, within = 500): boolean {
  if (!pressedAt?.closest(selector)) return false;
  return pressEnded === 0 || Date.now() - pressEnded < within;
}

// Calls fn whenever the last finger leaves the screen or a mouse or pen
// button is let go, which is when a dragged selection is finished.
export function whenReleased(fn: () => void): () => void {
  released.add(fn);
  return () => released.delete(fn);
}

// Asks the reader to take the selection as it stands now, without waiting
// for it to settle, as after Whole sentence widens it.
export const SETTLE_NOW = "selection-settle-now";
export function settleNow(): void {
  document.dispatchEvent(new Event(SETTLE_NOW));
}

// Calls fn whenever the last finger leaves the screen.
export function whenLifted(fn: () => void): () => void {
  lifted.add(fn);
  return () => lifted.delete(fn);
}

export const touchScreen = () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches);

export interface CaretResult {
  node: Node;
  offset: number;
}

// Portable caret position lookup across browsers (document.caretPositionFromPoint
// in Firefox and modern Chromium; caretRangeFromPoint in WebKit/Blink).
export function caretAt(x: number, y: number): CaretResult | null {
  if (typeof document === "undefined") return null;
  const doc = document as unknown as {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof doc.caretPositionFromPoint === "function") {
    const pos = doc.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      return { node: pos.offsetNode, offset: pos.offset };
    }
  }
  if (typeof doc.caretRangeFromPoint === "function") {
    const range = doc.caretRangeFromPoint(x, y);
    if (range && range.startContainer) {
      return { node: range.startContainer, offset: range.startOffset };
    }
  }
  return null;
}

// How long a selection must sit still before it counts: longer on touch,
// where iOS does not always tell the page that a handle is still held.
export const settleDelay = () => (touchScreen() ? 700 : 250);

const BLOCKS = "p, li, blockquote, h1, h2, h3, h4, figcaption, td";

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n as Text);
  return out;
}

// A character offset within root, from a point in the DOM.
function offsetOf(root: Node, node: Node, offset: number): number {
  let total = 0;
  for (const t of textNodes(root)) {
    if (t === node) return total + offset;
    total += t.data.length;
  }
  // An element boundary: count the text before the child at offset.
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(node, offset);
  return range.toString().length;
}

function pointAt(root: Node, at: number): [Text, number] | null {
  let total = 0;
  const nodes = textNodes(root);
  for (const t of nodes) {
    if (at <= total + t.data.length) return [t, at - total];
    total += t.data.length;
  }
  const last = nodes[nodes.length - 1];
  return last ? [last, last.data.length] : null;
}

// Widens the current selection to whole sentences, or to its paragraph.
// scope is the element a sentence may not cross, such as a page's text.
export function widenSelection(kind: "sentence" | "paragraph", scope: Element): boolean {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const endEl = range.endContainer.nodeType === Node.ELEMENT_NODE ? range.endContainer as Element : range.endContainer.parentElement;
  if (!startEl || !endEl || !scope.contains(startEl)) return false;
  const first = startEl.closest(BLOCKS);
  const last = endEl.closest(BLOCKS);
  if (kind === "paragraph") {
    const a = first && scope.contains(first) ? first : scope;
    const b = last && scope.contains(last) ? last : a;
    const next = document.createRange();
    next.setStartBefore(a.firstChild ?? a);
    next.setEndAfter(b.lastChild ?? b);
    sel.removeAllRanges();
    sel.addRange(next);
    return true;
  }
  // Sentences: from the end of the one before to the end of the last one touched.
  const block = first && last && first === last && scope.contains(first) ? first : scope;
  const text = block.textContent ?? "";
  const from = offsetOf(block, range.startContainer, range.startOffset);
  const to = offsetOf(block, range.endContainer, range.endOffset);
  const ender = /[.!?]["'\u2019\u201d)\]]*(?=\s|$)/g;
  let start = 0;
  let end = text.length;
  for (let m = ender.exec(text); m; m = ender.exec(text)) {
    const stop = m.index + m[0].length;
    if (stop <= from) start = stop;
    if (stop >= to) { end = stop; break; }
  }
  while (start < text.length && /\s/.test(text[start])) start += 1;
  const a = pointAt(block, start);
  const b = pointAt(block, end);
  if (!a || !b) return false;
  const next = document.createRange();
  next.setStart(a[0], a[1]);
  next.setEnd(b[0], b[1]);
  sel.removeAllRanges();
  sel.addRange(next);
  settleNow();
  return true;
}
