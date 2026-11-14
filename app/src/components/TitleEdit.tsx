import { useEffect, useRef, useState } from "react";

// Renames a title in place. The field wears the title's own type, so nothing jumps when
// editing starts, and Cancel and Done sit beside it, so the editing state always has a
// visible way out (design skill, Behaviour: "A way out, always").
//
// Enter or Done saves, Escape or Cancel puts it back, and leaving the field saves, as the
// title editors did before. The buttons keep focus in the field when pressed, so a tap on
// Cancel never saves first by blurring the field (iOS buttons take no focus on tap).
export function TitleEdit({
  value,
  label,
  placeholder,
  level = 1,
  onSave,
  onCancel,
}: {
  value: string;
  label: string;
  placeholder?: string;
  level?: 1 | 2;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const settled = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Each editing session ends exactly once, whichever way out is taken first.
  const save = () => {
    if (settled.current) return;
    settled.current = true;
    onSave(draft);
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };
  const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

  return (
    <div
      className="title-edit"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) save();
      }}
    >
      <input
        ref={input}
        className={`title-input${level === 2 ? " level-2" : ""}`}
        type="text"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        enterKeyHint="done"
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); save(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
        }}
      />
      <button type="button" className="quiet" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={cancel}>Cancel</button>
      <button type="button" className="button" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={save}>Done</button>
    </div>
  );
}
