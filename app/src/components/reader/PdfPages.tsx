// Outside PDF viewer using Mozilla PDF.js's official PDFViewer component, giving virtualised
// page rendering, crisp HiDPI canvases, text selection, annotation links and fit-to-width inside
// a single scrollable frame.

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { stepZoom } from "../../lib/zoom";

// Ensure the worker is configured even if the reader route has not been opened yet.
if (!pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}

export interface PdfPagesProps {
  bytes?: Uint8Array | null;
  url?: string | null;
  zoom: number | null;
  fit?: "width" | "page";
  initialPage?: number;
  onZoomChange?(zoom: number | null): void;
  onEffectiveScale?(scale: number): void;
  onError?(error: unknown): void;
  className?: string;
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
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const pdfViewerRef = useRef<PDFViewer | null>(null);
  const linkServiceRef = useRef<PDFLinkService | null>(null);
  const zoomRef = useRef(zoom);
  const fitRef = useRef(fit);
  const initialPageRef = useRef(initialPage);
  const onZoomChangeRef = useRef(onZoomChange);
  const onEffectiveScaleRef = useRef(onEffectiveScale);
  const onErrorRef = useRef(onError);

  zoomRef.current = zoom;
  fitRef.current = fit;
  initialPageRef.current = initialPage;
  onZoomChangeRef.current = onZoomChange;
  onEffectiveScaleRef.current = onEffectiveScale;
  onErrorRef.current = onError;

  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const data = bytes && bytes.byteLength > 0 ? bytes : null;
  const link = data ? null : url || null;

  // Initialise the PDF.js PDFViewer once on mount and tear down on unmount.
  useEffect(() => {
    const container = containerRef.current;
    const viewerEl = viewerRef.current;
    if (!container || !viewerEl) return undefined;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const pdfViewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      removePageBorders: true,
    });
    linkService.setViewer(pdfViewer);
    pdfViewerRef.current = pdfViewer;
    linkServiceRef.current = linkService;

    const applyScale = () => {
      if (!pdfViewer.pagesCount) return;
      const z = zoomRef.current;
      pdfViewer.currentScaleValue = z === null ? (fitRef.current === "page" ? "page-fit" : "page-width") : String(z);
    };

    eventBus.on("pagesinit", () => {
      applyScale();
      const target = initialPageRef.current;
      if (target !== undefined && target > 0 && pdfViewer.pagesCount > 0) {
        pdfViewer.currentPageNumber = Math.min(target + 1, pdfViewer.pagesCount);
      }
      onEffectiveScaleRef.current?.(pdfViewer.currentScale);
    });

    eventBus.on("scalechanging", (evt: { scale: number }) => {
      onEffectiveScaleRef.current?.(evt.scale);
    });

    const resizeObserver = new ResizeObserver(() => {
      if (zoomRef.current === null && pdfViewer.pagesCount > 0) {
        applyScale();
      }
    });
    resizeObserver.observe(container);

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (!onZoomChangeRef.current) return;
      event.preventDefault();
      onZoomChangeRef.current(stepZoom(pdfViewer.currentScale, event.deltaY < 0 ? 1 : -1));
    };
    container.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", onWheel);
      resizeObserver.disconnect();
      pdfViewer.cleanup();
      pdfViewerRef.current = null;
      linkServiceRef.current = null;
    };
  }, []);

  // Load the PDF document whenever bytes or url changes.
  useEffect(() => {
    setReady(false);
    setFailed(false);
    const pdfViewer = pdfViewerRef.current;
    if (!data && !link) {
      pdfViewer?.setDocument(null as unknown as PDFDocumentProxy);
      linkServiceRef.current?.setDocument(null as unknown as PDFDocumentProxy);
      return undefined;
    }

    let live = true;
    const task = pdfjs.getDocument(data ? { data: data.slice() } : { url: link as string });
    task.promise
      .then((loaded) => {
        if (!live) return;
        pdfViewerRef.current?.setDocument(loaded);
        linkServiceRef.current?.setDocument(loaded);
        setReady(true);
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

  // Keep zoom and fit mode in sync when controlled by the parent corner bar.
  useEffect(() => {
    const pdfViewer = pdfViewerRef.current;
    if (!pdfViewer || !pdfViewer.pagesCount) return;
    pdfViewer.currentScaleValue = zoom === null ? (fit === "page" ? "page-fit" : "page-width") : String(zoom);
  }, [zoom, fit, ready]);

  if (failed || (!data && !link)) return <>{fallback}</>;

  return (
    <div className={className ? `essay-pdfjs-frame ${className}` : "essay-pdfjs-frame"}>
      <div ref={containerRef} className="essay-pdfjs-container" tabIndex={0} aria-label="PDF preview">
        <div ref={viewerRef} className="pdfViewer" />
      </div>
      {!ready && <div className="essay-pdfjs-loading">{fallback}</div>}
    </div>
  );
}
