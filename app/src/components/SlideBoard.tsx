// The slides in a week's sessions, as lists you can rearrange by hand, as
// readings are. Pick slides up to reorder them, drop them on another
// session to move them there, or on a week in the grid that appears.

import { useDragSensors } from "../lib/drag";
import {
  DndContext, DragOverlay, useDroppable,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ReadingView, SessionView } from "../lib/library";
import { byWeek, sessionLabel, weekCode } from "../lib/modules";
import { moveToTray, moveToWeek, placeSlides, positionsOf } from "../lib/moves";
import { shortTitle } from "../lib/titles";
import type { WeekRow } from "../lib/types";
import { collide, MoveDock, Sortable } from "./WeekBoard";

interface Board {
  lists: Record<string, string[]>;
  all: Map<string, ReadingView>;
  dragging: boolean;
  weeks: WeekRow[];
}

const BoardContext = createContext<Board | null>(null);

// One session's slides. An empty list shows only while slides are dragged.
export function SessionSlides({ sessionId, fallback }: { sessionId: string; fallback: ReadingView[] }) {
  const board = useContext(BoardContext);
  const { setNodeRef, isOver } = useDroppable({ id: `slides:${sessionId}` });
  const views = board
    ? (board.lists[sessionId] ?? []).map((id) => board.all.get(id)).filter((v): v is ReadingView => Boolean(v))
    : fallback;
  if (!views.length && !board?.dragging) return null;
  return (
    <SortableContext items={views.map((v) => v.link!.id)} strategy={verticalListSortingStrategy}>
      <ul ref={setNodeRef} className={`readings${!views.length ? " empty-target" : ""}${isOver ? " over" : ""}`} style={{ borderTop: 0 }}>
        {views.map((v) => <Sortable key={v.link!.id} view={v} weeks={board?.weeks ?? []} />)}
        {!views.length && <li className="drop-hint">Drop here to make them this session's slides</li>}
      </ul>
    </SortableContext>
  );
}

export function SlideBoard({ week, weeks, moduleId, sessions, children }: {
  week: WeekRow; weeks: WeekRow[]; moduleId: string; sessions: SessionView[]; children: ReactNode;
}) {
  const sorted = useMemo(() => [...weeks].sort(byWeek), [weeks]);
  const all = useMemo(() => new Map(sessions.flatMap((s) => s.slides).map((v) => [v.link!.id, v])), [sessions]);
  const fromProps = () => Object.fromEntries(sessions.map((s) => [s.session.id, s.slides.map((v) => v.link!.id)]));
  const [lists, setLists] = useState<Record<string, string[]>>(fromProps);
  const [active, setActive] = useState<string | null>(null);
  // While nothing is being dragged, the lists follow the library.
  useEffect(() => { if (!active) setLists(fromProps()); }, [sessions, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useDragSensors(sortableKeyboardCoordinates);

  const sessionOf = (id: string): string | null => {
    if (id.startsWith("slides:")) return id.slice(7);
    return Object.keys(lists).find((key) => lists[key].includes(id)) ?? null;
  };

  const onStart = (e: DragStartEvent) => setActive(String(e.active.id));

  // Crossing into another session moves the slides there straight away, so
  // you see where they will land before letting go.
  const onOver = (e: DragOverEvent) => {
    const moving = String(e.active.id);
    const from = sessionOf(moving);
    const to = e.over ? sessionOf(String(e.over.id)) : null;
    if (!from || !to || from === to) return;
    setLists((current) => {
      const target = (current[to] ?? []).filter((x) => x !== moving);
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
    const to = sessionOf(overId);
    if (!to) return;
    const ids = [...(lists[to] ?? [])];
    const from = ids.indexOf(id);
    const overIndex = overId.startsWith("slides:") ? ids.length - 1 : ids.indexOf(overId);
    if (from >= 0 && overIndex >= 0 && from !== overIndex) {
      ids.splice(from, 1);
      ids.splice(overIndex, 0, id);
    }
    setLists((current) => ({ ...current, [to]: ids }));
    const unchanged = view.link.session_id === to && JSON.stringify(ids) === JSON.stringify(fromProps()[to]);
    if (unchanged) return;
    const session = sessions.find((s) => s.session.id === to)?.session;
    const name = session ? (session.title || sessionLabel(session.kind)).toLowerCase() : "session";
    await placeSlides(view.item, view.link, positionsOf(ids.map((x) => all.get(x)?.link ?? null)), ids.indexOf(id), to, name);
  };

  const dragged = active ? all.get(active) : null;
  const board: Board = { lists, all, dragging: Boolean(active), weeks };

  return (
    <BoardContext.Provider value={board}>
      <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={() => setActive(null)}>
        {children}
        {active && <MoveDock weeks={sorted} current={week} />}
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
          {dragged ? <div className="drag-card">{shortTitle(dragged.item)}<span className="where">{weekCode(week)}</span></div> : null}
        </DragOverlay>
      </DndContext>
    </BoardContext.Provider>
  );
}
