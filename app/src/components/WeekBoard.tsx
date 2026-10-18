// The week's readings and primary sources as two lists you can rearrange by
// hand. Pick a reading up to reorder it, drop it in the other list to change
// what it is, or drop it on another week in the grid that appears.
//
// Mouse and trackpad pick up after a small movement, so clicks still open
// readings. Touch picks up after a short press, as on a phone's home screen.
// The keyboard works too: focus a row, press space, use the arrows, press
// space again.

import { useDragSensors } from "../lib/drag";
import {
  closestCenter, pointerWithin, DndContext, type CollisionDetection, DragOverlay, useDroppable,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useState } from "react";
import type { ReadingView } from "../lib/library";
import { byWeek, weekCode } from "../lib/modules";
import { moveToTray, moveToWeek, placeInWeek, positionsOf } from "../lib/moves";
import { shortTitle } from "../lib/titles";
import type { WeekRow } from "../lib/types";
import { ReadingRow } from "./ReadingRow";

type ListKey = "secondary" | "primary";

// The week grid answers to where the pointer is, so the week under your
// finger is the week you get. The lists answer to the nearest row.
export const collide: CollisionDetection = (args) => {
  const under = pointerWithin(args).filter((c) => /^(week:|tray$)/.test(String(c.id)));
  return under.length ? under : closestCenter(args);
};

// A reading that can be picked up. The slide board uses it too.
export function Sortable({ view, weeks, short }: { view: ReadingView; weeks: WeekRow[]; short?: boolean }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: view.link!.id });
  return (
    <ReadingRow
      view={view} weeks={weeks} short={short}
      drag={{
        setNodeRef, attributes, listeners: listeners as never, dragging: isDragging,
        style: { transform: CSS.Translate.toString(transform), transition },
      }}
    />
  );
}

function List({ id, label, views, weeks, dragging }: { id: ListKey; label: string | null; views: ReadingView[]; weeks: WeekRow[]; dragging: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `list:${id}` });
  // An empty list only shows while something is being dragged, as a place to drop.
  if (!views.length && !dragging) return null;
  return (
    <div className="section" data-drop={id === "primary" ? "primary" : "readings"}>
      {label && <p className="group-label">{label}</p>}
      <SortableContext items={views.map((v) => v.link!.id)} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className={`readings${!views.length ? " empty-target" : ""}${isOver ? " over" : ""}`}>
          {views.map((v) => <Sortable key={v.link!.id} view={v} weeks={weeks} />)}
          {!views.length && <li className="drop-hint">Drop here to make it {id === "primary" ? "a primary source" : "a reading"}</li>}
        </ul>
      </SortableContext>
    </div>
  );
}

export function Target({ id, label, current, reading }: { id: string; label: string; current?: boolean; reading?: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled: current });
  return (
    <span ref={setNodeRef} className={`target${isOver ? " over" : ""}${current ? " current" : ""}${reading ? " is-reading-week" : ""}`}>
      {label}
    </span>
  );
}

export function WeekBoard({ week, readings, primaries, weeks, moduleId }: {
  week: WeekRow; readings: ReadingView[]; primaries: ReadingView[]; weeks: WeekRow[]; moduleId: string;
}) {
  const sorted = useMemo(() => [...weeks].sort(byWeek), [weeks]);
  const all = useMemo(() => new Map([...readings, ...primaries].map((v) => [v.link!.id, v])), [readings, primaries]);
  const fromProps = () => ({ secondary: readings.map((v) => v.link!.id), primary: primaries.map((v) => v.link!.id) });
  const [lists, setLists] = useState(fromProps);
  const [active, setActive] = useState<string | null>(null);
  // While nothing is being dragged, the lists follow the library.
  useEffect(() => { if (!active) setLists(fromProps()); }, [readings, primaries, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useDragSensors(sortableKeyboardCoordinates);

  const listOf = (id: string): ListKey | null => {
    if (id === "list:secondary" || lists.secondary.includes(id)) return "secondary";
    if (id === "list:primary" || lists.primary.includes(id)) return "primary";
    return null;
  };

  const onStart = (e: DragStartEvent) => setActive(String(e.active.id));

  // Crossing into the other list moves the row there straight away, so you
  // see where it will land before letting go.
  const onOver = (e: DragOverEvent) => {
    const from = listOf(String(e.active.id));
    const to = e.over ? listOf(String(e.over.id)) : null;
    if (!from || !to || from === to) return;
    setLists((current) => {
      const moving = String(e.active.id);
      const target = current[to].filter((x) => x !== moving);
      const overIndex = target.indexOf(String(e.over!.id));
      target.splice(overIndex < 0 ? target.length : overIndex, 0, moving);
      return { ...current, [from]: current[from].filter((x) => x !== moving), [to]: target };
    });
  };

  const onEnd = async (e: DragEndEvent) => {
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    setActive(null);
    const view = all.get(id);
    if (!view?.link || !overId) return;
    if (overId.startsWith("week:")) {
      const target = sorted.find((w) => w.id === overId.slice(5));
      if (target) await moveToWeek(view.item, view.link, target);
      return;
    }
    if (overId === "tray") {
      await moveToTray(view.item, view.link, moduleId);
      return;
    }
    const to = listOf(overId);
    if (!to) return;
    const ids = [...lists[to]];
    const from = ids.indexOf(id);
    const overIndex = overId.startsWith("list:") ? ids.length - 1 : ids.indexOf(overId);
    if (from >= 0 && overIndex >= 0 && from !== overIndex) {
      ids.splice(from, 1);
      ids.splice(overIndex, 0, id);
    }
    setLists((current) => ({ ...current, [to]: ids }));
    const kind = to === "primary" ? "primary" : "secondary";
    if (kind === view.item.kind && JSON.stringify(ids) === JSON.stringify(fromProps()[to])) return;
    // The new position falls between the rows either side of the drop.
    await placeInWeek(view.item, view.link, positionsOf(ids.map((x) => all.get(x)?.link ?? null)), ids.indexOf(id), kind);
  };

  const viewsOf = (key: ListKey) => lists[key].map((id) => all.get(id)).filter((v): v is ReadingView => Boolean(v));
  const dragged = active ? all.get(active) : null;

  return (
    <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
      <List id="secondary" label={null} views={viewsOf("secondary")} weeks={weeks} dragging={Boolean(active)} />
      <List id="primary" label="Primary sources" views={viewsOf("primary")} weeks={weeks} dragging={Boolean(active)} />
      {active && <MoveDock weeks={sorted} current={week} />}
      <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
        {dragged ? <div className="drag-card">{shortTitle(dragged.item)}<span className="where">{weekCode(week)}</span></div> : null}
      </DragOverlay>
    </DndContext>
  );
}

// The grid of the module's weeks that appears while something is dragged.
export function MoveDock({ weeks, current }: { weeks: WeekRow[]; current: WeekRow }) {
  return (
    <div className="move-dock" role="region" aria-label="Move to another week">
      <p className="small">Drop on a week to move it there</p>
      <div className="dock-grid">
        {(["AT", "WT"] as const).map((term) => (
          <div key={term} style={{ display: "contents" }}>
            <span className="term">{term}</span>
            {weeks.filter((w) => w.term === term).map((w) => (
              <Target key={w.id} id={`week:${w.id}`} label={String(w.number)} current={w.id === current.id} reading={w.is_reading_week} />
            ))}
          </div>
        ))}
      </div>
      <Target id="tray" label="Unsorted" />
    </div>
  );
}
