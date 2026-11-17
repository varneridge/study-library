// The desktop window's tabs as plain data: what is open, which is in front,
// which stay mounted and what was closed recently enough to bring back. Each
// change returns a new state, or the same one when nothing changes, so the
// rules can be tested without a window and a caller can tell a no-op apart.

export type Tab = { id: string; href: string; pinned?: boolean };

export type TabState = {
  tabs: Tab[];
  activeId: string;
  // Open tabs, the most recently in front first, which decides what stays mounted.
  recent: string[];
  // The addresses of closed tabs, the most recently closed last.
  closed: string[];
  // The number the next tab's id is made from, so that no id is ever reused.
  next: number;
};

export const HOME_TAB_ID = "home";
// The Home tab always shows the home page, so pressing it always leads back there.
export const HOME_HREF = "/";
export const MAX_CLOSED = 20;
export const MAX_MOUNTED = 5;

// A window opened at any other address keeps Home on the home page and shows
// that address in a tab of its own, by the same rule as a link followed from Home.
export function initialTabs(href: string): TabState {
  const home: TabState = {
    tabs: [{ id: HOME_TAB_ID, href: HOME_HREF, pinned: true }], activeId: HOME_TAB_ID, recent: [HOME_TAB_ID], closed: [], next: 1,
  };
  return followRoute(home, href);
}

// The tab in front, which falls back to Home if the state names one that is not open.
export function activeTab(state: TabState): Tab {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0];
}

function toFront(recent: string[], id: string): string[] {
  return [id, ...recent.filter((other) => other !== id)];
}

export function activate(state: TabState, id: string): TabState {
  if (id === state.activeId || !state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, activeId: id, recent: toFront(state.recent, id) };
}

// A new tab goes at the end. One opened in the background, as a middle-click
// opens it, waits there unmounted until it is first brought to the front.
export function openTab(state: TabState, href: string, background = false): TabState {
  const tab: Tab = { id: `t${state.next}`, href };
  const opened = { ...state, tabs: [...state.tabs, tab], next: state.next + 1 };
  return background ? opened : { ...opened, activeId: tab.id, recent: toFront(state.recent, tab.id) };
}

// Home cannot be closed. Closing the tab in front brings forward the one to
// its right, or the one to its left when it was the last, as a browser does.
export function closeTab(state: TabState, id: string): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  const tab = state.tabs[index];
  if (!tab || tab.pinned) return state;
  const tabs = state.tabs.filter((other) => other.id !== id);
  const closed = [...state.closed, tab.href].slice(-MAX_CLOSED);
  const recent = state.recent.filter((other) => other !== id);
  if (id !== state.activeId) return { ...state, tabs, closed, recent };
  const next = tabs[Math.min(index, tabs.length - 1)];
  return { ...state, tabs, closed, activeId: next.id, recent: toFront(recent, next.id) };
}

export function reopenTab(state: TabState): TabState {
  if (state.closed.length === 0) return state;
  const href = state.closed[state.closed.length - 1];
  return openTab({ ...state, closed: state.closed.slice(0, -1) }, href);
}

// A move within the tab in front, by a link, Back or a redirect, takes that
// tab with it, except that Home stays on the home page, so a move away from it
// opens a fresh tab in front instead.
export function followRoute(state: TabState, href: string): TabState {
  const front = activeTab(state);
  if (front.href === href) return state;
  if (front.id === HOME_TAB_ID) return openTab(state, href);
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === front.id ? { ...tab, href } : tab)) };
}

// The tabs kept mounted: the one in front and those most recently in front before it.
export function mountedTabIds(state: TabState): string[] {
  const open = new Set(state.tabs.map((tab) => tab.id));
  return [state.activeId, ...state.recent.filter((id) => id !== state.activeId && open.has(id))].slice(0, MAX_MOUNTED);
}

// The tabs saved before a reload, checked piece by piece, with the tab in
// front following the address the window reloaded at. Anything that does not
// hold together starts again from Home alone, because a broken save should
// never leave the window without its pinned tab.
export function restoreTabs(saved: string | null, href: string): TabState {
  let raw: unknown;
  try {
    raw = JSON.parse(saved ?? "");
  } catch {
    return initialTabs(href);
  }
  const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const tabs: Tab[] = (Array.isArray(data.tabs) ? data.tabs : [])
    .filter((item): item is Tab => Boolean(item) && typeof item.id === "string" && typeof item.href === "string")
    .map((item) => ({ id: item.id, href: item.href }));
  const ids = new Set(tabs.map((tab) => tab.id));
  if (tabs[0]?.id !== HOME_TAB_ID || ids.size !== tabs.length) return initialTabs(href);
  const activeId = typeof data.activeId === "string" && ids.has(data.activeId) ? data.activeId : HOME_TAB_ID;
  const numbers = tabs.map((tab) => Number(/^t(\d+)$/.exec(tab.id)?.[1] ?? 0));
  const state: TabState = {
    tabs: [{ ...tabs[0], href: HOME_HREF, pinned: true }, ...tabs.slice(1)],
    activeId,
    recent: toFront([...new Set(strings(data.recent))].filter((id) => ids.has(id)), activeId),
    closed: strings(data.closed).slice(-MAX_CLOSED),
    next: Math.max(...numbers) + 1,
  };
  return followRoute(state, href);
}
