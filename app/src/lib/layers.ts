import React, { createContext, useContext, useEffect, useId, useRef } from "react";

export interface LayerEntry {
  id: string;
  onEscape?: () => void;
  onOutside?: (e: PointerEvent) => void;
  containerRef?: React.RefObject<HTMLElement | null>;
}

const layerStack: LayerEntry[] = [];
let listenersAttached = false;
let lastDismissedAt = 0;

export function wasLayerRecentlyDismissed(): boolean {
  return Date.now() - lastDismissedAt < 150;
}

export function dismissTopLayer(): boolean {
  const top = layerStack[layerStack.length - 1];
  if (top?.onEscape) {
    lastDismissedAt = Date.now();
    top.onEscape();
    return true;
  }
  return false;
}

function handleKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing || e.defaultPrevented) return;
  const top = layerStack[layerStack.length - 1];
  if (top?.onEscape) {
    e.preventDefault();
    e.stopPropagation();
    lastDismissedAt = Date.now();
    top.onEscape();
  }
}

function handlePointerDown(e: PointerEvent) {
  const top = layerStack[layerStack.length - 1];
  if (!top?.onOutside) return;
  const container = top.containerRef?.current;
  if (container && !container.contains(e.target as Node)) {
    lastDismissedAt = Date.now();
    top.onOutside(e);
  }
}

function ensureListeners() {
  if (listenersAttached || typeof window === "undefined") return;
  document.addEventListener("keydown", handleKeyDown);
  document.addEventListener("pointerdown", handlePointerDown, true);
  listenersAttached = true;
}

export function registerLayer(entry: LayerEntry) {
  ensureListeners();
  const existing = layerStack.find((l) => l.id === entry.id);
  if (existing) {
    existing.containerRef = entry.containerRef;
    existing.onEscape = entry.onEscape;
    existing.onOutside = entry.onOutside;
    return;
  }
  layerStack.push(entry);
}

export function unregisterLayer(id: string) {
  const idx = layerStack.findIndex((l) => l.id === id);
  if (idx !== -1) {
    layerStack.splice(idx, 1);
  }
}

// React Context for resolving nearest modal root
export const ModalRootContext = createContext<React.RefObject<HTMLElement | null> | null>(null);

export function usePortalTarget(): HTMLElement {
  const ctx = useContext(ModalRootContext);
  if (ctx && ctx.current) return ctx.current;
  return typeof document !== "undefined" ? document.body : (null as unknown as HTMLElement);
}

export function useLayer(options: {
  onEscape?: () => void;
  onOutside?: (e: PointerEvent) => void;
  containerRef?: React.RefObject<HTMLElement | null>;
  enabled?: boolean;
}) {
  const id = useId();
  const { onEscape, onOutside, containerRef, enabled = true } = options;
  const onEscapeRef = useRef(onEscape);
  const onOutsideRef = useRef(onOutside);
  onEscapeRef.current = onEscape;
  onOutsideRef.current = onOutside;

  useEffect(() => {
    if (!enabled) return;
    const entry: LayerEntry = {
      id,
      containerRef,
      onEscape: onEscape ? () => onEscapeRef.current?.() : undefined,
      onOutside: onOutside ? (e) => onOutsideRef.current?.(e) : undefined,
    };
    registerLayer(entry);
    return () => unregisterLayer(id);
  }, [id, enabled, containerRef]);
}
