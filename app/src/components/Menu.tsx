import { Icon } from "./icons";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sheetHost } from "../lib/ui";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

// A "more actions" menu. Closes on a click elsewhere or on Escape.
export function Menu({ items, label = "More actions" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const poppedRef = useRef(false);
  const [shift, setShift] = useState(0);
  const shown = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!open) return;
    poppedRef.current = false;
    window.history.pushState({ overlayOpen: true }, "");

    const onPop = () => {
      poppedRef.current = true;
      setOpen(false);
    };
    window.addEventListener("popstate", onPop);

    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !panel.current?.contains(target)) {
        if (!poppedRef.current && window.history.state?.overlayOpen) {
          window.history.back();
        }
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!poppedRef.current && window.history.state?.overlayOpen) {
          window.history.back();
        }
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("popstate", onPop);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      if (!poppedRef.current && window.history.state?.overlayOpen) {
        window.history.back();
      }
      buttonRef.current?.focus();
    };
  }, [open]);

  const dismiss = () => {
    if (!poppedRef.current && window.history.state?.overlayOpen) {
      window.history.back();
    }
    setOpen(false);
  };

  const selectItem = (item: MenuItem) => {
    window.history.replaceState(null, "");
    setOpen(false);
    item.onSelect();
  };

  // Keep the panel on screen when its button sits near an edge.
  useLayoutEffect(() => {
    if (!open || !panel.current) return setShift(0);
    const rect = panel.current.getBoundingClientRect();
    const margin = 8;
    if (rect.left < margin) setShift(margin - rect.left);
    else if (rect.right > window.innerWidth - margin) setShift(window.innerWidth - margin - rect.right);
  }, [open]);

  if (!shown.length) return null;
  const host = sheetHost();
  const portal = (node: ReactNode) => (host ? createPortal(node, host) : node);
  return (
    <div className="menu" ref={ref}>
      <button ref={buttonRef} className="quiet menu-button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="more" size={18} /></button>
      {/* On a phone the menu is a sheet over a dimmed page; tapping the page closes it. */}
      {open && portal(<div className="menu-backdrop" aria-hidden="true" onClick={dismiss} />)}
      {open && portal(
        <div className="menu-panel" role="menu" ref={panel} style={shift ? { transform: `translateX(${shift}px)` } : undefined}>
          {shown.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              onClick={() => selectItem(item)}
            >
              {item.label}
            </button>
          ))}
          <button role="menuitem" className="menu-cancel" onClick={dismiss}>Cancel</button>
        </div>,
      )}
    </div>
  );
}
