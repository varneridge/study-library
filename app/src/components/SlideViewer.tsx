import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { fileBlob } from "../lib/files";
import type { ReadingView } from "../lib/library";
import { shortTitle } from "../lib/titles";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// One slide at a time. Turning a slide during a recording stores a mark.
export function SlideViewer({ decks }: { decks: ReadingView[] }) {
  const [deck, setDeck] = useState(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = decks[Math.min(deck, decks.length - 1)];

  useEffect(() => {
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    setDoc(null);
    setPage(0);
    void (async () => {
      try {
        const blob = view.file?.mime === "application/pdf" ? await fileBlob(view.file)
          : view.upload?.mime === "application/pdf" ? view.upload.blob : null;
        if (!blob) {
          setProblem("These slides are still being converted.");
          return;
        }
        loaded = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        if (!cancelled) {
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
    void (async () => {
      const pdfPage = await doc.getPage(page + 1);
      if (cancelled) return;
      const unit = pdfPage.getViewport({ scale: 1 });
      // Fit the width, but never taller than the screen allows, so a
      // portrait handout stays whole in view beside the notes.
      const tallest = Math.max(240, window.innerHeight - 190);
      const scale = Math.min(box.current!.clientWidth / unit.width, tallest / unit.height);
      const viewport = pdfPage.getViewport({ scale });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const target = canvas.current!;
      target.width = Math.floor(viewport.width * ratio);
      target.height = Math.floor(viewport.height * ratio);
      target.style.width = `${viewport.width}px`;
      target.style.height = `${viewport.height}px`;
      await pdfPage.render({
        canvasContext: target.getContext("2d")!,
        viewport,
        transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
      }).promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
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
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") setPage((p) => Math.min(p + 1, (doc?.numPages ?? 1) - 1));
      if (e.key === "ArrowLeft" || e.key === "PageUp") setPage((p) => Math.max(p - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doc]);

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

  return (
    <div className="slides">
      <div className="slides-head">
        {decks.length > 1 ? (
          <select value={deck} onChange={(e) => setDeck(Number(e.target.value))} aria-label="Slides">
            {decks.map((d, i) => <option key={d.item.id} value={i}>{shortTitle(d.item)}</option>)}
          </select>
        ) : (
          <span className="small muted">{shortTitle(view.item)}</span>
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
        {problem ? <p className="small muted">{problem}</p> : <canvas ref={canvas} />}
        {doc && doc.numPages > 1 && (
          <>
            <button className="slide-arrow prev" aria-label="Previous slide" disabled={page === 0} onClick={() => go(page - 1)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
            </button>
            <button className="slide-arrow next" aria-label="Next slide" disabled={page === doc.numPages - 1} onClick={() => go(page + 1)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
            </button>
            <span className="slide-count" aria-live="polite">{page + 1} / {doc.numPages}</span>
          </>
        )}
      </div>
    </div>
  );
}
