// The essay preview's pages, drawn in the page's own flow so that the window scrolls through
// them while the side columns stay where they are. The Word sheet is scaled by the caller with
// the scale this module works out, and a PDF kept with the essay is drawn page by page with the
// reader's own PageView, which only renders the pages near the screen however long the file.
// Destination: app/src/components/EssayPreviewPages.tsx

import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { EXACT_SIZES_UP_TO, exactPageSizes, openPdfData, pageSizes, type PageSize } from "../lib/pdfOpen";
import type { HighlightRow } from "../lib/types";
import { largestPage } from "../lib/zoom";
import { clampEssayZoom } from "./EssayPreviewCorner";
import { PageView, type Needles } from "./reader/pages";

// The Word sheet is A4, 210mm by 297mm, which is 794 CSS pixels wide at 96 dots to the inch.
export const A4_WIDTH_PX = 794;
// A fitted page stops growing at this scale, because past it a very wide screen only makes the
// type larger without showing more of the essay, and the desk around the page takes the rest.
export const ESSAY_FIT_MAX = 1.25;
// Matches ZoomViewport's wheel sensitivity, so that a pinch feels the same as in the reader.
const WHEEL_SENSITIVITY = 0.002;
// Width changes smaller than this are ignored, so that sub-pixel rounding never re-fits the page.
const MEASURE_THRESHOLD = 0.5;

const NO_HIGHLIGHTS: HighlightRow[] = [];
const NO_QUERY: Needles = { list: [], separate: false };
const noViewport = (_index: number, _viewport: PageViewport | null) => undefined;

// The scale the preview draws at: the manual zoom when one is set, and otherwise the page
// fitted to the width the element leaves inside its padding, which is how the preview opens.
export function useEssayFitScale(element: HTMLElement | null, zoom: number | null): number {
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    if (!element) return undefined;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const style = getComputedStyle(element);
      const next = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setWidth((prev) => (Math.abs(prev - next) < MEASURE_THRESHOLD ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(() => {
      if (raf === 0) raf = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [element]);

  if (zoom !== null) return clampEssayZoom(zoom);
  if (width <= 0) return 1;
  return Math.min(width / A4_WIDTH_PX, ESSAY_FIT_MAX);
}

// Ctrl and the wheel, which is also how a trackpad pinch arrives, zooms the preview as it did
// inside the old frame. The listener is non-passive, because React's onWheel cannot prevent the
// browser's own zoom.
export function useCtrlWheelZoom(element: HTMLElement | null, scale: number, onZoom: (zoom: number) => void): void {
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const zoomRef = useRef(onZoom);
  zoomRef.current = onZoom;

  useEffect(() => {
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      zoomRef.current(scaleRef.current * Math.exp(-event.deltaY * WHEEL_SENSITIVITY));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [element]);
}

// A stored PDF drawn in the flow. The scale given is the Word sheet's scale, and the PDF is
// drawn at whatever scale makes its widest page as wide as the sheet would be, so that the
// percentage in the corner means the same for both. A PDF that cannot be opened gives way to
// the fallback, which is the Word sheet, so that the preview is never left empty.
export function EssayPdfPages({ bytes, scale, fallback }: { bytes: Uint8Array; scale: number; fallback: ReactNode }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDoc(null);
    setSizes([]);
    setFailed(false);
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        // The document is given a copy, so that the stored bytes are never detached by the worker.
        loaded = await openPdfData(new Blob([bytes.slice()], { type: "application/pdf" }));
        const opened = loaded;
        const all = await pageSizes(opened);
        if (cancelled) return;
        setSizes(all);
        setDoc(opened);
        if (opened.numPages > EXACT_SIZES_UP_TO) {
          void exactPageSizes(opened, all[0], () => cancelled)
            .then((exact) => {
              if (exact && !cancelled) setSizes(exact);
            })
            .catch(() => undefined);
        }
      } catch (err) {
        console.error("Drawing the essay's PDF failed", err);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [bytes]);

  if (failed) return <>{fallback}</>;
  if (!doc || sizes.length === 0) {
    return <p className="small muted essay-pdf-note">Opening the PDF, which may take a moment for a long file.</p>;
  }

  const pdfScale = (scale * A4_WIDTH_PX) / largestPage(sizes).width;
  return (
    <div className="essay-pdf-pages">
      {sizes.map((size, index) => (
        <PageView
          key={index}
          doc={doc}
          index={index}
          size={size}
          scale={pdfScale}
          theme="plain"
          crop={null}
          highlights={NO_HIGHLIGHTS}
          activeId={null}
          query={NO_QUERY}
          currentHit={null}
          onViewport={noViewport}
        />
      ))}
    </div>
  );
}
