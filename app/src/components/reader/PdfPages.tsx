// Outside PDF viewer powered by @embedpdf/react-pdf-viewer (PDFium WebAssembly), providing
// built-in zoom, fit-width, fullscreen, search, thumbnails and text selection in one frame.

import { PDFViewer, ZoomMode, type PDFViewerConfig, type PluginRegistry } from "@embedpdf/react-pdf-viewer";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export interface PdfPagesProps {
  bytes?: Uint8Array | null;
  url?: string | null;
  initialPage?: number;
  className?: string;
  fallback?: ReactNode;
}

export function PdfPages({
  bytes,
  url,
  initialPage,
  className,
  fallback = null,
}: PdfPagesProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const initialPageRef = useRef(initialPage);
  initialPageRef.current = initialPage;

  const data = bytes && bytes.byteLength > 0 ? bytes : null;

  useEffect(() => {
    if (!data) {
      setBlobUrl(null);
      return undefined;
    }
    const created = URL.createObjectURL(new Blob([data.slice()], { type: "application/pdf" }));
    setBlobUrl(created);
    return () => {
      URL.revokeObjectURL(created);
    };
  }, [data]);

  const src = data ? blobUrl : url || null;

  const config = useMemo<PDFViewerConfig | null>(() => {
    if (!src) return null;
    return {
      src,
      tabBar: "never",
      disabledCategories: ["annotation", "form", "redaction"],
      zoom: {
        defaultZoomLevel: ZoomMode.FitWidth,
        minZoom: 0.5,
        maxZoom: 2.5,
      },
      theme: {
        preference: "system",
        light: {
          accent: {
            primary: "#185FA5",
            primaryHover: "#144E89",
            primaryActive: "#103F70",
            primaryLight: "#E6EFF8",
            primaryForeground: "#FFFFFF",
          },
        },
      },
    };
  }, [src]);

  const handleReady = (registry: PluginRegistry) => {
    const target = initialPageRef.current;
    if (target === undefined || target <= 0) return;
    const scrollPlugin = registry.getPlugin("scroll") as
      | { provides?: () => { scrollToPage?: (opts: { pageNumber: number }) => void } | null }
      | undefined;
    scrollPlugin?.provides?.()?.scrollToPage?.({ pageNumber: target + 1 });
  };

  if (!config) return <>{fallback}</>;

  return (
    <div className={className}>
      <PDFViewer
        key={src}
        config={config}
        style={{ width: "100%", height: "100%" }}
        onReady={handleReady}
      />
    </div>
  );
}
