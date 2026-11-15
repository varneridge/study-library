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
// Both kinds of pointer are served by one sensor. dnd-kit gathers every
// sensor's activators into a single set of props keyed by event name, so two
// sensors that both listen for onPointerDown do not run side by side: the
// second simply replaces the first. That is what left a mouse unable to drag
// anything, the "#" handle included, while a finger still could. One sensor
// with one activator decides by the kind of pointer instead, and takes its
// distance from the same fact.
//
// There is no dragging by keyboard, since a keyboard drag starts on Space or
// Enter pressed anywhere in a row and a space typed in a title would pick the
// row up. A focused handle answers to the arrow keys instead, moving its row
// one place at a time, so the keyboard keeps a way to reorder.

import { closestCenter, pointerWithin, PointerSensor, useSensor, useSensors, type CollisionDetection, type PointerSensorProps } from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from "react";

// Controls inside a row that keep their own clicks and typing. The handle is
// a button too, but it exists to be dragged, so it is left out of the list.
export const NO_DRAG = 'button:not([data-drag-handle]), input, select, textarea, option, label, [contenteditable]:not([contenteditable="false"]), [role="menuitem"], [role="menu"], [data-no-drag]';

// How far each kind of pointer travels before a press becomes a drag. A mouse
// needs the larger margin so that a slightly shaky click still opens a link,
// while a finger on the handle has nothing else it could mean.
export const MOUSE_DRAG_DISTANCE = 6;
export const TOUCH_DRAG_DISTANCE = 4;

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

// Whether a press may pick its row up, by the rules above. Exported so that
// the rules can be tested without a browser.
export function mayStartDrag(event: ReactPointerEvent): boolean {
  const { nativeEvent } = event;
  if (!nativeEvent.isPrimary || nativeEvent.button !== 0) return false;
  if (nativeEvent.pointerType === "touch") return startsOnHandle(event);
  return !startsOnControl(event);
}

// The one pointer sensor for reordering. Its activation distance is chosen
// when the press begins, from the kind of pointer that made it, since dnd-kit
// otherwise fixes one distance for every pointer a sensor serves.
export class ReorderSensor extends PointerSensor {
  constructor(props: PointerSensorProps) {
    const touch = (props.event as PointerEvent).pointerType === "touch";
    super({
      ...props,
      options: { ...props.options, activationConstraint: { distance: touch ? TOUCH_DRAG_DISTANCE : MOUSE_DRAG_DISTANCE } },
    });
  }

  static activators = [{
    eventName: "onPointerDown" as const,
    handler: (event: ReactPointerEvent) => mayStartDrag(event),
  }];
}

// The two sensors this module used to offer, kept as names so that any page
// still importing them builds. Both are now the one sensor, so even a page
// that registers the pair gets working mouse, pen and touch dragging.
export const MouseOrPenSensor = ReorderSensor;
export const TouchHandleSensor = ReorderSensor;

export function useDragSensors() {
  return useSensors(useSensor(ReorderSensor));
}

// Collision for a page of several sortable lists, such as a week's primary
// sources, secondary readings and summaries. A list registers itself as a
// droppable whose data names it ({ list: key }) and wraps its rows in a
// SortableContext whose id is listContextId(key).
//
// Measuring against every droppable at once, as closestCenter alone does,
// lets a whole list compete with its own rows. A long list's centre sits in
// its middle, so a row dropped there landed on the list rather than on its
// neighbours, and the drop sent it to the bottom. Here a target outside the
// lists (a week in the move grid, say) wins whenever the pointer is over it;
// otherwise the pointer chooses the list and the nearest row within that list
// decides the place, and a list answers for itself only when it has no rows.
// Pages with no such lists get closestCenter exactly as before.
export const listContextId = (key: string) => `rows:${key}`;

export const listCollision: CollisionDetection = (args) => {
  const containers = args.droppableContainers;
  const listKey = (c: (typeof containers)[number]): string | null => {
    const key = (c.data.current as { list?: unknown } | undefined)?.list;
    return typeof key === "string" ? key : null;
  };
  const lists = containers.filter((c) => listKey(c) !== null);
  if (!lists.length) return closestCenter(args);

  const contextOf = (c: (typeof containers)[number]): string | null => {
    const id = (c.data.current as { sortable?: { containerId?: unknown } } | undefined)?.sortable?.containerId;
    return id == null ? null : String(id);
  };
  const rowsOf = (key: string) => containers.filter((c) => contextOf(c) === listContextId(key));
  const others = containers.filter((c) => listKey(c) === null && contextOf(c) === null);

  if (args.pointerCoordinates) {
    if (others.length) {
      const target = pointerWithin({ ...args, droppableContainers: others });
      if (target.length) return target;
    }
    const [hit] = pointerWithin({ ...args, droppableContainers: lists });
    const list = hit ? lists.find((c) => c.id === hit.id) : undefined;
    const key = list ? listKey(list) : null;
    if (list && key !== null) {
      const rows = rowsOf(key);
      return rows.length ? closestCenter({ ...args, droppableContainers: rows }) : [hit];
    }
  }

  // Between the lists, the nearest row decides, or an empty list, which is
  // the only way to reach one when the pointer is not over it.
  const candidates = containers.filter((c) => {
    const key = listKey(c);
    return key === null ? contextOf(c) !== null : rowsOf(key).length === 0;
  });
  return closestCenter({ ...args, droppableContainers: candidates.length ? candidates : containers });
};

// The handle's own styles, inline so that it refuses panning and the long
// press callout even before any stylesheet has loaded.
export const HANDLE_STYLE: CSSProperties = { touchAction: "none", userSelect: "none", WebkitUserSelect: "none", WebkitTouchCallout: "none", cursor: "grab" } as CSSProperties;

// Everything a "#" handle needs beyond its label and its data-drag-handle
// attribute.
//
// A click focuses the handle, because Safari leaves a clicked button
// unfocused, and focus is what lets the arrow keys move the row straight away.
//
// A touch that starts on it is kept from any page-wide swipe, such as the
// week page's swipe to the next week, so a sideways drag reorders rather than
// turning the page. That stops only React's touchstart, which the drag does
// not use: the sensor above listens for pointerdown, a separate event that
// still reaches the row, so the handle's drag is unaffected.
export function dragHandleProps(step: (direction: -1 | 1) => void) {
  return {
    title: "Drag to reorder, or use the arrow keys",
    style: HANDLE_STYLE,
    onKeyDown: (event: ReactKeyboardEvent) => handleArrowKeys(event, step),
    onClick: (event: ReactMouseEvent<HTMLElement>) => event.currentTarget.focus(),
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

// A list's order after a row is dropped into it, for pages of several lists
// where the row may arrive from another list. overId is the row it was
// dropped on, the row itself, or the list (which only happens for a list with
// no other rows). Dropped on another row it takes that row's place, as
// arrayMove would; anything else leaves it where it already shows, or puts it
// at the end of a list it has not yet joined.
export function placedOrder(ids: string[], id: string, overId: string): string[] {
  const was = ids.indexOf(id);
  const rest = ids.filter((x) => x !== id);
  const overAt = overId === id ? -1 : ids.indexOf(overId);
  let at: number;
  if (overAt < 0) at = was >= 0 ? was : rest.length;
  else at = was >= 0 ? overAt : rest.indexOf(overId);
  const next = [...rest];
  next.splice(Math.min(Math.max(at, 0), rest.length), 0, id);
  return next;
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
