import { Icon } from "./icons";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { sheetHost, useCloseOnBack } from "../lib/ui";

// An item either runs an action or, when it has items of its own, opens them
// as a group. Groups go one level deep. On a wider screen a group opens as a
// flyout beside its item, as a Windows context menu does, so the menu never
// changes height under the pointer; on a phone, where the menu is a sheet and
// there is no room beside it, the group opens in place beneath its item.
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

const SHEET_QUERY = "(max-width: 44rem)";
// How long the pointer rests on an item before its flyout opens or another closes,
// long enough that sweeping across the menu does not flicker groups open.
const HOVER_DELAY = 200;
const EDGE_MARGIN = 8;

const sideways = () => typeof window !== "undefined" && !window.matchMedia(SHEET_QUERY).matches;

// The items the arrow keys can reach in one list, leaving out the sheet's own
// Cancel, which is hidden on a wider screen and so would trap the focus.
function reachable(list: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(list?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']:not([disabled])") ?? [])
    .filter((button) => button.getClientRects().length > 0);
}

// A danger item ends the list, so one rule sets it apart from what comes
// before it, rather than a line above every dangerous item.
function withSeparator(list: MenuItem[], render: (item: MenuItem) => ReactNode): ReactNode[] {
  const firstDanger = list.findIndex((item) => item.danger);
  return list.map((item, index) => (
    <Fragment key={item.label}>
      {index === firstDanger && index > 0 && <div className="menu-separator" role="separator" />}
      {render(item)}
    </Fragment>
  ));
}

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
  const [flyoutAt, setFlyoutAt] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const flyout = useRef<HTMLDivElement>(null);
  const parents = useRef(new Map<string, HTMLButtonElement>());
  const hoverTimer = useRef<number | undefined>(undefined);
  const focusFlyout = useRef(false);
  const actionSelectedRef = useRef(false);
  // The key handler is registered once per opening, so it reads these through refs.
  const submenuRef = useRef<string | null>(null);
  const sidewaysRef = useRef(false);
  const [shift, setShift] = useState(0);
  const [flipY, setFlipY] = useState(false);
  const shown = items.filter(showable);
  const flyouts = sideways();
  submenuRef.current = submenu;
  sidewaysRef.current = flyouts;

  useCloseOnBack(open, () => setOpen(false));

  useEffect(() => {
    if (!open) {
      setSubmenu(null);
      window.clearTimeout(hoverTimer.current);
      return;
    }
    actionSelectedRef.current = false;

    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!ref.current?.contains(target) && !panel.current?.contains(target) && !flyout.current?.contains(target)) {
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null;
      const inFlyout = Boolean(flyout.current && active && flyout.current.contains(active));
      const backToParent = () => {
        const parent = submenuRef.current ? parents.current.get(submenuRef.current) : undefined;
        setSubmenu(null);
        parent?.focus();
      };
      if (e.key === "Escape") {
        // Escape closes the flyout first, as in Windows, and the menu after it.
        if (sidewaysRef.current && submenuRef.current) {
          e.preventDefault();
          backToParent();
          return;
        }
        setOpen(false);
        return;
      }
      if (sidewaysRef.current && e.key === "ArrowRight" && active?.dataset.menuGroup) {
        e.preventDefault();
        focusFlyout.current = true;
        setSubmenu(active.dataset.menuGroup);
        return;
      }
      if (sidewaysRef.current && e.key === "ArrowLeft" && inFlyout) {
        e.preventDefault();
        backToParent();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const list = reachable(inFlyout ? flyout.current : panel.current);
      if (!list.length) return;
      const index = list.indexOf(active as HTMLButtonElement);
      if (e.key === "Home") list[0]?.focus();
      else if (e.key === "End") list[list.length - 1]?.focus();
      else if (e.key === "ArrowDown") list[index < list.length - 1 ? index + 1 : 0]?.focus();
      else list[index > 0 ? index - 1 : list.length - 1]?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.clearTimeout(hoverTimer.current);
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
    window.clearTimeout(hoverTimer.current);
    setSubmenu((current) => (current === item.label ? null : item.label));
  };

  // Resting on a group opens its flyout and resting on any other item closes
  // it, so the pointer can travel into a flyout without it shutting behind it.
  const hover = (next: string | null) => {
    if (!flyouts) return;
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setSubmenu(next), HOVER_DELAY);
  };
  const stayPut = () => window.clearTimeout(hoverTimer.current);

  // Keep the panel on screen when its button sits near an edge or near the bottom.
  // It is measured again when a group opens in place, because the panel grows.
  // Once flipped it stays flipped while open, since a flipped panel always seems
  // to fit and measuring it would otherwise send it back down past the edge.
  useLayoutEffect(() => {
    if (!open || !panel.current || !sideways()) {
      setShift(0);
      setFlipY(false);
      return;
    }
    const rect = panel.current.getBoundingClientRect();
    if (rect.left < EDGE_MARGIN) setShift((s) => s + EDGE_MARGIN - rect.left);
    else if (rect.right > window.innerWidth - EDGE_MARGIN) setShift((s) => s + window.innerWidth - EDGE_MARGIN - rect.right);

    if (rect.bottom > window.innerHeight - EDGE_MARGIN) {
      setFlipY(true);
    }
  }, [open, submenu]);

  // The flyout opens beside its item, on the right, or on the left when the
  // right has no room, and slides up only as far as it must to stay on
  // screen. It shares the panel's frame, so its place is worked out in that
  // frame's own coordinates and holds however the page is scrolled.
  useLayoutEffect(() => {
    setFlyoutAt(null);
    if (!open || !submenu || !flyouts) return;
    const parent = parents.current.get(submenu);
    const box = flyout.current;
    if (!parent || !box) return;
    const item = parent.getBoundingClientRect();
    const size = box.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(box).paddingTop) || 0;
    let left = item.right + 2;
    if (left + size.width > window.innerWidth - EDGE_MARGIN) left = item.left - 2 - size.width;
    left = Math.max(EDGE_MARGIN, left);
    let top = item.top - inset;
    if (top + size.height > window.innerHeight - EDGE_MARGIN) top = window.innerHeight - EDGE_MARGIN - size.height;
    top = Math.max(EDGE_MARGIN, top);
    const frame = box.offsetParent;
    if (frame instanceof HTMLElement && frame !== document.body) {
      const origin = frame.getBoundingClientRect();
      setFlyoutAt({
        left: left - origin.left - frame.clientLeft + frame.scrollLeft,
        top: top - origin.top - frame.clientTop + frame.scrollTop,
      });
    } else {
      setFlyoutAt({ left: left + window.scrollX, top: top + window.scrollY });
    }
  }, [open, submenu, flyouts]);

  // A flyout opened from the keyboard takes the focus once it is in place.
  useEffect(() => {
    if (!flyoutAt || !focusFlyout.current) return;
    focusFlyout.current = false;
    reachable(flyout.current)[0]?.focus();
  }, [flyoutAt]);

  if (!shown.length) return null;
  const host = sheetHost();
  const portal = (node: ReactNode) => (host ? createPortal(node, host) : node);
  const group = flyouts && submenu ? shown.find((item) => item.label === submenu && item.items) : undefined;

  const action = (item: MenuItem, inFlyout: boolean) => (
    <button
      role="menuitem"
      className={item.danger ? "danger" : undefined}
      onClick={() => runItem(item)}
      onMouseEnter={inFlyout ? stayPut : () => hover(null)}
    >
      {item.label}
    </button>
  );

  const entry = (item: MenuItem) => {
    if (!item.items) return action(item, false);
    const expanded = submenu === item.label;
    return (
      <>
        <button
          role="menuitem"
          ref={(element) => {
            if (element) parents.current.set(item.label, element);
            else parents.current.delete(item.label);
          }}
          data-menu-group={item.label}
          className={`menu-parent${item.danger ? " danger" : ""}${expanded ? " is-open" : ""}`}
          aria-haspopup={flyouts ? "menu" : undefined}
          aria-expanded={expanded}
          onClick={() => toggleGroup(item)}
          onMouseEnter={() => hover(item.label)}
        >
          {item.label}
          <span className={`menu-chevron${flyouts ? " is-side" : expanded ? " is-up" : ""}`} aria-hidden="true">
            <Icon name="down" size={12} />
          </span>
        </button>
        {/* In place, the group's buttons sit inside the panel, so the arrow keys reach them in order. */}
        {expanded && !flyouts && (
          <div className="menu-sub" role="group" aria-label={item.label}>
            {withSeparator(visible(item.items), (sub) => action(sub, false))}
          </div>
        )}
      </>
    );
  };

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
          {withSeparator(shown, entry)}
          <button role="menuitem" className="menu-cancel" onClick={() => setOpen(false)}>Cancel</button>
        </div>,
      )}
      {/* The flyout is the panel's sibling rather than its child, so the
          panel's own scrolling never clips it. */}
      {open && group?.items && portal(
        <div
          className="menu-panel menu-flyout"
          role="menu"
          aria-label={group.label}
          ref={flyout}
          onMouseEnter={stayPut}
          style={{
            right: "auto",
            bottom: "auto",
            left: flyoutAt?.left ?? 0,
            top: flyoutAt?.top ?? 0,
            visibility: flyoutAt ? undefined : "hidden",
          }}
        >
          {withSeparator(visible(group.items), (sub) => action(sub, true))}
        </div>,
      )}
    </div>
  );
}
