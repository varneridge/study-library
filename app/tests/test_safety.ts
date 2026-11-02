import assert from "node:assert/strict";
import { showToast, dismissToast, getToasts } from "../src/lib/ui";
import { pickPrimaryNote } from "../src/lib/notes";
import { describeFailedChange, isSyncExpired, isSyncPaused, pauseSync, resumeSync, stopSync } from "../src/lib/sync";
import type { NoteRow } from "../src/lib/types";

export function registerSafetyTests(test: (name: string, fn: () => void | Promise<void>) => void) {
  test("toast notices queue and dismiss individually", () => {
    dismissToast();
    showToast("First notice", { label: "Undo 1", run: () => {} });
    showToast("Second notice", { label: "Undo 2", run: () => {} });

    const state1 = getToasts();
    assert.equal(state1.length, 2);
    assert.equal(state1[0].message, "First notice");
    assert.equal(state1[1].message, "Second notice");

    const firstId = state1[0].id;
    dismissToast(firstId);

    const state2 = getToasts();
    assert.equal(state2.length, 1);
    assert.equal(state2[0].message, "Second notice");

    dismissToast();
    const state3 = getToasts();
    assert.equal(state3.length, 0);
  });

  test("identical toast messages reset timer only when neither has action", () => {
    dismissToast();
    const id1 = showToast("Already at the top.");
    const id2 = showToast("Already at the top.");
    assert.equal(id1, id2);
    assert.equal(getToasts().length, 1);

    // Notices with actions are distinct and not merged
    const actId1 = showToast("File replaced.", { label: "Undo", run: () => {} });
    const actId2 = showToast("File replaced.", { label: "Undo", run: () => {} });
    assert.notEqual(actId1, actId2);
    assert.equal(getToasts().length, 3);
    dismissToast();
  });

  test("toast queue evicts beyond 3 items cleanly, preferring items without actions", () => {
    dismissToast();
    showToast("Important action", { label: "Undo", run: () => {} });
    showToast("Notice 2");
    showToast("Notice 3");
    // Adding 4th notice should evict Notice 2 (oldest without action), preserving Important action
    showToast("Notice 4");
    const list = getToasts();
    assert.equal(list.length, 3);
    assert.equal(list[0].message, "Important action");
    assert.equal(list[1].message, "Notice 3");
    assert.equal(list[2].message, "Notice 4");
    dismissToast();
  });

  test("pickPrimaryNote picks canonical id or earliest id deterministically", () => {
    const target = { session_id: "s1" };
    assert.equal(pickPrimaryNote([], target), null);

    const canonicalId = "note:session_id:s1";
    const noteA: NoteRow = { id: "note:other:a", session_id: "s1", item_id: null, question_id: null, zotero_key: null, modified_at: "2026-01-01T00:00:00Z", deleted: false };
    const noteB: NoteRow = { id: "note:other:b", session_id: "s1", item_id: null, question_id: null, zotero_key: null, modified_at: "2026-01-01T00:00:00Z", deleted: false };
    const noteCanon: NoteRow = { id: canonicalId, session_id: "s1", item_id: null, question_id: null, zotero_key: null, modified_at: "2026-01-01T00:00:00Z", deleted: false };

    // With canonical note present, always prefer it
    assert.equal(pickPrimaryNote([noteB, noteA, noteCanon], target)?.id, canonicalId);

    // Without canonical note, sort deterministically by id
    assert.equal(pickPrimaryNote([noteB, noteA], target)?.id, "note:other:a");
  });

  test("describeFailedChange formats grammatically correct messages for every table without raw codes", () => {
    assert.equal(describeFailedChange("applications"), "A change to an application could not be saved.");
    assert.equal(describeFailedChange("application_events"), "A change to a job application event could not be saved.");
    assert.equal(describeFailedChange("items"), "A change to a reading could not be saved.");
    assert.equal(describeFailedChange("note_blocks"), "A change to part of a note could not be saved.");
    assert.equal(describeFailedChange("recordings"), "A change to a recording could not be saved.");
    assert.equal(describeFailedChange("week_items"), "A change to a reading in a week could not be saved.");
    assert.equal(describeFailedChange("settings"), "A change to a setting could not be saved.");
    assert.equal(describeFailedChange("custom_table"), "A change could not be saved.");
    assert.ok(!describeFailedChange("application_events").includes("_"));
    assert.ok(!describeFailedChange("custom_table").includes("custom_table"));
  });

  test("sync pause and resume state management", async () => {
    assert.equal(isSyncPaused(), false);
    assert.equal(isSyncExpired(), false);
    await pauseSync();
    assert.equal(isSyncPaused(), true);
    resumeSync();
    assert.equal(isSyncPaused(), false);
    stopSync();
  });
}
