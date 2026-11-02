import assert from "node:assert/strict";
import {
  computeApplicationPatch,
  validateApplication,
  detectApplicationConflict,
  entryAddChanges,
  entryDeleteChanges,
} from "../src/lib/jobs";
import type { ApplicationEventRow, ApplicationRow } from "../src/lib/types";

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
}
