// The graduate shortlist: prospective programmes and roles to check and apply
// to. Kept in its own table so unstarted prospects never clutter active
// application counts, timelines or the Google Drive folder sync until promoted.

import { db } from "./db";
import { daysUntil, formatDate, isOpen as isAppOpen, normaliseUrl, stageOf, todayIso, type DeadlineState } from "./jobs";
import { commit, newId, update } from "./sync";
import type { ApplicationRow, FileSlot, ProspectRow } from "./types";
import { showToast } from "./ui";
import type { Category } from "./jobs";

export type ProspectStatusKey = "not_open" | "open" | "applying" | "applied";

export interface ProspectStatus {
  key: string;
  label: string;
  cat: Category;
}

// The four statuses a prospect can be given. Applied is the last of them,
// because choosing it moves the prospect into applications.
export const PROSPECT_STATUSES: ProspectStatus[] = [
  { key: "not_open", label: "Not open", cat: "todo" },
  { key: "open", label: "Open", cat: "todo" },
  { key: "applying", label: "Applying", cat: "waiting" },
  { key: "applied", label: "Applied", cat: "waiting" },
];

export const PROSPECT_STATUS_GROUPS: { label: string; keys: ProspectStatusKey[] }[] = [
  { label: "Your status", keys: ["not_open", "open", "applying", "applied"] },
];

// Keys and labels used before the shortlist was reduced to four statuses,
// so that rows written then still read as one of the four.
const STATUS_ALIASES: Record<string, ProspectStatusKey> = {
  not_started: "not_open",
  not_open: "not_open",
  researching: "not_open",
  open: "open",
  opened: "open",
  drafting: "applying",
  applying: "applying",
  submitted: "applied",
  applied: "applied",
  online_tests: "applied",
  interview: "applied",
  assessment_centre: "applied",
  offer: "applied",
};

// Earlier closing statuses are no longer offered, but a row that holds one
// still reads as closed, so it drops out of counts and the due list.
const LEGACY_CLOSED: Record<string, string> = {
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  not_applying: "Not applying",
};

function normaliseStatusKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function prospectStatusOf(key: string | null | undefined): ProspectStatus {
  if (!key || !key.trim()) return PROSPECT_STATUSES[0];
  const norm = normaliseStatusKey(key);
  const alias = STATUS_ALIASES[norm];
  if (alias) return PROSPECT_STATUSES.find((s) => s.key === alias) ?? PROSPECT_STATUSES[0];
  const closed = LEGACY_CLOSED[norm];
  if (closed) return { key: norm, label: closed, cat: "closed" };
  return { key, label: key, cat: "todo" };
}

export function effectiveProspectStatus(prospect: ProspectRow, linkedApp?: ApplicationRow): ProspectStatus {
  if (linkedApp && !linkedApp.deleted) {
    const st = stageOf(linkedApp.stage);
    return { key: st.key, label: st.label, cat: st.cat };
  }
  return prospectStatusOf(prospect.status);
}

export function isProspectOpen(prospect: ProspectRow, linkedApp?: ApplicationRow): boolean {
  if (linkedApp && !linkedApp.deleted) return isAppOpen(linkedApp);
  return prospectStatusOf(prospect.status).cat !== "closed";
}

// Next check turns red once the date arrives (today or earlier), and amber
// within the next seven days. Closed prospects show no due state.
export function checkState(
  prospect: Pick<ProspectRow, "next_check" | "status">,
  linkedApp?: ApplicationRow | null,
  now = new Date(),
): DeadlineState {
  const open = linkedApp && !linkedApp.deleted ? isAppOpen(linkedApp) : prospectStatusOf(prospect.status).cat !== "closed";
  if (!prospect.next_check || !open) return "none";
  const days = daysUntil(prospect.next_check, now);
  if (days <= 0) return "overdue";
  if (days <= 7) return "soon";
  return "none";
}

export function checkWords(
  prospect: Pick<ProspectRow, "next_check" | "status">,
  linkedApp?: ApplicationRow | null,
  now = new Date(),
): string {
  const open = linkedApp && !linkedApp.deleted ? isAppOpen(linkedApp) : prospectStatusOf(prospect.status).cat !== "closed";
  if (!prospect.next_check || !open) return "";
  const days = daysUntil(prospect.next_check, now);
  if (days < -1) return `overdue by ${-days} days`;
  if (days === -1) return "overdue by a day";
  if (days === 0) return "check today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

// Checking a programme pushes its next check a week on. A date of today or
// later moves on from itself, so checking early keeps the weekly rhythm,
// whereas a date already passed, or none at all, starts again from today.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function localIso(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const CHECK_INTERVAL_DAYS = 7;

export function checkedNextCheck(current: string | null | undefined, now = new Date()): string {
  if (current && ISO_DATE.test(current) && daysUntil(current, now) >= 0) {
    return addDaysIso(current, CHECK_INTERVAL_DAYS);
  }
  return addDaysIso(localIso(now), CHECK_INTERVAL_DAYS);
}

export async function markProspectChecked(prospect: Pick<ProspectRow, "id" | "next_check">): Promise<string> {
  const previous = prospect.next_check ?? null;
  const next = checkedNextCheck(previous);
  await update("prospects", prospect.id, { next_check: next });
  showToast(`Next check moved to ${formatDate(next)}.`, {
    label: "Undo",
    run: () => void update("prospects", prospect.id, { next_check: previous }),
  });
  return next;
}

export type ParsedLink =
  | { kind: "none"; raw: string }
  | { kind: "url"; raw: string; href: string; label: string }
  | { kind: "search"; raw: string; query: string; href: string; label: string }
  | { kind: "text"; raw: string; label: string };

export function parseProspectLink(link: string | null | undefined): ParsedLink {
  const raw = (link ?? "").trim();
  if (!raw) return { kind: "none", raw: "" };

  const searchMatch = raw.match(/^search:\s*(.+)$/i);
  if (searchMatch) {
    const query = searchMatch[1].trim();
    if (query) {
      return {
        kind: "search",
        raw,
        query,
        href: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
        label: `Search: ${query}`,
      };
    }
  }

  if (/^https?:\/\//i.test(raw) || (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(raw) && !/\s/.test(raw))) {
    const href = normaliseUrl(raw);
    if (href) {
      let label = raw.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
      try {
        const u = new URL(href);
        label = u.hostname.replace(/^www\./i, "");
      } catch {
        // Keep stripped label
      }
      return { kind: "url", raw, href, label };
    }
  }

  return { kind: "text", raw, label: raw };
}

// Applications store their links in the same forms as the shortlist does.
export const parseJobLink = parseProspectLink;

export type ProspectOrder = "next_check" | "employer" | "status";

const STATUS_ORDER: string[] = PROSPECT_STATUSES.map((s) => s.key);

function statusRank(raw: string): number {
  const status = prospectStatusOf(raw);
  const idx = STATUS_ORDER.indexOf(status.key);
  if (idx >= 0) return idx;
  return status.cat === "closed" ? STATUS_ORDER.length : STATUS_ORDER.length + 1;
}

export function sortProspects(
  prospects: ProspectRow[],
  order: ProspectOrder = "next_check",
  appsById?: Map<string, ApplicationRow>,
): ProspectRow[] {
  const byEmployer = (a: ProspectRow, b: ProspectRow) =>
    a.employer.localeCompare(b.employer, "en-GB", { sensitivity: "base" }) ||
    a.programme.localeCompare(b.programme, "en-GB", { sensitivity: "base" });

  if (order === "employer") {
    return [...prospects].sort(byEmployer);
  }

  if (order === "status") {
    return [...prospects].sort((a, b) => {
      return (
        statusRank(a.status) - statusRank(b.status) ||
        (a.next_check ?? "9999").localeCompare(b.next_check ?? "9999") ||
        byEmployer(a, b)
      );
    });
  }

  const group = (p: ProspectRow) => {
    const open = isProspectOpen(p, p.application_id ? appsById?.get(p.application_id) : undefined);
    if (!open) return 2;
    return p.next_check ? 0 : 1;
  };

  return [...prospects].sort((a, b) => {
    const gA = group(a);
    const gB = group(b);
    if (gA !== gB) return gA - gB;
    if (gA === 0) {
      const cmp = (a.next_check ?? "").localeCompare(b.next_check ?? "");
      if (cmp !== 0) return cmp;
    }
    return byEmployer(a, b);
  });
}

export interface ProspectSummary {
  open: number;
  closed: number;
  dueNow: number;
  soon: number;
  inProgress: number;
  offers: number;
}

export function summariseProspects(
  prospects: ProspectRow[],
  appsById?: Map<string, ApplicationRow>,
  now = new Date(),
): ProspectSummary {
  const s: ProspectSummary = { open: 0, closed: 0, dueNow: 0, soon: 0, inProgress: 0, offers: 0 };
  for (const p of prospects) {
    const linked = p.application_id ? appsById?.get(p.application_id) : undefined;
    const status = effectiveProspectStatus(p, linked);
    if (status.cat !== "closed") s.open += 1;
    else s.closed += 1;

    const state = checkState(p, linked, now);
    if (state === "overdue") s.dueNow += 1;
    if (state === "soon") s.soon += 1;
    if (status.cat === "waiting") s.inProgress += 1;
    if (status.cat === "offer") s.offers += 1;
  }
  return s;
}

export function matchesProspect(
  prospect: ProspectRow,
  query: string,
  linkedApp?: ApplicationRow,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const status = effectiveProspectStatus(prospect, linkedApp);
  const rawStatus = prospectStatusOf(prospect.status);
  return [
    prospect.employer,
    prospect.programme,
    prospect.salary ?? "",
    prospect.last_year_open ?? "",
    prospect.link ?? "",
    prospect.notes ?? "",
    status.label,
    rawStatus.label,
    prospect.next_check ? formatDate(prospect.next_check) : "",
  ].some((field) => field.toLowerCase().includes(q));
}

// Promotion. A prospect becomes an application once, and stays linked to it.
// A link to an application that has since been deleted counts as no link, so
// the prospect can be promoted again rather than being stuck.

async function hasLiveApplication(appId: string | null | undefined): Promise<boolean> {
  if (!appId) return false;
  const app = await db.applications.get(appId);
  return Boolean(app && !app.deleted);
}

export function isAppliedStatus(key: string | null | undefined): boolean {
  return Boolean(key) && prospectStatusOf(key).key === "applied";
}

export function stageForProspectStatus(statusKey: string): { stage: string; applied: string | null } {
  // The finer stages of older rows are kept, so promoting one of them loses
  // nothing that its status said.
  switch (normaliseStatusKey(statusKey || "")) {
    case "online_tests":
      return { stage: "oa_todo", applied: todayIso() };
    case "interview":
      return { stage: "interview_todo", applied: todayIso() };
    case "assessment_centre":
      return { stage: "ac_todo", applied: todayIso() };
    case "offer":
      return { stage: "offer", applied: todayIso() };
    case "rejected":
      return { stage: "rejected", applied: todayIso() };
    case "withdrawn":
    case "not_applying":
      return { stage: "withdrawn", applied: null };
    default:
      break;
  }
  switch (prospectStatusOf(statusKey).key) {
    case "not_open":
    case "open":
    case "applying":
      return { stage: "to_apply", applied: null };
    case "applied":
    default:
      return { stage: "applied", applied: todayIso() };
  }
}

interface PromoteOptions {
  stage: string;
  applied: string | null;
  // Changes to the prospect written in the same step, such as its status.
  prospectPatch?: Partial<ProspectRow>;
  // What Undo puts back on the prospect besides removing the link.
  undoPatch?: Partial<ProspectRow>;
}

// Every field the application has a place for is carried across: employer,
// programme as role, salary, the link as written (and, when it is a web
// address, as the role description's link too), and the notes.
async function promoteRow(current: ProspectRow, opts: PromoteOptions): Promise<string> {
  const merged: ProspectRow = { ...current, ...opts.prospectPatch };
  const appId = newId();
  const eventId = newId();
  const parsedLink = parseProspectLink(merged.link);
  const fileRd: FileSlot | null = parsedLink.kind === "url" ? { state: "saved", url: parsedLink.href } : null;

  await commit([
    {
      table: "applications",
      row: {
        id: appId,
        employer: merged.employer,
        role: merged.programme,
        salary: merged.salary ?? null,
        link: merged.link?.trim() || null,
        applied: opts.applied,
        stage: opts.stage,
        next_deadline: null,
        notes: merged.notes ?? null,
        file_cv: null,
        file_cl: null,
        file_rd: fileRd,
        file_qs: null,
      },
    },
    {
      table: "application_events",
      row: {
        id: eventId,
        application_id: appId,
        stage: opts.stage,
        from_stage: null,
        at: new Date().toISOString(),
        kind: "change" as const,
        cleared_deadline: null,
      },
    },
    {
      table: "prospects",
      row: {
        ...opts.prospectPatch,
        id: current.id,
        application_id: appId,
      },
      patch: true,
    },
  ]);

  showToast(`${merged.employer || "Programme"} added to applications.`, {
    label: "Undo",
    run: () => {
      void commit([
        { table: "applications", row: { id: appId, employer: "", role: "", salary: null, link: null, notes: null, deleted: true }, patch: true },
        { table: "application_events", row: { id: eventId, deleted: true }, patch: true },
        { table: "prospects", row: { ...opts.undoPatch, id: current.id, application_id: null }, patch: true },
      ]);
    },
  });

  return appId;
}

export async function promoteProspectToApplication(prospect: ProspectRow): Promise<string | null> {
  const current = await db.prospects.get(prospect.id);
  if (!current || current.deleted) return null;
  if (await hasLiveApplication(current.application_id)) return current.application_id;
  const { stage, applied } = stageForProspectStatus(current.status);
  return promoteRow(current, { stage, applied });
}

// Editing

export async function addProspect(initial?: Partial<ProspectRow>): Promise<string> {
  const id = newId();
  const status = initial?.status ?? "not_open";
  await commit([
    {
      table: "prospects",
      row: {
        id,
        employer: initial?.employer ?? "",
        programme: initial?.programme ?? "",
        salary: initial?.salary ?? null,
        link: initial?.link ?? null,
        last_year_open: initial?.last_year_open ?? null,
        next_check: initial?.next_check ?? null,
        status,
        notes: initial?.notes ?? null,
        application_id: initial?.application_id ?? null,
      },
    },
  ]);
  // A programme added as already applied goes straight into applications.
  if (isAppliedStatus(status) && !(await hasLiveApplication(initial?.application_id))) {
    const row = await db.prospects.get(id);
    if (row && !row.deleted) {
      await promoteRow(row, { stage: "applied", applied: todayIso(), undoPatch: { status: "applying" } });
    }
  }
  return id;
}

// Every save goes through here, so setting Applied from any screen (the
// status card, the sheet, the form or a table cell) promotes the prospect
// in the same step as the status is written.
export async function saveProspect(id: string, changes: Partial<ProspectRow>): Promise<void> {
  if (changes.status !== undefined && isAppliedStatus(changes.status)) {
    const current = await db.prospects.get(id);
    if (current && !current.deleted && !(await hasLiveApplication(current.application_id))) {
      await promoteRow(current, {
        stage: "applied",
        applied: todayIso(),
        prospectPatch: changes,
        undoPatch: { status: current.status },
      });
      return;
    }
  }
  await update("prospects", id, changes);
}

export async function discardProspectIfBlank(id: string): Promise<boolean> {
  const p = await db.prospects.get(id);
  if (
    !p ||
    p.deleted ||
    p.employer.trim() ||
    p.programme.trim() ||
    p.salary?.trim() ||
    p.link?.trim() ||
    p.last_year_open?.trim() ||
    p.notes?.trim()
  ) {
    return false;
  }
  await update("prospects", id, { deleted: true });
  return true;
}

export async function cancelNewProspect(id: string): Promise<void> {
  await commit([
    {
      table: "prospects",
      row: {
        id,
        employer: "",
        programme: "",
        salary: null,
        link: null,
        last_year_open: null,
        next_check: null,
        notes: null,
        deleted: true,
      },
      patch: true,
    },
  ]);
}

export async function deleteProspect(id: string): Promise<void> {
  const p = await db.prospects.get(id);
  if (!p) return;
  await update("prospects", id, { deleted: true });
}

export async function restoreProspect(id: string): Promise<void> {
  const p = await db.prospects.get(id);
  if (!p) return;
  await update("prospects", id, { deleted: false });
}

export async function changeProspectStatus(prospect: ProspectRow, targetStatus: string): Promise<void> {
  const previous = prospect.status;
  if (previous === targetStatus) return;
  // Applied promotes, and the promotion's own notice offers the Undo.
  if (isAppliedStatus(targetStatus) && !(await hasLiveApplication(prospect.application_id))) {
    await saveProspect(prospect.id, { status: targetStatus });
    return;
  }
  await update("prospects", prospect.id, { status: targetStatus });
  const statusObj = prospectStatusOf(targetStatus);
  showToast(`Status changed to ${statusObj.label}.`, {
    label: "Undo",
    run: () => void update("prospects", prospect.id, { status: previous }),
  });
}

export function computeProspectPatch(
  initial: ProspectRow,
  current: Partial<ProspectRow>,
): Partial<ProspectRow> {
  const patch: Partial<ProspectRow> = {};
  for (const [key, val] of Object.entries(current)) {
    const k = key as keyof ProspectRow;
    const initialVal = initial[k];
    if (val !== undefined && val !== initialVal) {
      (patch as Record<string, unknown>)[k] = val;
    }
  }
  return patch;
}

export interface ProspectValidation {
  valid: boolean;
  errors: {
    employer?: string;
    next_check?: string;
  };
}

export function validateProspect(fields: {
  employer: string;
  programme?: string | null;
  next_check?: string | null;
}): ProspectValidation {
  const errors: ProspectValidation["errors"] = {};
  if (!fields.employer || !fields.employer.trim()) {
    errors.employer = "Employer is required";
  }
  if (fields.next_check && !ISO_DATE.test(fields.next_check)) {
    errors.next_check = "Next check date must be YYYY-MM-DD";
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}
