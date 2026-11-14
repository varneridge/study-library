import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

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

export function SelectionBar({ anchor, colours, current, onHighlight, onComment, onCopy, onDismiss }: SelectionBarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  // Placement needs the bar's own size, so it is measured before paint and the
  // bar stays hidden until then to avoid a flash at the wrong place.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const coarse = typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
    setPosition(
      placeSelectionBar(
        { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom },
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        coarse,
      ),
    );
  }, [anchor.left, anchor.top, anchor.right, anchor.bottom, colours.length]);

  // A press anywhere outside the bar dismisses it, except on the text layer,
  // where it starts a new selection that the reader will handle itself.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (ref.current?.contains(target)) return;
      if (target.closest(".textLayer")) return;
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
      style={{ ...BAR_STYLE, left: position?.left ?? 0, top: position?.top ?? 0, visibility: position ? "visible" : "hidden" }}
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
