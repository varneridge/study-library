// The graduate shortlist: prospective programmes and roles to check and apply
// to. Kept in its own table so unstarted prospects never clutter active
// application counts, timelines or the Google Drive folder sync until promoted.

import { db } from "./db";
import { daysUntil, formatDate, isOpen as isAppOpen, normaliseUrl, stageOf, todayIso, type DeadlineState } from "./jobs";
import { commit, newId, update, type Change } from "./sync";
import type { ApplicationRow, FileSlot, ProspectRow } from "./types";
import { showToast } from "./ui";
import type { Category } from "./jobs";

export interface ProspectStatus {
  key: string;
  label: string;
  cat: Category;
}

export const PROSPECT_STATUSES: ProspectStatus[] = [
  { key: "not_started", label: "Not started", cat: "todo" },
  { key: "researching", label: "Researching", cat: "todo" },
  { key: "drafting", label: "Drafting", cat: "todo" },
  { key: "submitted", label: "Submitted", cat: "waiting" },
  { key: "online_tests", label: "Online tests", cat: "waiting" },
  { key: "interview", label: "Interview", cat: "waiting" },
  { key: "assessment_centre", label: "Assessment centre", cat: "waiting" },
  { key: "offer", label: "Offer", cat: "offer" },
  { key: "rejected", label: "Rejected", cat: "closed" },
  { key: "withdrawn", label: "Withdrawn", cat: "closed" },
  { key: "not_applying", label: "Not applying", cat: "closed" },
];

export const PROSPECT_STATUS_GROUPS: { label: string; keys: string[] }[] = [
  { label: "Preparing", keys: ["not_started", "researching", "drafting"] },
  { label: "In progress", keys: ["submitted", "online_tests", "interview", "assessment_centre"] },
  { label: "Offer", keys: ["offer"] },
  { label: "Closed", keys: ["rejected", "withdrawn", "not_applying"] },
];

export function prospectStatusOf(key: string | null | undefined): ProspectStatus {
  if (!key) return PROSPECT_STATUSES[0];
  const byKey = PROSPECT_STATUSES.find((s) => s.key === key);
  if (byKey) return byKey;
  const byLabel = PROSPECT_STATUSES.find((s) => s.label.toLowerCase() === key.trim().toLowerCase());
  if (byLabel) return byLabel;
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

export type ProspectOrder = "next_check" | "employer" | "status";

const STATUS_RANK: Record<string, number> = Object.fromEntries(
  PROSPECT_STATUSES.map((s, idx) => [s.key, idx]),
);

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
      const rankA = STATUS_RANK[a.status] ?? 99;
      const rankB = STATUS_RANK[b.status] ?? 99;
      return rankA - rankB || (a.next_check ?? "9999").localeCompare(b.next_check ?? "9999") || byEmployer(a, b);
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

// Editing

export async function addProspect(initial?: Partial<ProspectRow>): Promise<string> {
  const id = newId();
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
        status: initial?.status ?? "not_started",
        notes: initial?.notes ?? null,
        application_id: initial?.application_id ?? null,
      },
    },
  ]);
  return id;
}

export const saveProspect = (id: string, changes: Partial<ProspectRow>) =>
  update("prospects", id, changes);

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

export function stageForProspectStatus(statusKey: string): { stage: string; applied: string | null } {
  switch (statusKey) {
    case "not_started":
    case "researching":
    case "drafting":
      return { stage: "to_apply", applied: null };
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
    case "submitted":
    default:
      return { stage: "applied", applied: todayIso() };
  }
}

export async function promoteProspectToApplication(prospect: ProspectRow): Promise<string | null> {
  const current = await db.prospects.get(prospect.id);
  if (!current || current.deleted || current.application_id) return current?.application_id ?? null;
  const appId = newId();
  const eventId = newId();
  const { stage, applied } = stageForProspectStatus(prospect.status);
  const parsedLink = parseProspectLink(prospect.link);
  const fileRd: FileSlot | null = parsedLink.kind === "url" ? { state: "saved", url: parsedLink.href } : null;

  await commit([
    {
      table: "applications",
      row: {
        id: appId,
        employer: prospect.employer,
        role: prospect.programme,
        salary: prospect.salary ?? null,
        applied,
        stage,
        next_deadline: null,
        notes: prospect.notes ?? null,
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
        stage,
        from_stage: null,
        at: new Date().toISOString(),
        kind: "change" as const,
        cleared_deadline: null,
      },
    },
    {
      table: "prospects",
      row: {
        id: prospect.id,
        application_id: appId,
      },
      patch: true,
    },
  ]);

  showToast(`${prospect.employer || "Programme"} added to applications.`, {
    label: "Undo",
    run: () => {
      void commit([
        { table: "applications", row: { id: appId, employer: "", role: "", salary: null, notes: null, deleted: true }, patch: true },
        { table: "application_events", row: { id: eventId, deleted: true }, patch: true },
        { table: "prospects", row: { id: prospect.id, application_id: null }, patch: true },
      ]);
    },
  });

  return appId;
}

export async function changeProspectStatus(prospect: ProspectRow, targetStatus: string): Promise<void> {
  const previous = prospect.status;
  if (previous === targetStatus) return;
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
  const dateIso = /^\d{4}-\d{2}-\d{2}$/;
  if (fields.next_check && !dateIso.test(fields.next_check)) {
    errors.next_check = "Next check date must be YYYY-MM-DD";
  }
  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}
