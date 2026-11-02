// Controls and panels for the reader: the highlight popover, page jump,
// end-of-reading card, highlight colour picker, Appearance menu, and sheets.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { deleteRows, withUndo } from "../../lib/edits";
import { navigate } from "../../lib/router";
import { COLOURS, colourLabel, type ColourNames } from "../../lib/settings";
import { update } from "../../lib/sync";
import { counts } from "../../lib/progress";
import { shortTitle } from "../../lib/titles";
import type { HighlightRow, ItemRow } from "../../lib/types";
import { sheetHost, useCloseOnBack, useNarrow } from "../../lib/ui";
import { Icon, IconButton } from "../icons";
import type { Theme } from "./pages";

export interface Active { id: string; x: number; y: number }
export interface Heading { title: string; page: number; level: number }

// The theme here is the app's theme: choosing one in the reader colours
// every screen, as choosing it in Settings does.
export const THEMES: { value: Theme; label: string; app: "light" | "sepia" | "dark" }[] = [
  { value: "plain", label: "Light", app: "light" },
  { value: "sepia", label: "Sepia", app: "sepia" },
  { value: "dark", label: "Dark", app: "dark" },
];

// The PDF's own contents list, with each entry resolved to a page.
export async function outline(doc: PDFDocumentProxy): Promise<Heading[]> {
  const items = await doc.getOutline().catch(() => null);
  if (!items) return [];
  const out: Heading[] = [];
  const walk = async (list: typeof items, level: number) => {
    for (const item of list) {
      try {
        const dest = typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
        const ref = dest?.[0];
        const page = ref && typeof ref === "object" ? await doc.getPageIndex(ref) : typeof ref === "number" ? ref : null;
        if (page !== null) out.push({ title: item.title, page, level });
      } catch {
        // An entry pointing nowhere is skipped.
      }
      if (item.items?.length && level < 2) await walk(item.items, level + 1);
    }
  };
  await walk(items, 0);
  return out;
}

// Closes a toolbar menu on outside click, Escape or the back gesture.
function useMenuClose(open: boolean, setOpen: (on: boolean) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  useCloseOnBack(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !sheet.current?.contains(target)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open, setOpen]);
  return { ref, sheet };
}

// Clicking a highlight: its colour, and a way to write about it in the notes.
export function Popover({ highlight, at, names, onClose, onWrite }: {
  highlight: HighlightRow; at: Active; names: ColourNames; onClose: () => void; onWrite: () => void;
}) {
  const narrow = useNarrow();
  const panelRef = useRef<HTMLDivElement>(null);
  const prevActiveRef = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);

  useCloseOnBack(true, onClose);

  useEffect(() => {
    if (narrow) {
      const firstInteractive = panelRef.current?.querySelector<HTMLElement>("button, [tabindex='0']");
      firstInteractive?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (narrow) prevActiveRef.current?.focus();
    };
  }, [narrow, onClose]);

  const left = Math.max(8, Math.min(at.x - 140, window.innerWidth - 330));
  const top = Math.min(at.y + 12, window.innerHeight - 240);

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Highlight"
      className={narrow ? "menu-panel highlight-sheet" : "floating panel"}
      style={narrow ? undefined : { left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="row" style={{ gap: "0.35rem" }}>
        {COLOURS.map((c) => (
          <button
            key={c.value}
            className="swatch"
            title={colourLabel(c.value, names)}
            aria-label={colourLabel(c.value, names)}
            aria-pressed={highlight.colour.toLowerCase() === c.value}
            style={{ background: c.value }}
            onClick={() => update("highlights", highlight.id, { colour: c.value })}
          />
        ))}
        <span className="small muted">{colourLabel(highlight.colour, names)}</span>
      </div>
      <button className="button primary write-note" onClick={onWrite}>Write a note about this</button>
      <div className="row">
        <button className="button" onClick={onClose}>Done</button>
        <span style={{ flex: 1 }} />
        <button className="quiet" onClick={() => { void withUndo("Highlight deleted.", deleteRows([{ table: "highlights", row: highlight }])); onClose(); }}>Delete</button>
      </div>
      {narrow && <button className="menu-cancel plain" onClick={onClose}>Cancel</button>}
    </div>
  );

  if (narrow) {
    const host = sheetHost();
    return host ? createPortal(
      <>
        <div className="menu-backdrop" aria-hidden="true" onClick={onClose} />
        {panel}
      </>,
      host,
    ) : panel;
  }

  return panel;
}

// Always an input, as in Zotero: type a page and press Enter.
export function PageJump({ current, total, onGo }: { current: number; total: number; onGo: (page: number) => void }) {
  const [value, setValue] = useState(String(current + 1));
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setValue(String(current + 1)); }, [current, editing]);
  const go = () => {
    setEditing(false);
    const n = Number(value);
    if (Number.isFinite(n) && n >= 1) onGo(Math.min(total, Math.round(n)) - 1);
    else setValue(String(current + 1));
  };
  return (
    <span className="pages-at">
      <input
        type="text" inputMode="numeric" pattern="[0-9]*" enterKeyHint="go" value={value} aria-label="Go to page" title="Go to page"
        onFocus={(e) => { setEditing(true); e.currentTarget.select(); }}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={go}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") { setEditing(false); e.currentTarget.blur(); } }}
        style={{ width: `${Math.max(2, String(total).length) + 1.2}ch` }}
      />
      <span className="of">/ {total}</span>
    </span>
  );
}

export function EndOfReading({ item, next, back, backLabel }: { item: ItemRow; next: ItemRow | null; back: () => void; backLabel: string }) {
  const read = item.read_status === "read";
  const canCount = counts(item);
  return (
    <div className="end-card">
      <p className="small muted">End of the reading.</p>
      {next ? (
        <div className="row">
          <button
            className="button primary"
            onClick={async () => {
              if (canCount && !read) await update("items", item.id, { read_status: "read" });
              navigate({ view: "reader", id: next.id });
            }}
          >
            {canCount && !read ? "Mark as read and go to the next" : "Next"}
          </button>
          <span className="small">{shortTitle(next)}</span>
        </div>
      ) : (
        <div className="row">
          {canCount && !read && <button className="button primary" onClick={() => update("items", item.id, { read_status: "read" })}>Mark as read</button>}
          <button className={canCount && !read ? "quiet" : "button primary"} onClick={back}>{backLabel}</button>
        </div>
      )}
    </div>
  );
}

// The highlight colour in use, with a menu of the others.
export function ColourPicker({ value, names, onChoose }: { value: string; names: ColourNames; onChoose: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const { ref } = useMenuClose(open, setOpen);
  return (
    <div className="menu" ref={ref}>
      <button className="icon-button colour-button" aria-label={`Highlight colour: ${colourLabel(value, names)}`} title="Highlight colour" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="swatch-mini" style={{ "--hl": value } as React.CSSProperties} /><Icon name="caret" size={14} />
      </button>
      {open && (
        <div className="menu-panel" role="menu">
          {COLOURS.map((c) => (
            <button key={c.value} role="menuitemradio" aria-checked={c.value === value} onClick={() => { onChoose(c.value); setOpen(false); }}>
              <span className="swatch-mini" style={{ "--hl": c.value } as React.CSSProperties} /> {colourLabel(c.value, names)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Page colour, zoom and margins, behind one button, as Zotero's Aa.
export function Appearance({ theme, setTheme, zoom, scale, changeZoom, trim, canTrim, setTrim, layout, setLayout, textSize, setTextSize }: {
  layout: "pages" | "text"; setLayout: (l: "pages" | "text") => void; textSize: number; setTextSize: (n: number) => void;
  theme: Theme; setTheme: (t: Theme) => void; zoom: number | null; scale: number; changeZoom: (z: number | null) => void;
  trim: boolean; canTrim: boolean; setTrim: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const { ref, sheet } = useMenuClose(open, setOpen);
  const host = sheetHost();
  const panel = (
    <div ref={sheet} className="menu-panel appearance" role="dialog" aria-label="Appearance">
      <p className="panel-label">Theme</p>
      <div className="segmented" role="group" aria-label="Theme">
        {THEMES.map((t) => (
          <button key={t.value} className={`tool theme-chip ${t.value}`} aria-pressed={theme === t.value} onClick={() => setTheme(t.value)}>{t.label}</button>
        ))}
      </div>
      <p className="panel-label">Layout</p>
      <div className="segmented" role="group" aria-label="Layout">
        <button className="tool" aria-pressed={layout === "text"} onClick={() => setLayout("text")}>Text</button>
        <button className="tool" aria-pressed={layout === "pages"} onClick={() => setLayout("pages")}>Pages</button>
      </div>
      <p className="panel-label">Size</p>
      {layout === "text" ? (
        <div className="row" style={{ gap: "0.35rem" }}>
          <button className="tool" aria-label="Smaller text" onClick={() => setTextSize(Math.max(0.8, Math.round((textSize - 0.1) * 10) / 10))}>A−</button>
          <span className="zoom-at">{Math.round(textSize * 100)}%</span>
          <button className="tool" aria-label="Larger text" onClick={() => setTextSize(Math.min(1.6, Math.round((textSize + 0.1) * 10) / 10))}>A+</button>
        </div>
      ) : (
        <div className="row" style={{ gap: "0.35rem" }}>
          <button className="tool" aria-label="Smaller" onClick={() => changeZoom(scale / 1.15)}>−</button>
          <span className="zoom-at">{Math.round(scale * 100)}%</span>
          <button className="tool" aria-label="Larger" onClick={() => changeZoom(scale * 1.15)}>+</button>
          <button className="tool" aria-pressed={zoom === null} onClick={() => changeZoom(null)}>Fit to width</button>
        </div>
      )}
      {canTrim && layout === "pages" && (
        <label className="choices panel-check">
          <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
          Trim white margins when fitted
        </label>
      )}
    </div>
  );

  return (
    <div className="menu" ref={ref}>
      <IconButton icon="appearance" label="Appearance" pressed={open} onClick={() => setOpen(!open)} />
      {open && host && createPortal(<div className="menu-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />, host)}
      {open && (host ? createPortal(panel, host) : panel)}
    </div>
  );
}

// A reading's details or its move, opened from the reader in a dialog, which
// a phone shows as a sheet from the foot of the screen.
export function ReaderSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDialogElement>(null);
  useEffect(() => { box.current?.showModal(); }, []);
  return (
    <dialog ref={box} className="dialog reader-sheet" aria-label={title} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
