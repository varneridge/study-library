// Dragging to reorder works the same way on every page that offers it, for
// modules, sections, sessions and readings alike.
//
// A mouse or a pen picks a row up from anywhere on it once it has moved six
// pixels, so a plain click on a link still opens it. A press that starts on
// a control (a button, a field, a menu) never picks anything up, because a
// row can hold fields such as a title being renamed, and a drag there would
// fight the typing or the click.
//
// On a touch screen a finger on a list means scrolling, and a held finger
// means selecting text, so a drag that started anywhere would fight both.
// Touch therefore picks a row up only from its "#" handle, which Reorganise
// shows. The handle refuses the browser's own panning (touch-action: none),
// so it moves after four pixels while the rest of the page scrolls as usual.
//
// There is no dragging by keyboard, since a keyboard drag starts on Space or
// Enter pressed anywhere in a row and a space typed in a title would pick the
// row up. A focused handle answers to the arrow keys instead, moving its row
// one place at a time, so the keyboard keeps a way to reorder.

import { PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";

// Controls inside a row that keep their own clicks and typing. The handle is
// a button too, but it exists to be dragged, so it is left out of the list.
export const NO_DRAG = 'button:not([data-drag-handle]), input, select, textarea, option, label, [contenteditable]:not([contenteditable="false"]), [role="menuitem"], [role="menu"], [data-no-drag]';

// Whether the press began on a control that belongs to the row itself, as
// opposed to something the row happens to sit inside.
function startsOnControl(event: ReactPointerEvent): boolean {
  const target = event.nativeEvent.target as Element | null;
  const control = target?.closest?.(NO_DRAG);
  const row = event.currentTarget as Element | null;
  return Boolean(control && (!row || row.contains(control)));
}

const startsOnHandle = (event: ReactPointerEvent): boolean =>
  Boolean((event.nativeEvent.target as Element | null)?.closest?.("[data-drag-handle]"));

// A pointer sensor for a mouse or a pen, which can start anywhere on a row
// that is not one of its controls.
export class MouseOrPenSensor extends PointerSensor {
  static activators = [{
    eventName: "onPointerDown" as const,
    handler: (event: ReactPointerEvent) => {
      const { nativeEvent } = event;
      if (nativeEvent.pointerType === "touch" || !nativeEvent.isPrimary || nativeEvent.button !== 0) return false;
      return !startsOnControl(event);
    },
  }];
}

// A pointer sensor for a finger, which starts only on a row's "#" handle so
// that touching anywhere else scrolls the page as it always has.
export class TouchHandleSensor extends PointerSensor {
  static activators = [{
    eventName: "onPointerDown" as const,
    handler: (event: ReactPointerEvent) => {
      const { nativeEvent } = event;
      if (nativeEvent.pointerType !== "touch" || !nativeEvent.isPrimary) return false;
      return startsOnHandle(event);
    },
  }];
}

// Each sensor keeps its own distance, since a constraint belongs to a sensor
// rather than to the kind of pointer that pressed.
export function useDragSensors() {
  return useSensors(
    useSensor(MouseOrPenSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchHandleSensor, { activationConstraint: { distance: 4 } }),
  );
}

// The handle's own styles, inline so that it refuses panning and the long
// press callout even before any stylesheet has loaded.
export const HANDLE_STYLE: CSSProperties = { touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", cursor: "grab" } as CSSProperties;

// Everything a "#" handle needs beyond its label and its data-drag-handle
// attribute. A touch that starts on it is kept from any page-wide swipe, such
// as the week page's swipe to the next week, so a sideways drag reorders
// rather than turning the page. Only touchstart is stopped, because the
// pointerdown has to reach the row for the drag to begin at all.
export function dragHandleProps(step: (direction: -1 | 1) => void) {
  return {
    title: "Drag to reorder, or use the arrow keys",
    style: HANDLE_STYLE,
    onKeyDown: (event: ReactKeyboardEvent) => handleArrowKeys(event, step),
    onTouchStart: (event: ReactTouchEvent) => event.stopPropagation(),
  };
}

// After a drag the browser can still send a click to the link the pointer
// was released over. dnd-kit stops that click reaching React, which leaves
// the link's own navigation in place, so the next click within a moment of
// the drop is cancelled here before anything else sees it.
export function swallowClickAfterDrag(): void {
  if (typeof window === "undefined") return;
  const swallow = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 120);
}

// The order after a drop of one id onto another, or null when nothing moved.
export function droppedOrder(ids: string[], activeId: string, overId: string | null): string[] | null {
  if (!overId || activeId === overId) return null;
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0) return null;
  return arrayMove(ids, from, to);
}

// The order after moving one id a single place, or null at either end.
export function steppedOrder(ids: string[], id: string, direction: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  return arrayMove(ids, from, to);
}

// Arrow keys on a focused handle move its row by one place: up or left for
// earlier, down or right for later, as the grid and the lists both read.
export function handleArrowKeys(event: ReactKeyboardEvent, step: (direction: -1 | 1) => void): void {
  const direction = event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : 0;
  if (!direction) return;
  event.preventDefault();
  event.stopPropagation();
  step(direction);
}

// Shows a new order straight away, before the database has caught up, so a
// dropped row does not jump back to where it was for a moment. The order is
// let go whenever the source (resetOn) changes, because by then the rows
// arrive in the order they were saved in.
export function useOptimisticOrder<T>(items: T[], idOf: (item: T) => string, resetOn: unknown): [T[], (ids: string[] | null) => void] {
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => { setOrder(null); }, [resetOn]);
  const ordered = useMemo(() => {
    if (!order) return items;
    const byId = new Map(items.map((item) => [idOf(item), item]));
    const placed = order.map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
    const named = new Set(order);
    return [...placed, ...items.filter((item) => !named.has(idOf(item)))];
  }, [items, order]); // eslint-disable-line react-hooks/exhaustive-deps
  return [ordered, setOrder];
}
