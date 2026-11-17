// The essay preview's corner bar and its PDF pages. The bar floats wholly inside the top
// right of the preview frame, small and translucent, so that it reads as part of the page
// rather than as a toolbar, and its rarer actions live in the house ••• menu so that the
// bar itself stays short. PDF pages are drawn at their printed size inside the same fixed
// frame the Word sheet uses, so that zooming changes only the pages and never the frame.

import { useEffect, useRef, useState, type ReactNode } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { Menu } from "./Menu";
import { PageZoomViewport } from "./PageZoomViewport";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;

// PDF units are points (1/72 inch), so this factor makes 100% match true printed size on screen.
const PDF_TO_CSS_UNITS = 96 / 72;
// Pages are redrawn with more pixels only in steps of this much zoom, so that zooming in
// keeps text sharp without redrawing every page on every press.
const SHARPNESS_STEP = 0.5;

export const clampZoom = (zoom: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

type Glyph = "minus" | "plus" | "expand" | "collapse";

// The bar's glyphs are drawn rather than typed, so that a font's metrics can never clip
// them, and they use the same thin rounded stroke as the app's other drawn icons.
function CornerGlyph({ glyph }: { glyph: Glyph }) {
  return (
    <svg
      className="essay-corner-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyph === "minus" && <path d="M3.5 8h9" />}
      {glyph === "plus" && <path d="M3.5 8h9M8 3.5v9" />}
      {glyph === "expand" && <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />}
      {glyph === "collapse" && <path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" />}
    </svg>
  );
}

export interface EssayPreviewCornerProps {
  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFit: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onExportDocx: () => void;
  onExportPdf: () => void;
  onReplace: () => void;
  disabled?: boolean;
}

export function EssayPreviewCorner({
  zoom,
  onZoomChange,
  onFit,
  fullscreen,
  onToggleFullscreen,
  onExportDocx,
  onExportPdf,
  onReplace,
  disabled = false,
}: EssayPreviewCornerProps) {
  const percent = Math.round(zoom * 100);
  const fullscreenLabel = fullscreen ? "Leave full screen" : "Full screen";
  // An empty essay has nothing to export, so the menu offers only the way to bring one in.
  const menuItems = [
    ...(disabled
      ? []
      : [
          { label: "Export as Word (.docx)", onSelect: onExportDocx },
          { label: "Export as PDF", onSelect: onExportPdf },
        ]),
    { label: "Replace with another Word document", onSelect: onReplace },
  ];

  return (
    <div className="essay-preview-corner">
      <div className="essay-corner-bar" role="toolbar" aria-label="Preview controls">
        <button
          type="button"
          className="essay-corner-button"
          onClick={() => onZoomChange(clampZoom(zoom - ZOOM_STEP))}
          disabled={disabled || zoom <= ZOOM_MIN}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <CornerGlyph glyph="minus" />
        </button>
        <span className="essay-corner-zoom" aria-live="polite" title="Current zoom">
          {percent}%
        </span>
        <button
          type="button"
          className="essay-corner-button"
          onClick={() => onZoomChange(clampZoom(zoom + ZOOM_STEP))}
          disabled={disabled || zoom >= ZOOM_MAX}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <CornerGlyph glyph="plus" />
        </button>
        <button
          type="button"
          className="essay-corner-button"
          onClick={onFit}
          disabled={disabled}
          title="Fit the page to the width of the preview"
        >
          Fit
        </button>

        <span className="essay-corner-sep" aria-hidden="true" />

        <button
          type="button"
          className="essay-corner-button"
          onClick={onToggleFullscreen}
          aria-pressed={fullscreen}
          aria-label={fullscreenLabel}
          title={fullscreenLabel}
        >
          <CornerGlyph glyph={fullscreen ? "collapse" : "expand"} />
        </button>

        <span className="essay-corner-menu">
          <Menu label="Preview actions" items={menuItems} />
        </span>
      </div>
    </div>
  );
}

export interface EssayPdfPreviewProps {
  pdfBytes?: Uint8Array | null;
  pdfUrl?: string | null;
  // Given a zoom, the pages sit in the fixed preview frame and the frame zooms them, as the
  // essay preview needs. Without one they are drawn at the width of their container, which
  // is how the document viewer shows a source.
  zoom?: number;
  label?: string;
  children?: ReactNode;
  onError?: (error: unknown) => void;
}

export function EssayPdfPreview({ pdfBytes, pdfUrl, zoom, label = "Essay preview", children, onError }: EssayPdfPreviewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const pagesRef = useRef<HTMLDivElement>(null);
  const drawnRef = useRef<PDFDocumentProxy | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  // The pages keep one size and the frame does the zooming, so a change of zoom redraws
  // them only when they need more pixels to stay sharp, never to change their size.
  const sharpness = Math.max(1, Math.ceil(clampZoom(zoom ?? 1) / SHARPNESS_STEP) * SHARPNESS_STEP);

  // Loading is keyed on the source alone, so zooming never parses the file again.
  useEffect(() => {
    setDoc(null);
    setFailed(false);
    const hasBytes = !!pdfBytes && pdfBytes.length > 0;
    if (!hasBytes && !pdfUrl) return;

    // pdf.js transfers the buffer it receives, so a copy keeps the caller's bytes usable afterwards.
    const task = pdfjsLib.getDocument(hasBytes ? { data: pdfBytes.slice() } : { url: pdfUrl as string });
    let live = true;
    task.promise.then(
      (loaded) => {
        if (live) setDoc(loaded);
      },
      (error: unknown) => {
        if (!live) return;
        setFailed(true);
        onErrorRef.current?.(error);
      },
    );
    return () => {
      live = false;
      void task.destroy();
    };
  }, [pdfBytes, pdfUrl]);

  useEffect(() => {
    const host = pagesRef.current;
    if (!doc || !host) return;
    let live = true;
    const tasks: RenderTask[] = [];
    // Drawing at the device pixel ratio, raised for a zoomed page, keeps text sharp on
    // high density screens.
    const density = (window.devicePixelRatio || 1) * sharpness;
    // A new file starts from no pages, while a sharper redraw reuses the canvases it has,
    // so that the frame's content keeps its height and its scroll position does not jump.
    if (drawnRef.current !== doc) {
      host.replaceChildren();
      drawnRef.current = doc;
    }

    (async () => {
      for (let pageNumber = 1; pageNumber <= doc.numPages && live; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        if (!live) return;
        const viewport = page.getViewport({ scale: PDF_TO_CSS_UNITS });
        let canvas = host.children.item(pageNumber - 1) as HTMLCanvasElement | null;
        if (!canvas) {
          canvas = document.createElement("canvas");
          canvas.className = "essay-pdf-page";
          canvas.setAttribute("aria-label", `Page ${pageNumber} of ${doc.numPages}`);
          host.appendChild(canvas);
        }
        // Only the width is set on screen, so that a page wider than its column can shrink
        // to fit and its height follows from the canvas's own shape.
        canvas.width = Math.floor(viewport.width * density);
        canvas.height = Math.floor(viewport.height * density);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        const context = canvas.getContext("2d");
        if (!context) continue;
        const task = page.render({
          canvasContext: context,
          viewport,
          transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
        });
        tasks.push(task);
        await task.promise;
      }
    })().catch((error: unknown) => {
      // A cancelled render is the expected result of zooming mid-draw rather than a real failure.
      const cancelled = (error as { name?: string } | null)?.name === "RenderingCancelledException";
      if (!live || cancelled) return;
      setFailed(true);
      onErrorRef.current?.(error);
    });

    return () => {
      live = false;
      tasks.forEach((task) => task.cancel());
    };
  }, [doc, sharpness]);

  if (!doc || failed) return <>{children}</>;
  const pages = <div ref={pagesRef} className="essay-pdf-pages" />;
  if (zoom === undefined) return pages;
  return (
    <PageZoomViewport zoom={zoom} label={label}>
      {pages}
    </PageZoomViewport>
  );
}
