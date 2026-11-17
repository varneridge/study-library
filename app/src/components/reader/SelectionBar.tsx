import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { usableRect } from "../../lib/highlightSelect";

export interface SelectionBarColour {
  value: string;
  label: string;
}

export interface SelectionBarProps {
  // Viewport rectangle of the selection's final client rect.
  anchor: DOMRect;
  colours: readonly SelectionBarColour[];
  // The last used colour, persisted by the reader under "highlight-colour".
  current: string;
  onHighlight(colour: string): void;
  onComment(colour: string): void;
  onCopy(): void;
  onDismiss(): void;
}

interface Edges {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Size {
  width: number;
  height: number;
}

const MARGIN = 8;
const OFFSET = 10;

function clamp(n: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, n));
}

// Centres the bar on the selection, above it by default and below it when
// asked (touch screens, where the platform's own callout sits above) or when
// there is no room above, and keeps it wholly inside the viewport.
export function placeSelectionBar(anchor: Edges, bar: Size, viewport: Size, preferBelow: boolean): { left: number; top: number } {
  const centre = (anchor.left + anchor.right) / 2;
  const left = clamp(centre - bar.width / 2, MARGIN, Math.max(MARGIN, viewport.width - bar.width - MARGIN));
  const above = anchor.top - bar.height - OFFSET;
  const below = anchor.bottom + OFFSET;
  const fitsAbove = above >= MARGIN;
  const fitsBelow = below + bar.height <= viewport.height - MARGIN;
  const order: Array<[number, boolean]> = preferBelow
    ? [
        [below, fitsBelow],
        [above, fitsAbove],
      ]
    : [
        [above, fitsAbove],
        [below, fitsBelow],
      ];
  const chosen = order.find(([, fits]) => fits)?.[0] ?? order[0][0];
  return { left, top: clamp(chosen, MARGIN, Math.max(MARGIN, viewport.height - bar.height - MARGIN)) };
}

// System colour keywords keep the bar legible in light and dark themes even
// where the app's own variables are absent.
const BAR_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 60,
  display: "flex",
  alignItems: "center",
  gap: "0.25rem",
  padding: "0.25rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--line, color-mix(in srgb, CanvasText 25%, transparent))",
  background: "var(--surface, Canvas)",
  color: "var(--text, CanvasText)",
  boxShadow: "0 4px 16px rgb(0 0 0 / 0.2)",
  font: "inherit",
  // A narrow screen wraps the buttons rather than pushing the bar off its edge.
  flexWrap: "wrap",
  maxWidth: `calc(100vw - ${MARGIN * 2}px)`,
  boxSizing: "border-box",
  // The bar's own labels must never become the selection, by a double click
  // or a long press, or the selection it acts on would be lost.
  userSelect: "none",
  WebkitUserSelect: "none",
  WebkitTouchCallout: "none",
  touchAction: "manipulation",
};

const BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.4rem",
  minHeight: "2rem",
  padding: "0 0.6rem",
  border: "none",
  borderRadius: "0.35rem",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

function dot(colour: string, size: string): CSSProperties {
  return {
    display: "inline-block",
    width: size,
    height: size,
    borderRadius: "50%",
    background: colour,
    border: "1px solid color-mix(in srgb, CanvasText 35%, transparent)",
    flex: "none",
  };
}

// The last line box of the live selection, which follows the text as it
// scrolls, where the anchor passed in is fixed at the moment of selecting.
function liveSelectionEdges(): Edges | null {
  const sel = typeof document !== "undefined" ? document.getSelection() : null;
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (typeof range.getClientRects !== "function") return null;
  const tail = Array.from(range.getClientRects()).reverse().find((r) => usableRect(r));
  return tail ? { left: tail.left, top: tail.top, right: tail.right, bottom: tail.bottom } : null;
}

// Whether a press landed on an element's own scroll bar, which scrolls the
// text rather than leaving the selection.
function onScrollBar(e: PointerEvent, el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const box = el.getBoundingClientRect();
  const pastRight = el.scrollHeight > el.clientHeight && e.clientX >= box.left + el.clientLeft + el.clientWidth;
  const pastBottom = el.scrollWidth > el.clientWidth && e.clientY >= box.top + el.clientTop + el.clientHeight;
  return pastRight || pastBottom;
}

export function SelectionBar({ anchor, colours, current, onHighlight, onComment, onCopy, onDismiss }: SelectionBarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  // While the selection is scrolled out of sight the bar is hidden, rather
  // than left clamped to the edge of the screen pointing at nothing.
  const [offscreen, setOffscreen] = useState(false);
  // The last usable edges to place against. A missing rectangle, all zeros,
  // never replaces them, so the bar cannot jump to the corner of the screen.
  const edges = useRef<Edges | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    const at = edges.current;
    if (!el || !at) return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    const next = placeSelectionBar(at, { width: el.offsetWidth, height: el.offsetHeight }, viewport, coarse);
    setOffscreen(at.bottom < 0 || at.top > viewport.height);
    // An unchanged place keeps the same state, so nothing re-renders.
    setPosition((was) => (was && Math.abs(was.left - next.left) < 0.5 && Math.abs(was.top - next.top) < 0.5 ? was : next));
  }, []);

  // Placement needs the bar's own size, so it is measured before paint and the
  // bar stays hidden until then to avoid a flash at the wrong place.
  useLayoutEffect(() => {
    const at = { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom };
    if (usableRect(at)) edges.current = at;
    place();
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, colours.length, current, place]);

  // Scrolling or resizing moves the selection, so the bar follows it, once a
  // frame at most, instead of staying where the selection used to be.
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      frame = 0;
      const live = liveSelectionEdges();
      if (live) edges.current = live;
      place();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(follow);
    };
    const options = { capture: true, passive: true } as const;
    window.addEventListener("scroll", schedule, options);
    window.addEventListener("resize", schedule, options);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, options);
      window.removeEventListener("resize", schedule, options);
    };
  }, [place]);

  // A press anywhere outside the bar dismisses it, except on the text layer,
  // where it starts a new selection that the reader will handle itself, and
  // on a scroll bar, which only moves the text the selection is in.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target)) return;
      if (target.closest(".textLayer")) return;
      if (onScrollBar(e, target)) return;
      dismissRef.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  return (
    <div
      ref={ref}
      data-selection-bar=""
      className="selection-bar"
      role="toolbar"
      aria-label="Highlight selection"
      style={{ ...BAR_STYLE, left: position?.left ?? 0, top: position?.top ?? 0, visibility: position && !offscreen ? "visible" : "hidden" }}
      // Keeping the mouse press from moving focus is what preserves the
      // selection while the reader reaches for a button.
      onMouseDown={(e) => e.preventDefault()}
    >
      <button type="button" className="selection-bar-primary" style={BUTTON_STYLE} aria-keyshortcuts="H" onClick={() => onHighlight(current)}>
        <span aria-hidden="true" style={dot(current, "0.9rem")} />
        <span>Highlight</span>
      </button>
      <span role="group" aria-label="Highlight colour" style={{ display: "inline-flex", gap: "0.2rem", padding: "0 0.25rem" }}>
        {colours.map((c) => (
          <button
            key={c.value}
            type="button"
            data-colour={c.value}
            aria-label={`Highlight ${c.label}`}
            title={c.label}
            aria-pressed={c.value === current}
            style={{ ...BUTTON_STYLE, minHeight: "1.75rem", padding: "0 0.2rem" }}
            onClick={() => onHighlight(c.value)}
          >
            <span aria-hidden="true" style={dot(c.value, c.value === current ? "1.1rem" : "0.9rem")} />
          </button>
        ))}
      </span>
      <button type="button" className="selection-bar-comment" style={BUTTON_STYLE} aria-keyshortcuts="C" onClick={() => onComment(current)}>
        Comment
      </button>
      <button type="button" className="selection-bar-copy" style={BUTTON_STYLE} onClick={onCopy}>
        Copy
      </button>
    </div>
  );
}
