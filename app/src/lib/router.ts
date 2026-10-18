// Navigation state lives in the URL query, so every screen has a link and the
// app stays a single page that the service worker can serve offline.

import { useEffect, useState } from "react";

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
  | { view: "jobs" };

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
    case "jobs":
      return { view };
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
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

const listeners = new Set<() => void>();

export function navigate(route: Route, replace = false): void {
  const url = href(route);
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  listeners.forEach((listener) => listener());
  if (!replace) window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.search));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.search));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
}
