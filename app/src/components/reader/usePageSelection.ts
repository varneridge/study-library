// Text selected on the drawn pages of a PDF, as the page it is on, its boxes in PDF points,
// its words and the box round it on screen. Shared by the reader and the passage reader, so
// that a selection is captured in exactly one way.

import { useEffect, useRef, type RefObject } from "react";
import type { PageViewport } from "pdfjs-dist";
import { unionRect, type EdgesLike } from "../../lib/highlightSelect";
import { fingerDown, SETTLE_NOW, settleDelay, whenLifted } from "../../lib/selection";
import { mergeRects, toPdfRect } from "./pages";

export interface PageSelection { page: number; rects: number[][]; text: string; box: EdgesLike }

// Reports the current selection once it has settled, and null when there is none or it is
// outside the pages. skip is asked when a selection is found, and answering true leaves the
// last report as it is, as the reader does while it shows text instead of pages. The caller's
// functions are read through refs, so the listeners are set up once.
export function usePageSelection({ pages, viewports, skip, onChange }: {
  pages: RefObject<HTMLDivElement | null>;
  viewports: RefObject<Map<number, PageViewport>>;
  skip?: () => boolean;
  onChange: (selection: PageSelection | null) => void;
}): void {
  const skipRef = useRef(skip);
  skipRef.current = skip;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      // A selection is not finished while a finger is still on the screen.
      if (fingerDown()) return;
      const selection = document.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        changeRef.current(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const start = range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
      const pageEl = start?.closest("[data-page]") as HTMLElement | null;
      if (skipRef.current?.()) return;
      if (!pageEl || !pages.current?.contains(pageEl)) return changeRef.current(null);
      const index = Number(pageEl.dataset.page);
      const viewport = viewports.current?.get(index);
      if (!viewport) return;
      const box = pageEl.getBoundingClientRect();
      const client = Array.from(range.getClientRects()).filter(
        (r) => r.width > 1 && r.height > 1 && r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right,
      );
      const around = unionRect(client);
      if (!around) return changeRef.current(null);
      changeRef.current({
        page: index,
        rects: mergeRects(client.map((r) => toPdfRect(r, box, viewport))),
        text: selection.toString().replace(/\s+/g, " ").trim(),
        box: around,
      });
    };
    const onSelectionChange = () => {
      clearTimeout(timer);
      timer = setTimeout(check, settleDelay());
    };
    const off = whenLifted(() => { clearTimeout(timer); timer = setTimeout(check, 150); });
    const now = () => { clearTimeout(timer); check(); };
    document.addEventListener(SETTLE_NOW, now);
    const onUp = () => document.querySelectorAll(".textLayer.selecting").forEach((el) => el.classList.remove("selecting"));
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerup", onUp);
    return () => {
      clearTimeout(timer);
      off();
      document.removeEventListener(SETTLE_NOW, now);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerup", onUp);
    };
    // The refs are stable, and everything else is read through them.
  }, [pages, viewports]);
}
