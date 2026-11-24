// A reading opened as the passage of one footnote of an essay: the reading's pages and the
// highlights that footnote draws on, and nothing of ordinary reading. There is no sidebar,
// no notes, no colours and no comments, so every highlight shown here is part of the
// passage. A selection is added to the passage in one step, a highlight is taken out of it
// in one more, and Previous and Next step through the highlights it draws on.

import { useLiveQuery } from "dexie-react-hooks";
import type { PageViewport, PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../../lib/appearance";
import { addPassage, assessmentSettingKey, normaliseAssessmentData, removePassage } from "../../lib/assessment";
import { db } from "../../lib/db";
import { numberedFootnotes, passageHighlightIds } from "../../lib/essaySources";
import { inReadingOrder } from "../../lib/highlightReferences";
import { isDuplicate, isHighlightable, shortcutFor } from "../../lib/highlightSelect";
import type { loadReader } from "../../lib/library";
import { EXACT_SIZES_UP_TO, exactPageSizes, openPdf, openPdfData, pageSizes } from "../../lib/pdfOpen";
import { navigate, type CiteTarget } from "../../lib/router";
import { touchScreen, widenSelection } from "../../lib/selection";
import { COLOURS } from "../../lib/settings";
import { insert, newId, remove } from "../../lib/sync";
import { fullTitle, shortTitle } from "../../lib/titles";
import type { HighlightRow } from "../../lib/types";
import { showToast, typing, useNarrow, useTitle } from "../../lib/ui";
import { clampZoom, stepZoom } from "../../lib/zoom";
import { IconButton } from "../icons";
import { PageView, screenRect, type Needles, type Size, type Theme } from "./pages";
import { SelectionBar } from "./SelectionBar";
import { usePageSelection, type PageSelection } from "./usePageSelection";
import "./PassageReader.css";

type ReaderData = NonNullable<Awaited<ReturnType<typeof loadReader>>>;

// The same limits as the reader's pages, so that a page is drawn the same size in both.
const MIN_SCALE = 0.4;
const MAX_SCALE = 4;
const MAX_FIT_PX = 900;
const clamp = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));

const NO_NEEDLES: Needles = { list: [], separate: false };
const NO_HIGHLIGHTS: HighlightRow[] = [];
// The bar that offers only Add to passage has no use for the colours or comments.
const NO_COLOURS: { value: string; label: string }[] = [];
const nothing = () => undefined;

const failure = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "The passage could not be changed, so try again in a moment.";

export function PassageReader({ id, data, page, cite }: { id: string; data: ReaderData; page?: number; cite: CiteTarget }) {
  const { item } = data;
  useTitle(fullTitle(item));
  const narrow = useNarrow();
  const appTheme = useTheme();
  const theme: Theme = appTheme === "light" ? "plain" : appTheme;
  const dataRef = useRef(data);
  dataRef.current = data;

  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [fit, setFit] = useState(1);
  const [at, setAt] = useState(0);
  const [selected, setSelected] = useState<PageSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewports = useRef(new Map<number, PageViewport>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const working = useRef(false);
  // The highlight to step to once the essay has saved the change that adds it.
  const focusId = useRef<string | null>(null);
  const scale = zoom ?? fit;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  const fileKey = data.file ? `${data.file.id}:${data.file.r2_key}:${data.file.mime}` : data.upload?.id ?? "none";

  // The essay's own row, read directly so that a row still loading is told from one with no
  // links: the first is undefined, and an essay that has gone is null.
  const row = useLiveQuery(
    async () => (await db.settings.get(assessmentSettingKey(cite.module, cite.essay))) ?? null,
    [cite.module, cite.essay],
  );
  const essay = useMemo(() => (row === undefined ? null : normaliseAssessmentData(row?.value)), [row]);

  // What the footnote draws on: its highlights in this reading, in reading order, and whether
  // the footnote is still in the draft, which a save from Word can change.
  const passage = useMemo(() => {
    if (!essay) return null;
    const ids = passageHighlightIds(essay.sourceLinks ?? [], cite.footnote);
    return {
      shown: inReadingOrder(data.highlights.filter((h) => ids.includes(h.id))),
      gone: cite.footnote.startsWith("new:") || !essay.draft.footnotes.some((f) => f.id === cite.footnote),
      number: numberedFootnotes(essay.draft).find((fn) => fn.id === cite.footnote)?.number,
    };
  }, [essay, data.highlights, cite.footnote]);
  const shown = passage?.shown ?? NO_HIGHLIGHTS;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const index = Math.min(at, Math.max(0, shown.length - 1));
  const activeId = shown[index]?.id ?? null;
  const what = passage?.number ? `footnote ${passage.number}` : "the footnote";

  const byPage = useMemo(() => {
    const map = new Map<number, HighlightRow[]>();
    for (const h of shown) map.set(h.page, [...(map.get(h.page) ?? []), h]);
    return map;
  }, [shown]);

  // Open the document from the local cache, or download it once.
  useEffect(() => {
    setDoc(null);
    setSizes([]);
    viewports.current.clear();
    let cancelled = false;
    let loaded: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const current = dataRef.current;
        if (current.file?.mime === "application/pdf") loaded = await openPdf(current.file);
        else if (current.upload?.mime === "application/pdf") loaded = await openPdfData(current.upload.blob);
        else {
          setProblem(current.file ? "This file is still being converted to PDF." : "This file has not finished uploading.");
          return;
        }
        const opened = loaded;
        const all = await pageSizes(opened);
        if (cancelled) return;
        viewports.current.clear();
        setSizes(all);
        setDoc(loaded);
        setProblem(null);
        // A long book shows at once with every page the size of its first, and any pages
        // of another size are put right in the background.
        if (opened.numPages > EXACT_SIZES_UP_TO) {
          void exactPageSizes(opened, all[0], () => cancelled)
            .then((exact) => { if (exact && !cancelled) setSizes(exact); })
            .catch(() => undefined);
        }
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

  // Fit to width, and refit when the window changes size.
  useEffect(() => {
    const element = scroller.current;
    if (!element || sizes.length === 0) return undefined;
    const widest = Math.max(...sizes.map((s) => s.width));
    const measure = () => {
      // A tab hidden with display: none measures nothing, and fitting to that
      // would shrink the pages until the reading is shown again.
      if (element.clientWidth === 0) return;
      setFit(clamp(Math.min((element.clientWidth - 24) / widest, MAX_FIT_PX / widest)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sizes]);

  const onViewport = useCallback((pageIndex: number, viewport: PageViewport | null) => {
    if (viewport) viewports.current.set(pageIndex, viewport);
    else viewports.current.delete(pageIndex);
  }, []);

  const changeZoom = useCallback((next: number | null) => {
    setZoom(next === null ? null : clamp(clampZoom(next)));
  }, []);

  const goToPage = useCallback((pageIndex: number) => {
    const element = pages.current?.children[pageIndex] as HTMLElement | undefined;
    if (element && scroller.current) scroller.current.scrollTop = element.offsetTop - 8;
  }, []);

  // Scrolls a highlight to a third of the way down the screen. A page not drawn yet has no
  // viewport, so its place is worked out from the page's size, which is exact for an
  // unrotated page and close enough to bring any other into view to be drawn.
  const scrollToHighlight = useCallback((highlight: HighlightRow) => {
    const element = pages.current?.children[highlight.page] as HTMLElement | undefined;
    const box = scroller.current;
    if (!element || !box || !highlight.rects.length) return;
    const viewport = viewports.current.get(highlight.page);
    const size = sizesRef.current[highlight.page];
    const top = viewport
      ? Math.min(...highlight.rects.map((r) => screenRect(r, viewport).top))
      : size ? (size.height - Math.max(...highlight.rects.map((r) => Math.max(r[1], r[3])))) * scaleRef.current : 0;
    box.scrollTop = Math.max(0, element.offsetTop + top - box.clientHeight / 3);
  }, []);

  // Opened, the reading goes to the first highlight once its pages are laid out, and only
  // once, so that reading on from there is never undone. With none, it opens at the page
  // the link names. Fit is a dependency so that the place is worked out at the final size.
  const opened = useRef(false);
  const ready = Boolean(doc && sizes.length > 0 && essay);
  useEffect(() => {
    if (!ready || opened.current) return undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (opened.current) return;
        opened.current = true;
        const first = shownRef.current[0];
        if (first) scrollToHighlight(first);
        else if (page !== undefined) goToPage(Math.min(page, sizesRef.current.length - 1));
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, fit, page, goToPage, scrollToHighlight]);

  // A highlight just added becomes the current one as soon as it is among those shown.
  useEffect(() => {
    if (!focusId.current) return;
    const found = shown.findIndex((h) => h.id === focusId.current);
    if (found >= 0) {
      setAt(found);
      focusId.current = null;
    }
  }, [shown]);

  const step = (direction: 1 | -1) => {
    if (shown.length < 2) return;
    const next = (index + direction + shown.length) % shown.length;
    setAt(next);
    scrollToHighlight(shown[next]);
  };

  const clearSelection = () => {
    document.getSelection()?.removeAllRanges();
    setSelected(null);
  };

  usePageSelection({ pages, viewports, onChange: setSelected });

  // A selection becomes part of the passage in one step: it is highlighted, as the reader
  // would highlight it, and added to the footnote. Words already highlighted are not
  // highlighted twice, and a second press while one is being added does nothing.
  async function addSelection() {
    const s = selectedRef.current;
    if (!s || working.current || !passage || passage.gone) return;
    const capture = { page: s.page, body: s.text };
    if (!isHighlightable(capture)) {
      clearSelection();
      return;
    }
    working.current = true;
    setBusy(true);
    let created = false;
    let highlightId = "";
    try {
      const existing = dataRef.current.highlights.find((h) => isDuplicate([h], capture));
      if (existing && shownRef.current.some((h) => h.id === existing.id)) {
        setAt(shownRef.current.findIndex((h) => h.id === existing.id));
        clearSelection();
        showToast(`That is already in the passage for ${what}.`);
        return;
      }
      highlightId = existing?.id ?? newId();
      if (!existing) {
        await insert("highlights", {
          id: highlightId, item_id: id, page: s.page, rects: s.rects, body: s.text,
          colour: localStorage.getItem("highlight-colour") || COLOURS[0].value,
          comment: null, question_id: null, zotero_key: null,
        });
        created = true;
      }
      await addPassage(cite, { itemId: id, highlightId, quote: s.text, page: s.page });
      focusId.current = highlightId;
      clearSelection();
      const added = highlightId;
      const madeHere = created;
      showToast(`Added to the passage for ${what}.`, {
        label: "Undo",
        // Undo puts things back as they were, so a highlight made for this is taken away too.
        run: async () => {
          try {
            await removePassage(cite, added);
            if (madeHere) await remove("highlights", added);
          } catch (error) {
            showToast(failure(error));
          }
        },
      });
    } catch (error) {
      // A highlight made for a passage that could not be saved would be left lying about.
      if (created) await remove("highlights", highlightId).catch(() => undefined);
      showToast(failure(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const addRef = useRef(addSelection);
  addRef.current = addSelection;

  // Takes the current highlight out of the passage. It stays in the reading and its notes.
  async function removeCurrent() {
    const highlight = shownRef.current[index];
    if (!highlight || working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await removePassage(cite, highlight.id);
      showToast("Removed from the passage. The highlight stays in the reading.", {
        label: "Undo",
        run: async () => {
          try {
            await addPassage(cite, { itemId: id, highlightId: highlight.id, quote: highlight.body ?? "", page: highlight.page });
          } catch (error) {
            showToast(failure(error));
          }
        },
      });
    } catch (error) {
      showToast(failure(error));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }

  // H adds the selection and Escape lets it go. Only a reading in view answers, since
  // every open tab keeps its own reader.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || !scroller.current?.getClientRects().length) return;
      const action = shortcutFor(e, false, selectedRef.current !== null);
      if (action === "dismiss") {
        e.preventDefault();
        e.stopPropagation();
        document.getSelection()?.removeAllRanges();
        setSelected(null);
      } else if (action === "highlight") {
        e.preventDefault();
        e.stopPropagation();
        void addRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // On a touch screen the bar covers the foot of the screen, so a selection low down
  // scrolls up just enough to stay in view above it.
  useEffect(() => {
    if (!selected || !touchScreen()) return undefined;
    const frame = requestAnimationFrame(() => {
      const sel = document.getSelection();
      const bar = document.querySelector(".touch-bar");
      if (!sel || !sel.rangeCount || !bar) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      // Its height, not its top: the bar may still be sliding into place.
      const limit = window.innerHeight - (bar as HTMLElement).offsetHeight - 16;
      if (rect.bottom <= limit) return;
      scroller.current?.scrollBy({ top: rect.bottom - limit, behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected]);

  const widenToSentence = () => {
    const node = document.getSelection()?.anchorNode;
    const el = node ? (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement) : null;
    const scope = el?.closest(".textLayer");
    if (scope) widenSelection("sentence", scope);
  };

  const copySelection = () => {
    const text = selectedRef.current?.text ?? "";
    if (!text) return;
    void navigator.clipboard?.writeText(text).then(() => showToast("Copied."), () => showToast("The text could not be copied."));
  };

  // Leaves for the essay. Done and the back button both do this, so that no state of this
  // view lacks a visible way out.
  const exit = () => void navigate(
    { view: "assessment", id: cite.module, ...(cite.essay ? { essay: cite.essay } : {}) },
    { replace: true },
  );

  const label = !passage
    ? ""
    : passage.gone
      ? "This footnote is no longer in the essay, so there is no passage to show."
      : shown.length === 0
        ? `Select the words ${what} cites, then choose Add to passage.`
        : `Passage for ${what}`;
  const canEdit = Boolean(passage && !passage.gone);

  return (
    <div className={`reader ${theme}${narrow ? " narrow" : ""} passage-mode`}>
      <div className="reader-bar" role="toolbar" aria-label="Reader">
        <div className="group">
          <IconButton icon="back" label="Back to the essay" onClick={exit} />
          {!narrow ? <h1 className="title" title={fullTitle(item)}>{shortTitle(item)}</h1> : <h1 className="sr-only">{fullTitle(item)}</h1>}
        </div>
        {!narrow && (
          <div className="group">
            <IconButton icon="zoomOut" label="Zoom out" shortcut="-" onClick={() => changeZoom(stepZoom(scale, -1))} />
            <IconButton icon="zoomIn" label="Zoom in" shortcut="+" onClick={() => changeZoom(stepZoom(scale, 1))} />
            <IconButton icon="fitWidth" label="Fit to width" shortcut="0" pressed={zoom === null} onClick={() => changeZoom(null)} />
          </div>
        )}
      </div>

      <div className="find-bar passage-bar" role="group" aria-label="Passage">
        <span className="passage-label" role="status">{label}</span>
        {shown.length > 0 && <span className="count-at" aria-live="polite">{index + 1} of {shown.length}</span>}
        <IconButton icon="up" label="Previous highlight" disabled={shown.length < 2} onClick={() => step(-1)} />
        <IconButton icon="down" label="Next highlight" disabled={shown.length < 2} onClick={() => step(1)} />
        <button type="button" className="quiet" disabled={busy || !canEdit || shown.length === 0} onClick={() => void removeCurrent()}>
          Remove from passage
        </button>
        <span className="spacer" />
        <button type="button" className="button small" onClick={exit}>Done</button>
      </div>

      <div className="reader-body">
        <div
          className="scroller"
          // The reading's fixed frame: its size comes from the layout alone,
          // and zoom changes only the pages inside it.
          data-zoom-frame=""
          // The reading keeps its own place across a change of tab (TabBar).
          data-own-place=""
          ref={scroller}
        >
          {problem && <p className="notice">{problem}</p>}
          {!doc && !problem && <p className="notice">Opening the reading...</p>}
          {doc && (
            <div className="pages" data-zoom-stage="" ref={pages}>
              {sizes.map((size, pageIndex) => (
                <PageView
                  key={pageIndex}
                  doc={doc}
                  index={pageIndex}
                  size={size}
                  scale={scale}
                  theme={theme}
                  crop={null}
                  highlights={byPage.get(pageIndex) ?? NO_HIGHLIGHTS}
                  activeId={activeId}
                  query={NO_NEEDLES}
                  currentHit={null}
                  onViewport={onViewport}
                  onHighlightClick={(hid) => {
                    const found = shownRef.current.findIndex((h) => h.id === hid);
                    if (found >= 0) setAt(found);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {selected && canEdit && (touchScreen() ? (
        // On a touch screen the bar docks at the foot of the screen, in reach of a thumb and
        // clear of the selection's handles. Whole sentence widens a rough selection.
        <div className="touch-bar" role="toolbar" aria-label="Add the selection to the passage" onPointerDown={(e) => e.preventDefault()}>
          <div className="touch-bar-widen">
            <button type="button" className="tool" disabled={busy} onClick={() => void addSelection()}>Add to passage</button>
            <button type="button" className="tool" onClick={widenToSentence}>Whole sentence</button>
          </div>
        </div>
      ) : (
        <SelectionBar
          anchor={selected.box}
          colours={NO_COLOURS}
          current=""
          onHighlight={nothing}
          onComment={nothing}
          onCopy={copySelection}
          onDismiss={() => setSelected(null)}
          onAddToPassage={() => void addSelection()}
        />
      ))}
    </div>
  );
}
