// The week's primary readings, secondary readings and summaries as three lists
// you can rearrange by hand. Pick a reading up to reorder it, drop it in
// another list to change what it is, or drop it on another week in the grid
// that appears. Where files can be added, each list keeps its heading and an
// Add button even when empty, so every week can hold all three.
//
// A mouse, a trackpad or a pen picks a row up after a small movement, so
// clicks still open readings, and a press on a control in the row never picks
// it up. Touch picks a row up only from its "#" handle, which Reorganise
// shows, so a finger anywhere else scrolls the page (see lib/drag).

import { listCollision, listContextId, placedOrder, swallowClickAfterDrag, useDragSensors } from "../lib/drag";
import {
  DndContext, type CollisionDetection, DragOverlay, useDroppable,
  type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReadingView } from "../lib/library";
import { weekCode } from "../lib/modules";
import { placeInWeek, positionsOf } from "../lib/moves";
import { shortTitle } from "../lib/titles";
import type { WeekRow } from "../lib/types";
import { KIND_GROUP, KIND_LABEL } from "../lib/kinds";
import { ReadingRow } from "./ReadingRow";
import { ViewSwitcher } from "./ViewSwitcher";
import { AddTile } from "./AddTile";
import { FolderStrip } from "./Folders";
import { moveToFolder } from "../lib/folders";
import type { FolderRow } from "../lib/types";
import { setSetting, useSetting } from "../lib/settings";
import { showToast } from "../lib/ui";
import { defaultViewMode, isTileMode, parseViewMode, viewSettingKey, type ReadingViewMode } from "../lib/views";
import { DROP_ZONE, type ReadingKind } from "../lib/readingKinds";
import type { FileTarget } from "./WeekPage";

type ListKey = "primary" | "secondary" | "summary" | "flat";

// The pointer chooses the list and the nearest row in it chooses the place,
// so a list never competes with its own rows (see lib/drag). The slide board
// uses this too, and with no lists of its own it measures as it always has.
export const collide: CollisionDetection = listCollision;

// A reading that can be picked up. The slide board uses it too.
export function Sortable({ view, weeks, short, mode, isLibrary }: { view: ReadingView; weeks: WeekRow[]; short?: boolean; mode?: ReadingViewMode; isLibrary?: boolean }) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: view.link!.id });
  return (
    <ReadingRow
      view={view} weeks={weeks} short={short} mode={mode} isLibrary={isLibrary}
      drag={{
        setNodeRef, attributes, listeners: listeners as never, dragging: isDragging,
        style: { transform: CSS.Translate.toString(transform), transition },
      }}
    />
  );
}

function List({ id, label, views, weeks, dragging, isLibrary, mode, tools, fileOver, onAdd, arranging = false }: {
  id: ListKey; label: string | null; views: ReadingView[]; weeks: WeekRow[]; dragging: boolean; isLibrary?: boolean; mode: ReadingViewMode; tools?: ReactNode;
  // Files from the computer are being dragged over this list.
  fileOver?: boolean;
  // Opens the file picker for this list; given only where files can be added.
  onAdd?: () => void;
  // Reorganising, which shows each row's "#" handle for touch.
  arranging?: boolean;
}) {
  // The list names itself, so that the collision can tell it from a row.
  const { setNodeRef, isOver } = useDroppable({ id: `list:${id}`, data: { list: id } });
  // An empty list shows while a reading or a file is dragged, as a place to
  // drop, and always where it can be added to, so each kind has a home.
  if (!views.length && !dragging && !fileOver && !onAdd) return null;
  const zone = id === "flat" ? "summary" : DROP_ZONE[id];
  const hintText = isLibrary || id === "flat" ? "a document" : `a ${KIND_LABEL[id as "primary" | "secondary" | "summary"]}`;
  const emptyText = dragging
    ? `Drop here to make it ${hintText}`
    : fileOver
      ? `Drop files here to add them as ${(label ?? "documents").toLowerCase()}`
      : `No ${(label ?? "documents").toLowerCase()} yet. Drop files here.`;
  // Adding is a blank tile, or row, at the end of the list rather than a button above it.
  const named = (label ?? "documents").toLowerCase();
  const addTile = onAdd && (
    <AddTile label={`Add ${named}`} announce={`Add ${named}`} onAdd={onAdd} variant={isTileMode(mode) ? "tile" : "row"} />
  );
  const add = null;
  return (
    <div className={`section${fileOver ? " drop-over-lists" : ""}`} data-drop={zone}>
      {/* The first list's heading also carries the folder's view buttons, so
          they sit on the same line as the heading rather than in a row of their own.
          The Add button shares that line for the same reason. */}
      {tools || add ? (
        <div className="board-head">
          {label && <p className="group-label">{label}</p>}
          {add}
          {tools}
        </div>
      ) : (
        label && <p className="group-label">{label}</p>
      )}
      {/* Tiles move about a grid, rows up and down a list. */}
      <SortableContext id={listContextId(id)} items={views.map((v) => v.link!.id)} strategy={isTileMode(mode) ? rectSortingStrategy : verticalListSortingStrategy}>
        <ul ref={setNodeRef} className={`readings view-${mode}${arranging ? " arranging" : ""}${!views.length ? " empty-target" : ""}${isOver ? " over" : ""}`}>
          {views.map((v) => <Sortable key={v.link!.id} view={v} weeks={weeks} mode={mode} isLibrary={isLibrary} />)}
          {!views.length && (!addTile || dragging || fileOver) && <li className="drop-hint">{emptyText}</li>}
          {addTile}
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

const NONE: ReadingView[] = [];

export function WeekBoard({ week, primaries = NONE, readings = NONE, summaries = NONE, weeks, isLibrary, isSyllabus, dropKind = null, onAddTo, folders, folderViews }: {
  week: WeekRow; primaries?: ReadingView[]; readings?: ReadingView[]; summaries?: ReadingView[]; weeks: WeekRow[]; moduleId?: string;
  isLibrary?: boolean; isSyllabus?: boolean;
  // A Library shelf's folders, shown at its front, and the readings in each; left out inside a folder and elsewhere.
  folders?: FolderRow[];
  folderViews?: (folderId: string) => ReadingView[];
  // What files dragged over the page would become, so the matching list can light up.
  dropKind?: FileTarget["kind"] | null;
  // Adds files to one list; left out where the week takes documents only.
  onAddTo?: (kind: ReadingKind) => void;
}) {
  const all = useMemo(() => new Map([...primaries, ...readings, ...summaries].map((v) => [v.link!.id, v])), [primaries, readings, summaries]);
  const allViewsSorted = useMemo(() => {
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...primaries, ...readings, ...summaries].sort(
      (a, b) => cmp(a.link?.position ?? "", b.link?.position ?? "") || cmp(a.link!.id, b.link!.id)
    );
  }, [primaries, readings, summaries]);


  const fromProps = () => {
    if (isSyllabus) {
      return {
        primary: [] as string[],
        secondary: [] as string[],
        summary: [] as string[],
        flat: allViewsSorted.map((v) => v.link!.id),
      };
    }
    return {
      primary: primaries.map((v) => v.link!.id),
      secondary: readings.map((v) => v.link!.id),
      summary: summaries.map((v) => v.link!.id),
      flat: [] as string[],
    };
  };

  const [lists, setLists] = useState(fromProps);
  const [active, setActive] = useState<string | null>(null);
  const [arranging, setArranging] = useState(false);
  // Between a drop and the library catching up, the lists show the order
  // that was dropped. Without this the end of the drag put the old order
  // back for a moment, and the row jumped back before jumping forward again.
  const settling = useRef(false);
  // New readings from the library end the wait. This runs before the effect
  // below, so the lists then take the library's order, which is the saved one.
  useEffect(() => { settling.current = false; }, [primaries, readings, summaries]);
  // While nothing is being dragged or settling, the lists follow the library.
  useEffect(() => { if (!active && !settling.current) setLists(fromProps()); }, [primaries, readings, summaries, active, isSyllabus]); // eslint-disable-line react-hooks/exhaustive-deps

  const sensors = useDragSensors();

  const listOf = (id: string): ListKey | null => {
    if (isSyllabus) {
      if (id === "list:flat" || lists.flat?.includes(id)) return "flat";
      return null;
    }
    if (id === "list:primary" || lists.primary.includes(id)) return "primary";
    if (id === "list:secondary" || lists.secondary.includes(id)) return "secondary";
    if (id === "list:summary" || lists.summary.includes(id)) return "summary";
    return null;
  };

  const onStart = (e: DragStartEvent) => setActive(String(e.active.id));

  // Crossing into another list moves the row there straight away, so you
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

  // A drag that ends without a change puts the library's order back.
  const onCancel = () => {
    swallowClickAfterDrag();
    setActive(null);
    setLists(fromProps());
  };

  const onEnd = async (e: DragEndEvent) => {
    // The pointer is often released over a reading's title, a link.
    swallowClickAfterDrag();
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : null;
    const view = all.get(id);
    // A reading dropped on a folder's tile goes into that folder.
    if (view?.link && overId?.startsWith("folder:")) {
      setActive(null);
      settling.current = true;
      try {
        await moveToFolder(view.link, overId.slice("folder:".length));
      } catch (error) {
        settling.current = false;
        setLists(fromProps());
        showToast(`The reading could not be moved. ${(error as Error).message || "Try again in a moment."}`);
      }
      return;
    }
    const to = overId ? listOf(overId) : null;
    if (!view?.link || !overId || !to) {
      onCancel();
      return;
    }
    // The row may still be missing from its new list, if the drop came before
    // the last crossing had shown, so the order is worked out with it either way.
    const ids = placedOrder(lists[to] ?? [], id, overId);
    const kind = to === "flat" ? view.item.kind : to;
    const unchanged = kind === view.item.kind && JSON.stringify(ids) === JSON.stringify(fromProps()[to]);
    settling.current = !unchanged;
    setActive(null);
    setLists((current) => {
      // Only the list it lands in keeps it, wherever it showed during the drag.
      const next = { ...current };
      for (const key of Object.keys(next) as ListKey[]) next[key] = (next[key] ?? []).filter((x) => x !== id);
      next[to] = ids;
      return next;
    });
    if (unchanged) return;
    try {
      // The new position falls between the rows either side of the drop.
      await placeInWeek(view.item, view.link, positionsOf(ids.map((x) => all.get(x)?.link ?? null)), ids.indexOf(id), kind);
    } catch (error) {
      settling.current = false;
      setLists(fromProps());
      showToast(`The new order could not be saved. ${(error as Error).message || "Try again in a moment."}`);
    }
  };

  const viewsOf = (key: ListKey) => (lists[key] ?? []).map((id) => all.get(id)).filter((v): v is ReadingView => Boolean(v));
  const dragged = active ? all.get(active) : null;
  const summaryLabel = isLibrary ? "Documents" : KIND_GROUP.summary;
  const primaryLabel = isLibrary ? "Primary sources" : KIND_GROUP.primary;
  const secondaryLabel = isLibrary ? "Secondary readings" : KIND_GROUP.secondary;

  // The folder's view, as File Explorer keeps one for each folder.
  const everything = useMemo(() => [...primaries, ...readings, ...summaries], [primaries, readings, summaries]);
  const stored = parseViewMode(useSetting<unknown>(viewSettingKey(week.id), null));
  const mode = stored ?? defaultViewMode({ library: Boolean(isLibrary), views: everything });
  const switcher = everything.length > 0
    ? <ViewSwitcher mode={mode} onChange={(next) => void setSetting(viewSettingKey(week.id), next)} />
    : null;
  // Reorganise only means something with two readings or more to put in order.
  const reorganising = arranging && everything.length > 1;
  const reorganise = everything.length > 1
    ? (
      <button type="button" className="quiet" aria-pressed={reorganising} onClick={() => setArranging(!reorganising)}>
        {reorganising ? "Done" : "Reorganise"}
      </button>
    )
    : null;
  const tools = reorganise || switcher ? <>{reorganise}{switcher}</> : null;
  // Lists with nothing in them are not drawn, so the switcher goes to the first one that is.
  const order: ListKey[] = isSyllabus ? ["flat"] : ["primary", "secondary", "summary"];
  const shown = (key: ListKey) => (lists[key] ?? []).length > 0 || Boolean(active) || dropKind === key || Boolean(onAddTo && key !== "flat");
  const toolsOn = order.find(shown) ?? null;
  const toolsFor = (key: ListKey) => (key === toolsOn ? tools : null);
  const fileOver = (key: ListKey) => !active && dropKind === key;
  const addFor = (key: ReadingKind) => (onAddTo ? () => onAddTo(key) : undefined);

  return (
    <DndContext sensors={sensors} collisionDetection={collide} onDragStart={onStart} onDragOver={onOver} onDragEnd={onEnd} onDragCancel={onCancel}>
      {folders && folderViews && <FolderStrip week={week} folders={folders} viewsIn={folderViews} />}
      {isSyllabus ? (
        <List id="flat" label="Documents" views={viewsOf("flat")} weeks={weeks} dragging={Boolean(active)} isLibrary={isLibrary} mode={mode} tools={toolsFor("flat")} arranging={reorganising} />
      ) : (

        <>
          <List id="primary" label={primaryLabel} views={viewsOf("primary")} weeks={weeks} dragging={Boolean(active)} isLibrary={isLibrary} mode={mode} tools={toolsFor("primary")} arranging={reorganising} fileOver={fileOver("primary")} onAdd={addFor("primary")} />
          <List id="secondary" label={secondaryLabel} views={viewsOf("secondary")} weeks={weeks} dragging={Boolean(active)} isLibrary={isLibrary} mode={mode} tools={toolsFor("secondary")} arranging={reorganising} fileOver={fileOver("secondary")} onAdd={addFor("secondary")} />
          <List id="summary" label={summaryLabel} views={viewsOf("summary")} weeks={weeks} dragging={Boolean(active)} isLibrary={isLibrary} mode={mode} tools={toolsFor("summary")} arranging={reorganising} fileOver={fileOver("summary")} onAdd={addFor("summary")} />
        </>
      )}
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
