// The desktop window's tabs, in the manner of Zotero's: Home is pinned on the
// left and cannot be closed, anything else opens beside it, and the five most
// recently shown stay mounted, so a reading or a long page keeps its place.
// The strip is the window's top row, and in the frameless window it carries
// the window controls on its right, as Windows Terminal and File Explorer do,
// with the empty stretch between them dragging the window.
// The rules live in lib/tabs as plain data, and this file joins them to the
// router, the keyboard and the mouse, keeping every link to the app inside the
// window rather than letting Edge open a tab or window of its own. Back and
// Forward sit at the left of the strip, as Edge puts them beside its address
// bar, because the frameless window has no browser toolbar to carry them. None
// of it runs outside the desktop window.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { sessionLabel, weekCode } from "../lib/modules";
import { confirmLeave, href, navigate, routeOf, type Route } from "../lib/router";
import { isFrameless, TAB_HIDDEN_EVENT, TAB_SHOWN_EVENT, windowControls } from "../lib/shell";
import {
  activate, activeTab, closeTab, followRoute, initialTabs, mountedTabIds, openTab, reopenTab, restoreTabs, tabKind, tabLabel,
  type Tab, type TabState,
} from "../lib/tabs";
import type { SessionRow, WeekRow } from "../lib/types";
import { hasOpenOverlay } from "../lib/ui";
import { Icon } from "./icons";
import "./TabBar.css";

// A new tab opens on search, as a browser's opens on its search box.
const NEW_TAB_HREF = href({ view: "search" });
const STORE_KEY = "sl-tabs";

export type TabView = Tab & { route: Route; active: boolean };

export type TabCommands = {
  activate(id: string): void;
  open(to: string, background?: boolean): void;
  openNew(): void;
  reopen(): void;
  close(id: string): Promise<void>;
};

type Snapshot = { y: number; boxes: [Element, number, number][] };

// Where the window and every scrolled box inside a pane stand, taken while the
// pane is still shown, because a box hidden with display: none can lose its place.
// A box marked data-own-place, with everything inside it, keeps its place itself
// and is left out, since it is told when its tab is shown again (TAB_SHOWN_EVENT).
function snapshot(pane: HTMLElement | undefined): Snapshot {
  const boxes: [Element, number, number][] = [];
  if (pane) {
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => ((node as Element).hasAttribute("data-own-place") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const box = node as Element;
      if (box.scrollTop || box.scrollLeft) boxes.push([box, box.scrollTop, box.scrollLeft]);
    }
  }
  return { y: window.scrollY, boxes };
}

function restore(saved: Snapshot | undefined): void {
  for (const [box, top, left] of saved?.boxes ?? []) {
    if (box.isConnected) box.scrollTo(left, top);
  }
  window.scrollTo(0, saved?.y ?? 0);
}

// The field that had the cursor when its tab was put away, and where the cursor
// stood in it, so that typing can go on when the tab comes back.
type Held = { element: HTMLElement; start: number | null; end: number | null };

function isField(element: HTMLElement): boolean {
  return element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName);
}

function holdFocus(element: HTMLElement): Held {
  try {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return { element, start: element.selectionStart, end: element.selectionEnd };
    }
  } catch {
    // An input of a kind that has no cursor, such as a number, throws on asking.
  }
  return { element, start: null, end: null };
}

// Given back once the tab is shown and laid out, and never over a dialog that
// opened in the meantime. A page built on ProseMirror puts its own caret back on focus.
function resumeFocus(held: Held | undefined, pane: HTMLElement | undefined): void {
  if (!held || !pane?.contains(held.element) || hasOpenOverlay()) return;
  held.element.focus({ preventScroll: true });
  if (held.start === null || held.end === null) return;
  try {
    (held.element as HTMLInputElement).setSelectionRange(held.start, held.end);
  } catch {
    // Left where focus put it.
  }
}

function readStore(): string | null {
  try {
    return sessionStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function writeStore(state: TabState): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    // Without storage the tabs last only until the window reloads.
  }
}

// The non-pinned tab beside the one in front, skipping Home so Ctrl+Tab and
// Ctrl+Shift+Tab cycle only through open pages; Home is still reached by click.
function neighbour(state: TabState, step: 1 | -1): string {
  const pool = state.tabs.filter((tab) => !tab.pinned);
  if (!pool.length) return state.activeId;
  const index = pool.findIndex((tab) => tab.id === state.activeId);
  if (index === -1) return pool[step > 0 ? 0 : pool.length - 1].id;
  return pool[(index + step + pool.length) % pool.length].id;
}

export function useDesktopTabs(route: Route, enabled: boolean) {
  const routeHref = href(route);
  const [state, setState] = useState<TabState>(() => (enabled ? restoreTabs(readStore(), routeHref) : initialTabs(routeHref)));
  // A move within the tab in front, by a link, Back or a redirect, carries that
  // tab along. It is applied during render, so that the page never draws once
  // at its old address before catching up.
  const [seen, setSeen] = useState(routeHref);
  if (enabled && routeHref !== seen) {
    setSeen(routeHref);
    setState((current) => followRoute(current, routeHref));
  }

  const live = useRef(state);
  useLayoutEffect(() => {
    live.current = state;
  }, [state]);
  const panes = useRef(new Map<string, HTMLElement>());
  const scrolls = useRef(new Map<string, Snapshot>());
  const routes = useRef(new Map<string, Route>());
  // The last field to take the cursor in each pane, and the one put away with its tab.
  const fields = useRef(new Map<string, HTMLElement>());
  const held = useRef(new Map<string, Held>());

  const commands = useMemo<TabCommands>(() => {
    const commit = (next: TabState) => {
      const current = live.current;
      if (next === current) return;
      if (next.activeId !== current.activeId) {
        const pane = panes.current.get(current.activeId);
        scrolls.current.set(current.activeId, snapshot(pane));
        const field = fields.current.get(current.activeId);
        if (field && pane?.contains(field)) held.current.set(current.activeId, holdFocus(field));
        else held.current.delete(current.activeId);
        pane?.dispatchEvent(new CustomEvent(TAB_HIDDEN_EVENT, { bubbles: true, detail: { tab: current.activeId } }));
      }
      // A tab that is no longer mounted starts afresh at the top when it returns.
      const kept = new Set(mountedTabIds(next));
      for (const map of [scrolls.current, fields.current, held.current]) {
        for (const id of [...map.keys()]) if (!kept.has(id)) map.delete(id);
      }
      live.current = next;
      setState(next);
      const target = activeTab(next).href;
      // A move between tabs leaves no page behind, so no guard is asked.
      if (target !== activeTab(current).href) void navigate(routeOf(target), { replace: true, guard: false });
    };
    return {
      activate: (id) => commit(activate(live.current, id)),
      open: (to, background = false) => commit(openTab(live.current, to, background)),
      openNew: () => commit(openTab(live.current, NEW_TAB_HREF)),
      reopen: () => commit(reopenTab(live.current)),
      close: async (id) => {
        const tab = live.current.tabs.find((other) => other.id === id);
        if (!tab || tab.pinned) return;
        // Closing the tab in front does leave its page, so its guard may object.
        if (id === live.current.activeId && !(await confirmLeave())) return;
        commit(closeTab(live.current, id));
      },
    };
  }, []);

  // The tab brought forward goes back to where it was left, and a new one starts at the top.
  const shownBefore = useRef(state.activeId);
  useLayoutEffect(() => {
    if (shownBefore.current === state.activeId) return;
    shownBefore.current = state.activeId;
    restore(scrolls.current.get(state.activeId));
    // Told once the tab is shown and laid out, for a page that keeps its own place.
    const pane = panes.current.get(state.activeId);
    pane?.dispatchEvent(new CustomEvent(TAB_SHOWN_EVENT, { bubbles: true, detail: { tab: state.activeId } }));
    resumeFocus(held.current.get(state.activeId), pane);
    held.current.delete(state.activeId);
  }, [state.activeId]);

  // Which field in each pane had the cursor last. A tab clicked with the mouse
  // takes focus itself, so the field is remembered as it is entered, and a
  // button entered after it means the cursor was no longer in a field.
  useEffect(() => {
    if (!enabled) return;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      for (const [id, pane] of panes.current) {
        if (!pane.contains(target)) continue;
        if (isField(target)) fields.current.set(id, target);
        else fields.current.delete(id);
        return;
      }
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, [enabled]);

  useEffect(() => {
    if (enabled) writeStore(state);
  }, [enabled, state]);

  useEffect(() => {
    if (!enabled) return;
    // An address inside the app that a link points to, or null for anything
    // else: another site, a download, or a link meant for a window of its own.
    const appLink = (event: MouseEvent): string | null => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.hasAttribute("download")) return null;
      if (link.target && link.target !== "_self") return null;
      const url = new URL(link.href);
      return url.origin === location.origin && url.pathname === "/" ? `/${url.search}` : null;
    };
    // A middle-click or Ctrl+click on a link opens it in a tab behind this
    // one, as a browser would, instead of in a separate Edge window.
    const onAuxClick = (event: MouseEvent) => {
      if (event.button !== 1) return;
      const to = appLink(event);
      if (!to) return;
      event.preventDefault();
      commands.open(to, true);
    };
    // Shift+click, which Edge would answer with a window of its own, and
    // Ctrl+Shift+click open the link in a tab in front instead, so that no
    // page of the app ever leaves this window.
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.altKey || event.metaKey || !(event.ctrlKey || event.shiftKey)) return;
      const to = appLink(event);
      if (!to) return;
      event.preventDefault();
      event.stopPropagation();
      commands.open(to, event.ctrlKey && !event.shiftKey);
    };
    // Taken in the capture phase, before any page sees them, and always kept
    // from Edge, so that a held Ctrl+W never closes the window itself.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      let act: (() => void) | null = null;
      if (key === "t") act = event.shiftKey ? commands.reopen : commands.openNew;
      else if (key === "w" && !event.shiftKey) act = () => void commands.close(live.current.activeId);
      else if (key === "tab") act = () => commands.activate(neighbour(live.current, event.shiftKey ? -1 : 1));
      if (!act) return;
      event.preventDefault();
      event.stopPropagation();
      // Holding Ctrl+Tab keeps stepping through the tabs, whereas a held Ctrl+T or Ctrl+W acts once.
      if (!event.repeat || key === "tab") act();
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("auxclick", onAuxClick, true);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("auxclick", onAuxClick, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [enabled, commands]);

  // Each address is parsed once, so a hidden page keeps the same route object
  // from one render to the next and its effects do not run again for nothing.
  const routeFor = (to: string): Route => {
    let found = routes.current.get(to);
    if (!found) {
      found = to === routeHref ? route : routeOf(to);
      routes.current.set(to, found);
    }
    return found;
  };
  if (routes.current.size > 50) {
    const open = new Set(state.tabs.map((tab) => tab.href));
    for (const key of [...routes.current.keys()]) if (!open.has(key)) routes.current.delete(key);
  }

  const mounted = new Set(mountedTabIds(state));
  const views: TabView[] = state.tabs.map((tab) => ({ ...tab, route: routeFor(tab.href), active: tab.id === state.activeId }));
  return {
    tabs: views,
    commands,
    activeRoute: routeFor(activeTab(state).href),
    panes: views.filter((view) => mounted.has(view.id)),
    paneRef: (id: string) => (element: HTMLDivElement | null) => {
      if (element) panes.current.set(id, element);
      else panes.current.delete(id);
    },
  };
}

const FALLBACK_TITLES: Record<Route["view"], string> = {
  home: "Home",
  module: "Module",
  week: "Week",
  reader: "Reading",
  essay: "Essay",
  assessment: "Assessment",
  across: "This week",
  session: "Session",
  search: "Search",
  settings: "Settings",
  tasks: "To do",
  calendar: "Calendar",
  jobs: "Job search",
};

function field(row: unknown, key: string): string | null {
  const value = row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function lookUp(table: string, id: string | null): Promise<unknown> {
  if (!id) return undefined;
  try {
    return await db.table(table).get(id);
  } catch {
    return undefined;
  }
}

// The short name the week's own page uses for it, such as "Week 3" or a
// section's name, so that a tab and the page it shows agree.
function placeOf(week: unknown): string | null {
  if (!week || typeof week !== "object") return null;
  try {
    return weekCode(week as WeekRow) || null;
  } catch {
    return null;
  }
}

async function codeOf(week: unknown): Promise<string | null> {
  return field(await lookUp("modules", field(week, "module_id")), "code");
}

async function nameFor(route: Route): Promise<string | null> {
  switch (route.view) {
    case "reader":
      return field(await lookUp("items", route.id), "title");
    case "week": {
      const week = await lookUp("weeks", route.id);
      return tabLabel(await codeOf(week), placeOf(week)) ?? field(week, "title");
    }
    case "session": {
      // A session is named within its week, as "HY335 (Week 3 Seminar)", so
      // that it never reads the same as the tab of the week it belongs to.
      const session = await lookUp("sessions", route.id);
      const week = await lookUp("weeks", field(session, "week_id"));
      const kind = field(session, "kind");
      const name = field(session, "title") ?? (kind ? sessionLabel(kind as SessionRow["kind"]) : null);
      const place = [placeOf(week), name].filter(Boolean).join(" ");
      return tabLabel(await codeOf(week), place);
    }
    case "module":
    case "assessment":
    case "essay": {
      const code = field(await lookUp("modules", route.id), "code");
      if (!code || route.view === "module") return code;
      return `${code} ${route.view === "essay" ? "essay" : "assessment"}`;
    }
    case "search":
      return route.q ? `Search: ${route.q}` : null;
    default:
      return null;
  }
}

// The titles found so far, by address, so that a tab drawn again, or one whose
// page comes back to an address it showed before, never shows the kind of page
// in place of its name while the lookup runs. The oldest are dropped past a limit.
const TITLE_LIMIT = 200;
const knownTitles = new Map<string, string>();

// A tab is named for what it shows, from the library on this device, and
// falls back to the kind of page only when nothing has been found for it yet.
function useTabTitle(route: Route): string {
  const key = href(route);
  const named = useLiveQuery(() => nameFor(route), [key]);
  if (named) {
    knownTitles.delete(key);
    knownTitles.set(key, named);
    if (knownTitles.size > TITLE_LIMIT) knownTitles.delete(knownTitles.keys().next().value as string);
  }
  return named ?? knownTitles.get(key) ?? FALLBACK_TITLES[route.view];
}

function TabItem({ tab, onSelect, onClose, onKeyDown }: {
  tab: TabView; onSelect: () => void; onClose: () => void; onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const title = useTabTitle(tab.route);
  const kind = tabKind(tab.route.view);
  const homeTitle = title === "Home" ? "Home" : `Home: ${title}`;
  // The middle button closes a tab, as in a browser, and is kept from
  // starting the page's autoscroll when it is pressed.
  return (
    <div
      role="none"
      className={`sl-tab${tab.active ? " is-active" : ""}${tab.pinned ? " is-pinned" : ""}`}
      data-kind={kind}
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || tab.pinned) return;
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={tab.active}
        tabIndex={tab.active ? 0 : -1}
        className="sl-tab-title"
        title={tab.pinned ? homeTitle : title}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      >
        <Icon name={kind} size={16} />
        {tab.pinned
          ? <span className="sr-only">{homeTitle}</span>
          : <span className="sl-tab-label">{title}</span>}
      </button>
      {!tab.pinned && (
        <button type="button" className="sl-tab-close" tabIndex={-1} aria-label={`Close ${title}`} title="Close tab (Ctrl+W)" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}

// Windows' own caption glyphs are drawn ten pixels square with hairline
// strokes, so these match them rather than borrowing the app's heavier icons.
function Glyph({ shape }: { shape: "minimise" | "maximise" | "restore" | "close" }) {
  const paths = {
    minimise: "M0 5.5h10",
    maximise: "M0.5 0.5h9v9h-9z",
    restore: "M0.5 2.5h7v7h-7z M2.5 2.5v-2h7v7h-2",
    close: "M0.5 0.5l9 9M9.5 0.5l-9 9",
  };
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" focusable="false">
      <path d={paths[shape]} fill="none" stroke="currentColor" strokeWidth="1" />
    </svg>
  );
}

// Edge's own arrows are a shaft with an open head, drawn at a hairline weight
// to sit with the caption glyphs rather than with the page's heavier icons.
function Arrow({ direction }: { direction: "back" | "forward" }) {
  const path = direction === "back" ? "M13 8H3.5M7.5 3.5L3 8l4.5 4.5" : "M3 8h9.5M8.5 3.5L13 8l-4.5 4.5";
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type NavigationLike = {
  canGoBack: boolean;
  canGoForward: boolean;
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
};

// Whether there is anywhere to step back or forward to. Edge's Navigation API
// says so and announces every change of entry, so the arrows grey out as the
// browser's do; anywhere without it the arrows simply stay available, because
// a step past either end of the history does nothing harmful.
function useHistorySteps(): { back: boolean; forward: boolean } {
  const navigation = (window as unknown as { navigation?: NavigationLike }).navigation;
  const [steps, setSteps] = useState(() => ({
    back: navigation ? navigation.canGoBack : true,
    forward: navigation ? navigation.canGoForward : true,
  }));
  useEffect(() => {
    if (!navigation) return;
    const update = () => setSteps({ back: navigation.canGoBack, forward: navigation.canGoForward });
    update();
    navigation.addEventListener("currententrychange", update);
    return () => navigation.removeEventListener("currententrychange", update);
  }, [navigation]);
  return steps;
}

// Back and Forward walk the window's own history, so the router's guard, its
// remembered scroll positions and the tab in front all follow exactly as they
// do for Alt+Left and Alt+Right.
function HistoryButtons() {
  const steps = useHistorySteps();
  return (
    <div className="sl-history" role="group" aria-label="History">
      <button type="button" className="sl-history-button" aria-label="Back" title="Back (Alt+Left arrow)"
        disabled={!steps.back} onClick={() => window.history.back()}>
        <Arrow direction="back" />
      </button>
      <button type="button" className="sl-history-button" aria-label="Forward" title="Forward (Alt+Right arrow)"
        disabled={!steps.forward} onClick={() => window.history.forward()}>
        <Arrow direction="forward" />
      </button>
    </div>
  );
}

// Minimise, maximise and close for the frameless window. Closing asks the page
// in front first, as closing its tab does, so that unsaved work is not lost.
function WindowControls({ maximised, onToggle }: { maximised: boolean; onToggle: () => void }) {
  return (
    <div className="sl-window-controls">
      <button type="button" className="sl-window-button" aria-label="Minimise" title="Minimise"
        onClick={() => void windowControls().then((api) => api?.minimize())}>
        <Glyph shape="minimise" />
      </button>
      <button type="button" className="sl-window-button" aria-label={maximised ? "Restore" : "Maximise"}
        title={maximised ? "Restore" : "Maximise"} onClick={onToggle}>
        <Glyph shape={maximised ? "restore" : "maximise"} />
      </button>
      <button type="button" className="sl-window-button is-close" aria-label="Close" title="Close"
        onClick={() => void confirmLeave().then(async (leave) => leave && (await windowControls())?.close())}>
        <Glyph shape="close" />
      </button>
    </div>
  );
}

// A press on the empty stretch is handed to Windows as a press on a title bar,
// so that Windows moves the window itself, with Aero Snap, Win+Arrow and a
// maximised window restored as it is dragged, rather than pywebview moving it
// pixel by pixel. Windows keeps the mouse until the press ends, so the page
// never sees the double-click, and its second press maximises here instead.
// start_drag is optional because a desktop.py from before it leaves the
// stretch inert rather than throwing.
function dragWindow(event: React.MouseEvent, toggle: () => void): void {
  if (event.button !== 0) return;
  event.preventDefault();
  if (event.detail === 2) toggle();
  else void windowControls().then((api) => (api as { start_drag?: () => unknown } | null | undefined)?.start_drag?.());
}

// Whether the frameless window is maximised, asked again after every resize,
// since Win+Up, a snap or a double-click can each change it.
function useMaximised(frameless: boolean): [boolean, () => void] {
  const [maximised, setMaximised] = useState(false);
  useEffect(() => {
    if (!frameless) return;
    let live = true;
    const check = () => void windowControls().then((api) => api?.is_maximized()).then((now) => {
      if (live && typeof now === "boolean") setMaximised(now);
    });
    check();
    window.addEventListener("resize", check);
    return () => {
      live = false;
      window.removeEventListener("resize", check);
    };
  }, [frameless]);
  const toggle = () => void windowControls().then((api) => api?.toggle_maximize()).then((now) => {
    if (typeof now === "boolean") setMaximised(now);
  });
  return [maximised, toggle];
}

// How far the strip's edge fades, which TabBar.css draws as 1.5rem, so a tab
// brought into view is scrolled clear of the fade and not left half faded.
const FADE_PX = 24;

export function DesktopTabBar({ tabs, commands }: { tabs: TabView[]; commands: TabCommands }) {
  const frameless = isFrameless();
  const [maximised, toggleMaximised] = useMaximised(frameless);
  const list = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState<"start" | "end" | "both" | undefined>();
  const activeId = tabs.find((tab) => tab.active)?.id;
  // The tab in front is always scrolled into view when the row overflows.
  useEffect(() => {
    const box = list.current;
    const tab = box?.querySelector<HTMLElement>(".sl-tab.is-active");
    if (!box || !tab) return;
    const inner = tab.getBoundingClientRect();
    const outer = box.getBoundingClientRect();
    if (inner.left < outer.left + FADE_PX) box.scrollLeft -= outer.left + FADE_PX - inner.left;
    else if (inner.right > outer.right - FADE_PX) box.scrollLeft += inner.right - (outer.right - FADE_PX);
  }, [activeId, tabs.length]);
  // The edges fade only on a side that has more tabs beyond it.
  useEffect(() => {
    const box = list.current;
    if (!box) return;
    const measure = () => {
      const start = box.scrollLeft > 1;
      const end = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
      setFade(start && end ? "both" : start ? "start" : end ? "end" : undefined);
    };
    measure();
    box.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => {
      box.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [tabs.length]);
  const select = (tab: TabView) => {
    // Pressing Home while it is already in front takes it back to the home page.
    if (tab.pinned && tab.active) void navigate({ view: "home" });
    else commands.activate(tab.id);
  };
  // The arrow keys, Home and End move between tabs, and Delete closes the
  // focused one, so the strip works without a mouse.
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = tabs.length - 1;
    if (event.key === "Delete" && !tabs[index].pinned) {
      event.preventDefault();
      void commands.close(tabs[index].id);
      return;
    }
    const moves: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    commands.activate(tabs[next].id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className={`sl-tabs${frameless ? " is-frameless" : ""}`}>
      <HistoryButtons />
      <div className="sl-tabs-list" role="tablist" aria-label="Open tabs" ref={list} data-fade={fade}>
        {tabs.map((tab, index) => (
          <TabItem
            key={tab.id}
            tab={tab}
            onSelect={() => select(tab)}
            onClose={() => void commands.close(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          />
        ))}
      </div>
      <button type="button" className="sl-tab-new" aria-label="New tab" title="New tab (Ctrl+T)" onClick={commands.openNew}>
        <Icon name="plus" size={16} />
      </button>
      <div className="sl-tabs-drag" aria-hidden="true"
        onMouseDown={frameless ? (event) => dragWindow(event, toggleMaximised) : undefined} />
      {frameless && <WindowControls maximised={maximised} onToggle={toggleMaximised} />}
    </div>
  );
}
