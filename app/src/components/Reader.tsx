import { sessionLabel } from "../lib/modules";
import { deleteReading, download, Editor, MovePicker, replaceFile } from "./ReadingRow";
import { READING_ACCEPT } from "../lib/photos";
import type { ReadingView } from "../lib/library";
import { useLiveQuery } from "dexie-react-hooks";
import * as pdfjs from "pdfjs-dist";
import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "../App";
import { fileBlob } from "../lib/files";
import { loadReader } from "../lib/library";
import { navigate } from "../lib/router";
import { bumpFile, commit, insert, newId, update } from "../lib/sync";
import { fullTitle, shortTitle } from "../lib/titles";
import { COLOURS, colourLabel, useColourNames, type ColourNames } from "../lib/settings";
import { deleteRows, withUndo } from "../lib/edits";
import { dismissToast, typing, useNarrow, useTitle } from "../lib/ui";
import type { HighlightRow, ItemRow, QuestionRow } from "../lib/types";
import { Menu } from "./Menu";
import { Icon, IconButton } from "./icons";
import { Sidebar, type Tab } from "./reader/Sidebar";
import { TextView, type TextSelection } from "./reader/TextView";
import { reflow, type Reflowed } from "../lib/reflow";
import { useLiveQuery as useLive } from "dexie-react-hooks";
import { placesOf } from "../lib/library";
import { openShortcuts, sheetHost, useCloseOnBack } from "../lib/ui";
import { createPortal } from "react-dom";
import { fingerDown, SETTLE_NOW, settleDelay, touchScreen, whenLifted, widenSelection } from "../lib/selection";
import { reconcile } from "../lib/readingNotes";
import { sendNow } from "../lib/sync";
import { db } from "../lib/db";
import type { NoteEditorHandle } from "./NoteEditor";
import type { Spot } from "../lib/types";
import { chooseAppearance, useTheme } from "../lib/appearance";
import { findInDocument, type Needles, mergeRects, PageView, screenRect, textColumn, toPdfRect, type Crop, type Size, type Theme } from "./reader/pages";

const NoteEditor = lazy(() => import("./NoteEditor"));

const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
// Pages fitted to the window stop growing at this width, so lines stay a
// comfortable length on a large screen.
const MAX_FIT_PX = 900;
// The theme here is the app's theme: choosing one in the reader colours
// every screen, as choosing it in Settings does.
const THEMES: { value: Theme; label: string; app: "light" | "sepia" | "dark" }[] = [
  { value: "plain", label: "Light", app: "light" },
  { value: "sepia", label: "Sepia", app: "sepia" },
  { value: "dark", label: "Dark", app: "dark" },
];

interface Selected { page: number; rects: number[][]; text: string; x: number; y: number }
interface Active { id: string; x: number; y: number }
interface Heading { title: string; page: number; level: number }

const NO_NEEDLES: Needles = { list: [], separate: false };
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

// The PDF's own contents list, with each entry resolved to a page.
async function outline(doc: PDFDocumentProxy): Promise<Heading[]> {
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

// Clicking a highlight: its colour, the question it is filed under, and a
// way to write about it. Writing happens in the notes, beneath its quotation.
function Popover({ highlight, at, questions, names, onClose, onWrite }: {
  highlight: HighlightRow; at: Active; questions: QuestionRow[]; names: ColourNames; onClose: () => void; onWrite: () => void;
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
function PageJump({ current, total, onGo }: { current: number; total: number; onGo: (page: number) => void }) {
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

function EndOfReading({ item, next, back, backLabel }: { item: ItemRow; next: ItemRow | null; back: () => void ; backLabel: string }) {
  const read = item.read_status === "read";
  return (
    <div className="end-card">
      <p className="small muted">End of the reading.</p>
      {next ? (
        <div className="row">
          <button
            className="button primary"
            onClick={async () => {
              if (!read) await update("items", item.id, { read_status: "read" });
              navigate({ view: "reader", id: next.id });
            }}
          >
            {read ? "Next" : "Mark as read and go to the next"}
          </button>
          <span className="small">{shortTitle(next)}</span>
        </div>
      ) : (
        <div className="row">
          {!read && <button className="button primary" onClick={() => update("items", item.id, { read_status: "read" })}>Mark as read</button>}
          <button className="quiet" onClick={back}>{backLabel}</button>
        </div>
      )}
    </div>
  );
}

// The highlight colour in use, with a menu of the others.
function ColourPicker({ value, names, onChoose }: { value: string; names: ColourNames; onChoose: (value: string) => void }) {
  const [open, setOpen] = useState(false);
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
  }, [open]);
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
function Appearance({ theme, setTheme, zoom, scale, changeZoom, trim, canTrim, setTrim, layout, setLayout, textSize, setTextSize, footnotes, setFootnotes }: {
  layout: "pages" | "text"; setLayout: (l: "pages" | "text") => void; textSize: number; setTextSize: (n: number) => void;
  footnotes: boolean; setFootnotes: (on: boolean) => void;
  theme: Theme; setTheme: (t: Theme) => void; zoom: number | null; scale: number; changeZoom: (z: number | null) => void;
  trim: boolean; canTrim: boolean; setTrim: (on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // The sheet may be drawn into the body on a phone, so a tap in it counts as inside.
  const sheet = useRef<HTMLDivElement>(null);

  useCloseOnBack(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;

    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !sheet.current?.contains(target)) {
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <IconButton icon="appearance" label="Appearance" pressed={open} onClick={() => setOpen(!open)} />
      {open && sheetHost() && createPortal(<div className="menu-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />, sheetHost()!)}
      {open && portalTo(sheetHost(),
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
          {layout === "text" && (
            <label className="choices panel-check">
              <input type="checkbox" checked={footnotes} onChange={(e) => setFootnotes(e.target.checked)} />
              Show footnotes
            </label>
          )}
          {canTrim && layout === "pages" && (
            <label className="choices panel-check">
              <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
              Trim white margins when fitted
            </label>
          )}
        </div>,
      )}
    </div>
  );
}

// Draws a panel into host when there is one (a phone), or in place otherwise.
function portalTo(host: HTMLElement | null, node: React.ReactNode): React.ReactNode {
  return host ? createPortal(node, host) : node;
}

export function Reader({ id, page, q }: { id: string; page?: number; q?: string }) {
  const data = useLiveQuery(() => loadReader(id), [id]);
  const [sheet, setSheet] = useState<"edit" | "move" | null>(null);
  const replacer = useRef<HTMLInputElement>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  useTitle(data ? fullTitle(data.item) : undefined);
  const names = useColourNames();
  const place = useLive(async () => (await placesOf([id])).get(id) ?? null, [id], null);
  const narrow = useNarrow();
  const appTheme = useTheme();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [column, setColumn] = useState<Crop | null>(null);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const theme: Theme = appTheme === "light" ? "plain" : appTheme;
  const [left, setLeft] = useState(() => !window.matchMedia?.("(max-width: 34rem)").matches && localStorage.getItem("reader-sidebar") !== "closed");
  const [tab, setTab] = useState<Tab>("notes");
  const noteHandle = useRef<NoteEditorHandle>(null);
  const [tool, setTool] = useState<"select" | "highlight">("select");
  // Pages, as printed, or the text set to fit the screen. Phones start with text.
  const [layout, setLayoutState] = useState<"pages" | "text">(() => {
    const saved = localStorage.getItem("reader-layout");
    if (saved === "pages" || saved === "text") return saved;
    return window.matchMedia?.("(max-width: 34rem)").matches ? "text" : "pages";
  });
  const [textSize, setTextSize] = useState(() => Number(localStorage.getItem("reader-text-size")) || 1);
  const [footnotes, setFootnotes] = useState(() => localStorage.getItem("reader-footnotes") === "on");
  const [progress, setProgress] = useState(0);
  const [reflowed, setReflowed] = useState<Reflowed | null>(null);
  const [reflowing, setReflowing] = useState(false);
  // Exactly where you are, kept as you read and saved when you stop.
  const spotRef = useRef<Spot | null>(null);
  const [spotTick, setSpotTick] = useState(0);
  const pendingSpot = useRef<Spot | null>(null);
  const layoutRef = useRef(layout);
  const pendingPage = useRef<number | null>(null);
  const textRef = useRef(false);
  layoutRef.current = layout;
  const [toolColour, setToolColour] = useState(() => localStorage.getItem("highlight-colour") || COLOURS[0].value);
  const [trim, setTrim] = useState(() => {
    const saved = localStorage.getItem("reader-trim");
    return saved ? saved === "on" : Boolean(window.matchMedia?.("(max-width: 34rem)").matches);
  });
  const [current, setCurrent] = useState(0);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [active, setActive] = useState<Active | null>(null);
  const [finding, setFinding] = useState(Boolean(q));
  const [query, setQuery] = useState(q ?? "");
  const [hits, setHits] = useState<{ page: number; n: number }[]>([]);
  const [needles, setNeedles] = useState<Needles>({ list: [], separate: false });
  const [hit, setHit] = useState(-1);
  const [barHidden, setBarHidden] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const viewports = useRef(new Map<number, PageViewport>());
  const texts = useRef(new Map<number, string>());
  const restored = useRef(false);
  const lastTop = useRef(0);
  const crop = trim && zoom === null ? column : null;
  const scale = zoom ?? fit;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  const fileKey = data?.file ? `${data.file.id}:${data.file.r2_key}:${data.file.mime}` : data?.upload?.id ?? (data ? "none" : null);

  // Opening a reading puts it at the top of Recently opened.
  const stamped = useRef(false);
  useEffect(() => {
    if (!data || stamped.current) return;
    stamped.current = true;
    void update("items", id, { last_opened_at: new Date().toISOString() });
  }, [data, id]);

  // Open the document from the local cache, or download it once.
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        let blob: Blob;
        if (data.file?.mime === "application/pdf") blob = await fileBlob(data.file);
        else if (data.upload?.mime === "application/pdf") blob = data.upload.blob;
        else {
          setProblem(data.file ? "This file is still being converted to PDF." : "This file has not finished uploading.");
          return;
        }
        loaded = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
        const all = await Promise.all(
          Array.from({ length: loaded.numPages }, async (_, i) => {
            const viewport = (await loaded!.getPage(i + 1)).getViewport({ scale: 1 });
            return { width: viewport.width, height: viewport.height };
          }),
        );
        if (cancelled) return;
        restored.current = false;
        viewports.current.clear();
        texts.current.clear();
        setSizes(all);
        setDoc(loaded);
        setProblem(null);
        void textColumn(loaded).then((c) => { if (!cancelled) setColumn(c); }).catch(() => undefined);
        void outline(loaded).then((h) => { if (!cancelled) setHeadings(h); });
        if (data.file && data.file.text_status !== "ready") void bumpFile(data.file.id);
      } catch {
        if (!cancelled) {
          setProblem(navigator.onLine
            ? "This file could not be opened."
            : "This file is not saved on this device yet. Connect to the internet to open it.");
        }
      }
    })();
    return () => {
      cancelled = true;
      if (loaded) void loaded.destroy();
    };
    // Only reopen when the file itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileKey]);

  // The text is worked out once, the first time text view is wanted.
  useEffect(() => {
    if (layout !== "text" || !doc || reflowed || reflowing) return;
    setReflowing(true);
    void reflow(doc).then((r) => { setReflowed(r); setReflowing(false); }).catch(() => setReflowing(false));
  }, [layout, doc, reflowed, reflowing]);
  const textReady = layout === "text" && reflowed?.usable;
  textRef.current = Boolean(textReady);

  // Fit to width, and refit when the window changes size.
  useEffect(() => {
    const element = scroller.current;
    if (!element || sizes.length === 0) return;
    const widest = crop ? crop.width : Math.max(...sizes.map((s) => s.width));
    const measure = () => setFit(clamp(Math.min((element.clientWidth - 24) / widest, MAX_FIT_PX / widest)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sizes, left, crop]);

  const pageElement = (index: number) => pages.current?.children[index] as HTMLElement | undefined;

  // The top of the reading area: below the toolbar on a phone.
  const topInset = () => {
    const el = scroller.current;
    return el ? parseFloat(getComputedStyle(el).scrollPaddingTop) || 0 : 0;
  };
  const goToSpotPages = useCallback((spot: Spot) => {
    const element = pageElement(spot.page);
    if (!element || !scroller.current) return false;
    scroller.current.scrollTop = element.offsetTop + spot.frac * element.offsetHeight - topInset() - 8;
    lastTop.current = scroller.current.scrollTop;
    setCurrent(spot.page);
    return true;
  }, []);

  const goToPage = useCallback((index: number) => {
    if (layoutRef.current === "text") {
      const marker = scroller.current?.querySelector<HTMLElement>(`.text-view .pg[data-pg="${index}"]`);
      if (marker) { marker.scrollIntoView({ block: "start" }); setCurrent(index); return; }
    }
    const element = pageElement(index);
    if (element && scroller.current) {
      scroller.current.scrollTop = element.offsetTop - 8;
      lastTop.current = scroller.current.scrollTop;
    }
    setCurrent(index);
  }, []);

  // Switching to pages opens them at the page that was in view as text.
  useEffect(() => {
    if (layout !== "pages" || pendingPage.current === null || !sizes.length) return;
    const target = pendingPage.current;
    const spot = pendingSpot.current;
    pendingPage.current = null;
    pendingSpot.current = null;
    requestAnimationFrame(() => { if (!spot || !goToSpotPages(spot)) goToPage(target); });
  }, [layout, sizes.length, goToPage]);

  // Open at the requested page, or where you last stopped.
  useLayoutEffect(() => {
    if (!doc || restored.current || !data || sizes.length === 0) return;
    const saved = data.item.last_spot;
    if (page === undefined && saved && saved.page < sizes.length) {
      goToSpotPages(saved);
      spotRef.current = saved;
    } else goToPage(Math.min(page ?? data.item.last_page ?? 0, sizes.length - 1));
    requestAnimationFrame(() => {
      if (scroller.current) lastTop.current = scroller.current.scrollTop;
      restored.current = true;
    });
  }, [doc, sizes, data, page, fit, goToPage, goToSpotPages]);

  // Keep exactly the same place when the pages change size: zooming,
  // fitting to a new width, trimming margins or turning a phone.
  useLayoutEffect(() => {
    if (!restored.current || layoutRef.current !== "pages" || !spotRef.current) return;
    goToSpotPages(spotRef.current);
  }, [scale, crop, goToSpotPages]);

  const changeZoom = useCallback((next: number | null) => {
    setZoom(next === null ? null : clamp(next));
  }, []);

  // Track the current page and save it as the reading position. On a phone
  // the toolbar slides away while you read down the page.
  const onScroll = useCallback(() => {
    const element = scroller.current;
    const container = pages.current;
    if (element) {
      const room = element.scrollHeight - element.clientHeight;
      setProgress(room > 0 ? Math.min(1, Math.max(0, element.scrollTop / room)) : 0);
      const delta = element.scrollTop - lastTop.current;
      if (!restored.current) {
        lastTop.current = element.scrollTop;
      } else if (Math.abs(delta) > 12) {
        setBarHidden(delta > 0 && element.scrollTop > 80);
        lastTop.current = element.scrollTop;
      }
    }
    if (!element || !container) return;
    const line = element.scrollTop + element.clientHeight / 3;
    let low = 0;
    let high = container.children.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((container.children[mid] as HTMLElement).offsetTop <= line) low = mid;
      else high = mid - 1;
    }
    setCurrent(Math.min(low, sizes.length - 1));
    if (!restored.current) return;
    // The spot is the point at the top of the reading area.
    const top = element.scrollTop + topInset() + 8;
    let at = 0;
    while (at < container.children.length - 1 && (container.children[at + 1] as HTMLElement).offsetTop <= top) at += 1;
    const pageEl = container.children[at] as HTMLElement | undefined;
    if (pageEl) {
      spotRef.current = { page: at, frac: Math.round(Math.min(1, Math.max(0, (top - pageEl.offsetTop) / pageEl.offsetHeight)) * 1000) / 1000 };
      setSpotTick((n) => n + 1);
    }
  }, [sizes.length]);

  // The words at the top of the screen go with a place saved in page
  // layout, so text layout can open on exactly the same line. They are read
  // when saving, after the page's text has settled from any zoom.
  const quoteAtTop = (): string | null => {
    const element = scroller.current;
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const edge = box.top + topInset();
    for (let y = edge + 10; y < edge + 90; y += 5) {
      for (const x of [box.left + box.width * 0.35, box.left + box.width * 0.5]) {
        const span = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest(".textLayer span");
        const text = span?.textContent?.trim();
        if (text && text.length > 6) return text.slice(0, 48);
      }
    }
    return null;
  };

  const saveSpot = useCallback((urgent?: boolean) => {
    const current = spotRef.current;
    if (!current || !restored.current) return;
    const spot = layoutRef.current === "pages" ? { ...current, quote: quoteAtTop() } : current;
    spotRef.current = spot;
    if (urgent === true) {
      const item = dataRef.current?.item;
      if (item) sendNow("items", { ...item, last_page: spot.page, last_spot: spot }, ["last_page", "last_spot"]);
      void update("items", id, { last_page: spot.page, last_spot: spot });
      return;
    }
    const was = dataRef.current?.item.last_spot;
    if (was && was.page === spot.page && Math.abs(was.frac - spot.frac) < 0.002 && (was.at ?? null) === (spot.at ?? null) && (was.quote ?? null) === (spot.quote ?? null)) return;
    void update("items", id, { last_page: spot.page, last_spot: spot });
  }, [id]);
  useEffect(() => {
    if (!spotTick) return;
    const timer = setTimeout(() => saveSpot(), 1000);
    return () => clearTimeout(timer);
  }, [spotTick, saveSpot]);
  // A phone may close a tab in the background without warning, so the place
  // is saved the moment you switch away, and when the reading closes.
  useEffect(() => {
    const away = () => { if (document.visibilityState === "hidden") saveSpot(true); };
    const hide = () => saveSpot(true);
    document.addEventListener("visibilitychange", away);
    window.addEventListener("pagehide", hide);
    return () => {
      document.removeEventListener("visibilitychange", away);
      window.removeEventListener("pagehide", hide);
      saveSpot();
    };
  }, [saveSpot]);

  // Find in the reading.
  useEffect(() => {
    if (!doc || !finding) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const { hits: found, needles: used } = await findInDocument(doc, texts.current, query);
      if (cancelled) return;
      setHits(found);
      setNeedles(used);
      // Start at the first match on or after the page in view.
      const start = page !== undefined && q === query ? page : current;
      const index = found.findIndex((h) => h.page >= start);
      setHit(found.length ? (index < 0 ? 0 : index) : -1);
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
    // Only search again when the words or the document change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, query, finding]);

  const step = useCallback((direction: 1 | -1) => {
    if (!hits.length) return;
    setHit((h) => (h + direction + hits.length) % hits.length);
  }, [hits.length]);

  // Bring the current match's page into view, so it renders and can scroll
  // itself to the match.
  useEffect(() => {
    const target = hits[hit];
    if (!target) return;
    const element = pageElement(target.page);
    const box = scroller.current;
    if (element && box && (element.offsetTop > box.scrollTop + box.clientHeight || element.offsetTop + element.offsetHeight < box.scrollTop)) {
      box.scrollTop = element.offsetTop - 8;
    }
  }, [hit, hits]);

  const openFind = useCallback(() => {
    setFinding(true);
    setBarHidden(false);
    requestAnimationFrame(() => findBox.current?.select());
  }, []);
  const closeFind = useCallback(() => {
    setFinding(false);
    setHits([]);
    setNeedles({ list: [], separate: false });
    setHit(-1);
  }, []);

  // Text selection becomes a highlight toolbar.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      // A selection is not finished while a finger is still on the screen.
      if (fingerDown()) return;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        setSelected(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const start = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
      const pageEl = start?.closest("[data-page]") as HTMLElement | null;
      if (layoutRef.current === "text" && textRef.current) return;
      if (!pageEl || !pages.current?.contains(pageEl)) return setSelected(null);
      const index = Number(pageEl.dataset.page);
      const viewport = viewports.current.get(index);
      if (!viewport) return;
      const box = pageEl.getBoundingClientRect();
      const client = Array.from(range.getClientRects()).filter(
        (r) => r.width > 1 && r.height > 1 && r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right,
      );
      if (client.length === 0) return setSelected(null);
      const last = client[client.length - 1];
      setSelected({
        page: index,
        rects: mergeRects(client.map((r) => toPdfRect(r, box, viewport))),
        text: selection.toString().replace(/\s+/g, " ").trim(),
        x: last.right,
        y: last.bottom,
      });
    };
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(check, settleDelay());
    };
    const off = whenLifted(() => { clearTimeout(timer); timer = setTimeout(check, 150); });
    const now = () => { clearTimeout(timer); check(); };
    document.addEventListener(SETTLE_NOW, now);
    const onUp = () => document.querySelectorAll(".textLayer.selecting").forEach((el) => el.classList.remove("selecting"));
    document.addEventListener("selectionchange", onChange);
    document.addEventListener("pointerup", onUp);
    return () => {
      clearTimeout(timer);
      off();
      document.removeEventListener(SETTLE_NOW, now);
      document.removeEventListener("selectionchange", onChange);
      document.removeEventListener("pointerup", onUp);
    };
  }, []);

  // Pinch to zoom on touch screens, and ctrl or cmd with the wheel elsewhere.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let start: { distance: number; scale: number } | null = null;
    let ratio = 1;
    const distance = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        start = { distance: distance(e.touches), scale: scaleRef.current };
        ratio = 1;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      ratio = distance(e.touches) / start.distance;
      if (pages.current) pages.current.style.transform = `scale(${ratio})`;
    };
    const onEnd = () => {
      if (!start) return;
      if (pages.current) pages.current.style.transform = "";
      changeZoom(start.scale * ratio);
      start = null;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      changeZoom(scaleRef.current * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd);
    element.addEventListener("touchcancel", onEnd);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", onEnd);
      element.removeEventListener("wheel", onWheel);
    };
  }, [changeZoom, doc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey)) {
        // The browser's own find only sees the pages drawn so far.
        e.preventDefault();
        openFind();
        return;
      }
      if (typing(e)) return;
      if (e.key === "/") { e.preventDefault(); openFind(); }
      else if (e.key === "+" || e.key === "=") changeZoom(scaleRef.current * 1.15);
      else if (e.key === "-") changeZoom(scaleRef.current / 1.15);
      else if (e.key === "0") changeZoom(null);
      else if (e.key === "ArrowLeft" && !e.altKey) { e.preventDefault(); goToPage(Math.max(0, current - 1)); }
      else if (e.key === "ArrowRight" && !e.altKey) { e.preventDefault(); goToPage(Math.min(sizes.length - 1, current + 1)); }
      else if (e.key === "h" || e.key === "H") setTool((t) => (t === "highlight" ? "select" : "highlight"));
      // Escape undoes the nearest thing first: the highlight tool, then Find.
      else if (e.key === "Escape") { setActive(null); if (tool === "highlight") setTool("select"); else if (finding) closeFind(); }
    };
    // Listened for first, so a menu elsewhere on the page that swallows
    // Escape cannot keep the highlight tool on.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [changeZoom, openFind, closeFind, finding, goToPage, current, sizes.length, tool]);

  const onTextSpot = useCallback((spot: Spot) => {
    setCurrent(spot.page);
    spotRef.current = spot;
    setSpotTick((n) => n + 1);
  }, []);
  const onTextSelect = useCallback((sel: TextSelection | null) => {
    if (!sel) { if (layoutRef.current === "text") setSelected(null); return; }
    setSelected({ page: sel.page, rects: sel.rects, text: sel.text, x: sel.x, y: sel.y });
  }, []);
  const onViewport = useCallback((index: number, viewport: PageViewport | null) => {
    if (viewport) viewports.current.set(index, viewport);
    else viewports.current.delete(index);
  }, []);

  const setTheme = (next: Theme) => {
    void chooseAppearance(THEMES.find((t) => t.value === next)!.app);
  };

  // On a touch screen the highlight bar covers the foot of the screen, so a
  // selection low down scrolls up just enough to stay in view above it.
  useEffect(() => {
    if (!selected || !touchScreen()) return;
    const frame = requestAnimationFrame(() => {
      const sel = document.getSelection();
      const bar = document.querySelector(".touch-bar");
      if (!sel || !sel.rangeCount || !bar) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      // Its height, not its top: the bar may still be sliding into place.
      const limit = window.innerHeight - (bar as HTMLElement).offsetHeight - 16;
      if (rect.bottom <= limit) return;
      let box: HTMLElement | null = (sel.anchorNode?.parentElement ?? null);
      while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      (box ?? document.scrollingElement as HTMLElement | null)?.scrollBy({ top: rect.bottom - limit, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  // Widens the selection to its sentence or paragraph, within the text it is in.
  function widen(kind: "sentence" | "paragraph") {
    const node = document.getSelection()?.anchorNode;
    const el = node ? (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement) : null;
    const scope = el?.closest(".text-view, .textLayer");
    if (scope) widenSelection(kind, scope);
  }

  async function createHighlight(colour: string) {
    if (!selected) return;
    const highlightId = newId();
    await insert("highlights", {
      id: highlightId, item_id: id, page: selected.page, rects: selected.rects, body: selected.text,
      colour, comment: null, question_id: null, zotero_key: null,
    });
    document.getSelection()?.removeAllRanges();
    setSelected(null);
    setActive({ id: highlightId, x: selected.x, y: selected.y });
  }

  // With the highlight tool on, a selection becomes a highlight straight away.
  useEffect(() => {
    if (tool !== "highlight" || !selected) return;
    const s = selected;
    void (async () => {
      await insert("highlights", {
        id: newId(), item_id: id, page: s.page, rects: s.rects, body: s.text,
        colour: toolColour, comment: null, question_id: null, zotero_key: null,
      });
      document.getSelection()?.removeAllRanges();
      setSelected(null);
    })();
  }, [tool, selected, toolColour, id]);

  function onPageClick(event: React.MouseEvent) {
    if (!document.getSelection()?.isCollapsed) return;
    const pageEl = (event.target as Element).closest("[data-page]") as HTMLElement | null;
    if (!pageEl || !data) return setActive(null);
    const index = Number(pageEl.dataset.page);
    const viewport = viewports.current.get(index);
    if (!viewport) return;
    const box = pageEl.getBoundingClientRect();
    const [x, y] = viewport.convertToPdfPoint(event.clientX - box.left, event.clientY - box.top);
    const found = data.highlights.find(
      (h) => h.page === index && h.rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]),
    );
    setActive(found ? { id: found.id, x: event.clientX, y: event.clientY } : null);
  }

  function goTo(highlight: HighlightRow) {
    if (textReady) {
      const mark = scroller.current?.querySelector<HTMLElement>(`.text-view mark[data-id="${highlight.id}"]`);
      if (narrow) setLeft(false);
      if (mark) {
        mark.scrollIntoView({ block: "center" });
        requestAnimationFrame(() => {
          const r = mark.getBoundingClientRect();
          setActive({ id: highlight.id, x: r.left + r.width / 2, y: r.bottom });
        });
      } else goToPage(highlight.page);
      return;
    }
    const element = pageElement(highlight.page);
    const viewport = viewports.current.get(highlight.page);
    if (element && scroller.current) {
      const offset = viewport && highlight.rects[0] ? screenRect(highlight.rects[0], viewport).top : 0;
      scroller.current.scrollTop = element.offsetTop + offset - scroller.current.clientHeight / 3;
    }
    if (narrow) setLeft(false);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const mark = document.querySelector(`.hl[data-id="${highlight.id}"]`);
        const rect = mark?.getBoundingClientRect();
        setActive({ id: highlight.id, x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2, y: rect ? rect.bottom : 120 });
      }),
    );
  }


  // The notes hold every highlight as a quotation. Whenever a highlight is
  // made, recoloured, moved or removed, the notes follow.
  const shape = (data?.highlights ?? []).map((h) => `${h.id}:${h.colour}:${h.page}:${h.body}:${h.comment ?? ""}`).join("|");
  useEffect(() => {
    const timer = setTimeout(() => void reconcile(id), 300);
    return () => clearTimeout(timer);
  }, [shape, id]);

  // Opens the notes at the line beneath a quotation, ready to write.
  const writeAbout = useCallback((highlightId: string) => {
    setLeft(true);
    setTab("notes");
    setActive(null);
    let tries = 0;
    const attempt = () => {
      if (noteHandle.current?.writeUnder(highlightId)) return;
      if ((tries += 1) < 20) setTimeout(attempt, 150);
    };
    setTimeout(attempt, 100);
  }, []);

  const byPage = useMemo(() => {
    const map = new Map<number, HighlightRow[]>();
    for (const h of data?.highlights ?? []) map.set(h.page, [...(map.get(h.page) ?? []), h]);
    return map;
  }, [data?.highlights]);

  const onQuoteRemoved = useCallback((hid: string) => {
    const h = (data?.highlights ?? []).find((x) => x.id === hid);
    if (h) void withUndo("Highlight removed from the page too.", deleteRows([{ table: "highlights", row: h }]));
  }, [data?.highlights]);

  const onQuoteRestored = useCallback(async (hid: string) => {
    const h = (await db.highlights.get(hid)) as HighlightRow | undefined;
    if (h?.deleted) {
      await commit([{ table: "highlights", row: { ...h, deleted: false } }]);
      dismissToast();
    }
  }, []);

  if (data === undefined) return null;
  if (data === null) return <div className="page"><p className="muted">This reading no longer exists.</p></div>;

  const { item, week, highlights, questions, previous, next, link, session, file, upload } = data;
  // The reading as a row would show it, for the actions it shares with one.
  const asView: ReadingView = { link, item, file, upload, cached: true };
  const activeHighlight = active ? highlights.find((h) => h.id === active.id) : undefined;
  const read = item.read_status === "read";
  // Back to where the reading lives: its session for slides, else its week.
  const back = () => navigate(session ? { view: "session", id: session.id } : week ? { view: "week", id: week.id } : { view: "home" });
  // A named session by its name; otherwise "the lecture", "the seminar".
  const backLabel = session ? (session.title ? `Back to ${session.title}` : `Back to the ${sessionLabel(session.kind).toLowerCase()}`) : week ? "Back to the week" : "Back";
  const currentHit = hits[hit];
  const toggleLeft = () => {
    setLeft(!left);
    localStorage.setItem("reader-sidebar", left ? "closed" : "open");
  };
  const openTab = (which: Tab) => { setTab(which); setLeft(true); };
  const chooseColour = (value: string) => { setToolColour(value); localStorage.setItem("highlight-colour", value); setTool("highlight"); };
  const chooseLayout = (next: "pages" | "text") => {
    // Keep the place: where you are now is where the other layout opens.
    pendingPage.current = current;
    pendingSpot.current = spotRef.current;
    setLayoutState(next);
    localStorage.setItem("reader-layout", next);
    setSelected(null);
  };
  const chooseTextSize = (n: number) => { setTextSize(n); localStorage.setItem("reader-text-size", String(n)); };
  const chooseTrim = (on: boolean) => { setTrim(on); localStorage.setItem("reader-trim", on ? "on" : "off"); };

  return (
    <div style={{ "--tool": toolColour } as React.CSSProperties} className={`reader ${theme}${narrow ? " narrow" : ""}${barHidden && narrow && !finding ? " bar-hidden" : ""}${tool === "highlight" ? " tool-highlight" : ""}`}>
      <div className="reader-bar" role="toolbar" aria-label="Reader">
        <div className="group">
          <IconButton icon="back" label={backLabel} onClick={back} />
          <IconButton icon="sidebar" label="Sidebar" pressed={left} onClick={toggleLeft} />
          {layout === "pages" ? (
            !narrow ? <h1 className="title" title={fullTitle(item)}>{shortTitle(item)}</h1> : <h1 className="sr-only">{fullTitle(item)}</h1>
          ) : (
            !narrow && <span className="title" title={fullTitle(item)}>{shortTitle(item)}</span>
          )}
        </div>
        {!narrow && (
          <div className="group">
            <IconButton icon="zoomOut" label="Zoom out" shortcut="−" onClick={() => changeZoom(scale / 1.15)} />
            <IconButton icon="zoomIn" label="Zoom in" shortcut="+" onClick={() => changeZoom(scale * 1.15)} />
            <IconButton icon="fitWidth" label="Fit to width" shortcut="0" pressed={zoom === null} onClick={() => changeZoom(null)} />
            <span className="sep" />
            <IconButton icon="up" label="Previous page" shortcut="←" disabled={current === 0} onClick={() => goToPage(Math.max(0, current - 1))} />
            <IconButton icon="down" label="Next page" shortcut="→" disabled={current >= sizes.length - 1} onClick={() => goToPage(Math.min(sizes.length - 1, current + 1))} />
          </div>
        )}
        {sizes.length > 0 && <PageJump current={current} total={sizes.length} onGo={goToPage} />}
        {!narrow && (
          <div className="group tools">
            <IconButton icon="highlight" label="Highlight text" shortcut="H" pressed={tool === "highlight"} onClick={() => setTool(tool === "highlight" ? "select" : "highlight")} />
            <ColourPicker value={toolColour} names={names} onChoose={chooseColour} />
          </div>
        )}
        <div className="group end">
          <Appearance theme={theme} setTheme={setTheme} zoom={zoom} scale={scale} changeZoom={changeZoom} trim={trim} canTrim={Boolean(column)} setTrim={chooseTrim}
            layout={layout} setLayout={chooseLayout} textSize={textSize} setTextSize={chooseTextSize}
            footnotes={footnotes} setFootnotes={(on) => { setFootnotes(on); localStorage.setItem("reader-footnotes", on ? "on" : "off"); }} />
          {narrow && (
            <IconButton icon={layout === "text" ? "pages" : "outline"} label={layout === "text" ? "Show the pages" : "Show as text"}
              onClick={() => chooseLayout(layout === "text" ? "pages" : "text")} />
          )}
          <IconButton icon="search" label="Find" shortcut="Ctrl+F" pressed={finding} onClick={() => (finding ? closeFind() : openFind())} />
          <IconButton icon="check" label={read ? "Read. Mark as unread" : "Mark as read"} pressed={read} className="read-toggle"
            onClick={() => update("items", id, { read_status: read ? "unread" : "read" })} />
          {!narrow && (
            <IconButton icon="notes" label="Notes on this reading" pressed={left && tab === "notes"}
              onClick={() => { if (left && tab === "notes") toggleLeft(); else { setLeft(true); setTab("notes"); } }} />
          )}
          <Menu
            label="More reading actions"
            items={[
              { label: "Notes on this reading", onSelect: () => { setLeft(true); setTab("notes"); }, hidden: !narrow },
              { label: tool === "highlight" ? "Stop highlighting" : "Highlight as I select", onSelect: () => setTool(tool === "highlight" ? "select" : "highlight"), hidden: !narrow },
              { label: `Previous: ${previous ? shortTitle(previous) : ""}`, onSelect: () => previous && navigate({ view: "reader", id: previous.id }), hidden: !previous },
              { label: `Next: ${next ? shortTitle(next) : ""}`, onSelect: () => next && navigate({ view: "reader", id: next.id }), hidden: !next },
              // What a reading's row offers on the week page, here as well.
              { label: "Edit details", onSelect: () => setSheet("edit") },
              { label: "Move to another week or module", onSelect: () => setSheet("move") },
              { label: "Download file", onSelect: () => void download(asView), hidden: !file },
              { label: "Replace file", onSelect: () => replacer.current?.click(), hidden: Boolean(upload) },
              { label: "Keyboard shortcuts", onSelect: () => openShortcuts() },
              { label: "Delete reading", danger: true, onSelect: async () => { if (await deleteReading(asView)) back(); } },
            ]}
          />
          <input
            ref={replacer} type="file" hidden accept={READING_ACCEPT}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void replaceFile(asView, f); }}
          />
        </div>
      </div>

      {finding && (
        <div className="find-bar" role="search">
          <input
            ref={findBox} type="search" value={query} placeholder="Find in this reading" aria-label="Find in this reading" autoFocus
            inputMode="search" enterKeyHint="search" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
              if (e.key === "Escape") closeFind();
            }}
          />
          <span className="count-at" aria-live="polite">
            {query.trim().length < 2 ? "" : hits.length ? `${hit + 1} of ${hits.length}${needles.separate ? ", any of the words" : ""}` : "No matches"}
          </span>
          <IconButton icon="up" label="Previous match" shortcut="Shift+Enter" disabled={!hits.length} onClick={() => step(-1)} />
          <IconButton icon="down" label="Next match" shortcut="Enter" disabled={!hits.length} onClick={() => step(1)} />
          <span className="spacer" />
          <IconButton icon="close" label="Close find" shortcut="Esc" onClick={closeFind} />
        </div>
      )}

      {narrow && (
        <div className="reading-progress" role="progressbar" aria-label="How far through the reading" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      )}
      <div className="reader-body">
        {left && (
          <Sidebar
            tab={tab} setTab={setTab} doc={doc} sizes={sizes} current={current} headings={headings}
            itemId={id} highlights={highlights} noteHandle={noteHandle}
            onGoPage={(p) => { goToPage(p); if (narrow) setLeft(false); }}
            onOpenHighlight={(hid) => { const h = highlights.find((x) => x.id === hid); if (h) goTo(h); }}
            onQuoteRemoved={onQuoteRemoved}
            onQuoteRestored={onQuoteRestored}
            onClose={toggleLeft}
          />
        )}
        <div
          className="scroller"
          ref={scroller}
          onScroll={onScroll}
          onClick={() => { if (barHidden) setBarHidden(false); }}
        >
          {problem && <p className="notice">{problem}</p>}
          {!doc && !problem && <p className="notice">Opening the reading…</p>}
          {doc && layout === "text" && !reflowed && <p className="notice">Setting the text for this screen…</p>}
          {doc && layout === "text" && reflowed && !reflowed.usable && (
            <p className="notice small">This reading has no text to set, so it shows as pages. A scan gains text once it has been processed.</p>
          )}
          {textReady && (
            <div style={{ "--tv-size": textSize } as React.CSSProperties}>
              <TextView
                reflowed={reflowed!}
                kicker={place ? place.label : ""}
                title={item.title}
                byline={item.author}
                standfirst={[item.kind === "secondary" && item.year ? String(item.year) : item.doc_date, item.source, item.pages && `pp. ${item.pages}`].filter(Boolean).join(", ") || null}
                highlights={highlights}
                needles={finding ? needles.list : []}
                currentHit={finding && currentHit ? currentHit : null}
                start={pendingSpot.current ?? (page !== undefined ? { page, frac: 0 } : item.last_spot ?? { page: item.last_page ?? 0, frac: 0 })}
                onSpot={onTextSpot}
                onSelect={onTextSelect}
                onHighlight={(hid, x, y) => setActive({ id: hid, x, y })}
                notes={footnotes}
              />
            </div>
          )}
          {doc && !textReady && (layout === "pages" || (reflowed && !reflowed.usable)) && (
            <div className="pages" ref={pages} onClick={onPageClick}>
              {sizes.map((size, index) => (
                <PageView
                  key={index}
                  doc={doc}
                  index={index}
                  size={size}
                  scale={scale}
                  theme={theme}
                  crop={crop}
                  highlights={byPage.get(index) ?? []}
                  activeId={active?.id ?? null}
                  query={finding ? needles : NO_NEEDLES}
                  currentHit={currentHit && currentHit.page === index ? currentHit.n : null}
                  onViewport={onViewport}
                  onHighlightClick={(hid, x, y) => setActive({ id: hid, x, y })}
                />
              ))}
            </div>
          )}
          {doc && (layout === "pages" || reflowed) && <EndOfReading item={item} next={next} back={back} backLabel={backLabel} />}
        </div>
      </div>

      {selected && !active && tool === "select" && (touchScreen() ? (
        // On a touch screen the colours dock at the foot of the screen, in
        // reach of a thumb and clear of the selection's handles and the
        // phone's own Copy menu. Sentence and Paragraph widen a rough selection.
        <div className="touch-bar" role="toolbar" aria-label="Highlight the selection" onPointerDown={(e) => e.preventDefault()}>
          <div className="touch-bar-widen">
            <button type="button" className="tool" onClick={() => widen("sentence")}>Whole sentence</button>
            {layout === "text" && <button type="button" className="tool" onClick={() => widen("paragraph")}>Whole paragraph</button>}
          </div>
          <div className="touch-bar-colours">
            {COLOURS.map((c) => (
              <button key={c.value} type="button" className="touch-swatch" onClick={() => createHighlight(c.value)}
                aria-label={`Highlight ${colourLabel(c.value, names).toLowerCase()}`}>
                <span className="dot" style={{ background: c.value }} />
                <span className="name">{colourLabel(c.value, names)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div
          className="floating"
          style={{ left: Math.max(8, Math.min(selected.x - 100, window.innerWidth - 210)), top: Math.min(selected.y + 10, window.innerHeight - 60) }}
          onPointerDown={(e) => e.preventDefault()}
        >
          {COLOURS.map((c) => (
            <button
              key={c.value} className="swatch"
              title={`Highlight ${colourLabel(c.value, names).toLowerCase()}`}
              aria-label={`Highlight ${colourLabel(c.value, names).toLowerCase()}`}
              style={{ background: c.value }} onClick={() => createHighlight(c.value)}
            />
          ))}
        </div>
      ))}
      {sheet && (
        <ReaderSheet title={sheet === "edit" ? "Edit details" : "Move this reading"} onClose={() => setSheet(null)}>
          {sheet === "edit"
            ? <Editor view={asView} onClose={() => setSheet(null)} />
            : <MovePicker view={asView} onMoved={() => setSheet(null)} />}
        </ReaderSheet>
      )}
      {active && activeHighlight && (
        <Popover highlight={activeHighlight} at={active} questions={questions} names={names} onClose={() => setActive(null)} onWrite={() => writeAbout(activeHighlight.id)} />
      )}
    </div>
  );
}

// A reading's details or its move, opened from the reader in a dialog, which
// a phone shows as a sheet from the foot of the screen.
function ReaderSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDialogElement>(null);
  useEffect(() => { box.current?.showModal(); }, []);
  return (
    <dialog ref={box} className="dialog reader-sheet" aria-label={title} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}
