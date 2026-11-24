// Navigation state lives in the URL query, so every screen has a link and the
// app stays a single page that the service worker can serve offline.

import { useEffect, useLayoutEffect, useState, useTransition } from "react";
import { parseISO } from "./civilDate";
import { hasOpenOverlay } from "./ui";

// The footnote of an essay that a passage chosen in the reader is linked to. A footnote
// of "new:" and a key asks for a new one, which the word processor tab with that key adds.
export interface CiteTarget {
  module: string;
  essay?: string;
  footnote: string;
}

export type Route =
  | { view: "home" }
  | { view: "module"; id: string }
  | { view: "week"; id: string; folder?: string }
  // A reading, at a page, with a search, opened at one highlight (hl), or open to link a
  // passage to an essay's footnote (cite). With a cite, passage opens the reading as that
  // footnote's passage alone, with only the highlights it draws on.
  | { view: "reader"; id: string; page?: number; q?: string; hl?: string; cite?: CiteTarget; passage?: boolean }
  | { view: "essay"; id: string; essay?: string; q?: string }
  // A module's Assessment & essay page.
  | { view: "assessment"; id: string; essay?: string }
  | { view: "across"; term?: string; number?: number }
  | { view: "session"; id: string; rec?: string; t?: number; turn?: number }
  | { view: "search"; q?: string }
  | { view: "settings" }
  // The calendar: the date it is centred on, how it is shown, and the event whose sheet is open.
  | { view: "calendar"; date?: string; mode?: "month" | "week" | "day" | "agenda"; event?: string }
  // The to-do lists: the list shown and the task whose sheet is open.
  | { view: "tasks"; list?: string; task?: string }
  // The job search, kept apart from the study library.
  | { view: "jobs"; list?: "applications" | "shortlist"; app?: string; prospect?: string; edit?: boolean; newApp?: boolean; entry?: string; tab?: string };

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  if (params.get("connect") === "processor") {
    return { view: "settings" };
  }
  const view = params.get("v");
  const id = params.get("id") ?? "";
  switch (view) {
    case "module":
      return id ? { view, id } : { view: "home" };
    case "week": {
      const folder = params.get("folder");
      return id ? (folder ? { view, id, folder } : { view, id }) : { view: "home" };
    }
    case "assessment": {
      const essay = params.get("essay");
      return id ? (essay ? { view, id, essay } : { view, id }) : { view: "home" };
    }
    // The import page has gone. An old link to it opens its module, where
    // files dropped on the page go to the weeks in their names.
    case "import":
      return id ? { view: "module", id } : { view: "home" };
    case "essay": {
      const essay = params.get("essay");
      const q = params.get("q");
      if (!id) return { view: "home" };
      return {
        view,
        id,
        ...(essay ? { essay } : {}),
        ...(q ? { q } : {}),
      };
    }
    case "reader": {
      const pageStr = params.get("page");
      const pageNum = pageStr !== null && pageStr.trim() !== "" ? Number(pageStr) : NaN;
      const validPage = Number.isInteger(pageNum) && pageNum >= 0 ? pageNum : undefined;
      // A link to a footnote needs both the module and the footnote, so half of one is ignored.
      const citeModule = params.get("cm");
      const citeFootnote = params.get("cf");
      const citeEssay = params.get("ce");
      const cite = citeModule && citeFootnote
        ? { module: citeModule, footnote: citeFootnote, ...(citeEssay ? { essay: citeEssay } : {}) }
        : undefined;
      const hl = params.get("hl") || undefined;
      // The passage view is of a footnote's passage, so it needs the footnote to name one.
      const passage = cite !== undefined && params.get("pv") === "1";
      return id
        ? {
            view,
            id,
            page: validPage,
            q: params.get("q") ?? undefined,
            ...(hl ? { hl } : {}),
            ...(cite ? { cite } : {}),
            ...(passage ? { passage } : {}),
          }
        : { view: "home" };
    }
    case "across":
      return { view, term: params.get("term") ?? undefined, number: Number(params.get("n")) || undefined };
    case "session": {
      const tStr = params.get("t");
      const tNum = tStr !== null && tStr.trim() !== "" ? Number(tStr) : NaN;
      const validT = Number.isFinite(tNum) && tNum >= 0 ? tNum : undefined;

      const turnStr = params.get("turn");
      const turnNum = turnStr !== null && turnStr.trim() !== "" ? Number(turnStr) : NaN;
      const validTurn = Number.isInteger(turnNum) && turnNum >= 0 ? turnNum : undefined;

      const rec = params.get("rec") ?? undefined;
      return id
        ? { view, id, rec, t: validT, turn: validTurn }
        : { view: "home" };
    }
    case "search":
      return { view, q: params.get("q") ?? undefined };
    case "settings":
      return { view };
    case "calendar": {
      const d = params.get("date");
      const m = params.get("mode");
      const date = d && parseISO(d) ? d : undefined;
      const mode = m === "month" || m === "week" || m === "day" || m === "agenda" ? m : undefined;
      const event = params.get("event") || undefined;
      // Only what is present is set, so a parsed route equals the one that was linked.
      return { view, ...(date ? { date } : {}), ...(mode ? { mode } : {}), ...(event ? { event } : {}) };
    }
    case "tasks": {
      const list = params.get("list") || undefined;
      const task = params.get("task") || undefined;
      // Only what is present is set, so a parsed route equals the one that was linked.
      return { view, ...(list ? { list } : {}), ...(task ? { task } : {}) };
    }
    case "jobs": {
      const prospect = params.get("prospect") ?? undefined;
      const list = params.get("list") === "shortlist" || prospect ? "shortlist" : undefined;
      const app = params.get("app") ?? undefined;
      const edit = params.get("edit") === "1" ? true : undefined;
      const newApp = params.get("new") === "1" ? true : undefined;
      const entry = params.get("entry") ?? undefined;
      const tab = params.get("tab") ?? undefined;
      return { view, list, app, prospect, edit, newApp, entry, tab };
    }
    default:
      return { view: "home" };
  }
}

// The route an address inside the app leads to, such as one kept by a desktop tab.
export function routeOf(url: string): Route {
  return parseRoute(new URL(url, "http://localhost").search);
}

export function href(route: Route): string {
  const params = new URLSearchParams();
  if (route.view !== "home") params.set("v", route.view);
  if ("id" in route) params.set("id", route.id);
  if ((route.view === "assessment" || route.view === "essay") && route.essay) params.set("essay", route.essay);
  if (route.view === "week" && route.folder) params.set("folder", route.folder);
  if (route.view === "reader" && route.page !== undefined) params.set("page", String(route.page));
  if ((route.view === "reader" || route.view === "essay") && route.q) params.set("q", route.q);
  if (route.view === "reader") {
    if (route.hl) params.set("hl", route.hl);
    if (route.cite) {
      params.set("cm", route.cite.module);
      if (route.cite.essay) params.set("ce", route.cite.essay);
      params.set("cf", route.cite.footnote);
      if (route.passage) params.set("pv", "1");
    }
  }
  if (route.view === "session") {
    if (route.rec) params.set("rec", route.rec);
    if (route.t !== undefined) params.set("t", String(Math.floor(route.t)));
    if (route.turn !== undefined) params.set("turn", String(route.turn));
  }
  if (route.view === "search" && route.q) params.set("q", route.q);
  if (route.view === "across") {
    if (route.term) params.set("term", route.term);
    if (route.number) params.set("n", String(route.number));
  }
  if (route.view === "calendar") {
    if (route.date) params.set("date", route.date);
    if (route.mode) params.set("mode", route.mode);
    if (route.event) params.set("event", route.event);
  }
  if (route.view === "tasks") {
    if (route.list) params.set("list", route.list);
    if (route.task) params.set("task", route.task);
  }
  if (route.view === "jobs") {
    if (route.list === "shortlist") params.set("list", "shortlist");
    if (route.app) params.set("app", route.app);
    if (route.prospect) params.set("prospect", route.prospect);
    if (route.edit) params.set("edit", "1");
    if (route.newApp) params.set("new", "1");
    if (route.entry) params.set("entry", route.entry);
    if (route.tab) params.set("tab", route.tab);
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export type NavigationGuard = () => Promise<boolean> | boolean;

const listeners = new Set<() => void>();
let activeGuard: NavigationGuard | null = null;
let currentAppliedUrl = typeof window !== "undefined" ? window.location.href : "/";
let popstateGuarding = false;
// Where the next page should sit, set by navigate or by a step through the
// history and spent once that page has committed, so the old page never
// moves while it is still on screen.
let scrollOnCommit: number | null = null;
// How far down each page was when it was left, so Back returns to the same place.
const positions = new Map<string, number>();
// Whether the next route change should play a view transition. Only a move
// that keeps one thing on screen while the rest changes around it (a week and
// one of its sessions) earns the morph, because a full-page cross-fade on every
// other navigation reads as a flash rather than as movement.
let nextMorph = false;

function morphsBetween(prev: Route, next: Route): boolean {
  return (prev.view === "week" && next.view === "session") || (prev.view === "session" && next.view === "week");
}

export function setNavigationGuard(guard: NavigationGuard | null): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

// Whether the page in front may be left, as its guard decides. A desktop tab
// asks this before it closes, and then moves with the guard switched off.
export async function confirmLeave(): Promise<boolean> {
  return activeGuard ? Boolean(await activeGuard()) : true;
}

if (typeof window !== "undefined") {
  currentAppliedUrl = window.location.href;
  // The browser would otherwise restore the scroll before popstate fires, moving
  // the page being left before the transition has taken its picture of it.
  history.scrollRestoration = "manual";
  window.addEventListener("popstate", async () => {
    // A menu, sheet or dialog that closes steps back off its own history entry, which leaves
    // the address as it was, so the step is no move between pages. Treating it as one would
    // put the window back where it was and cancel a smooth scroll that had just begun.
    if (window.location.href === currentAppliedUrl) return;
    if (popstateGuarding) return;
    if (hasOpenOverlay()) return;
    if (activeGuard) {
      popstateGuarding = true;
      try {
        const allow = await activeGuard();
        if (!allow) {
          // Guard refused: restore previously applied URL without triggering another prompt
          window.history.pushState(null, "", currentAppliedUrl);
          return;
        }
      } finally {
        popstateGuarding = false;
      }
    }
    const prev = routeOf(currentAppliedUrl);
    positions.set(currentAppliedUrl, window.scrollY);
    currentAppliedUrl = window.location.href;
    scrollOnCommit = positions.get(currentAppliedUrl) ?? 0;
    // Stepping back from a session to its week morphs just as the forward move did.
    nextMorph = morphsBetween(prev, parseRoute(window.location.search));
    listeners.forEach((listener) => listener());
  });
}

// Accepts the older boolean form, navigate(route, true) for a replace, as
// well as an options object that can also ask for the morph transition, or
// with guard: false skip the guard, as a switch between desktop tabs does
// because the page it leaves stays mounted behind its tab.
export async function navigate(
  route: Route,
  opts: boolean | { replace?: boolean; morph?: boolean; guard?: boolean } = false,
): Promise<void> {
  const isReplace = typeof opts === "boolean" ? opts : Boolean(opts.replace);
  const morph = typeof opts === "boolean" ? false : Boolean(opts.morph);
  const guarded = typeof opts === "boolean" ? true : opts.guard !== false;
  if (guarded && activeGuard) {
    const allow = await activeGuard();
    if (!allow) return;
  }
  const url = href(route);
  const isOverlay = Boolean(typeof history !== "undefined" && history.state?.overlay);
  // The route being left is read before the URL changes, so a switch of tab or
  // week within one page can keep its scroll position instead of jumping to the top.
  const prev = routeOf(currentAppliedUrl);
  const samePage = prev.view === route.view && (!("id" in prev) || !("id" in route) || prev.id === route.id);
  positions.set(currentAppliedUrl, window.scrollY);
  if (isReplace || isOverlay) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  currentAppliedUrl = typeof window !== "undefined" ? window.location.href : url;
  scrollOnCommit = isReplace || samePage ? null : 0;
  nextMorph = morph || morphsBetween(prev, route);
  listeners.forEach((listener) => listener());
}

// Mirrors the route into the URL query without triggering navigation guards or route listeners
export function syncUrl(route: Route): void {
  const url = href(route);
  if (typeof history !== "undefined") {
    history.replaceState(history.state, "", url);
  }
  currentAppliedUrl = typeof window !== "undefined" ? window.location.href : url;
}

// The view transition waits on this promise. It is released only when React has
// committed the new route (see the layout effect below), so the browser takes
// its "after" snapshot of the new page and not of the page being left.
let transitionResolve: (() => void) | null = null;

function settleTransition(): void {
  const resolve = transitionResolve;
  transitionResolve = null;
  resolve?.();
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(typeof location !== "undefined" ? location.search : ""));
  const [, startRouteTransition] = useTransition();
  useEffect(() => {
    // A transition keeps the current page on screen until the next one has its data.
    const update = () => {
      // The morph is spent by the first change that reads it, so a later
      // navigation never inherits it by accident.
      const morph = nextMorph;
      nextMorph = false;
      const doc = typeof document !== "undefined" ? (document as Document & { startViewTransition?: (cb: () => Promise<void> | void) => { skipTransition: () => void } }) : null;
      if (morph && doc?.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const transition = doc.startViewTransition(() => {
          return new Promise<void>((resolve) => {
            // A transition still waiting from an earlier navigation is released first.
            settleTransition();
            transitionResolve = resolve;
            startRouteTransition(() => setRoute(parseRoute(location.search)));
            // Safety net, so a page that is slow to commit can never leave the screen frozen.
            // The animation is dropped rather than played, because playing it now would
            // morph the old page into itself and then cut to the new one when it lands.
            window.setTimeout(() => {
              if (transitionResolve !== resolve) return;
              transition?.skipTransition();
              settleTransition();
            }, 400);
          });
        });
      } else {
        // Every other change swaps the page in place, with no snapshot or
        // cross-fade, so nothing on screen flashes. A morph still waiting from
        // an earlier navigation is released first so it can never freeze the screen.
        settleTransition();
        startRouteTransition(() => setRoute(parseRoute(location.search)));
      }
    };
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  useLayoutEffect(() => {
    // The new route is in the DOM, so it is put where it belongs and only then
    // may the transition take its new snapshot.
    if (scrollOnCommit !== null) {
      const top = scrollOnCommit;
      scrollOnCommit = null;
      if (top === 0) window.scrollTo(0, 0);
      else window.scrollTo(0, top);
    }
    settleTransition();
  }, [route]);
  return route;
}
