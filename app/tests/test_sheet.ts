import assert from "node:assert/strict";
import { parseRoute, href } from "../src/lib/router";

export function registerSheetRouteTests(test: (name: string, fn: () => void) => void) {
  test("route parsing and href round-trip for job search sheets", () => {
    assert.deepEqual(parseRoute("?v=jobs"), { view: "jobs", list: undefined, app: undefined, prospect: undefined, edit: undefined, newApp: undefined, entry: undefined, tab: undefined });
    assert.equal(href({ view: "jobs" }), "/?v=jobs");

    // Application sheet
    const appRoute = parseRoute("?v=jobs&app=abc-123");
    assert.deepEqual(appRoute, { view: "jobs", list: undefined, app: "abc-123", prospect: undefined, edit: undefined, newApp: undefined, entry: undefined, tab: undefined });
    assert.equal(href({ view: "jobs", app: "abc-123" }), "/?v=jobs&app=abc-123");

    // Edit application sheet
    const editRoute = parseRoute("?v=jobs&app=abc-123&edit=1");
    assert.deepEqual(editRoute, { view: "jobs", list: undefined, app: "abc-123", prospect: undefined, edit: true, newApp: undefined, entry: undefined, tab: undefined });
    assert.equal(href({ view: "jobs", app: "abc-123", edit: true }), "/?v=jobs&app=abc-123&edit=1");

    // New application sheet
    const newRoute = parseRoute("?v=jobs&new=1");
    assert.deepEqual(newRoute, { view: "jobs", list: undefined, app: undefined, prospect: undefined, edit: undefined, newApp: true, entry: undefined, tab: undefined });
    assert.equal(href({ view: "jobs", newApp: true }), "/?v=jobs&new=1");

    // Timeline entry sheet (new)
    const entryNewRoute = parseRoute("?v=jobs&app=abc-123&entry=new");
    assert.deepEqual(entryNewRoute, { view: "jobs", list: undefined, app: "abc-123", prospect: undefined, edit: undefined, newApp: undefined, entry: "new", tab: undefined });
    assert.equal(href({ view: "jobs", app: "abc-123", entry: "new" }), "/?v=jobs&app=abc-123&entry=new");

    // Timeline entry sheet (edit existing)
    const entryEditRoute = parseRoute("?v=jobs&app=abc-123&entry=evt-456");
    assert.deepEqual(entryEditRoute, { view: "jobs", list: undefined, app: "abc-123", prospect: undefined, edit: undefined, newApp: undefined, entry: "evt-456", tab: undefined });
    assert.equal(href({ view: "jobs", app: "abc-123", entry: "evt-456" }), "/?v=jobs&app=abc-123&entry=evt-456");

    // Notes tab in application sheet
    const notesRoute = parseRoute("?v=jobs&app=abc-123&tab=notes");
    assert.deepEqual(notesRoute, { view: "jobs", list: undefined, app: "abc-123", prospect: undefined, edit: undefined, newApp: undefined, entry: undefined, tab: "notes" });
    assert.equal(href({ view: "jobs", app: "abc-123", tab: "notes" }), "/?v=jobs&app=abc-123&tab=notes");

    // Shortlist list view and prospect sheets
    const shortlistRoute = parseRoute("?v=jobs&list=shortlist");
    assert.deepEqual(shortlistRoute, { view: "jobs", list: "shortlist", app: undefined, prospect: undefined, edit: undefined, newApp: undefined, entry: undefined, tab: undefined });
    assert.equal(href({ view: "jobs", list: "shortlist" }), "/?v=jobs&list=shortlist");

    const prospectRoute = parseRoute("?v=jobs&list=shortlist&prospect=shortlist-01");
    assert.deepEqual(prospectRoute, { view: "jobs", list: "shortlist", app: undefined, prospect: "shortlist-01", edit: undefined, newApp: undefined, entry: undefined, tab: undefined });
    assert.equal(href({ view: "jobs", list: "shortlist", prospect: "shortlist-01" }), "/?v=jobs&list=shortlist&prospect=shortlist-01");

    // Address with prospect alone implies shortlist
    const prospectBareRoute = parseRoute("?v=jobs&prospect=shortlist-01");
    assert.deepEqual(prospectBareRoute, { view: "jobs", list: "shortlist", app: undefined, prospect: "shortlist-01", edit: undefined, newApp: undefined, entry: undefined, tab: undefined });

    const prospectEditRoute = parseRoute("?v=jobs&list=shortlist&prospect=shortlist-01&edit=1");
    assert.deepEqual(prospectEditRoute, { view: "jobs", list: "shortlist", app: undefined, prospect: "shortlist-01", edit: true, newApp: undefined, entry: undefined, tab: undefined });
    assert.equal(href({ view: "jobs", list: "shortlist", prospect: "shortlist-01", edit: true }), "/?v=jobs&list=shortlist&prospect=shortlist-01&edit=1");
  });
}
