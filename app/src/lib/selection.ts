// Selecting text with a finger. Two problems a mouse never has: the finger
// stays down while a selection is still being made, and a precise selection
// is hard to drag. So the reader waits for the finger to lift, and offers to
// widen a rough selection to the whole sentence or paragraph.

let fingers = 0;
const lifted = new Set<() => void>();
if (typeof document !== "undefined") {
  const track = (e: TouchEvent) => {
    const before = fingers;
    fingers = e.touches.length;
    if (before && !fingers) lifted.forEach((fn) => fn());
  };
  document.addEventListener("touchstart", track, { passive: true, capture: true });
  document.addEventListener("touchend", track, { passive: true, capture: true });
  document.addEventListener("touchcancel", track, { passive: true, capture: true });
}

export const fingerDown = () => fingers > 0;

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
