import { useLayoutEffect, useRef, type ReactNode } from "react";
import { centredScroll, clampZoom, type Scroll } from "../lib/zoom";
import "./PageZoomViewport.css";

/**
 * The essay preview's box. It keeps one full page's size at every zoom and
 * only the pages inside it are scaled (CSS zoom, so text stays crisp and
 * reflows nothing), so zooming out shows more of the essay in the same box and
 * zooming in shows less, while the point at the centre of the box stays put.
 */
export function PageZoomViewport({ zoom, label, children }: { zoom: number; label: string; children: ReactNode }) {
  const scale = clampZoom(zoom);
  const frameRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shownRef = useRef(scale);
  // The scroll position is remembered as it happens rather than read after the
  // new scale has been laid out, because by then a shrinking page has already
  // had its scroll clamped and the centre would be lost.
  const scrollRef = useRef<Scroll>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const from = shownRef.current;
    shownRef.current = scale;
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content || from === scale) return;
    const rect = content.getBoundingClientRect();
    const next = centredScroll(
      scrollRef.current,
      { width: frame.clientWidth, height: frame.clientHeight },
      { width: rect.width / scale, height: rect.height / scale },
      from,
      scale,
    );
    scrollRef.current = next;
    frame.scrollTo(next.left, next.top);
  }, [scale]);

  return (
    <div
      ref={frameRef}
      className="page-zoom-viewport"
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(event) => {
        scrollRef.current = { left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
      }}
    >
      <div ref={contentRef} className="page-zoom-content" style={{ zoom: scale }}>
        {children}
      </div>
    </div>
  );
}

export default PageZoomViewport;
