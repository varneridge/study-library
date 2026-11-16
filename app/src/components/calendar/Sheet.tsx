// The calendar's one modal: a card in the middle of the screen on a laptop and
// a sheet from the foot of the screen on a phone, as the date card is. It
// holds the event form and the list of calendars alike. Escape, a tap outside
// and the buttons inside close it, Tab stays within it, and focus goes back to
// whatever opened it.

import { type ReactNode, useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useLayer, usePortalTarget } from "../../lib/layers";
import { usePhone } from "./hooks";

const FOCUSABLE = 'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]';

export function Sheet({ title, onClose, children, foot }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const portalTarget = usePortalTarget();
  const headingId = useId();
  const phone = usePhone();

  // Escape closes this before anything beneath it.
  useLayer({ containerRef, onEscape: onClose });

  // Focus moves in on opening, unless a field has already taken it, and
  // returns to the opener on closing.
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = containerRef.current;
    if (box && !box.contains(document.activeElement)) box.focus();
    return () => {
      if (opener && opener !== document.body) requestAnimationFrame(() => { if (opener.isConnected) opener.focus(); });
    };
  }, []);

  // The date card opens from inside the form but lives elsewhere on the page,
  // and its key presses still reach this handler, so only keys from within
  // this sheet are the sheet's to trap.
  const trap = (e: React.KeyboardEvent) => {
    const box = containerRef.current;
    if (e.key !== "Tab" || !box || !box.contains(e.target as Node)) return;
    const stops = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0);
    if (!stops.length) return;
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // The page behind does not scroll while the sheet is open.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return createPortal(
    <>
      <div className="cal-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={`cal-sheet ${phone ? "is-sheet" : "is-card"}`}
        tabIndex={-1}
        onKeyDown={trap}
      >
        <h2 id={headingId} className="choice-title cal-sheet-title">{title}</h2>
        <div className="cal-sheet-body">{children}</div>
        {foot && <div className="cal-sheet-foot">{foot}</div>}
      </div>
    </>,
    portalTarget,
  );
}
