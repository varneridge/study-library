// The processor status as Settings shows it (src/lib/status.ts): how the
// Worker's answer is read, including from a Worker deployed before the work
// list, how jobs are named, and how jobs and Listen audio are ordered and
// worded in the one list of work in hand, which leaves out what failed, and
// what Send to top moves for each row.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  jobKindLabel, JOB_KIND_LABEL, parseStatus, voiceLabel, VISIBLE_WORK, waitingSummary, workRows,
  type ProcessorStatus, type StatusBody,
} from "../src/lib/status";

type Test = (name: string, fn: () => void) => void;

const NOW = Date.UTC(2026, 10, 18, 14, 0);

function body(extra: Partial<StatusBody> = {}): StatusBody {
  return { processor_seen: NOW / 1000 - 30, queued: 0, running: 0, failed: 0, ...extra };
}

type JobInput = NonNullable<StatusBody["jobs"]>[number];
type ListenInput = NonNullable<StatusBody["listen"]>[number];

function job(id: number, kind: string, status: JobInput["status"], extra: Partial<JobInput> = {}): JobInput {
  return { id, kind, status, target_id: `f${id}`, target_kind: "file", title: null, run_after: null, label: null, attempts: 0, error: null, ...extra };
}

function listen(item: string, state: ListenInput["state"], extra: Partial<ListenInput> = {}): ListenInput {
  return { item_id: item, voice: "bf_emma", title: null, state, ready: 0, total: 10, failed: 0, requested_at: "2026-11-18T13:00:00.000Z", ...extra };
}

function status(extra: Partial<StatusBody>): ProcessorStatus {
  return parseStatus(body(extra));
}

export function registerStatusTests(test: Test) {
  test("a status from a Worker before the work list reads with empty lists and keeps its counts", () => {
    const parsed = parseStatus({ processor_seen: 1_700_000_000, queued: 3, running: 1, failed: 2 });
    assert.equal(parsed.seenAt?.getTime(), 1_700_000_000_000);
    assert.equal(parsed.gpuSeenAt, null);
    assert.deepEqual([parsed.queued, parsed.running, parsed.failed], [3, 1, 2]);
    assert.deepEqual(parsed.jobs, []);
    assert.deepEqual(parsed.listen, []);
  });

  test("a job from a Worker before titles reads with no title, kind or retry time", () => {
    const parsed = parseStatus(body({
      jobs: [{ id: 4, kind: "ocr", status: "queued", target_id: "f4", label: null, attempts: 1, error: null }],
    }));
    assert.equal(parsed.jobs[0].title, null);
    assert.equal(parsed.jobs[0].targetKind, null);
    assert.equal(parsed.jobs[0].runAfter, null);
    assert.equal(workRows(parsed, NOW)[0].state, "next");
  });

  test("a status that never heard from the processor has no time seen, and a bad date reads as none", () => {
    const parsed = parseStatus(body({ processor_seen: null, jobs: [job(1, "thumb", "queued", { run_after: "not a date" })] }));
    assert.equal(parsed.seenAt, null);
    assert.equal(parsed.jobs[0].runAfter, null);
  });

  test("every job kind the Worker queues has a label, and an unknown kind is still readable", () => {
    for (const kind of ["extract_text", "convert", "ocr", "thumb", "identify", "prepare_audio", "transcribe"]) {
      assert.ok(JOB_KIND_LABEL[kind], `${kind} has no label`);
      assert.equal(jobKindLabel(kind), JOB_KIND_LABEL[kind]);
    }
    assert.equal(jobKindLabel("redo_cover"), "Redo cover");
    assert.equal(jobKindLabel("summarise-notes"), "Summarise notes");
    assert.equal(jobKindLabel("__"), "Job");
    assert.equal(jobKindLabel("toString"), "ToString");
  });

  test("job labels and work wording use no dashes between words", () => {
    const words = [
      ...Object.values(JOB_KIND_LABEL),
      ...workRows(status({
        queued: 2,
        jobs: [job(1, "ocr", "queued"), job(2, "thumb", "queued", { attempts: 2, run_after: new Date(NOW + 60_000).toISOString() })],
        listen: [listen("i1", "queued", { failed: 2, ready: 8 }), listen("i2", "upgrading")],
      }), NOW).flatMap((row) => [row.when, row.task, row.progress ?? ""]),
    ].join(" ");
    assert.ok(!/[\u2013\u2014]/.test(words), "an en or em dash crept into the wording");
  });

  test("work in hand runs now, next, then later, with jobs before Listen audio in each and nothing that failed", () => {
    const rows = workRows(status({
      queued: 3, running: 1, failed: 1,
      jobs: [
        job(1, "transcribe", "running", { target_kind: "recording", title: "HY101, Autumn Term week 3 lecture" }),
        job(2, "identify", "queued", { title: "The July Crisis" }),
        job(3, "convert", "queued"),
        job(4, "thumb", "queued"),
        job(5, "thumb", "failed", { attempts: 3, error: "No pages." }),
      ],
      listen: [
        listen("i1", "running", { title: "Empire", ready: 4, total: 12 }),
        listen("i2", "upgrading", { ready: 9, total: 9 }),
        listen("i3", "queued"),
        listen("i4", "queued"),
        listen("i5", "failed", { failed: 1 }),
      ],
    }), NOW);
    assert.deepEqual(
      rows.map((r) => r.key),
      ["job-1", "listen-i1-bf_emma", "listen-i2-bf_emma", "job-2", "listen-i3-bf_emma", "job-3", "job-4", "listen-i4-bf_emma"],
    );
    assert.deepEqual(rows.map((r) => r.when), ["Now", "Now", "Now", "Next", "Next", "Later", "Later", "Later"]);
  });

  test("a job waiting to try again is later, and the next job is the first the processor can take", () => {
    const rows = workRows(status({
      queued: 2,
      jobs: [
        job(1, "ocr", "queued", { attempts: 2, run_after: new Date(NOW + 4 * 60_000).toISOString() }),
        job(2, "thumb", "queued", { run_after: new Date(NOW - 60_000).toISOString() }),
      ],
    }), NOW);
    assert.deepEqual(rows.map((r) => [r.key, r.state]), [["job-2", "next"], ["job-1", "later"]]);
    assert.equal(rows[1].progress, "Attempt 2, tries again at 14:04");
  });

  test("a reading's title is in curly quotation marks, and a recording's place is not", () => {
    const rows = workRows(status({
      running: 1, queued: 1,
      jobs: [
        job(1, "transcribe", "running", { target_kind: "recording", title: "HY101, Autumn Term week 3 lecture" }),
        job(2, "extract_text", "queued", { title: "The July Crisis" }),
        job(3, "thumb", "queued", { label: "Imported slides" }),
        job(4, "thumb", "queued"),
      ],
    }), NOW);
    assert.equal(rows[0].title, "HY101, Autumn Term week 3 lecture");
    assert.equal(rows[0].task, "Transcribing the recording");
    assert.equal(rows[1].title, "\u201cThe July Crisis\u201d");
    assert.equal(rows[2].title, "Imported slides");
    assert.equal(rows[3].title, null, "a bare id means nothing to a person, so none is shown");
  });

  test("failed jobs and readings whose Listen audio failed are left out, while their counts stay", () => {
    const parsed = status({
      queued: 1, failed: 2,
      jobs: [
        job(8, "ocr", "failed", { attempts: 3, error: "Tesseract crashed." }),
        job(9, "thumb", "queued"),
        job(10, "convert", "failed", { attempts: 1 }),
      ],
      listen: [listen("i1", "failed", { failed: 3 }), listen("i2", "queued", { ready: 4, failed: 1 })],
    });
    const rows = workRows(parsed, NOW);
    assert.deepEqual(rows.map((r) => [r.key, r.when]), [["job-9", "Next"], ["listen-i2-bf_emma", "Next"]]);
    assert.equal(parsed.failed, 2, "the failed count is still read from the Worker");
    assert.equal(rows[1].progress, "4 of 10 paragraphs ready in Emma\u2019s British voice, 1 paragraph could not be made");
    assert.deepEqual(workRows(status({ failed: 1, jobs: [job(1, "ocr", "failed")], listen: [listen("i1", "failed")] }), NOW), []);
  });

  test("a running job that is on a later attempt says so", () => {
    const [row] = workRows(status({ running: 1, jobs: [job(9, "ocr", "running", { attempts: 2 })] }), NOW);
    assert.equal(row.when, "Now");
    assert.equal(row.progress, "Attempt 2");
  });

  test("Listen audio says how much is ready, in which voice, and how much could not be made", () => {
    const rows = workRows(status({
      listen: [
        listen("i1", "running", { title: "Empire", ready: 1, total: 1 }),
        listen("i2", "upgrading", { voice: "am_adam", ready: 12, total: 12 }),
        listen("i3", "queued", { voice: "xx", ready: 8, total: 10, failed: 2 }),
      ],
    }), NOW);
    assert.equal(rows[0].task, "Preparing Listen audio");
    assert.equal(rows[0].title, "\u201cEmpire\u201d");
    assert.equal(rows[0].progress, "1 of 1 paragraph ready in Emma\u2019s British voice");
    assert.equal(rows[1].task, "Remaking Listen audio on the graphics card");
    assert.equal(rows[1].progress, "12 of 12 paragraphs ready in Adam\u2019s American voice");
    assert.equal(rows[2].when, "Next");
    assert.equal(rows[2].progress, "8 of 10 paragraphs ready in the xx voice, 2 paragraphs could not be made");
    assert.equal(voiceLabel("bm_george"), "George\u2019s British voice");
  });

  test("an empty status has no work in hand and no waiting summary to add", () => {
    const empty = status({ jobs: [], listen: [] });
    assert.deepEqual(workRows(empty, NOW), []);
    assert.equal(waitingSummary(empty), null);
    assert.equal(waitingSummary(status({ failed: 3, listen: [listen("i1", "failed")] })), null, "failed work alone is not waiting");
  });

  test("each row says what Send to top moves: its job, or its reading's Listen audio in its voice", () => {
    const rows = workRows(status({
      queued: 2,
      jobs: [job(1, "ocr", "queued"), job(2, "thumb", "queued")],
      listen: [listen("i1", "queued"), listen("i2", "queued", { voice: "am_adam" }), listen("", "queued", { item_id: null })],
    }), NOW);
    assert.deepEqual(rows.map((r) => [r.when, r.target]), [
      ["Next", { source: "job", id: 1 }],
      ["Next", { source: "listen", itemId: "i1", voice: "bf_emma" }],
      ["Later", { source: "job", id: 2 }],
      ["Later", { source: "listen", itemId: "i2", voice: "am_adam" }],
      ["Later", { source: "listen", itemId: null, voice: "bf_emma" }],
    ]);
  });

  test("the waiting summary counts jobs and readings with Listen audio still to make", () => {
    assert.equal(waitingSummary(status({ queued: 1 })), "1 job is waiting.");
    assert.equal(waitingSummary(status({ queued: 2, running: 1 })), "3 jobs are waiting.");
    assert.equal(waitingSummary(status({ listen: [listen("i1", "queued")] })), "Listen audio for 1 reading is waiting.");
    assert.equal(
      waitingSummary(status({ queued: 1, listen: [listen("i1", "queued"), listen("i2", "running"), listen("i3", "failed")] })),
      "1 job and Listen audio for 2 readings are waiting.",
    );
  });

  test("five rows of work show at first", () => {
    assert.equal(VISIBLE_WORK, 5);
  });

  test("Settings groups the processor, speech and updates, and keeps old links working", () => {
    const src = readFileSync(new URL("../src/components/Settings.tsx", import.meta.url), "utf8");
    const order = [...src.matchAll(/\{ id: "(section-[a-z-]+)", label:/g)].map((m) => m[1]);
    assert.deepEqual(order, [
      "section-appearance", "section-term-dates", "section-shortcuts", "section-processor",
      "section-updates", "section-device", "section-bin", "section-danger",
    ]);
    assert.ok(/"section-pronunciations": \{ section: "section-processor", open: "pronunciations" \}/.test(src), "the old pronunciations link no longer opens them");
    assert.ok(src.includes('"section-speech": { section: "section-processor" }'), "the old speech link no longer leads anywhere");
    assert.ok(src.includes("<WorkList") && !src.includes("function JobList"), "the work list did not replace the job list");
    assert.ok(src.includes("VISIBLE_BIN") && src.includes("See ${hidden} more") && src.includes("Show fewer"), "Recently deleted has no See more");
    assert.ok(!/maxHeight: "14rem"|overflowY: "auto"/.test(src), "the work list sets its own scrolling inline again");
    assert.ok(src.includes('is-expanded') && !src.includes("work-error"), "the work list neither scrolls when expanded nor drops failed rows");
    assert.ok(!/#2f9e44|#e8590c/i.test(src), "the connection badge writes its own colours");
    assert.ok(!src.includes("Nothing is waiting") && !src.includes("Each shows Retry where it belongs"), "an empty queue or the failed jobs are spelt out again");
    assert.ok(/row\.state === "later" && \(\s*<button/.test(src) && src.includes("Send to top") && src.includes("prioritiseWork(row.target)"), "later rows no longer offer Send to top");
  });

  test("the work list scrolls inside its panel only once See more has opened it", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const rule = (selector: string) => {
      const start = css.indexOf(`\n${selector} {`);
      assert.ok(start >= 0, `${selector} has no rule`);
      return css.slice(start, css.indexOf("}", start));
    };
    assert.ok(!/max-height|overflow/.test(rule(".work-list")), "five rows scroll in a box before they need to");
    const expanded = rule(".work-list.is-expanded");
    assert.ok(/max-height: 18rem/.test(expanded) && /overflow-y: auto/.test(expanded), "the expanded list lengthens the page instead of scrolling");
  });

  test("Settings shows themes as compact pills and keeps its fields off stark white", () => {
    const src = readFileSync(new URL("../src/components/Settings.tsx", import.meta.url), "utf8");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    assert.ok(src.includes("theme-chip theme-pill") && !src.includes("zotero-theme"), "the theme cards are back");
    assert.ok(src.includes('role="group" aria-label="Appearance"'), "the theme tests can no longer find the themes");
    assert.ok(!/style=\{\{ flex: 1, minWidth: "14rem" \}\}/.test(src), "the term dates stretch apart again");
    assert.ok(/\.colour-names li \{[^}]*background: var\(--surface\)/.test(css), "the highlight names are not on the soft surface");
    assert.ok(/\.term-dates \.date-picker-trigger \{[^}]*background: var\(--surface\)/.test(css), "the term dates are not on the soft surface");
    assert.ok(/\.theme-pill\[aria-pressed="true"\][^{]*\{[^}]*box-shadow: inset 0 0 0 1px var\(--accent\)/.test(css), "the chosen theme lost its accent ring");
  });
}
