// Navigation state lives in the URL query, so every screen has a link and the
// app stays a single page that the service worker can serve offline.

import { useEffect, useLayoutEffect, useState, useTransition } from "react";
import { hasOpenOverlay } from "./ui";

export type Route =
  | { view: "home" }
  | { view: "module"; id: string }
  | { view: "week"; id: string }
  | { view: "reader"; id: string; page?: number; q?: string }
  | { view: "essay"; id: string; essay?: string; q?: string }
  // A module's Assessment & essay page.
  | { view: "assessment"; id: string; essay?: string }
  | { view: "across"; term?: string; number?: number }
  | { view: "session"; id: string; rec?: string; t?: number; turn?: number }
  | { view: "search"; q?: string }
  | { view: "settings" }
  // The job search, kept apart from the study library.
  | { view: "jobs"; list?: "applications" | "shortlist"; app?: string; prospect?: string; edit?: boolean; newApp?: boolean; entry?: string; tab?: string };

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("v");
  const id = params.get("id") ?? "";
  switch (view) {
    case "module":
    case "week":
      return id ? { view, id } : { view: "home" };
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
      return id
        ? { view, id, page: validPage, q: params.get("q") ?? undefined }
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

export function href(route: Route): string {
  const params = new URLSearchParams();
  if (route.view !== "home") params.set("v", route.view);
  if ("id" in route) params.set("id", route.id);
  if ((route.view === "assessment" || route.view === "essay") && route.essay) params.set("essay", route.essay);
  if (route.view === "reader" && route.page !== undefined) params.set("page", String(route.page));
  if ((route.view === "reader" || route.view === "essay") && route.q) params.set("q", route.q);
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

export function setNavigationGuard(guard: NavigationGuard | null): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

if (typeof window !== "undefined") {
  currentAppliedUrl = window.location.href;
  // The browser would otherwise restore the scroll before popstate fires, moving
  // the page being left before the transition has taken its picture of it.
  history.scrollRestoration = "manual";
  window.addEventListener("popstate", async () => {
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
    positions.set(currentAppliedUrl, window.scrollY);
    currentAppliedUrl = window.location.href;
    scrollOnCommit = positions.get(currentAppliedUrl) ?? 0;
    listeners.forEach((listener) => listener());
  });
}

export async function navigate(route: Route, replace = false): Promise<void> {
  if (activeGuard) {
    const allow = await activeGuard();
    if (!allow) return;
  }
  const url = href(route);
  const isOverlay = Boolean(typeof history !== "undefined" && history.state?.overlay);
  positions.set(currentAppliedUrl, window.scrollY);
  if (replace || isOverlay) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  currentAppliedUrl = typeof window !== "undefined" ? window.location.href : url;
  scrollOnCommit = replace ? null : 0;
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
  const [pending, startRouteTransition] = useTransition();
  useEffect(() => {
    // A transition keeps the current page on screen until the next one has its data.
    const update = () => {
      const doc = typeof document !== "undefined" ? (document as Document & { startViewTransition?: (cb: () => Promise<void> | void) => { skipTransition: () => void } }) : null;
      if (doc?.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
  // Lets the stylesheet dim the old page when the next one is slow to arrive. A
  // layout effect clears it in the same commit, so the new snapshot is never dimmed.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("navigating", pending);
  }, [pending]);
  return route;
}
