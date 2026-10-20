// A choice card replaces a dropdown. On a laptop it is a small panel beside
// the button that opened it; on a phone it is a sheet from the foot of the
// screen. Either way it is a modal dialog, so Tab stays inside it, Escape
// and a click outside close it, the back gesture closes it before leaving the
// page, and focus goes back to the button that opened it. Pages with key
// shortcuts ignore keys while a card is open (dialog[open]).

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useCloseOnBack } from "../lib/ui";

const PHONE = "(max-width: 44rem)";

export function ChoiceCard({ open, onClose, anchor, label, title, children, className, initialFocus }: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
  label: string;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  // A selector for what takes focus on opening: the current choice, say.
  initialFocus?: string;
}) {
  useCloseOnBack(open, onClose);
  if (!open) return null;
  return <CardBody onClose={onClose} anchor={anchor} label={label} title={title} className={className} initialFocus={initialFocus}>{children}</CardBody>;
}

function CardBody({ onClose, anchor, label, title, children, className, initialFocus }: {
  onClose: () => void; anchor: RefObject<HTMLElement | null>; label: string; title?: ReactNode;
  children: ReactNode; className?: string; initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [sheet] = useState(() => window.matchMedia?.(PHONE).matches ?? false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const first = (initialFocus && dialog.querySelector<HTMLElement>(initialFocus))
      || dialog.querySelector<HTMLElement>("[aria-pressed='true'], button:not([disabled]), input");
    first?.focus();
    const opener = anchor.current;
    return () => {
      if (dialog.open) dialog.close();
      // Back to the button that opened it, once the card has gone.
      requestAnimationFrame(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // On a laptop the panel sits just below its button, or above it near the
  // foot of the screen, and never runs off either side.
  useLayoutEffect(() => {
    if (sheet) return;
    const place = () => {
      const dialog = ref.current, button = anchor.current;
      if (!dialog || !button) return;
      const at = button.getBoundingClientRect();
      const margin = 8;
      const width = dialog.offsetWidth, height = dialog.offsetHeight;
      let top = at.bottom + 6;
      if (top + height > window.innerHeight - margin && at.top - height - 6 > margin) top = at.top - height - 6;
      top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
      const left = Math.max(margin, Math.min(at.left, window.innerWidth - width - margin));
      dialog.style.top = `${Math.round(top)}px`;
      dialog.style.left = `${Math.round(left)}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [sheet, anchor]);

  return (
    <dialog
      ref={ref}
      className={`choice-card${sheet ? " sheet" : ""}${className ? ` ${className}` : ""}`}
      aria-label={label}
      onCancel={(e) => { e.preventDefault(); closeRef.current(); }}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog itself, outside its box.
        if (e.target !== ref.current) return;
        const box = ref.current.getBoundingClientRect();
        const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
        if (!inside) closeRef.current();
      }}
    >
      {title && <div className="choice-head">{title}</div>}
      {children}
      <div className="choice-foot">
        <button type="button" className="button choice-cancel" onClick={() => closeRef.current()}>Cancel</button>
      </div>
    </dialog>
  );
}
