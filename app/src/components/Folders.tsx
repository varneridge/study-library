// Folders on Library shelves (lib/folders.ts). On a shelf they sit at the front
// of the grid as tiles, each with the first covers inside it fanned together,
// its name and how many readings it holds, followed by a New folder tile. The
// shelf's own readings stay loose beside them. A tile is a drop target, so a
// reading dragged onto it goes in. Opening one shows its readings with the
// shelf named above as the way back.

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Link } from "../App";
import { createFolder, deleteFolder, NEW_FOLDER_TITLE, renameFolder, sortFolderByTitle } from "../lib/folders";
import type { ReadingView } from "../lib/library";
import type { FolderRow, WeekRow } from "../lib/types";
import { showToast } from "../lib/ui";
import { AddTile } from "./AddTile";
import { Menu } from "./Menu";

/** The shelf's folders and which one is open, for the reading menu's Move to folder. */
export const FolderContext = createContext<{ folders: FolderRow[]; current: string | null; weekId: string } | null>(null);

export function useFolders() {
  return useContext(FolderContext);
}

export function folderTitle(folder: Pick<FolderRow, "title">): string {
  return folder.title?.trim() || NEW_FOLDER_TITLE;
}

/** A folder's name, edited in place: Enter or leaving the field saves, Escape keeps the old one. */
export function FolderName({ folder, editing, setEditing, as = "span" }: {
  folder: FolderRow; editing: boolean; setEditing: (on: boolean) => void; as?: "span" | "h1";
}) {
  const [value, setValue] = useState(folderTitle(folder));
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) {
      setValue(folderTitle(folder));
      requestAnimationFrame(() => field.current?.select());
    }
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editing) {
    const Tag = as;
    return <Tag className="folder-name">{folderTitle(folder)}</Tag>;
  }
  const save = () => {
    setEditing(false);
    if (value.trim() !== folderTitle(folder)) void renameFolder(folder.id, value);
  };
  return (
    <input
      ref={field}
      className={`folder-name-field${as === "h1" ? " is-title" : ""}`}
      aria-label="Folder name"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={save}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); save(); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(false); }
      }}
    />
  );
}

export async function removeFolder(folder: FolderRow): Promise<void> {
  const undo = await deleteFolder(folder);
  showToast(`Deleted the folder \u201c${folderTitle(folder)}\u201d. Its readings are back on the shelf.`, { label: "Undo", run: undo });
}

function folderMenu(folder: FolderRow, rename: () => void) {
  return [
    { label: "Rename folder", onSelect: rename },
    { label: "Sort by title", onSelect: () => void sortFolderByTitle(folder.id).then(() => showToast("Sorted by title.")) },
    { label: "Delete folder", danger: true, onSelect: () => void removeFolder(folder) },
  ];
}

function FolderTile({ folder, views, week, editing, setEditing }: {
  folder: FolderRow; views: ReadingView[]; week: WeekRow; editing: boolean; setEditing: (on: boolean) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `folder:${folder.id}`, data: { folder: folder.id } });
  const covers = views.map((v) => v.file?.thumb_key).filter((k): k is string => Boolean(k)).slice(0, 3);
  const count = views.length;
  return (
    <li ref={setNodeRef} className={`folder-tile${isOver ? " over" : ""}`} data-folder={folder.id}>
      <Link to={{ view: "week", id: week.id, folder: folder.id }} className="folder-open" label={`Open the folder ${folderTitle(folder)}`}>
        <span className={`folder-covers n${covers.length}`} aria-hidden="true">
          {covers.length === 0 && <span className="folder-empty" />}
          {covers.map((key) => <img key={key} src={`/api/objects/${key}`} alt="" loading="lazy" decoding="async" />)}
        </span>
      </Link>
      <span className="folder-caption">
        <FolderName folder={folder} editing={editing} setEditing={setEditing} />
        <span className="folder-count">{count === 1 ? "1 reading" : `${count} readings`}</span>
      </span>
      <Menu label={`More actions for the folder ${folderTitle(folder)}`} items={folderMenu(folder, () => setEditing(true))} />
    </li>
  );
}

/** The shelf's folders and its New folder tile, at the front of the shelf. Rendered inside the board's drag context. */
export function FolderStrip({ week, folders, viewsIn }: {
  week: WeekRow; folders: FolderRow[]; viewsIn: (folderId: string) => ReadingView[];
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      // The new folder's name is ready to type straight away.
      setEditingId(await createFolder(week.id));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="section folders">
      {folders.length > 0 && <p className="group-label">Folders</p>}
      <ul className="folder-grid">
        {folders.map((f) => (
          <FolderTile
            key={f.id} folder={f} views={viewsIn(f.id)} week={week}
            editing={editingId === f.id} setEditing={(on) => setEditingId(on ? f.id : null)}
          />
        ))}
        <AddTile label="New folder" announce="Add a folder to this shelf" onAdd={() => void add()} disabled={busy} className="folder-add" />
      </ul>
    </div>
  );
}

/** Above an open folder: the shelf it is on, as the way back, its name and its actions. */
export function FolderHeader({ folder, week, shelfTitle }: { folder: FolderRow; week: WeekRow; shelfTitle: string }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="folder-header">
      <nav aria-label="Folder" className="folder-trail small">
        <Link to={{ view: "week", id: week.id }}>{shelfTitle}</Link>
        <span aria-hidden="true"> / </span>
      </nav>
      <div className="page-title-group">
        <FolderName folder={folder} editing={editing} setEditing={setEditing} as="h1" />
        <Menu label={`More actions for the folder ${folderTitle(folder)}`} items={folderMenu(folder, () => setEditing(true))} />
      </div>
    </div>
  );
}
