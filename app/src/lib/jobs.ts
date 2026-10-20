// The job search: applications, their stages, deadlines and files. It is
// kept apart from the study library. Nothing here is read by the reader,
// search or the processor.

import { db } from "./db";
import { api, commit, insert, newId, update, type Change, type Fresh } from "./sync";
import { sha256 } from "./uploads";
import { shortDate } from "./dates";
import type { ApplicationEventRow, ApplicationRow, FileSlot, SlotName } from "./types";
import { showToast } from "./ui";

export type Category = "todo" | "waiting" | "offer" | "closed";

// Stages are stored by key, so a stage can be reworded without touching
// the data. The category sets the colour; the wording says what is next.
export const STAGES: { key: string; label: string; cat: Category }[] = [
  { key: "to_apply", label: "To apply", cat: "todo" },
  { key: "applied", label: "Applied: awaiting response", cat: "waiting" },
  { key: "oa_todo", label: "Online test: to complete", cat: "todo" },
  { key: "oa_wait", label: "Online test: done, awaiting result", cat: "waiting" },
  { key: "written_todo", label: "Written assessment: to complete", cat: "todo" },
  { key: "written_wait", label: "Written assessment: done, awaiting result", cat: "waiting" },
  { key: "hirevue_todo", label: "Video interview: to record", cat: "todo" },
  { key: "hirevue_wait", label: "Video interview: done, awaiting result", cat: "waiting" },
  { key: "interview_todo", label: "Interview: to prepare and attend", cat: "todo" },
  { key: "interview_wait", label: "Interview: done, awaiting result", cat: "waiting" },
  { key: "ac_todo", label: "Assessment centre: to prepare and attend", cat: "todo" },
  { key: "ac_wait", label: "Assessment centre: done, awaiting result", cat: "waiting" },
  { key: "final_todo", label: "Final interview: to prepare and attend", cat: "todo" },
  { key: "final_wait", label: "Final interview: done, awaiting result", cat: "waiting" },
  { key: "offer", label: "Offer: to accept or decline", cat: "offer" },
  { key: "accepted", label: "Accepted", cat: "offer" },
  { key: "rejected", label: "Rejected", cat: "closed" },
  { key: "withdrawn", label: "Withdrawn", cat: "closed" },
  { key: "declined", label: "Offer declined", cat: "closed" },
  { key: "no_response", label: "No response", cat: "closed" },
];

export const CATEGORY_LABEL: Record<Category, string> = { todo: "To do", waiting: "Waiting", offer: "Offer", closed: "Closed" };

export function stageOf(key: string) {
  return STAGES.find((s) => s.key === key) ?? { key, label: key, cat: "waiting" as Category };
}

export interface StageGridRow {
  label: string;
  todo?: string;
  done?: string;
  extra?: string[];
}

export const STAGE_GRID: StageGridRow[] = [
  { label: "Applying", todo: "to_apply", done: "applied" },
  { label: "Online test", todo: "oa_todo", done: "oa_wait" },
  { label: "Written assessment", todo: "written_todo", done: "written_wait" },
  { label: "Video interview", todo: "hirevue_todo", done: "hirevue_wait" },
  { label: "Interview", todo: "interview_todo", done: "interview_wait" },
  { label: "Assessment centre", todo: "ac_todo", done: "ac_wait" },
  { label: "Final interview", todo: "final_todo", done: "final_wait" },
  { label: "Offer", todo: "offer", done: "accepted" },
  { label: "Closed", extra: ["rejected", "withdrawn", "declined", "no_response"] },
];

const LIKELY_NEXT: Record<string, string[]> = {
  to_apply: ["applied"],
  applied: ["oa_todo", "hirevue_todo", "interview_todo", "rejected"],
  oa_todo: ["oa_wait"],
  oa_wait: ["written_todo", "hirevue_todo", "interview_todo", "rejected"],
  written_todo: ["written_wait"],
  written_wait: ["hirevue_todo", "interview_todo", "ac_todo", "rejected"],
  hirevue_todo: ["hirevue_wait"],
  hirevue_wait: ["interview_todo", "ac_todo", "rejected"],
  interview_todo: ["interview_wait"],
  interview_wait: ["ac_todo", "final_todo", "offer", "rejected"],
  ac_todo: ["ac_wait"],
  ac_wait: ["final_todo", "offer", "rejected"],
  final_todo: ["final_wait"],
  final_wait: ["offer", "rejected"],
  offer: ["accepted", "declined"],
};

export function likelyNextStages(key: string): string[] {
  return LIKELY_NEXT[key] ?? [];
}

export const STAGE_ALIASES: Record<string, string[]> = {
  oa_todo: ["oa", "online test"],
  oa_wait: ["oa", "online test"],
  hirevue_todo: ["hirevue", "video interview"],
  hirevue_wait: ["hirevue", "video interview"],
};

export const SLOTS: { name: SlotName; short: string; label: string }[] = [
  { name: "cv", short: "CV", label: "CV" },
  { name: "cl", short: "CL", label: "Cover letter" },
  { name: "rd", short: "RD", label: "Role description" },
  { name: "qs", short: "Qs", label: "Answers to questions" },
];

export const slotColumn = (slot: SlotName) => `file_${slot}` as const;

// Dates are stored as YYYY-MM-DD and only formatted for display.

export function todayIso(now = new Date()): string {
  const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, "0"), d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// A stored date as a local midnight, never as UTC, so it is never a day out.
function localDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function formatDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  return shortDate(localDate(iso), { year: true });
}

// Whole days from today to the date. Dates only, so a deadline due today
// is never overdue in the afternoon.
export function daysUntil(iso: string, now = new Date()): number {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((localDate(iso).getTime() - today.getTime()) / 86_400_000);
}

export type DeadlineState = "none" | "overdue" | "soon";

// A closed application never shows a deadline as due.
export function deadlineState(app: Pick<ApplicationRow, "next_deadline" | "stage">, now = new Date()): DeadlineState {
  if (!app.next_deadline || stageOf(app.stage).cat === "closed") return "none";
  const days = daysUntil(app.next_deadline, now);
  if (days < 0) return "overdue";
  if (days <= 7) return "soon";
  return "none";
}

// Words for a deadline, so the colour never carries the meaning alone.
export function deadlineWords(app: Pick<ApplicationRow, "next_deadline" | "stage">, now = new Date()): string {
  if (!app.next_deadline || stageOf(app.stage).cat === "closed") return "";
  const days = daysUntil(app.next_deadline, now);
  if (days < -1) return `overdue by ${-days} days`;
  if (days === -1) return "overdue by a day";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

export const isOpen = (app: ApplicationRow) => stageOf(app.stage).cat !== "closed";

export type Order = "deadline" | "applied" | "employer";

// The default order: open applications by deadline, soonest first; then
// open ones with no deadline, newest first; then closed ones, newest first.
export function sortApplications(apps: ApplicationRow[], order: Order = "deadline"): ApplicationRow[] {
  const byApplied = (a: ApplicationRow, b: ApplicationRow) => (b.applied ?? "").localeCompare(a.applied ?? "") || a.employer.localeCompare(b.employer);
  const byEmployer = (a: ApplicationRow, b: ApplicationRow) => a.employer.localeCompare(b.employer, "en-GB", { sensitivity: "base" }) || byApplied(a, b);
  if (order === "applied") return [...apps].sort(byApplied);
  if (order === "employer") return [...apps].sort(byEmployer);
  const group = (a: ApplicationRow) => (!isOpen(a) ? 2 : a.next_deadline ? 0 : 1);
  return [...apps].sort((a, b) =>
    group(a) - group(b)
    || (group(a) === 0 ? a.next_deadline!.localeCompare(b.next_deadline!) : 0)
    || byApplied(a, b));
}

export interface Summary { open: number; closed: number; overdue: number; soon: number; offers: number }

export function summarise(apps: ApplicationRow[], now = new Date()): Summary {
  const s: Summary = { open: 0, closed: 0, overdue: 0, soon: 0, offers: 0 };
  for (const app of apps) {
    if (isOpen(app)) s.open += 1; else s.closed += 1;
    const state = deadlineState(app, now);
    if (state === "overdue") s.overdue += 1;
    if (state === "soon") s.soon += 1;
    if (stageOf(app.stage).cat === "offer") s.offers += 1;
  }
  return s;
}

export function matches(app: ApplicationRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const stage = stageOf(app.stage);
  const aliases = STAGE_ALIASES[app.stage] ?? [];
  return [app.employer, app.role, stage.label, ...aliases, app.notes ?? ""].some((field) => field.toLowerCase().includes(q));
}

// Editing

export async function addApplication(): Promise<string> {
  const id = newId();
  await insert("applications", {
    id, employer: "", role: "", applied: todayIso(), stage: "applied", next_deadline: null, notes: null,
    file_cv: null, file_cl: null, file_rd: null, file_qs: null,
  });
  return id;
}

export const saveApplication = (id: string, changes: Partial<ApplicationRow>) => update("applications", id, changes);

// A new application left with no employer or role is not kept.
export async function discardIfBlank(id: string): Promise<boolean> {
  const app = await db.applications.get(id);
  if (!app || app.deleted || app.employer.trim() || app.role.trim() || app.notes?.trim()) return false;
  if (SLOTS.some((s) => app[slotColumn(s.name)])) return false;
  await commit([{ table: "applications", row: { id, deleted: true }, patch: true }]);
  return true;
}

export async function deleteApplication(id: string): Promise<void> {
  await commit([{ table: "applications", row: { id, deleted: true }, patch: true }]);
}

export async function restoreApplication(id: string): Promise<void> {
  await commit([{ table: "applications", row: { id, deleted: false }, patch: true }]);
}

export function setSlot(id: string, slot: SlotName, value: FileSlot | null): Promise<void> {
  return update("applications", id, { [slotColumn(slot)]: value } as Partial<ApplicationRow>);
}

// Files for applications: PDFs, Word documents, plain text and pictures.
export const ATTACH_TYPES: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "application/msword": "Word",
  "text/plain": "text",
  "image/png": "picture", "image/jpeg": "picture", "image/webp": "picture",
};
export const ATTACH_ACCEPT = ".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg,.webp," + Object.keys(ATTACH_TYPES).join(",");
const ATTACH_LIMIT = 50 * 1024 * 1024;

// A browser sometimes gives a Word file no type. Its name settles it.
function typeOf(file: File): string {
  if (file.type && ATTACH_TYPES[file.type]) return file.type;
  const ext = file.name.toLowerCase().split(".").pop();
  return ({ pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", txt: "text/plain" } as Record<string, string>)[ext ?? ""] ?? file.type;
}

// Stores a file as a note picture is stored: by its contents, with no file
// row, so nothing processes it, search never sees it, and the storage sweep
// leaves it alone. Returns the slot to save.
export async function attachFile(file: File): Promise<FileSlot> {
  const mime = typeOf(file);
  if (!ATTACH_TYPES[mime]) throw new Error("Attach a PDF, Word document, text file or picture.");
  if (file.size > ATTACH_LIMIT) throw new Error("That file is over 50 MB.");
  if (!navigator.onLine) throw new Error("Connect to the internet to attach a file.");
  const sha = await sha256(file);
  const response = await api(`/api/files/${sha}`, { method: "PUT", headers: { "content-type": mime }, body: file });
  const { key } = (await response.json()) as { key: string };
  return { state: "saved", key, name: file.name, mime, bytes: file.size };
}

// A link a slot can open: the stored file under its own name, or a web address.
export function slotHref(slot: FileSlot | null): string | null {
  if (!slot || slot.state !== "saved") return null;
  if (slot.key) return `/api/objects/${slot.key}?name=${encodeURIComponent(slot.name ?? "file")}`;
  return slot.url ?? null;
}

export function normaliseUrl(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function sizeText(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Timeline and mis-tap rules

export function parseEntryTime(at: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    const [y, m, d] = at.split("-").map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  }
  return new Date(at).getTime();
}

export function sortEvents(events: ApplicationEventRow[]): ApplicationEventRow[] {
  return [...events].sort((a, b) => (parseEntryTime(a.at) - parseEntryTime(b.at)) || a.id.localeCompare(b.id));
}

export function formatDuration(fromMs: number, toMs: number, fromDateOnly = false, toDateOnly = false): string {
  const diffMs = Math.max(0, toMs - fromMs);
  const diffDays = Math.round(diffMs / 86_400_000);
  if (fromDateOnly && toDateOnly) {
    if (diffDays === 0) return "same day";
    return `${diffDays} ${diffDays === 1 ? "day" : "days"}`;
  }
  if (diffMs < 3_600_000) {
    return diffDays === 0 ? "same day" : `${diffDays} ${diffDays === 1 ? "day" : "days"}`;
  }
  const diffHours = Math.round(diffMs / 3_600_000);
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? "hour" : "hours"}`;
  }
  return `${diffDays} ${diffDays === 1 ? "day" : "days"}`;
}

export function daysSinceApplied(appliedDateIso: string | null, now = new Date()): number | null {
  if (!appliedDateIso || !/^\d{4}-\d{2}-\d{2}/.test(appliedDateIso)) return null;
  const [y, m, d] = appliedDateIso.slice(0, 10).split("-").map(Number);
  const appliedMidnight = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  return Math.max(0, Math.round((todayMidnight - appliedMidnight) / 86_400_000));
}

export function daysInStage(eventAt: string, now = new Date()): number {
  const t = parseEntryTime(eventAt);
  const eventDate = new Date(t);
  const eventMidnight = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate(), 0, 0, 0, 0).getTime();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  return Math.max(0, Math.round((todayMidnight - eventMidnight) / 86_400_000));
}

export function entryTimeText(at: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) {
    return formatDate(at);
  }
  const d = new Date(at);
  const hours = String(d.getHours()).padStart(2, "0");
  const mins = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${mins}`;
}

export interface StageChangeUndo {
  appId: string;
  previousStage: string;
  previousDeadline: string | null;
  previousApplied: string | null;
  action: "add" | "amend" | "remove";
  eventId: string;
  previousEvent?: ApplicationEventRow;
}

export interface StageChangePlan {
  action: "add" | "amend" | "remove";
  appUpdates: Partial<ApplicationRow>;
  eventChanges: Change[];
  undo: StageChangeUndo;
  notice: string;
}

export function evaluateStageChange(
  app: ApplicationRow,
  liveEvents: ApplicationEventRow[],
  targetStage: string,
  now = new Date(),
): StageChangePlan {
  const currentStage = app.stage;
  const sorted = sortEvents(liveEvents.filter((e) => !e.deleted && e.application_id === app.id));
  const lastEntry = sorted.length ? sorted[sorted.length - 1] : undefined;

  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  let inWindow = false;
  if (lastEntry && lastEntry.kind === "change" && lastEntry.stage === currentStage) {
    const entryMs = parseEntryTime(lastEntry.at);
    const elapsed = nowMs - entryMs;
    if (elapsed >= -60_000 && elapsed <= 600_000) {
      inWindow = true;
    }
  }

  if (inWindow && lastEntry) {
    if (targetStage === lastEntry.from_stage) {
      const appUpdates: Partial<ApplicationRow> = { stage: targetStage };
      if (lastEntry.cleared_deadline !== null) {
        appUpdates.next_deadline = lastEntry.cleared_deadline;
      }
      if (targetStage === "to_apply") {
        appUpdates.applied = null;
      } else if (lastEntry.stage === "to_apply" && !app.applied) {
        appUpdates.applied = todayIso(now);
      }

      const eventChanges: Change[] = [
        { table: "application_events", row: { id: lastEntry.id, deleted: true }, patch: true },
      ];

      return {
        action: "remove",
        appUpdates,
        eventChanges,
        undo: {
          appId: app.id,
          previousStage: app.stage,
          previousDeadline: app.next_deadline,
          previousApplied: app.applied,
          action: "remove",
          eventId: lastEntry.id,
          previousEvent: { ...lastEntry },
        },
        notice: `Stage returned to ${stageOf(targetStage).label}.`,
      };
    }

    if (likelyNextStages(lastEntry.stage).includes(targetStage)) {
      const shouldClearDeadline = stageOf(currentStage).cat === "todo" && stageOf(targetStage).cat !== "todo";
      const clearedDeadline = shouldClearDeadline ? app.next_deadline : null;
      const appUpdates: Partial<ApplicationRow> = { stage: targetStage };
      if (shouldClearDeadline) {
        appUpdates.next_deadline = null;
      }
      if (targetStage === "to_apply") {
        appUpdates.applied = null;
      } else if (currentStage === "to_apply" && !app.applied) {
        appUpdates.applied = todayIso(now);
      }

      const newEventId = newId();
      const newEvent: Fresh<"application_events"> = {
        id: newEventId,
        application_id: app.id,
        stage: targetStage,
        from_stage: currentStage,
        at: nowIso,
        kind: "change",
        cleared_deadline: clearedDeadline,
      };

      const eventChanges: Change[] = [
        { table: "application_events", row: newEvent },
      ];

      return {
        action: "add",
        appUpdates,
        eventChanges,
        undo: {
          appId: app.id,
          previousStage: app.stage,
          previousDeadline: app.next_deadline,
          previousApplied: app.applied,
          action: "add",
          eventId: newEventId,
        },
        notice: `Stage changed to ${stageOf(targetStage).label}.`,
      };
    }

    const originalFrom = lastEntry.from_stage ?? currentStage;
    const shouldClearDeadline = stageOf(originalFrom).cat === "todo" && stageOf(targetStage).cat !== "todo";
    const clearedDeadline = shouldClearDeadline ? (lastEntry.cleared_deadline ?? app.next_deadline) : null;
    const appUpdates: Partial<ApplicationRow> = { stage: targetStage };
    if (shouldClearDeadline) {
      appUpdates.next_deadline = null;
    } else if (stageOf(targetStage).cat === "todo" && lastEntry.cleared_deadline) {
      appUpdates.next_deadline = lastEntry.cleared_deadline;
    }
    if (targetStage === "to_apply") {
      appUpdates.applied = null;
    } else if (originalFrom === "to_apply" && targetStage !== "to_apply" && !app.applied) {
      appUpdates.applied = todayIso(now);
    }

    const eventChanges: Change[] = [
      {
        table: "application_events",
        row: {
          id: lastEntry.id,
          stage: targetStage,
          cleared_deadline: clearedDeadline,
        },
        patch: true,
      },
    ];

    const timeStr = entryTimeText(lastEntry.at);
    return {
      action: "amend",
      appUpdates,
      eventChanges,
      undo: {
        appId: app.id,
        previousStage: app.stage,
        previousDeadline: app.next_deadline,
        previousApplied: app.applied,
        action: "amend",
        eventId: lastEntry.id,
        previousEvent: { ...lastEntry },
      },
      notice: `${stageOf(targetStage).label}, replacing the change at ${timeStr}.`,
    };
  }

  const shouldClearDeadline = stageOf(currentStage).cat === "todo" && stageOf(targetStage).cat !== "todo";
  const clearedDeadline = shouldClearDeadline ? app.next_deadline : null;
  const appUpdates: Partial<ApplicationRow> = { stage: targetStage };
  if (shouldClearDeadline) {
    appUpdates.next_deadline = null;
  }
  if (targetStage === "to_apply") {
    appUpdates.applied = null;
  } else if (currentStage === "to_apply" && !app.applied) {
    appUpdates.applied = todayIso(now);
  }

  const newEventId = newId();
  const newEvent: Fresh<"application_events"> = {
    id: newEventId,
    application_id: app.id,
    stage: targetStage,
    from_stage: currentStage,
    at: nowIso,
    kind: "change",
    cleared_deadline: clearedDeadline,
  };

  const eventChanges: Change[] = [
    { table: "application_events", row: newEvent },
  ];

  return {
    action: "add",
    appUpdates,
    eventChanges,
    undo: {
      appId: app.id,
      previousStage: app.stage,
      previousDeadline: app.next_deadline,
      previousApplied: app.applied,
      action: "add",
      eventId: newEventId,
    },
    notice: `Stage changed to ${stageOf(targetStage).label}.`,
  };
}

export function undoStageChangeChanges(undo: StageChangeUndo): Change[] {
  const changes: Change[] = [
    {
      table: "applications",
      row: {
        id: undo.appId,
        stage: undo.previousStage,
        next_deadline: undo.previousDeadline,
        applied: undo.previousApplied,
      },
      patch: true,
    },
  ];

  if (undo.action === "add") {
    changes.push({
      table: "application_events",
      row: { id: undo.eventId, deleted: true },
      patch: true,
    });
  } else if (undo.action === "amend" && undo.previousEvent) {
    changes.push({
      table: "application_events",
      row: {
        id: undo.eventId,
        stage: undo.previousEvent.stage,
        from_stage: undo.previousEvent.from_stage,
        cleared_deadline: undo.previousEvent.cleared_deadline,
      },
      patch: true,
    });
  } else if (undo.action === "remove" && undo.previousEvent) {
    changes.push({
      table: "application_events",
      row: {
        id: undo.eventId,
        deleted: false,
      },
      patch: true,
    });
  }

  return changes;
}

export async function undoStageChange(undo: StageChangeUndo): Promise<void> {
  await commit(undoStageChangeChanges(undo));
}

export function getTimelineEntries(app: ApplicationRow, events: ApplicationEventRow[]): ApplicationEventRow[] {
  const live = sortEvents(events.filter((e) => !e.deleted && e.application_id === app.id));
  if (!live.length && app.applied) {
    const fallback: ApplicationEventRow = {
      id: `virtual-applied-${app.id}`,
      application_id: app.id,
      stage: "applied",
      from_stage: null,
      at: app.applied,
      kind: "manual",
      cleared_deadline: null,
      modified_at: app.modified_at,
      seq: 0,
      deleted: false,
    };
    return [fallback];
  }
  return live;
}
