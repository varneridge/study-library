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

let toasts: Toast[] = [];
let shortcuts = false;
let ask: Ask | null = null;
let counter = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export function showToast(message: string, action?: Toast["action"], ms = 8000): number {
  const existing = toasts.find((t) => t.message === message);
  if (existing && !action && !existing.action) {
    const prevTimer = toastTimers.get(existing.id);
    if (prevTimer) clearTimeout(prevTimer);
    const newTimer = setTimeout(() => {
      dismissToast(existing.id);
    }, ms);
    toastTimers.set(existing.id, newTimer);
    notify();
    return existing.id;
  }
  counter += 1;
  const id = counter;
  const item: Toast = { id, message, action };
  if (toasts.length >= 3) {
    const candidateIndex = toasts.findIndex((t) => !t.action);
    const evictIndex = candidateIndex !== -1 ? candidateIndex : 0;
    const evicted = toasts[evictIndex];
    const evictedTimer = toastTimers.get(evicted.id);
    if (evictedTimer) clearTimeout(evictedTimer);
    toastTimers.delete(evicted.id);
    toasts.splice(evictIndex, 1);
  }
  toasts.push(item);
  const timer = setTimeout(() => {
    dismissToast(id);
  }, ms);
  toastTimers.set(id, timer);
  notify();
  return id;
}

export function dismissToast(id?: number): void {
  if (id !== undefined) {
    const timer = toastTimers.get(id);
    if (timer) clearTimeout(timer);
    toastTimers.delete(id);
    toasts = toasts.filter((t) => t.id !== id);
  } else {
    toastTimers.forEach((t) => clearTimeout(t));
    toastTimers.clear();
    toasts = [];
  }
  notify();
}

export function getToasts(): Toast[] {
  return toasts;
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

export function useOverlays(): { toast: Toast | null; toasts: Toast[]; ask: Ask | null; shortcuts: boolean } {
  const [, force] = useState(0);
  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return { toast: toasts[toasts.length - 1] ?? null, toasts, ask, shortcuts };
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

// True on a phone-width screen, where some actions move into a menu or sheet.
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

interface OverlayEntry {
  id: number;
  close: () => void;
  pushed: boolean;
  popped: boolean;
}

const overlayStack: OverlayEntry[] = [];

if (typeof window !== "undefined") {
  if (window.history.state?.overlay) {
    window.history.replaceState(null, "");
  }
  window.addEventListener("popstate", (e) => {
    if (overlayStack.length === 0) return;
    const top = overlayStack[overlayStack.length - 1];
    // If the browser popped back to this overlay from an overlay above it, stay open.
    if (e.state?.overlay === top.id) return;
    top.popped = true;
    top.close();
  });
}

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
    const hasExistingOverlay = Boolean(window.history.state?.overlay);
    let pushed = false;

    if (!hasExistingOverlay || overlayStack.length > 0) {
      window.history.pushState({ overlay: id }, "");
      pushed = true;
    } else {
      // An overlay was closing and this one is replacing it in the same interaction
      // (e.g. Menu -> Editor/MovePicker/ReaderSheet). Update the existing entry.
      window.history.replaceState({ overlay: id }, "");
      pushed = true;
    }

    const entry: OverlayEntry = { id, close: () => closeRef.current(), pushed, popped: false };
    overlayStack.push(entry);

    return () => {
      const idx = overlayStack.findIndex((e) => e.id === id);
      if (idx !== -1) overlayStack.splice(idx, 1);

      queueMicrotask(() => {
        if (entry.popped) return;
        if (overlayStack.length === 0 && window.history.state?.overlay) {
          window.history.back();
        } else if (overlayStack.length > 0 && pushed && hasExistingOverlay) {
          // If this was a nested overlay that pushed its own entry, retreat its entry.
          window.history.back();
        }
      });
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
