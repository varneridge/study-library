// Short-lived interface state shared across screens: the notice at the
// foot of the screen, with its undo, and the confirmation dialog.

import { useEffect, useRef, useState } from "react";

export interface Toast {
  id: number;
  message: string;
  action?: { label: string; run: () => void | Promise<void> };
}

export interface Ask {
  title: string;
  body?: string;
  confirm: string;
  danger?: boolean;
  // When set, the person types this before the button works.
  typed?: string;
  resolve: (ok: boolean) => void;
}

let toast: Toast | null = null;
let shortcuts = false;
let ask: Ask | null = null;
let counter = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function showToast(message: string, action?: Toast["action"], ms = 8000): void {
  counter += 1;
  toast = { id: counter, message, action };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { toast = null; notify(); }, ms);
  notify();
}

export function dismissToast(): void {
  toast = null;
  if (timer) clearTimeout(timer);
  notify();
}

export function confirmAction(options: Omit<Ask, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    ask?.resolve(false);
    ask = {
      ...options,
      resolve: (ok) => { ask = null; notify(); resolve(ok); },
    };
    notify();
  });
}

export function openShortcuts(): void {
  shortcuts = true;
  notify();
}

export function closeShortcuts(): void {
  shortcuts = false;
  notify();
}

export function useOverlays(): { toast: Toast | null; ask: Ask | null; shortcuts: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return { toast, ask, shortcuts };
}

// Sets the browser tab's title for the screen on show.
export function useTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Study Library` : "Study Library";
  }, [title]);
}

// True when a key press is meant for a text field rather than the app.
export function typing(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

// True on a phone-width screen, where some actions move into a menu.
export function useNarrow(query = "(max-width: 34rem)"): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const change = () => setNarrow(list.matches);
    list.addEventListener("change", change);
    return () => list.removeEventListener("change", change);
  }, [query]);
  return narrow;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online;
}

let overlaySeq = 0;

// Closes an overlay (sheet, menu, panel or dialog) on the browser back gesture
// or button before leaving the page. Goes back exactly once when the overlay is
// closed any other way (Escape, Cancel, click outside). If an action inside
// navigates, navigate() replaces the overlay entry so one Back returns to the
// page you were on.
export function useCloseOnBack(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open) return;
    const id = ++overlaySeq;
    let popped = false;

    window.history.pushState({ overlay: id }, "");

    const onPop = (e: PopStateEvent) => {
      // If the browser popped back to this overlay from an overlay above it, stay open.
      if (e.state?.overlay === id) return;
      popped = true;
      closeRef.current();
    };

    window.addEventListener("popstate", onPop);

    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped && window.history.state?.overlay === id) {
        window.history.back();
      }
    };
  }, [open]);
}

// A sideways swipe, as a shortcut for something the page also offers as a
// link. It ignores swipes that start in a field, an editor, a row that can
// be dragged, or anything that scrolls sideways, and ones that are mostly
// up and down, so it never fights with typing, selecting or scrolling.
export function useSwipe(onLeft: (() => void) | null, onRight: (() => void) | null): void {
  useEffect(() => {
    if (!onLeft && !onRight) return;
    let start: { x: number; y: number; t: number } | null = null;
    const skip = (el: EventTarget | null) => {
      if (!(el instanceof Element)) return true;
      if (el.closest("input, textarea, select, [contenteditable='true'], .movable, .dragging, .slide-box, .apps, dialog")) return true;
      for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
        if (n.scrollWidth > n.clientWidth + 2 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
      }
      return false;
    };
    const down = (e: TouchEvent) => {
      if (e.touches.length !== 1 || skip(e.target)) { start = null; return; }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    };
    const up = (e: TouchEvent) => {
      if (!start) return;
      const dx = e.changedTouches[0].clientX - start.x;
      const dy = e.changedTouches[0].clientY - start.y;
      const quick = Date.now() - start.t < 600;
      start = null;
      if (!quick || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
      if (window.getSelection()?.toString()) return;
      if (dx < 0) onLeft?.(); else onRight?.();
    };
    document.addEventListener("touchstart", down, { passive: true });
    document.addEventListener("touchend", up, { passive: true });
    return () => { document.removeEventListener("touchstart", down); document.removeEventListener("touchend", up); };
  }, [onLeft, onRight]);
}

// On a phone, menus and panels become sheets fixed to the foot of the
// screen. A fixed element inside a transformed parent (a toolbar sliding
// away) is held in that parent's box instead, so sheets are drawn straight
// into the body there.
export const sheetHost = (): HTMLElement | null =>
  typeof window !== "undefined" && window.matchMedia?.("(max-width: 44rem)").matches ? document.body : null;
