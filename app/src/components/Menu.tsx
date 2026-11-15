import { Icon } from "./icons";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sheetHost, useCloseOnBack } from "../lib/ui";

// An item either runs an action or, when it has items of its own, opens them
// as a group in place beneath it. Groups go one level deep, which keeps
// secondary actions out of sight without stacking a second popover or sheet.
export interface MenuItem {
  label: string;
  onSelect?: () => void;
  items?: MenuItem[];
  danger?: boolean;
  hidden?: boolean;
}

const visible = (items: MenuItem[]) => items.filter((i) => !i.hidden);

// A group with nothing left to show is left out altogether, so it never opens empty.
const showable = (item: MenuItem) => !item.hidden && (!item.items || visible(item.items).length > 0);

// A "more actions" menu. Closes on a click elsewhere or on Escape.
export function Menu({
  items,
  label = "More actions",
  trigger,
  className,
}: {
  items: MenuItem[];
  label?: string;
  trigger?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const actionSelectedRef = useRef(false);
  const [shift, setShift] = useState(0);
  const [flipY, setFlipY] = useState(false);
  const shown = items.filter(showable);

  useCloseOnBack(open, () => setOpen(false));

  useEffect(() => {
    if (!open) {
      setSubmenu(null);
      return;
    }
    actionSelectedRef.current = false;

    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !panel.current?.contains(target)) {
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not([disabled])") || []);
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown") {
          const next = index < items.length - 1 ? index + 1 : 0;
          items[next]?.focus();
        } else {
          const prev = index > 0 ? index - 1 : items.length - 1;
          items[prev]?.focus();
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not([disabled])") || []);
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        const items = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not([disabled])") || []);
        items[items.length - 1]?.focus();
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      if (!actionSelectedRef.current) {
        buttonRef.current?.focus();
      }
    };
  }, [open]);

  const runItem = (item: MenuItem) => {
    actionSelectedRef.current = true;
    setOpen(false);
    item.onSelect?.();
  };

  // Opening a group leaves the menu open, and opening one closes any other.
  const toggleGroup = (item: MenuItem) => {
    setSubmenu((current) => (current === item.label ? null : item.label));
  };

  // Keep the panel on screen when its button sits near an edge or near the bottom.
  // It is measured again when a group opens, because the panel grows. Once
  // flipped it stays flipped while open, since a flipped panel always seems to
  // fit and measuring it would otherwise send it back down past the edge.
  useLayoutEffect(() => {
    if (!open || !panel.current || window.matchMedia("(max-width: 44rem)").matches) {
      setShift(0);
      setFlipY(false);
      return;
    }
    const rect = panel.current.getBoundingClientRect();
    const margin = 8;
    if (rect.left < margin) setShift((s) => s + margin - rect.left);
    else if (rect.right > window.innerWidth - margin) setShift((s) => s + window.innerWidth - margin - rect.right);

    if (rect.bottom > window.innerHeight - margin) {
      setFlipY(true);
    }
  }, [open, submenu]);

  if (!shown.length) return null;
  const host = sheetHost();
  const portal = (node: ReactNode) => (host ? createPortal(node, host) : node);
  return (
    <div className={`menu${className ? ` ${className}` : ""}`} ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className={`quiet menu-button${trigger ? " has-label" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {trigger ?? <Icon name="more" size={18} />}
      </button>
      {/* On a phone the menu is a sheet over a dimmed page; tapping the page closes it. */}
      {open && portal(<div className="menu-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />)}
      {open && portal(
        <div
          className="menu-panel"
          role="menu"
          ref={panel}
          style={{
            ...(shift ? { transform: `translateX(${shift}px)` } : {}),
            ...(flipY ? { top: "auto", bottom: "100%", marginBottom: "0.25rem" } : {}),
          }}
        >
          {shown.map((item) => {
            if (!item.items) {
              return (
                <button
                  key={item.label}
                  role="menuitem"
                  className={item.danger ? "danger" : undefined}
                  onClick={() => runItem(item)}
                >
                  {item.label}
                </button>
              );
            }
            const expanded = submenu === item.label;
            const subItems = visible(item.items);
            // The group's buttons sit inside the panel, so the arrow keys reach them in order.
            return (
              <Fragment key={item.label}>
                <button
                  role="menuitem"
                  className={`menu-parent${item.danger ? " danger" : ""}`}
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(item)}
                >
                  {item.label}
                  <span className="menu-chevron" aria-hidden="true">{expanded ? "▴" : "▾"}</span>
                </button>
                {expanded && (
                  <div className="menu-sub" role="group" aria-label={item.label}>
                    {subItems.map((sub) => (
                      <button
                        key={sub.label}
                        role="menuitem"
                        className={sub.danger ? "danger" : undefined}
                        onClick={() => runItem(sub)}
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                )}
              </Fragment>
            );
          })}
          <button role="menuitem" className="menu-cancel" onClick={() => setOpen(false)}>Cancel</button>
        </div>,
      )}
    </div>
  );
}
