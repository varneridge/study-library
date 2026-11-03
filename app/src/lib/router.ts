// Navigation state lives in the URL query, so every screen has a link and the
// app stays a single page that the service worker can serve offline.

import { useEffect, useState } from "react";
import { hasOpenOverlay } from "./ui";

export type Route =
  | { view: "home" }
  | { view: "module"; id: string }
  | { view: "week"; id: string }
  | { view: "reader"; id: string; page?: number; q?: string }
  | { view: "import"; id: string }
  | { view: "across"; term?: string; number?: number }
  | { view: "session"; id: string; t?: number; turn?: number }
  | { view: "question"; id: string }
  | { view: "search"; q?: string }
  | { view: "settings" }
  // The job search, kept apart from the study library.
  | { view: "jobs"; app?: string; edit?: boolean; newApp?: boolean; entry?: string; tab?: string };

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const view = params.get("v");
  const id = params.get("id") ?? "";
  switch (view) {
    case "module":
    case "week":
    case "import":
      return id ? { view, id } : { view: "home" };
    case "reader": {
      const page = Number(params.get("page"));
      return id
        ? { view, id, page: Number.isFinite(page) && params.has("page") ? page : undefined, q: params.get("q") ?? undefined }
        : { view: "home" };
    }
    case "across":
      return { view, term: params.get("term") ?? undefined, number: Number(params.get("n")) || undefined };
    case "session":
      return id
        ? { view, id, t: params.has("t") ? Number(params.get("t")) : undefined, turn: params.has("turn") ? Number(params.get("turn")) : undefined }
        : { view: "home" };
    case "question":
      return id ? { view, id } : { view: "home" };
    case "search":
      return { view, q: params.get("q") ?? undefined };
    case "settings":
      return { view };
    case "jobs": {
      const app = params.get("app") ?? undefined;
      const edit = params.get("edit") === "1" ? true : undefined;
      const newApp = params.get("new") === "1" ? true : undefined;
      const entry = params.get("entry") ?? undefined;
      const tab = params.get("tab") ?? undefined;
      return { view, app, edit, newApp, entry, tab };
    }
    default:
      return { view: "home" };
  }
}

export function href(route: Route): string {
  const params = new URLSearchParams();
  if (route.view !== "home") params.set("v", route.view);
  if ("id" in route) params.set("id", route.id);
  if (route.view === "reader" && route.page !== undefined) params.set("page", String(route.page));
  if (route.view === "reader" && route.q) params.set("q", route.q);
  if (route.view === "session" && route.t !== undefined) params.set("t", String(Math.floor(route.t)));
  if (route.view === "session" && route.turn !== undefined) params.set("turn", String(route.turn));
  if (route.view === "search" && route.q) params.set("q", route.q);
  if (route.view === "across") {
    if (route.term) params.set("term", route.term);
    if (route.number) params.set("n", String(route.number));
  }
  if (route.view === "jobs") {
    if (route.app) params.set("app", route.app);
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

export function setNavigationGuard(guard: NavigationGuard | null): () => void {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

if (typeof window !== "undefined") {
  currentAppliedUrl = window.location.href;
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
    currentAppliedUrl = window.location.href;
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
  if (replace || isOverlay) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  currentAppliedUrl = typeof window !== "undefined" ? window.location.href : url;
  listeners.forEach((listener) => listener());
  if (!replace && typeof window !== "undefined") window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(typeof location !== "undefined" ? location.search : ""));
  useEffect(() => {
    const update = () => {
      setRoute(parseRoute(location.search));
    };
    listeners.add(update);
    return () => {
      listeners.delete(update);
    };
  }, []);
  return route;
}
