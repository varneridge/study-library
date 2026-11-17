import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.5;
export const ZOOM_STEP = 0.1;

// PDF units are points (1/72 inch), so this factor makes 100% match true printed size on screen.
const PDF_TO_CSS_UNITS = 96 / 72;

export const clampZoom = (zoom: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLSpanElement>(null);

  // The menu closes on an outside click or Escape so it never lingers over the document.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const pick = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  const fullscreenLabel = fullscreen ? 'Exit full screen' : 'Full screen';

  return (
    <div className="essay-preview-corner">
      <div className="essay-corner-bar" role="toolbar" aria-label="Preview controls">
        <button
          type="button"
          onClick={() => onZoomChange(clampZoom(zoom - ZOOM_STEP))}
          disabled={disabled || zoom <= ZOOM_MIN}
          aria-label="Zoom out"
          title="Zoom out"
        >
          -
        </button>
        <span aria-live="polite" title="Current zoom">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          onClick={() => onZoomChange(clampZoom(zoom + ZOOM_STEP))}
          disabled={disabled || zoom >= ZOOM_MAX}
          aria-label="Zoom in"
          title="Zoom in"
        >
          +
        </button>
        <button type="button" onClick={onFit} disabled={disabled} title="Fit to width">
          Fit
        </button>

        <span className="essay-corner-sep" aria-hidden="true" />

        <button
          type="button"
          onClick={onToggleFullscreen}
          aria-pressed={fullscreen}
          aria-label={fullscreenLabel}
          title={fullscreenLabel}
        >
          {fullscreen ? '⤡' : '⤢'}
        </button>

        <span className="essay-corner-sep" aria-hidden="true" />

        <span className="essay-corner-menu-wrap" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="More options"
            title="More options"
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="essay-corner-menu" role="menu">
              <button type="button" role="menuitem" onClick={pick(onExportDocx)} disabled={disabled}>
                Export as Word (.docx)
              </button>
              <button type="button" role="menuitem" onClick={pick(onExportPdf)} disabled={disabled}>
                Export as PDF
              </button>
              <button type="button" role="menuitem" onClick={pick(onReplace)}>
                Replace
              </button>
            </div>
          )}
        </span>
      </div>
    </div>
  );
}

export interface EssayPdfPreviewProps {
  pdfBytes?: Uint8Array | null;
  pdfUrl?: string | null;
  zoom?: number;
  children?: ReactNode;
  onError?: (error: unknown) => void;
}

export function EssayPdfPreview({ pdfBytes, pdfUrl, zoom = 1, children, onError }: EssayPdfPreviewProps) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const pagesRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // Loading is keyed on the source alone, so zooming re-renders pages without re-parsing the file.
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
    // Drawing at the device pixel ratio keeps text sharp on high density screens.
    const dpr = window.devicePixelRatio || 1;
    host.replaceChildren();

    (async () => {
      for (let pageNumber = 1; pageNumber <= doc.numPages && live; pageNumber += 1) {
        const page = await doc.getPage(pageNumber);
        if (!live) return;
        const viewport = page.getViewport({ scale: zoom * PDF_TO_CSS_UNITS });
        const canvas = document.createElement('canvas');
        canvas.className = 'essay-pdf-page';
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.setAttribute('aria-label', `Page ${pageNumber} of ${doc.numPages}`);
        const context = canvas.getContext('2d');
        if (!context) continue;
        host.appendChild(canvas);
        const task = page.render({
          canvasContext: context,
          viewport,
          transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
        });
        tasks.push(task);
        await task.promise;
      }
    })().catch((error: unknown) => {
      // A cancelled render is the expected result of zooming mid-draw rather than a real failure.
      const cancelled = (error as { name?: string } | null)?.name === 'RenderingCancelledException';
      if (!live || cancelled) return;
      setFailed(true);
      onErrorRef.current?.(error);
    });

    return () => {
      live = false;
      tasks.forEach((task) => task.cancel());
    };
  }, [doc, zoom]);

  if (!doc || failed) return <>{children}</>;
  return <div ref={pagesRef} className="essay-pdf-pages" />;
}
