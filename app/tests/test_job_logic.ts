import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeApplicationPatch,
  validateApplication,
  detectApplicationConflict,
  entryAddChanges,
  entryDeleteChanges,
  matches,
} from "../src/lib/jobs";
import {
  PROSPECT_STATUSES,
  PROSPECT_STATUS_GROUPS,
  prospectStatusOf,
  stageForProspectStatus,
  checkState,
  checkWords,
  parseProspectLink,
  sortProspects,
  summariseProspects,
  matchesProspect,
  validateProspect,
  computeProspectPatch,
} from "../src/lib/prospects";
import type { ApplicationEventRow, ApplicationRow, ProspectRow } from "../src/lib/types";

function baseApp(overrides?: Partial<ApplicationRow>): ApplicationRow {
  return {
    id: "app-1",
    employer: "Acme Corp",
    role: "Software Engineer",
    stage: "applied",
    applied: "2026-10-01",
    next_deadline: "2026-11-15",
    file_cv: null,
    file_cl: null,
    file_rd: null,
    file_qs: null,
    notes: "Applied online",
    modified_at: "2026-10-01T12:00:00Z",
    seq: 1,
    deleted: false,
    ...overrides,
  };
}

function baseEvent(id: string, stage: string, at: string): ApplicationEventRow {
  return {
    id,
    application_id: "app-1",
    stage,
    from_stage: null,
    at,
    kind: "manual",
    cleared_deadline: null,
    modified_at: at,
    seq: 1,
    deleted: false,
  };
}

export function registerJobLogicTests(test: (name: string, fn: () => void) => void) {
  test("computeApplicationPatch returns only modified fields", () => {
    const initial = baseApp();
    const current = {
      ...initial,
      role: "Senior Software Engineer",
      notes: "Updated note",
    };
    const patch = computeApplicationPatch(initial, current);
    assert.deepEqual(patch, {
      role: "Senior Software Engineer",
      notes: "Updated note",
    });

    // Unchanged returns empty patch
    assert.deepEqual(computeApplicationPatch(initial, { ...initial }), {});

    // Undefined fields are ignored
    assert.deepEqual(computeApplicationPatch(initial, { role: initial.role, notes: undefined }), {});
  });

  test("validateApplication validates employer and date formats", () => {
    // Valid inputs
    const valid = validateApplication({
      employer: "Google",
      role: "Engineer",
      applied: "2026-10-01",
      next_deadline: "2026-11-01",
    });
    assert.equal(valid.valid, true);
    assert.deepEqual(valid.errors, {});

    // Blank / missing employer
    const missingEmployer = validateApplication({
      employer: "   ",
      applied: "2026-10-01",
    });
    assert.equal(missingEmployer.valid, false);
    assert.equal(missingEmployer.errors.employer, "Employer is required");

    // Invalid dates
    const invalidDates = validateApplication({
      employer: "Google",
      applied: "01/10/2026",
      next_deadline: "tomorrow",
    });
    assert.equal(invalidDates.valid, false);
    assert.equal(invalidDates.errors.applied, "Applied date must be YYYY-MM-DD");
    assert.equal(invalidDates.errors.next_deadline, "Next deadline must be YYYY-MM-DD");
  });

  test("detectApplicationConflict identifies dirty field conflicts on modified records", () => {
    const initial = baseApp({ modified_at: "2026-10-01T10:00:00Z" });
    const local = { ...initial, role: "Staff Engineer" };

    // Same modified_at: no conflict
    assert.equal(
      detectApplicationConflict(initial.modified_at, initial.modified_at, ["role"], local, initial),
      false,
    );

    // Newer remote modified_at, but the dirty field (role) was NOT changed on remote
    const remoteNoOverlap = { ...initial, modified_at: "2026-10-01T11:00:00Z", notes: "Remote updated notes" };
    assert.equal(
      detectApplicationConflict(initial.modified_at, remoteNoOverlap.modified_at, ["role"], remoteNoOverlap, initial),
      false,
    );

    // Newer remote modified_at and dirty field (role) was changed on remote: CONFLICT
    const remoteOverlap = { ...initial, modified_at: "2026-10-01T11:00:00Z", role: "Principal Engineer" };
    assert.equal(
      detectApplicationConflict(initial.modified_at, remoteOverlap.modified_at, ["role"], remoteOverlap, initial),
      true,
    );
  });

  test("entryAddChanges updates application stage when new entry is latest", () => {
    const app = baseApp({ stage: "applied", applied: "2026-10-01" });
    const events = [baseEvent("e1", "applied", "2026-10-01T10:00:00Z")];

    // Adding an interview event later than applied event
    const { changes, newStage } = entryAddChanges(app, events, {
      id: "e2",
      stage: "first_interview",
      at: "2026-10-15T14:00:00Z",
    });

    assert.equal(newStage, "first_interview");
    // Should have changes: insert event and patch application stage
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[0], {
      table: "application_events",
      row: {
        id: "e2",
        application_id: "app-1",
        stage: "first_interview",
        from_stage: null,
        at: "2026-10-15T14:00:00Z",
        kind: "manual",
        cleared_deadline: null,
        modified_at: (changes[0].row as ApplicationEventRow).modified_at,
        seq: 0,
        deleted: false,
      },
    });
    assert.deepEqual(changes[1], {
      table: "applications",
      row: { id: "app-1", stage: "first_interview" },
      patch: true,
    });
  });

  test("entryAddChanges does not override stage if new entry is chronological past", () => {
    const app = baseApp({ stage: "first_interview" });
    const events = [
      baseEvent("e1", "applied", "2026-10-01T10:00:00Z"),
      baseEvent("e2", "first_interview", "2026-10-20T10:00:00Z"),
    ];

    // Adding an earlier event (e.g. phone screen on 2026-10-10)
    const { changes, newStage } = entryAddChanges(app, events, {
      id: "e-past",
      stage: "phone_screen",
      at: "2026-10-10T10:00:00Z",
    });

    assert.equal(newStage, "first_interview");
    // Only event inserted, no stage patch on application
    assert.equal(changes.length, 1);
    assert.equal(changes[0].table, "application_events");
  });

  test("entryDeleteChanges reverts application stage to latest remaining event", () => {
    const app = baseApp({ stage: "offer" });
    const events = [
      baseEvent("e1", "applied", "2026-10-01T10:00:00Z"),
      baseEvent("e2", "first_interview", "2026-10-15T10:00:00Z"),
      baseEvent("e3", "offer", "2026-10-25T10:00:00Z"),
    ];

    // Deleting latest event (offer)
    const { changes, restoredStage } = entryDeleteChanges(app, events, "e3");
    assert.equal(restoredStage, "first_interview");

    assert.equal(changes.length, 2);
    // Mark e3 deleted
    assert.deepEqual(changes[0], {
      table: "application_events",
      row: { id: "e3", deleted: true },
      patch: true,
    });
    // Patch app stage to first_interview
    assert.deepEqual(changes[1], {
      table: "applications",
      row: { id: "app-1", stage: "first_interview" },
      patch: true,
    });
  });

  test("application salary is included in search matching and patch computation", () => {
    const initial = baseApp({ salary: "£37,500" });
    assert.ok(matches(initial, "37,500"));
    assert.ok(matches(initial, "£37"));
    const updated = { ...initial, salary: "£42,000" };
    assert.deepEqual(computeApplicationPatch(initial, updated), { salary: "£42,000" });
  });

  test("prospect statuses provide the 4 streamlined options and map legacy choices cleanly", () => {
    assert.equal(PROSPECT_STATUSES.length, 4);
    assert.deepEqual(PROSPECT_STATUSES.map((s) => s.key), ["not_open", "open", "applying", "applied"]);
    const groupKeys = PROSPECT_STATUS_GROUPS.flatMap((g) => g.keys);
    assert.deepEqual([...groupKeys].sort(), PROSPECT_STATUSES.map((s) => s.key).sort());
    assert.equal(prospectStatusOf("not_open").label, "Not open");
    assert.equal(prospectStatusOf("not_started").label, "Not open");
    assert.equal(prospectStatusOf("not_applying").cat, "closed");
    assert.equal(stageForProspectStatus("not_open").stage, "to_apply");
    assert.equal(stageForProspectStatus("not_started").stage, "to_apply");
    assert.equal(stageForProspectStatus("not_started").applied, null);
    assert.equal(stageForProspectStatus("submitted").stage, "applied");
    assert.equal(stageForProspectStatus("applied").stage, "applied");
    assert.equal(stageForProspectStatus("online_tests").stage, "oa_todo");
    assert.equal(stageForProspectStatus("interview").stage, "interview_todo");
    assert.equal(stageForProspectStatus("assessment_centre").stage, "ac_todo");
    assert.equal(stageForProspectStatus("offer").stage, "offer");
    assert.equal(stageForProspectStatus("rejected").stage, "rejected");
    assert.equal(stageForProspectStatus("withdrawn").stage, "withdrawn");
  });

  test("prospect checkState turns overdue on the check date itself and soon within 7 days", () => {
    const baseProspect = (next_check: string | null, status = "not_started"): ProspectRow => ({
      id: "p1",
      employer: "Civil Service Fast Stream",
      programme: "Diplomatic & Development Economics",
      salary: "£31k-£33k",
      link: "https://www.faststream.gov.uk/",
      last_year_open: "9 Oct - 6 Nov 2025",
      next_check,
      status,
      notes: null,
      application_id: null,
      modified_at: "2026-11-13T12:00:00Z",
      seq: 1,
      deleted: false,
    });
    const refNow = new Date(2026, 10, 16, 12, 0); // 16 Nov 2026
    // Excel rule: "Next check turns red once the date arrives"
    assert.equal(checkState(baseProspect("2026-11-16"), null, refNow), "overdue");
    assert.equal(checkWords(baseProspect("2026-11-16"), null, refNow), "check today");
    assert.equal(checkState(baseProspect("2026-11-15"), null, refNow), "overdue");
    assert.equal(checkWords(baseProspect("2026-11-15"), null, refNow), "overdue by a day");
    assert.equal(checkWords(baseProspect("2026-11-13"), null, refNow), "overdue by 3 days");
    assert.equal(checkState(baseProspect("2026-11-17"), null, refNow), "soon");
    assert.equal(checkWords(baseProspect("2026-11-17"), null, refNow), "tomorrow");
    assert.equal(checkState(baseProspect("2026-11-23"), null, refNow), "soon");
    assert.equal(checkWords(baseProspect("2026-11-23"), null, refNow), "in 7 days");
    assert.equal(checkState(baseProspect("2026-11-24"), null, refNow), "none");
    // Closed prospects never show as due
    assert.equal(checkState(baseProspect("2026-11-15", "not_applying"), null, refNow), "none");
    assert.equal(checkWords(baseProspect("2026-11-15", "rejected"), null, refNow), "");
  });

  test("parseProspectLink handles URLs, Search: queries, plain text, and blocks unsafe schemes", () => {
    const url = parseProspectLink("https://www.faststream.gov.uk/programmes");
    assert.equal(url.kind, "url");
    if (url.kind === "url") {
      assert.equal(url.href, "https://www.faststream.gov.uk/programmes");
      assert.equal(url.label, "faststream.gov.uk");
    }

    const search = parseProspectLink("Search: House of Commons Fast Stream");
    assert.equal(search.kind, "search");
    if (search.kind === "search") {
      assert.equal(search.label, "Search: House of Commons Fast Stream");
      assert.ok(search.href.startsWith("https://www.google.com/search?q=House%20of%20Commons"));
    }

    const unsafe = parseProspectLink("javascript:alert(1)");
    assert.equal(unsafe.kind, "text");

    const empty = parseProspectLink("   ");
    assert.equal(empty.kind, "none");
  });

  test("sortProspects, summariseProspects, matchesProspect, and validateProspect work as expected", () => {
    const mk = (id: string, next_check: string | null, status = "not_started", employer = id): ProspectRow => ({
      id,
      employer,
      programme: "Graduate Scheme",
      salary: "£35,000",
      link: "Search: " + employer,
      last_year_open: "Oct 2025",
      next_check,
      status,
      notes: null,
      application_id: null,
      modified_at: "2026-11-13T12:00:00Z",
      seq: 1,
      deleted: false,
    });
    const refNow = new Date(2026, 10, 16, 12, 0);
    const rows = [
      mk("closed", "2026-11-10", "not_applying", "Closed Co"),
      mk("later", "2026-12-01", "not_started", "Later Co"),
      mk("due-today", "2026-11-16", "researching", "Alpha Co"),
      mk("no-date", null, "not_started", "Beta Co"),
    ];
    assert.deepEqual(sortProspects(rows).map((r) => r.id), ["due-today", "later", "no-date", "closed"]);
    assert.deepEqual(summariseProspects(rows, new Map(), refNow), {
      open: 3,
      closed: 1,
      dueNow: 1,
      soon: 0,
      inProgress: 0,
      offers: 0,
    });
    assert.ok(matchesProspect(rows[2], "alpha"));
    assert.ok(matchesProspect(rows[2], "35,000"));
    assert.ok(matchesProspect(rows[2], "oct 2025"));

    assert.equal(validateProspect({ employer: "  " }).valid, false);
    assert.equal(validateProspect({ employer: "Ofcom", next_check: "16/11/2026" }).valid, false);
    assert.equal(validateProspect({ employer: "Ofcom", next_check: "2026-11-16" }).valid, true);
    assert.deepEqual(computeProspectPatch(rows[2], { ...rows[2], salary: "£40,000" }), { salary: "£40,000" });
  });

  test("migration 0018 seeds all 22 graduate shortlist rows and adds salary to applications without em or en dashes", () => {
    const sql = readFileSync(new URL("../migrations/0018_job_shortlist.sql", import.meta.url), "utf8");
    assert.ok(sql.includes("ALTER TABLE applications ADD COLUMN salary TEXT;"));
    assert.ok(sql.includes("CREATE TABLE prospects ("));
    for (let i = 1; i <= 22; i += 1) {
      const id = `shortlist-${String(i).padStart(2, "0")}`;
      assert.ok(sql.includes(`'${id}'`), `migration missing ${id}`);
    }
    const checkFiles = [
      "../migrations/0018_job_shortlist.sql",
      "../src/lib/prospects.ts",
      "../src/components/jobs/ProspectControls.tsx",
      "../src/components/jobs/ProspectSheet.tsx",
      "../src/components/jobs/ProspectForm.tsx",
      "../src/components/jobs/ProspectRow.tsx",
      "../src/components/jobs/ProspectList.tsx",
    ];
    for (const rel of checkFiles) {
      const text = readFileSync(new URL(rel, import.meta.url), "utf8");
      assert.ok(!text.includes("\u2013") && !text.includes("\u2014"), `${rel} contains an en or em dash`);
    }
  });
}
