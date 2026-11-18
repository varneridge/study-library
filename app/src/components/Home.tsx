import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { AddTile } from "./AddTile";
import { rectSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useSuspendingLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link } from "../App";
import { loadModules, type ModuleSummary } from "../lib/library";
import { useTeachingWeek } from "../lib/term";
import { createModule, WEEK_NUMBERS } from "../lib/modules";
import { navigate } from "../lib/router";
import { reorderModules } from "../lib/edits";
import { droppedOrder, dragHandleProps, steppedOrder, swallowClickAfterDrag, useDragSensors, useOptimisticOrder } from "../lib/drag";
import { showToast, useTitle } from "../lib/ui";
import { Icon } from "./icons";
import type { ModuleKind } from "../lib/types";

function NewModule({ onDone }: { onDone?: () => void }) {
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<ModuleKind>("taught");
  const [autumn, setAutumn] = useState("6");
  const [winter, setWinter] = useState("6");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    if (saving) return;
    setSaving(true);
    const readingWeeks = [autumn && `AT${autumn}`, winter && `WT${winter}`].filter(Boolean) as string[];
    try {
      const id = await createModule({ code, title, readingWeeks, kind });
      onDone?.();
      navigate({ view: "module", id });
    } catch (error) {
      // Without this the button stayed on "Creating…" for good after a failure.
      setSaving(false);
      showToast(`The module could not be created. ${(error as Error).message || "Try again in a moment."}`);
    }
  }

  return (
    <form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape" && onDone) { e.preventDefault(); onDone(); } }} className="section">
      <div className="row">
        <label className="field" style={{ flex: "0 0 9rem" }}>
          <span>Code</span>
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="HY335" required autoFocus autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" enterKeyHint="next" />
        </label>
        <label className="field" style={{ flex: 1, minWidth: "14rem" }}>
          <span>Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoCapitalize="words" autoComplete="off" enterKeyHint="done" />
        </label>
      </div>
      <div className="field">
        <span className="small muted">This module is</span>
        <div className="segmented" role="group" aria-label="Kind of module">
          <button type="button" className="tool" aria-pressed={kind === "taught"} onClick={() => setKind("taught")}>Taught</button>
          <button type="button" className="tool" aria-pressed={kind === "dissertation"} onClick={() => setKind("dissertation")}>Dissertation</button>
          <button type="button" className="tool" aria-pressed={kind === "library"} onClick={() => setKind("library")}>Library</button>
        </div>
      </div>
      {kind === "dissertation" ? (
        <p className="small muted">It starts with one section, ready to name. Add sections for chapters, sources and supervision as you go, and key dates for the countdown.</p>
      ) : kind === "library" ? (
        <p className="small muted">An open library for books, secondary literature and downloaded references, organised by shelves you name (such as Historiography, Reference, or Primary sources) with no term weeks.</p>
      ) : (<>
      <p className="small muted">Weeks of term, ready for your readings, seminars and lectures.</p>
      <div className="row">
        <label className="field">
          <span>Autumn reading week</span>
          <select value={autumn} onChange={(e) => setAutumn(e.target.value)}>
            <option value="">None</option>
            {WEEK_NUMBERS.map((n) => <option key={n} value={n}>AT{n}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Winter reading week</span>
          <select value={winter} onChange={(e) => setWinter(e.target.value)}>
            <option value="">None</option>
            {WEEK_NUMBERS.map((n) => <option key={n} value={n}>WT{n}</option>)}
          </select>
        </label>
      </div>
      </>)}
      <div className="row" style={{ gap: "0.5rem" }}>
        <button className="button primary" disabled={saving || !code.trim()}>{saving ? "Creating…" : "Create module"}</button>
        {onDone && <button type="button" className="button" onClick={onDone} disabled={saving}>Cancel</button>}
      </div>
    </form>
  );
}


// A module's card, which a mouse or a pen can drag from anywhere and a finger
// from its "#" handle, shown while the modules are being reorganised.
function ModuleCard({
  item,
  index,
  arranging,
  onStep,
}: {
  item: ModuleSummary;
  index: number;
  arranging: boolean;
  onStep: (direction: -1 | 1) => void;
}) {
  const { module } = item;
  const [imgFailed, setImgFailed] = useState(false);
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: module.id });
  const hasImage = Boolean(module.image_key && !imgFailed);
  const imageSrc = module.image_key
    ? (module.image_key.startsWith("pictures/") ? `/api/${module.image_key}` : `/api/pictures/${module.image_key}`)
    : null;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`module-card module-item movable${isDragging ? " dragging" : ""}${arranging ? " arranging" : ""}`}
      {...(listeners as React.HTMLAttributes<HTMLLIElement>)}
    >
      <div className="module-card-cover">
        {hasImage && imageSrc ? (
          <img
            src={imageSrc}
            alt=""
            loading={index < 2 ? "eager" : "lazy"}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="module-card-typo-cover" aria-hidden="true">
            <span className="module-card-typo-code">{module.code}</span>
          </div>
        )}
      </div>
      <div className="module-card-body">
        {arranging ? (
          <div className="module-row">
            <span className="code">{module.code}</span>
            <span className="title">{module.title || module.code}</span>
          </div>
        ) : (
          <Link
            to={{ view: "module", id: module.id }}
            className="module-row"
            aria-label={`Open ${module.code} ${module.title || ""}`}
          >
            <span className="code">{module.code}</span>
            <span className="title">{module.title || module.code}</span>
            <span className="module-card-stretch" aria-hidden="true" />
          </Link>
        )}

        {/* While reorganising the link gives way to a plain row, so the
            handle never sits inside a link that a tap would follow. */}
        {arranging && (
          <button
            type="button"
            className="drag-handle"
            data-drag-handle
            aria-label={`Drag ${module.code} to reorder`}
            {...dragHandleProps(onStep)}
          >
            <Icon name="reorder" size={16} />
          </button>
        )}
      </div>
    </li>
  );
}

export function Home() {
  const week = useTeachingWeek();
  const modules = useSuspendingLiveQuery(() => loadModules(week), ["home-modules", week?.term, week?.number, week?.upcoming]);
  const [adding, setAdding] = useState(false);
  const [arranging, setArranging] = useState(false);
  const sensors = useDragSensors();
  // The order on screen runs ahead of the database for the moment after a drop.
  const [ordered, setOrder] = useOptimisticOrder(modules, (m) => m.module.id, modules);
  useTitle(null);

  const save = (next: string[] | null) => {
    if (!next) return;
    setOrder(next);
    reorderModules(next).catch((error: unknown) => {
      setOrder(null);
      showToast(`The new order could not be saved. ${(error as Error).message || "Try again in a moment."}`);
    });
  };
  const ids = ordered.map((m) => m.module.id);
  const onDragEnd = (event: DragEndEvent) => {
    swallowClickAfterDrag();
    save(droppedOrder(ids, String(event.active.id), event.over ? String(event.over.id) : null));
  };

  if (modules.length === 0) {
    return (
      <div className="page wide">
        <h1>Add your first module</h1>
        <p className="lede">Creating a module sets up all 22 weeks, ready for your readings and notes.</p>
        <NewModule />
      </div>
    );
  }

  return (
    <div className="page wide">
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h1>Modules</h1>
        <span className="spacer" />
        {modules.length > 1 && (
          <button type="button" className="quiet" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
            {arranging ? "Done" : "Reorganise"}
          </button>
        )}
      </div>
      {/* The new module opens above the grid, where it will be read first. */}
      {adding && <NewModule onDone={() => setAdding(false)} />}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} onDragCancel={swallowClickAfterDrag}>
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          <ul className={`module-grid${arranging ? " arranging" : ""}`}>
            {ordered.map((item, index) => (
              <ModuleCard
                key={item.module.id}
                item={item}
                index={index}
                arranging={arranging}
                onStep={(direction) => save(steppedOrder(ids, item.module.id, direction))}
              />
            ))}
            {/* A new module is added from a blank tile at the end of the grid (AddTile.tsx). */}
            {!adding && !arranging && <AddTile label="New module" announce="Add a module" onAdd={() => setAdding(true)} className="module-add" />}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}
