// A video's transcript as a document: its pages, as the reader draws a PDF,
// or set as text, exactly as a reading's text layout sets it, with the same
// paragraphs, headings and page numbers. Find marks what you look for in both.

import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTheme } from "../lib/appearance";
import { EXACT_SIZES_UP_TO, exactPageSizes, openPdf, openPdfData, pageSizes, type PageSize } from "../lib/pdfOpen";
import { reflow, type Reflowed } from "../lib/reflow";
import type { FileRow, HighlightRow } from "../lib/types";
import { PageView, type Needles, type Theme as PageTheme } from "./reader/pages";
import { TextView } from "./reader/TextView";
import { ZoomViewport } from "./reader/ZoomViewport";

export type TranscriptLayout = "pages" | "text";

const NO_HIGHLIGHTS: HighlightRow[] = [];
const noop = () => undefined;

export function TranscriptDocument({ file, blob, layout, query, name }: {
  file: FileRow | null;
  // A transcript still uploading, shown from this device's copy.
  blob: Blob | null;
  layout: TranscriptLayout;
  query: string;
  name: string;
}) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [reflowed, setReflowed] = useState<Reflowed | null>(null);
  // null fits the pages to the frame's width; Ctrl and the wheel, or a pinch, zooms.
  const [zoom, setZoom] = useState<number | null>(null);
  const appTheme = useTheme();
  const theme: PageTheme = appTheme === "light" ? "plain" : appTheme;
  const source = file ? `${file.id}:${file.r2_key}` : blob ? `local:${blob.size}` : "none";

  useEffect(() => {
    setDoc(null);
    setSizes([]);
    setReflowed(null);
    setProblem(null);
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        if (file) loaded = await openPdf(file);
        else if (blob) loaded = await openPdfData(blob);
        else return;
        const opened = loaded;
        const all = await pageSizes(opened);
        if (cancelled) return;
        setSizes(all);
        setDoc(opened);
        if (opened.numPages > EXACT_SIZES_UP_TO) {
          void exactPageSizes(opened, all[0], () => cancelled)
            .then((exact) => { if (exact && !cancelled) setSizes(exact); })
            .catch(noop);
        }
      } catch {
        if (!cancelled) {
          setProblem(navigator.onLine
            ? "The transcript could not be opened."
            : "The transcript is not saved on this device yet. Connect to the internet to open it.");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
    // Only reopen when the document itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // The text is worked out once, the first time it is wanted, as in the reader.
  useEffect(() => {
    if (layout !== "text" || !doc || reflowed) return;
    let cancelled = false;
    void reflow(doc).then((r) => { if (!cancelled) setReflowed(r); }).catch(noop);
    return () => { cancelled = true; };
  }, [layout, doc, reflowed]);

  // A new transcript opens fitted again.
  useEffect(() => setZoom(null), [source]);

  const needles: Needles = useMemo(() => ({ list: query.trim() ? [query.trim().toLowerCase()] : [], separate: false }), [query]);
  const onViewport = useCallback((_index: number, _viewport: PageViewport | null) => undefined, []);
  const asText = layout === "text" && Boolean(reflowed?.usable);

  // The frame keeps one size whatever is in it, and the pages scale inside it,
  // so nothing around the transcript moves as it opens, zooms or scrolls.
  return (
    <div className={`transcript-scroller${asText ? " as-text" : ""}`}>
      {problem && <p className="small muted transcript-note">{problem}</p>}
      {!problem && !doc && <p className="small muted transcript-note">Opening the transcript…</p>}
      {doc && layout === "text" && !reflowed && <p className="small muted transcript-note">Setting the transcript as text…</p>}
      {doc && layout === "text" && reflowed && !reflowed.usable && (
        <p className="small muted transcript-note">This transcript has no text layer to set out, so it shows as pages.</p>
      )}
      {asText && reflowed && (
        <div className="scroller transcript-text">
        <TextView
          reflowed={reflowed}
          kicker="Transcript"
          title={name}
          byline={null}
          standfirst={null}
          highlights={NO_HIGHLIGHTS}
          needles={needles.list}
          currentHit={null}
          start={null}
          onSpot={noop}
          onSelect={noop}
          onHighlight={noop}
        />
        </div>
      )}
      {doc && !asText && (layout === "pages" || reflowed) && (
        <ZoomViewport pageSizes={sizes} zoom={zoom} fit="width" gap={10} onZoomChange={setZoom} className="transcript-pages">
          {(view) => sizes.map((size, index) => (
            <PageView
              key={index}
              doc={doc}
              index={index}
              size={size}
              scale={view.scale}
              theme={theme}
              crop={null}
              highlights={NO_HIGHLIGHTS}
              activeId={null}
              query={needles}
              currentHit={null}
              onViewport={onViewport}
            />
          ))}
        </ZoomViewport>
      )}
    </div>
  );
}
