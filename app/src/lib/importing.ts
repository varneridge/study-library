// Turning dropped or chosen files into readings and slides.

import { db } from "./db";
import { combinePhotos } from "./photos";
import { byPosition, keysAfter } from "./keys";
import { parseTitle, stripExtension, type Parsed } from "./parse";
import { commit, newId, type Change } from "./sync";
import { mimeFor, queueUpload, sha256 } from "./uploads";
import type { ItemKind, ModuleRow, WeekRow } from "./types";

export type PlanKind = ItemKind | "week-title" | "skip";

export interface PlannedFile {
  file: File;
  mime: string | null;
  parsed: Parsed;
  weekId: string | null;
  kind: PlanKind;
  order: number;
  author: string;
  title: string;
  source: string;
  pages: string;
  year: string;
  docDate: string;
  sha: string | null;
  existingFileId: string | null;
  sessionId?: string | null;
}

const SLIDES = /presentationml|ms-powerpoint/;

export function planFile(file: File, weeks: WeekRow[], forcedWeek?: WeekRow): PlannedFile {
  const mime = mimeFor(file);
  // A dissertation's files can begin with a section's name in brackets, as
  // in "(Chapter 2) Author (Year) 'Title'", and go to that section.
  let name = stripExtension(file.name);
  let sectionWeek: WeekRow | undefined;
  const bracket = /^\(([^)]+)\)\s*/.exec(name);
  if (bracket) {
    const wanted = bracket[1].trim().toLowerCase();
    sectionWeek = weeks.find((w) => w.term === "S" && !w.deleted && (w.title ?? "").trim().toLowerCase() === wanted);
    if (sectionWeek) name = name.slice(bracket[0].length);
  }
  // The citation after a section's name reads as it would after a week code.
  const parsed = sectionWeek ? { ...parseTitle(`(AT1) ${name}`), term: undefined, week: undefined } : parseTitle(name);
  const parsedWeek = parsed.term ? weeks.find((w) => w.term === parsed.term && w.number === parsed.week) : sectionWeek;
  const week = forcedWeek ?? parsedWeek ?? null;
  let kind: PlanKind =
    parsed.kind === "primary" ? "primary" : parsed.kind === "session" ? "week-title" : "secondary";
  if (mime && SLIDES.test(mime)) kind = "slides";
  if (!mime || parsed.kind === "module") kind = "skip";
  return {
    file, mime, parsed,
    weekId: week?.id ?? null,
    kind,
    order: parsed.order ?? 0,
    author: parsed.author ?? "",
    title: parsed.title,
    source: parsed.source ?? "",
    pages: parsed.pages ?? "",
    year: parsed.year ? String(parsed.year) : "",
    docDate: parsed.doc_date ?? "",
    sha: null,
    existingFileId: null,
  };
}

export async function hashPlans(plans: PlannedFile[], onEach?: () => void): Promise<void> {
  const files = (await db.files.toArray()).filter((f) => !f.deleted);
  for (const plan of plans) {
    if (plan.kind === "skip" || plan.sha) continue;
    plan.sha = await sha256(plan.file);
    plan.existingFileId = files.find((f) => f.sha256 === plan.sha)?.id ?? null;
    onEach?.();
  }
}

// Creates items, links and uploads for every plan that is not skipped.
// Plans without a week go to the module's unsorted tray.
export async function applyPlans(module: ModuleRow, plans: PlannedFile[]): Promise<number> {
  await hashPlans(plans);
  const weeks = new Map((await db.weeks.where("module_id").equals(module.id).toArray()).map((w) => [w.id, w]));
  const changes: Change[] = [];
  const uploads: Parameters<typeof queueUpload>[0][] = [];
  const nextKeys = new Map<string, string[]>();
  let count = 0;

  const ordered = [...plans].sort(
    (a, b) =>
      Number(a.kind === "primary") - Number(b.kind === "primary") ||
      a.order - b.order ||
      a.file.name.localeCompare(b.file.name),
  );

  for (const plan of ordered) {
    if (plan.kind === "skip" || !plan.mime) continue;
    const week = plan.weekId ? weeks.get(plan.weekId) : undefined;

    if (plan.kind === "week-title") {
      if (week && !week.title) changes.push({ table: "weeks", row: { ...week, title: plan.title } });
      continue;
    }

    let sessionId: string | null = plan.kind === "slides" ? plan.sessionId ?? null : null;
    if (plan.kind === "slides" && week && !sessionId) {
      const sessions = (await db.sessions.where("week_id").equals(week.id).toArray())
        .filter((s) => !s.deleted)
        .sort(byPosition);
      sessionId = (sessions.find((s) => s.kind !== "seminar") ?? sessions[0])?.id ?? null;
    }

    const itemId = newId();
    const fileId = plan.existingFileId ?? newId();
    changes.push({
      table: "items",
      row: {
        id: itemId,
        kind: plan.kind,
        author: plan.author.trim() || null,
        title: plan.title.trim() || plan.file.name,
        source: plan.source.trim() || null,
        pages: plan.pages.trim() || null,
        year: plan.year ? Number(plan.year) || null : null,
        doc_date: plan.docDate.trim() || null,
        file_id: plan.existingFileId,
        original_file_id: null,
        tray_module_id: week ? null : module.id,
        zotero_key: null,
        last_page: null,
        read_status: "unread" as const,
      },
    });

    if (week) {
      const scope = `${week.id}:${sessionId ?? ""}`;
      if (!nextKeys.has(scope)) {
        const links = (await db.week_items.where("week_id").equals(week.id).toArray())
          .filter((l) => !l.deleted && (l.session_id ?? null) === sessionId)
          .sort(byPosition);
        nextKeys.set(scope, keysAfter(links.at(-1)?.position ?? null, plans.length));
      }
      changes.push({
        table: "week_items",
        row: { id: newId(), week_id: week.id, item_id: itemId, session_id: sessionId, position: nextKeys.get(scope)!.shift()! },
      });
    }

    if (!plan.existingFileId) {
      uploads.push({
        file_id: fileId, item_id: itemId, name: plan.file.name, mime: plan.mime,
        sha256: plan.sha!, bytes: plan.file.size, blob: plan.file,
      });
    }
    count += 1;
  }

  await commit(changes);
  for (const upload of uploads) await queueUpload(upload);
  return count;
}

// Adds files to a session as its slides, from wherever the session is shown:
// its row on the week page or its own page. Pictures chosen together become
// one deck, a slide each.
export async function addSlides(sessionId: string, chosen: File[]): Promise<number> {
  const session = await db.sessions.get(sessionId);
  const week = session ? await db.weeks.get(session.week_id) : undefined;
  const module = week ? await db.modules.get(week.module_id) : undefined;
  if (!session || !week || !module || !chosen.length) return 0;
  const files = await combinePhotos(chosen);
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const plans = files.map((file) => ({ ...planFile(file, weeks, week), kind: "slides" as const, sessionId }));
  return applyPlans(module, plans);
}

export const SLIDES_ACCEPT = ".pdf,.pptx,.ppt,image/*,.heic,.heif";
