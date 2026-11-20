// Tests for the calendar's place in the router. Runs on its own with
// `npx tsx tests/routing.ts` from app/. It imports router.ts, which imports
// ./ui, so if ui.ts needs a browser at import time, run it where the rest of
// the app's tests run instead.

import assert from "node:assert/strict";
import { href, parseRoute, type Route } from "../src/lib/router";
import { tabKind, type TabKind } from "../src/lib/tabs";

export function registerRoutingTests(test: (name: string, fn: () => void) => void): void {

const round = (route: Route) => parseRoute(new URL(href(route), "http://localhost").search);

test("a bare calendar route is a stable link", () => {
  assert.equal(href({ view: "calendar" }), "/?v=calendar");
  assert.deepEqual(parseRoute("?v=calendar"), { view: "calendar" });
});

test("every optional field survives a round trip, alone and together", () => {
  const routes: Route[] = [
    { view: "calendar", date: "2026-11-16" },
    { view: "calendar", mode: "agenda" },
    { view: "calendar", event: "p:7f3a" },
    { view: "calendar", date: "2026-11-16", mode: "week" },
    { view: "calendar", date: "2026-11-16", mode: "day", event: "e:m1:k1" },
    { view: "calendar", mode: "month", event: "g:abc123@google.com|2026-11-16T10:00:00.000Z" },
  ];
  for (const route of routes) assert.deepEqual(round(route), route);
});

test("the link names each field plainly", () => {
  assert.equal(
    href({ view: "calendar", date: "2026-11-16", mode: "week", event: "p:abc" }),
    "/?v=calendar&date=2026-11-16&mode=week&event=p%3Aabc",
  );
});

test("each of the four modes is accepted and anything else is dropped", () => {
  for (const mode of ["month", "week", "day", "agenda"] as const) assert.deepEqual(parseRoute(`?v=calendar&mode=${mode}`), { view: "calendar", mode });
  for (const mode of ["year", "Month", "", "week%20", "agenda,day"]) assert.deepEqual(parseRoute(`?v=calendar&mode=${mode}`), { view: "calendar" });
});

test("a date that is not a real date is dropped", () => {
  for (const date of ["2026-02-30", "2026-13-01", "16/11/2026", "2026-1-5", "tomorrow", "1899-12-31", "2200-01-01", ""]) {
    assert.deepEqual(parseRoute(`?v=calendar&date=${date}`), { view: "calendar" }, date);
  }
  assert.deepEqual(parseRoute("?v=calendar&date=2028-02-29"), { view: "calendar", date: "2028-02-29" });
});

test("an empty event is dropped, and a bad field does not spoil a good one", () => {
  assert.deepEqual(parseRoute("?v=calendar&event="), { view: "calendar" });
  assert.deepEqual(parseRoute("?v=calendar&date=nonsense&mode=day&event=p%3Aabc"), { view: "calendar", mode: "day", event: "p:abc" });
});

test("a parsed calendar route holds only what the link held, and never an id", () => {
  assert.deepEqual(Object.keys(parseRoute("?v=calendar")), ["view"]);
  assert.deepEqual(Object.keys(parseRoute("?v=calendar&mode=week")), ["view", "mode"]);
  const withId = parseRoute("?v=calendar&id=m1&date=2026-11-16");
  assert.equal("id" in withId, false);
  assert.equal(href(withId), "/?v=calendar&date=2026-11-16");
});

test("other fields never leak into a calendar link", () => {
  const route = { view: "calendar", date: "2026-11-16", term: "AT", q: "x", essay: "e", app: "a1" } as unknown as Route;
  assert.equal(href(route), "/?v=calendar&date=2026-11-16");
});

  test("each page opens in a tab of its own kind, and anything unknown is a menu", () => {
    const kinds: Record<string, TabKind> = {
      home: "home", module: "menu", week: "menu", across: "menu", assessment: "menu", reader: "reading",
      session: "notes", essay: "notes", calendar: "calendar", jobs: "job", tasks: "todo", search: "search", settings: "settings",
    };
    for (const [view, kind] of Object.entries(kinds)) assert.equal(tabKind(view), kind, view);
    // All nine kinds are in use, so no icon is drawn for nothing.
    assert.equal(new Set(Object.values(kinds)).size, 9);
    for (const view of ["", "elsewhere", "Reader", "reader "]) assert.equal(tabKind(view), "menu", view);
  });

  test("a parsed route's view always has a kind", () => {
    for (const search of ["", "?v=module&id=m1", "?v=week&id=w1", "?v=reader&id=i1", "?v=calendar", "?v=jobs", "?v=settings", "?v=search"]) {
      assert.ok(tabKind(parseRoute(search).view), search);
    }
  });

  test("the existing routes are untouched", () => {
    assert.deepEqual(parseRoute(""), { view: "home" });
    assert.deepEqual(parseRoute("?v=nonsense"), { view: "home" });
    assert.deepEqual(parseRoute("?v=week&id=w1"), { view: "week", id: "w1" });
    assert.equal(href({ view: "week", id: "w1" }), "/?v=week&id=w1");
    assert.deepEqual(parseRoute("?v=settings"), { view: "settings" });
    assert.deepEqual(parseRoute("?v=reader&id=i1&page=3"), { view: "reader", id: "i1", page: 3, q: undefined });
    assert.equal(href({ view: "jobs", app: "a1", edit: true }), "/?v=jobs&app=a1&edit=1");
    assert.deepEqual(parseRoute("?v=jobs&prospect=p1"), { view: "jobs", list: "shortlist", app: undefined, prospect: "p1", edit: undefined, newApp: undefined, entry: undefined, tab: undefined });
  });
}

let passed = 0;
registerRoutingTests((name, fn) => {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`FAILED: ${name}`);
    throw error;
  }
});
console.log(`routing: ${passed} tests passed`);
