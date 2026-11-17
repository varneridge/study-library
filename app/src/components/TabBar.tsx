// The desktop window's tabs, in the manner of Zotero's: Home is pinned on the
// left and cannot be closed, anything else opens beside it, and the five most
// recently shown stay mounted, so a reading or a long page keeps its place.
// The rules live in lib/tabs as plain data, and this file joins them to the
// router, the keyboard and the mouse. None of it runs outside the desktop window.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { confirmLeave, href, navigate, routeOf, type Route } from "../lib/router";
import { TAB_HIDDEN_EVENT } from "../lib/shell";
import {
  activate, activeTab, closeTab, followRoute, initialTabs, mountedTabIds, openTab, reopenTab, restoreTabs,
  type Tab, type TabState,
} from "../lib/tabs";
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
function snapshot(pane: HTMLElement | undefined): Snapshot {
  const boxes: [Element, number, number][] = [];
  if (pane) {
    const walker = document.createTreeWalker(pane, NodeFilter.SHOW_ELEMENT);
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

  const commands = useMemo<TabCommands>(() => {
    const commit = (next: TabState) => {
      const current = live.current;
      if (next === current) return;
      if (next.activeId !== current.activeId) {
        const pane = panes.current.get(current.activeId);
        scrolls.current.set(current.activeId, snapshot(pane));
        pane?.dispatchEvent(new CustomEvent(TAB_HIDDEN_EVENT, { bubbles: true, detail: { tab: current.activeId } }));
      }
      // A tab that is no longer mounted starts afresh at the top when it returns.
      const kept = new Set(mountedTabIds(next));
      for (const id of [...scrolls.current.keys()]) if (!kept.has(id)) scrolls.current.delete(id);
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
  }, [state.activeId]);

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
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || !event.ctrlKey || event.shiftKey || event.altKey) return;
      const to = appLink(event);
      if (!to) return;
      event.preventDefault();
      event.stopPropagation();
      commands.open(to, true);
    };
    // Taken in the capture phase, before any page sees them, and always kept
    // from Edge, so that a held Ctrl+W never closes the window itself.
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const key = event.key.toLowerCase();
      let act: (() => void) | null = null;
      if (key === "t") act = event.shiftKey ? commands.reopen : commands.openNew;
      else if (key === "w" && !event.shiftKey) act = () => void commands.close(live.current.activeId);
      if (!act) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) act();
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
  calendar: "Calendar",
  jobs: "Job search",
};

function field(row: unknown, key: string): string | null {
  const value = row && typeof row === "object" ? (row as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function lookUp(table: string, id: string): Promise<unknown> {
  try {
    return await db.table(table).get(id);
  } catch {
    return undefined;
  }
}

async function nameFor(route: Route): Promise<string | null> {
  switch (route.view) {
    case "reader":
      return field(await lookUp("items", route.id), "title");
    case "week":
      return field(await lookUp("weeks", route.id), "title");
    case "session":
      return field(await lookUp("sessions", route.id), "title");
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

// A tab is named for what it shows, from the library on this device, and
// falls back to the kind of page while that is still being looked up.
function useTabTitle(route: Route): string {
  const key = href(route);
  const named = useLiveQuery(() => nameFor(route), [key]);
  return named ?? FALLBACK_TITLES[route.view];
}

function TabItem({ tab, onSelect, onClose, onKeyDown }: {
  tab: TabView; onSelect: () => void; onClose: () => void; onKeyDown: (event: React.KeyboardEvent) => void;
}) {
  const title = useTabTitle(tab.route);
  const homeTitle = title === "Home" ? "Home" : `Home: ${title}`;
  // The middle button closes a tab, as in a browser, and is kept from
  // starting the page's autoscroll when it is pressed.
  return (
    <div
      role="none"
      className={`sl-tab${tab.active ? " is-active" : ""}${tab.pinned ? " is-pinned" : ""}`}
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
        {tab.pinned
          ? <><Icon name="home" size={16} /><span className="sr-only">{homeTitle}</span></>
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

export function DesktopTabBar({ tabs, commands }: { tabs: TabView[]; commands: TabCommands }) {
  const list = useRef<HTMLDivElement>(null);
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
    <div className="sl-tabs">
      <div className="sl-tabs-list" role="tablist" aria-label="Open tabs" ref={list}>
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
    </div>
  );
}
