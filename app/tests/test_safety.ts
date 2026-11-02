import assert from "node:assert/strict";
import { showToast, dismissToast, getToast } from "../src/lib/ui";
import { pickPrimaryNote } from "../src/lib/notes";
import { describeFailedChange, isSyncExpired, isSyncPaused, pauseSync, resumeSync, stopSync } from "../src/lib/sync";
import type { NoteRow } from "../src/lib/types";

export function registerSafetyTests(test: (name: string, fn: () => void | Promise<void>) => void) {
  test("toast notice shows, updates, and dismisses", () => {
    dismissToast();
    assert.equal(getToast(), null);

    showToast("First notice");
    assert.equal(getToast()?.message, "First notice");

    showToast("Second notice", { label: "Undo", run: () => {} });
    assert.equal(getToast()?.message, "Second notice");
    assert.equal(getToast()?.action?.label, "Undo");

    dismissToast();
    assert.equal(getToast(), null);
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
