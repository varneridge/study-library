// PDF pages drawn by the reader's own page primitive inside the shared zoom viewport, for
// screens that show a PDF without the reader around it, such as the essay preview and the
// documents opened from an essay. Pages are drawn only while they are near the frame's view
// and give their memory back once they leave it, so a long source costs no more than a short one.

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EXACT_SIZES_UP_TO, exactPageSizes, pageSizes } from "../../lib/pdfOpen";
import type { HighlightRow } from "../../lib/types";
import type { Box, FitMode } from "../../lib/zoom";
import { PageView, type Needles, type Size } from "./pages";
import { ZoomViewport } from "./ZoomViewport";

// PDF sizes are in points, a 72nd of an inch, so this turns them into CSS pixels and makes
// 100 per cent the page's printed size, which is the scale the Word sheet uses as well.
export const PT_TO_PX = 96 / 72;

// These are module constants because PageView is memoised, so fresh empty values on every
// render would redraw every page each time the zoom changed.
const NO_HIGHLIGHTS: HighlightRow[] = [];
const NO_NEEDLES: Needles = { list: [], separate: false };
const ignoreViewport = (): void => undefined;

export interface PdfPagesProps {
  // The file to draw, from stored bytes or from a link; bytes win when both are given.
  bytes?: Uint8Array | null;
  url?: string | null;
  // null fits the pages to the frame, and a number is a manual scale where 1 is printed size.
  zoom: number | null;
  fit?: FitMode;
  // A zero-based page to open at, which is scrolled to once, after the first fitted layout.
  initialPage?: number;
  onZoomChange?(zoom: number | null): void;
  onEffectiveScale?(scale: number): void;
  onError?(error: unknown): void;
  className?: string;
  // Shown while the file opens and whenever it cannot be opened.
  fallback?: ReactNode;
}

export function PdfPages({
  bytes,
  url,
  zoom,
  fit = "width",
  initialPage,
  onZoomChange,
  onEffectiveScale,
  onError,
  className,
  fallback = null,
}: PdfPagesProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [failed, setFailed] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const data = bytes && bytes.byteLength > 0 ? bytes : null;
  const link = data ? null : url || null;

  // Loading is keyed on the source alone, so that zooming never parses the file again.
  useEffect(() => {
    setDoc(null);
    setSizes([]);
    setFailed(false);
    if (!data && !link) return undefined;
    let live = true;
    // pdf.js transfers the buffer it is given, so a copy keeps the caller's bytes usable.
    const task = pdfjs.getDocument(data ? { data: data.slice() } : { url: link as string });
    task.promise
      .then(async (loaded) => {
        const all = await pageSizes(loaded);
        if (!live) return;
        setSizes(all);
        setDoc(loaded);
        // A long file shows at once with every page the size of its first, as the reader
        // does, and pages of any other size are put right in the background.
        if (loaded.numPages > EXACT_SIZES_UP_TO && all.length > 0) {
          void exactPageSizes(loaded, all[0], () => !live)
            .then((exact) => {
              if (exact && live) setSizes(exact);
            })
            .catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (!live) return;
        setFailed(true);
        onErrorRef.current?.(error);
      });
    return () => {
      live = false;
      void task.destroy();
    };
  }, [data, link]);

  const boxes = useMemo<Box[]>(
    () => sizes.map((size) => ({ width: size.width * PT_TO_PX, height: size.height * PT_TO_PX })),
    [sizes],
  );

  // The scroll waits for an animation frame because the viewport settles on its fitted scale
  // in a render of its own straight after mounting, and a scroll made before that would land
  // on the page's provisional position instead.
  const pageCount = sizes.length;
  useEffect(() => {
    if (!doc || pageCount === 0 || initialPage === undefined || initialPage <= 0) return undefined;
    const target = Math.min(initialPage, pageCount - 1);
    const frameId = requestAnimationFrame(() => {
      const frame = frameRef.current;
      const slot = frame?.querySelector<HTMLElement>(`[data-page="${target}"]`)?.parentElement;
      // The frame is the slot's offset parent, so setting its own scroll never moves the
      // sheet or the page around it, as scrollIntoView would.
      if (frame && slot) frame.scrollTop = Math.max(0, slot.offsetTop - 8);
    });
    return () => cancelAnimationFrame(frameId);
  }, [doc, pageCount, initialPage]);

  if (failed || !doc || pageCount === 0) return <>{fallback}</>;

  return (
    <ZoomViewport
      ref={frameRef}
      className={className}
      pageSizes={boxes}
      zoom={zoom}
      fit={fit}
      onZoomChange={onZoomChange}
      onEffectiveScale={onEffectiveScale}
    >
      {(layout) =>
        sizes.map((size, index) => (
          <PageView
            key={index}
            doc={doc}
            index={index}
            size={size}
            scale={layout.scale * PT_TO_PX}
            theme="plain"
            crop={null}
            highlights={NO_HIGHLIGHTS}
            activeId={null}
            query={NO_NEEDLES}
            currentHit={null}
            onViewport={ignoreViewport}
          />
        ))
      }
    </ZoomViewport>
  );
}
