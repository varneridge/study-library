// The divider between a session's notes and the readings beside them. It is
// dragged with a pointer, moved with the arrow keys, sent to either limit
// with Home and End, and put back to an even split with a double click.

import { useRef, useState } from "react";
import { DEFAULT_SPLIT, MAX_SPLIT, MIN_SPLIT, splitFromKey, splitFromPointer } from "../lib/split";
import "./SplitHandle.css";

export function SplitHandle({ grid, value, onChange, label = "Resize the notes and readings" }: {
  // The grid being divided, measured on each move because its width changes
  // with the window and the handle has no width of its own to go by.
  grid: { readonly current: HTMLElement | null };
  value: number;
  onChange: (fraction: number) => void;
  label?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const pointer = useRef<number | null>(null);

  const follow = (clientX: number) => {
    const box = grid.current?.getBoundingClientRect();
    if (box) onChange(splitFromPointer(clientX, box));
  };

  const release = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    pointer.current = null;
    setDragging(false);
  };

  const percent = Math.round(value * 100);

  return (
    <div
      className={`split-handle${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(MIN_SPLIT * 100)}
      aria-valuemax={Math.round(MAX_SPLIT * 100)}
      aria-valuenow={percent}
      aria-valuetext={`Notes ${percent}%, readings ${100 - percent}%`}
      tabIndex={0}
      title="Drag to resize. Double-click to even out."
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Stopping the default keeps the drag from selecting the notes' text
        // as the pointer passes over them.
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        pointer.current = e.pointerId;
        setDragging(true);
      }}
      onPointerMove={(e) => { if (pointer.current === e.pointerId) follow(e.clientX); }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={() => { pointer.current = null; setDragging(false); }}
      onKeyDown={(e) => {
        const next = splitFromKey(value, e.key);
        if (next === null) return;
        e.preventDefault();
        onChange(next);
      }}
      onDoubleClick={() => onChange(DEFAULT_SPLIT)}
    >
      <span className="split-grip" aria-hidden="true" />
    </div>
  );
}
