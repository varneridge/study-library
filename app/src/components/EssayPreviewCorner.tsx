// The essay preview's corner bar. The bar floats wholly inside the top right of the preview
// frame, small and translucent, so that it reads as part of the page rather than as a
// toolbar, and its rarer actions live in the house ••• menu so that the bar itself stays
// short. The pages themselves are drawn by the reader's PdfPages and ZoomViewport.

import { clampZoom, stepZoom } from "../lib/zoom";
import { Menu } from "./Menu";

// The essay keeps a narrower range than the reader, because a page drawn much above twice
// its printed size passes the largest canvas an iPhone will draw and comes out blank.
export const ESSAY_ZOOM_MIN = 0.5;
export const ESSAY_ZOOM_MAX = 2;

// Every zoom passes through the shared limits first and then the essay's own range, as the
// reader's zoom does with its range.
export const clampEssayZoom = (zoom: number): number =>
  Math.min(ESSAY_ZOOM_MAX, Math.max(ESSAY_ZOOM_MIN, clampZoom(zoom)));

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
  // null means the page is fitted to the width of the frame.
  zoom: number | null;
  // The scale actually in use, which the viewport reports, so that the bar can show a
  // percentage while the page is fitted.
  scale: number;
  onZoomChange: (zoom: number | null) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onExportDocx: () => void;
  onExportPdf: () => void;
  onReplace: () => void;
  disabled?: boolean;
}

export function EssayPreviewCorner({
  zoom,
  scale,
  onZoomChange,
  fullscreen,
  onToggleFullscreen,
  onExportDocx,
  onExportPdf,
  onReplace,
  disabled = false,
}: EssayPreviewCornerProps) {
  const percent = Math.round(scale * 100);
  const smaller = clampEssayZoom(stepZoom(scale, -1));
  const larger = clampEssayZoom(stepZoom(scale, 1));
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
          onClick={() => onZoomChange(smaller)}
          disabled={disabled || smaller >= scale}
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
          onClick={() => onZoomChange(larger)}
          disabled={disabled || larger <= scale}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <CornerGlyph glyph="plus" />
        </button>
        <button
          type="button"
          className="essay-corner-button"
          onClick={() => onZoomChange(null)}
          disabled={disabled}
          aria-pressed={zoom === null}
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
