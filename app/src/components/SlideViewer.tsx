import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fileBlob } from "../lib/files";
import type { ReadingView } from "../lib/library";
import { shortTitle } from "../lib/titles";
import { Icon } from "./icons";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// Each deck's shape, once known, so coming back to a deck draws its frame at
// the right size straight away instead of at 16 by 9 and then again.
const deckRatios = new Map<string, number>();

// Pressing an arrow leaves focus where it was. Focusing it could make the
// browser scroll the sticky slides panel to show the button, which moved the
// slide under the pointer. The keyboard still reaches the arrows with Tab.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

function SlideLightbox({
  doc,
  page,
  title,
  onGo,
  onClose,
}: {
  doc: PDFDocumentProxy;
  page: number;
  title: string;
  onGo: (page: number) => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        onGo(Math.min(page + 1, doc.numPages - 1));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        onGo(Math.max(page - 1, 0));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc.numPages, page, onGo, onClose]);

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;
    let cancelled = false;

    void (async () => {
      try {
        const prior = renderTaskRef.current;
        if (prior) {
          try { prior.cancel(); } catch { /* ignore */ }
          await prior.promise.catch(() => {});
          if (cancelled) return;
        }

        const pdfPage = await doc.getPage(page + 1);
        if (cancelled) return;
        const unit = pdfPage.getViewport({ scale: 1 });
        const maxWidth = window.innerWidth * 0.92;
        const maxHeight = window.innerHeight * 0.85;
        const scale = Math.min(maxWidth / unit.width, maxHeight / unit.height);
        const viewport = pdfPage.getViewport({ scale });
        let ratio = Math.min(window.devicePixelRatio || 1, 2);
        const maxPixels = 16_000_000;
        const pixelArea = viewport.width * ratio * (viewport.height * ratio);
        if (pixelArea > maxPixels) {
          ratio *= Math.sqrt(maxPixels / pixelArea);
        }

        const target = canvasRef.current;
        if (!target) return;
        target.width = Math.floor(viewport.width * ratio);
        target.height = Math.floor(viewport.height * ratio);
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;

        const ctx = target.getContext("2d");
        if (!ctx) return;

        const renderTask = pdfPage.render({
          canvasContext: ctx,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        renderTaskRef.current = renderTask;
        await renderTask.promise;
      } catch (err: unknown) {
        if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "RenderingCancelledException") {
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch { /* ignore */ }
      }
    };
  }, [doc, page]);


  return (
    <div className="slide-lightbox" role="dialog" aria-modal="true" aria-label={`Enlarged slides: ${title}`}>
      <div className="slide-lightbox-backdrop" onClick={onClose} />
      <div className="slide-lightbox-header">
        <span className="slide-lightbox-title">{title}</span>
        <span className="slide-lightbox-count">{page + 1} / {doc.numPages}</span>
        <button type="button" className="button small slide-lightbox-close" onClick={onClose} aria-label="Minimise enlarged slides">
          Minimise
        </button>
      </div>
      <div ref={containerRef} className="slide-lightbox-content">
        <canvas ref={canvasRef} />
        {doc.numPages > 1 && (
          <>
            <button
              type="button"
              className="slide-arrow prev"
              aria-label="Previous slide"
              disabled={page === 0}
              onMouseDown={keepFocus}
              onClick={() => onGo(page - 1)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
            </button>
            <button
              type="button"
              className="slide-arrow next"
              aria-label="Next slide"
              disabled={page === doc.numPages - 1}
              onMouseDown={keepFocus}
              onClick={() => onGo(page + 1)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// One slide at a time. Turning a slide during a recording stores a mark.
//
// The deck's name, its menu, the choice of deck and Enlarge share one line
// above the slide. A page that lists readings with their own row (and menu)
// passes renderHeader, and is handed the deck being shown and the controls to
// place in that row, so the deck appears once rather than as a list entry
// above a second title. Without it the line shows the deck's short title.
export function SlideViewer({
  decks,
  heading,
  className,
  renderHeader,
}: {
  decks: ReadingView[];
  // A heading for screen readers and for the section's name, such as "Slides".
  heading?: string;
  className?: string;
  renderHeader?: (view: ReadingView, controls: React.ReactNode) => React.ReactNode;
}) {
  const [deck, setDeck] = useState(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(0);
  const [enlarged, setEnlarged] = useState(false);
  const [aspectRatio, setAspectRatio] = useState<number | null>(() => deckRatios.get(decks[0]?.item.id ?? "") ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const genRef = useRef(0);
  const enlargeButtonRef = useRef<HTMLButtonElement>(null);
  const view = decks[Math.min(deck, decks.length - 1)];

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setPage(0);
    // The frame keeps its size while the next deck opens: the shape this deck
    // had before, or else the one already showing, never a reset to 16 by 9.
    const known = deckRatios.get(view.item.id);
    if (known) setAspectRatio(known);
    void (async () => {
      try {
        const blob = view.file?.mime === "application/pdf" ? await fileBlob(view.file)
          : view.upload?.mime === "application/pdf" ? view.upload.blob : null;
        if (!blob) {
          setProblem("These slides are still being converted.");
          return;
        }
        loaded = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        // The deck's shape is read before anything shows, so the frame is
        // drawn once at its final size and the arrows never move beneath the
        // pointer as the first slide arrives.
        const first = await loaded.getPage(1).then((p) => p.getViewport({ scale: 1 })).catch(() => null);
        if (!cancelled) {
          if (first?.width && first.height) {
            deckRatios.set(view.item.id, first.width / first.height);
            setAspectRatio(first.width / first.height);
          }
          setDoc(loaded);
          setProblem(null);
        }
      } catch {
        if (!cancelled) setProblem("These slides could not be opened.");
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
  }, [view.item.id, view.file?.r2_key, view.file?.mime, view.upload?.id]);

  useEffect(() => {
    if (!doc || !canvas.current || !box.current) return;
    let cancelled = false;
    const currentGen = ++genRef.current;

    void (async () => {
      try {
        const prior = renderTaskRef.current;
        if (prior) {
          try { prior.cancel(); } catch { /* ignore */ }
          await prior.promise.catch(() => {});
          if (cancelled || currentGen !== genRef.current) return;
        }

        const pdfPage = await doc.getPage(page + 1);
        if (cancelled || currentGen !== genRef.current) return;

        const unit = pdfPage.getViewport({ scale: 1 });
        const boxWidth = box.current ? box.current.clientWidth : 0;
        if (!boxWidth) return;
        // Fit the width, but never taller than the screen allows, so a
        // portrait handout stays whole in view beside the notes.
        const tallest = Math.max(240, window.innerHeight - 190);
        const scale = Math.min(boxWidth / unit.width, tallest / unit.height);
        const viewport = pdfPage.getViewport({ scale });
        const ratio = Math.min(window.devicePixelRatio || 1, 2);

        const offscreen = document.createElement("canvas");
        offscreen.width = Math.floor(viewport.width * ratio);
        offscreen.height = Math.floor(viewport.height * ratio);
        const ctx = offscreen.getContext("2d");
        if (!ctx) return;

        const renderTask = pdfPage.render({
          canvasContext: ctx,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;
        if (cancelled || currentGen !== genRef.current) return;

        const target = canvas.current;
        if (!target) return;
        target.width = offscreen.width;
        target.height = offscreen.height;
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        const targetCtx = target.getContext("2d");
        if (targetCtx) {
          targetCtx.drawImage(offscreen, 0, 0);
        }
      } catch (err: unknown) {
        if (err && typeof err === "object" && "name" in err && (err as { name: string }).name === "RenderingCancelledException") {
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          // Ignore cancellation errors
        }
        renderTaskRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, width]);


  // The slide is drawn again when its column changes width.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.round(element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (enlarged) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") setPage((p) => Math.min(p + 1, (doc?.numPages ?? 1) - 1));
      if (e.key === "ArrowLeft" || e.key === "PageUp") setPage((p) => Math.max(p - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc, enlarged]);


  // The arrows sit on the slide itself, faint, and fade away while you are
  // not using them. A tap, a move of the pointer or a key brings them back.
  const [awake, setAwake] = useState(false);
  const sleep = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wake = () => {
    setAwake(true);
    clearTimeout(sleep.current);
    sleep.current = setTimeout(() => setAwake(false), 1800);
  };
  useEffect(() => () => clearTimeout(sleep.current), []);
  const go = (to: number) => {
    if (!doc) return;
    setPage(Math.max(0, Math.min(to, doc.numPages - 1)));
    wake();
  };
  // A swipe across the slide turns it, on a touch screen.
  const swipe = useRef<number | null>(null);

  const multi = decks.length > 1;
  const controls = (
    <span className="slides-controls">
      {multi && (
        <select
          className="slides-select"
          value={Math.min(deck, decks.length - 1)}
          onChange={(e) => setDeck(Number(e.target.value))}
          aria-label="Choose slides"
        >
          {decks.map((d, i) => <option key={d.item.id} value={i}>{shortTitle(d.item)}</option>)}
        </select>
      )}
      <button
        ref={enlargeButtonRef}
        type="button"
        className="icon-button small slide-enlarge-head"
        aria-label="Enlarge slides"
        title="Enlarge slides"
        disabled={!doc}
        onClick={() => setEnlarged(true)}
      >
        <Icon name="enlarge" size={16} />
      </button>
    </span>
  );

  return (
    <section className={`slides${className ? ` ${className}` : ""}`} aria-label={heading}>
      {heading && <h2 className="sr-only">{heading}</h2>}
      <div className={`slides-head${multi ? " multi" : ""}`}>
        {renderHeader ? renderHeader(view, controls) : (
          <>
            {!multi && <span className="slides-title">{shortTitle(view.item)}</span>}
            {controls}
          </>
        )}
      </div>
      <div
        ref={box}
        className={`slide-box${awake ? " awake" : ""}`}
        onPointerMove={wake}
        onPointerDown={(e) => { wake(); swipe.current = e.pointerType === "touch" ? e.clientX : null; }}
        onPointerUp={(e) => {
          if (swipe.current === null) return;
          const dx = e.clientX - swipe.current;
          swipe.current = null;
          if (Math.abs(dx) > 40) go(page + (dx < 0 ? 1 : -1));
        }}
        onFocus={wake}
      >
        {problem ? (
          <p className="small muted">{problem}</p>
        ) : (
          <div
            className="slide-stage"
            style={{ "--slide-ar": aspectRatio ? `${aspectRatio}` : "16 / 9" } as React.CSSProperties}
          >
            <div className="slide-frame">
              <canvas ref={canvas} role="img" aria-label={`Slide ${page + 1}${doc ? ` of ${doc.numPages}` : ""}`} />
            </div>
            {doc && doc.numPages > 1 && (
              <>
                <button
                  type="button"
                  className="slide-arrow prev"
                  aria-label="Previous slide"
                  disabled={page === 0}
                  onMouseDown={keepFocus}
                  onClick={() => go(page - 1)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
                </button>
                <button
                  type="button"
                  className="slide-arrow next"
                  aria-label="Next slide"
                  disabled={page === doc.numPages - 1}
                  onMouseDown={keepFocus}
                  onClick={() => go(page + 1)}
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
                </button>
                <span className="slide-count" aria-live="polite">{page + 1} / {doc.numPages}</span>
              </>
            )}
          </div>
        )}
      </div>
      {enlarged && doc && typeof document !== "undefined" && createPortal(
        <SlideLightbox
          doc={doc}
          page={page}
          title={shortTitle(view.item)}
          onGo={go}
          onClose={() => {
            setEnlarged(false);
            requestAnimationFrame(() => enlargeButtonRef.current?.focus());
          }}
        />,
        document.body,
      )}
    </section>
  );

}
