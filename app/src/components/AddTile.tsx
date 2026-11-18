// The way to add something across the site: a blank tile at the end of a
// grid, or a blank row at the end of a list, with a plus and a short label,
// in place of an Add button above it. It shows where the new thing will
// appear, is the same size as its neighbours, and is a real button: reachable
// by keyboard, announced by its full label, and at least 44 px to touch.
// Where it adds readings, files dropped on it are added there too.

import { useState, type ReactNode } from "react";
import { Icon } from "./icons";

export function AddTile({
  label,
  announce,
  onAdd,
  onFiles,
  variant = "tile",
  as = "li",
  disabled,
  className,
  children,
}: {
  /** Shown under the plus: "New folder". */
  label: string;
  /** Read out in full by screen readers: "Add a folder to this shelf". Defaults to the label. */
  announce?: string;
  onAdd: () => void;
  /** Files dropped on the tile, where it adds readings. */
  onFiles?: (files: File[]) => void;
  /** A tile in a grid, or a row in a list. */
  variant?: "tile" | "row";
  /** The element around the button, to fit the list or grid it ends. */
  as?: "li" | "div";
  disabled?: boolean;
  className?: string;
  /** Anything that opens from the tile, such as a menu of choices. */
  children?: ReactNode;
}) {
  const [fileOver, setFileOver] = useState(false);
  const Wrapper = as;
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return (
    <Wrapper
      className={`add-tile add-${variant}${fileOver ? " file-over" : ""}${className ? ` ${className}` : ""}`}
      onDragOver={onFiles ? (e) => { if (hasFiles(e)) { e.preventDefault(); e.stopPropagation(); setFileOver(true); } } : undefined}
      onDragLeave={onFiles ? () => setFileOver(false) : undefined}
      onDrop={onFiles ? (e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        setFileOver(false);
        onFiles(Array.from(e.dataTransfer.files));
      } : undefined}
    >
      <button type="button" className="add-tile-button" onClick={onAdd} disabled={disabled} aria-label={announce ?? label}>
        <span className="add-tile-plus" aria-hidden="true"><Icon name="add" size={variant === "tile" ? 22 : 16} /></span>
        <span className="add-tile-label" aria-hidden="true">{label}</span>
      </button>
      {children}
    </Wrapper>
  );
}
