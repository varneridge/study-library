import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ForwardRefExoticComponent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
  type RefAttributes,
} from "react";
import { anchorScroll, canvasScale, clampZoom, fitScale, largestPage, type Box, type FitMode, type Scroll } from "../../lib/zoom";

// What a page needs to draw itself inside the viewport: the CSS scale to size
// it by, and the (possibly lower) scale at which to rasterise its canvas.
export interface ViewportLayout {
  scale: number;
  renderScale(page: Box): number;
  frame: Box;
}

export interface ZoomViewportProps {
  // Unscaled page boxes, already cropped when trimming is on.
  pageSizes: readonly Box[];
  // null means fit to the frame, otherwise a manual scale.
  zoom: number | null;
  // "page" for slides and previews, "width" for readings and transcripts.
  fit: FitMode;
  // Vertical gap between pages in CSS pixels.
  gap?: number;
  // Called for Ctrl or pinch wheel gestures with the requested manual scale.
  onZoomChange?(zoom: number | null): void;
  // Reports the scale actually in use, so a toolbar can show a percentage in fit mode.
  onEffectiveScale?(scale: number): void;
  className?: string;
  children(layout: ViewportLayout): ReactNode;
}

// Matches the gutter given to fitScale, so that in fit mode the stage's outer
// width equals the frame's client width and never overflows it.
const GUTTER = 16;
// Frame size changes smaller than this are ignored, which stops a scrollbar
// or sub-pixel rounding from making fitting oscillate.
const MEASURE_THRESHOLD = 0.5;
const WHEEL_SENSITIVITY = 0.002;
// A wheel focal point older than this is stale and the frame centre is used.
const FOCAL_LIFETIME_MS = 250;

// The frame takes its size from layout alone, never from its content, which is
// what keeps the outer dimensions stable while pages scale inside it. The
// styles are inline so that the invariant holds even before any stylesheet loads.
const FRAME_STYLE: CSSProperties = {
  position: "relative",
  flex: "1 1 0",
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
  overscrollBehavior: "contain",
  contain: "layout paint",
  scrollbarGutter: "stable both-edges",
};

const STAGE_STYLE: CSSProperties = {
  boxSizing: "border-box",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  padding: `${GUTTER}px`,
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) (ref as MutableRefObject<T | null>).current = value;
}

interface Focal {
  x: number;
  y: number;
  at: number;
}

export const ZoomViewport: ForwardRefExoticComponent<ZoomViewportProps & RefAttributes<HTMLDivElement>> = forwardRef<
  HTMLDivElement,
  ZoomViewportProps
>(function ZoomViewport({ pageSizes, zoom, fit, gap = 12, onZoomChange, onEffectiveScale, className, children }, forwardedRef) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<Box>({ width: 0, height: 0 });

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      frameRef.current = node;
      assignRef(forwardedRef, node);
    },
    [forwardedRef],
  );

  const largest = useMemo(() => largestPage(pageSizes), [pageSizes]);
  const scale = zoom === null ? fitScale(frame, largest, fit, GUTTER) : clampZoom(zoom);

  // Measure the frame, batching observer callbacks into animation frames.
  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const next: Box = { width: el.clientWidth, height: el.clientHeight };
      setFrame((prev) =>
        Math.abs(prev.width - next.width) < MEASURE_THRESHOLD && Math.abs(prev.height - next.height) < MEASURE_THRESHOLD ? prev : next,
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (raf === 0) raf = requestAnimationFrame(measure);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, []);

  // Keep the point under focus where it was across a change of scale. The
  // scroll position is read from the last scroll event rather than the DOM,
  // because by the time this runs the browser may already have clamped it to
  // the new, smaller content. The fixed gutters and gaps mean the anchoring is
  // exact for the pages themselves and out by at most a few pixels overall.
  const scrollRef = useRef<Scroll>({ left: 0, top: 0 });
  const focalRef = useRef<Focal | null>(null);
  const previous = useRef({ scale, measured: false });
  useLayoutEffect(() => {
    const el = frameRef.current;
    const { scale: from, measured: wasMeasured } = previous.current;
    previous.current = { scale, measured: frame.width > 0 && frame.height > 0 };
    // The first real measurement turns the provisional 100 per cent into the
    // fitted scale, which is a layout settling and must not scroll anything.
    if (!el || !wasMeasured || from === scale) return;
    const fresh = focalRef.current && performance.now() - focalRef.current.at < FOCAL_LIFETIME_MS ? focalRef.current : null;
    focalRef.current = null;
    const focal = fresh ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 };
    const next = anchorScroll(scrollRef.current, focal, from, scale);
    el.scrollLeft = next.left;
    el.scrollTop = next.top;
    scrollRef.current = { left: el.scrollLeft, top: el.scrollTop };
  }, [scale, frame.width, frame.height]);

  // Ctrl and wheel, which is also how trackpad pinches arrive, zooms about the
  // pointer. The listener must be non-passive for preventDefault to take
  // effect, which React's own onWheel prop does not allow.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const zoomChangeRef = useRef(onZoomChange);
  zoomChangeRef.current = onZoomChange;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      const notify = zoomChangeRef.current;
      if (!notify) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      focalRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, at: performance.now() };
      notify(clampZoom(scaleRef.current * Math.exp(-e.deltaY * WHEEL_SENSITIVITY)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const effectiveRef = useRef(onEffectiveScale);
  effectiveRef.current = onEffectiveScale;
  useEffect(() => {
    effectiveRef.current?.(scale);
  }, [scale]);

  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  const layout = useMemo<ViewportLayout>(
    () => ({ scale, frame, renderScale: (page: Box) => canvasScale(page, scale, dpr) }),
    [scale, frame, dpr],
  );

  return (
    <div
      ref={setRefs}
      data-zoom-frame=""
      className={className ? `zoom-frame ${className}` : "zoom-frame"}
      style={FRAME_STYLE}
      role="region"
      aria-label="Pages"
      tabIndex={0}
      onScroll={(e) => {
        scrollRef.current = { left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop };
      }}
    >
      <div data-zoom-stage="" className="zoom-stage" style={{ ...STAGE_STYLE, gap: `${gap}px`, width: `${largest.width * scale + GUTTER * 2}px` }}>
        {children(layout)}
      </div>
    </div>
  );
});
