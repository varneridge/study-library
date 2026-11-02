// Read models. Each loader reads from IndexedDB, so it works offline and
// re-runs automatically inside useLiveQuery when any table it read changes.

import { db, type PendingUpload } from "./db";
import { byPosition } from "./keys";
import { byWeek, weekCode, isSection } from "./modules";
import { blockText } from "./notes";
import { moduleProgress, readCount, type ModuleProgress } from "./progress";
import { currentYear, defaultDates, isThisWeek, teachingWeek, type TeachingWeek, type TermDates } from "./term";
import { pending } from "./citations";
import type {
  Block,
  FileRow,
  HighlightRow,
  ItemRow,
  ModuleRow,
  NoteBlockRow,
  NoteRow,
  QuestionRow,
  RecordingRow,
  SessionRow,
  WeekItemRow,
  WeekRow,
} from "./types";

const live = <T extends { deleted: boolean }>(rows: T[]) => rows.filter((row) => !row.deleted);

export interface ReadingView {
  link: WeekItemRow | null;
  item: ItemRow;
  file: FileRow | null;
  upload: PendingUpload | null;
  // Whether the file is saved on this device for reading offline.
  cached: boolean;
}

export interface NoteView {
  note: NoteRow;
  blocks: Block[];
}

export interface QuestionView {
  question: QuestionRow;
  answered: boolean;
}

export interface SessionView {
  session: SessionRow;
  slides: ReadingView[];
  notes: NoteView[];
  recordings: RecordingRow[];
  questions: QuestionView[];
}

export interface WeekView {
  week: WeekRow;
  readings: ReadingView[];
  primaries: ReadingView[];
  summaries: ReadingView[];
  sessions: SessionView[];
}

export interface ModuleView {
  module: ModuleRow;
  weeks: WeekView[];
  tray: ReadingView[];
}

export interface WeekOverview {
  week: WeekRow;
  readingCount: { read: number; total: number };
  thumb_key: string | null;
  sessions: { session: SessionRow; hasNotes: boolean }[];
  isCurrentWeek: boolean;
}

export interface ModuleOverview {
  module: ModuleRow;
  weeks: WeekOverview[];
  tray: ReadingView[];
  found: ReadingView[];
  empty: boolean;
}

export interface ModuleSummary {
  module: ModuleRow;
  readings: number;
  read: number;
  // The first unread reading in the week you last opened, or the next week with one.
  next: { item: ItemRow; week: WeekRow } | null;
  progress: ModuleProgress;
}

export async function loadModules(now?: TeachingWeek | null): Promise<ModuleSummary[]> {
  if (now === undefined) {
    const dates = ((await db.settings.get("term-dates"))?.value ?? {}) as Partial<Record<number, TermDates>>;
    const year = currentYear();
    now = teachingWeek(new Date(), dates[year] ?? defaultDates(year));
  }
  const modules = live(await db.modules.toArray()).sort(byPosition);
  const result: ModuleSummary[] = [];
  for (const module of modules) {
    const weeks = live(await db.weeks.where("module_id").equals(module.id).toArray()).sort(byWeek);
    const links = live(await db.week_items.where("week_id").anyOf(weeks.map((w) => w.id)).toArray())
      .filter((l) => !l.session_id).sort(byPosition);
    const itemsMap = new Map(live((await db.items.bulkGet(links.map((l) => l.item_id))).filter(Boolean) as ItemRow[]).map((i) => [i.id, i]));
    const weekItemsList = weeks.map((week) => {
      const weekLinks = links.filter((l) => l.week_id === week.id);
      const weekItems = weekLinks.map((l) => itemsMap.get(l.item_id)).filter((i): i is ItemRow => Boolean(i));
      return { week, items: weekItems };
    });
    const progress = moduleProgress(weekItemsList, now);
    let next: ModuleSummary["next"] = null;
    const startIndex = (progress.state === "week" || progress.state === "upcoming" || progress.state === "reading-week")
      ? Math.max(0, weekItemsList.findIndex((w) => w.week.id === progress.week.id))
      : Math.max(0, weekItemsList.findIndex((w) => w.week.id === module.last_opened_week_id));

    // First search forward from current / opened week
    for (const entry of weekItemsList.slice(startIndex)) {
      const primaries = entry.items.filter((i) => i.kind === "primary");
      const secondaries = entry.items.filter((i) => i.kind === "secondary");
      const candidates = [...primaries, ...secondaries];
      const unread = candidates.find((i) => i.read_status !== "read");
      if (unread) {
        next = { item: unread, week: entry.week };
        break;
      }
    }
    // If nothing found forward, look from the start of the module
    if (!next) {
      for (const entry of weekItemsList.slice(0, startIndex)) {
        const primaries = entry.items.filter((i) => i.kind === "primary");
        const secondaries = entry.items.filter((i) => i.kind === "secondary");
        const candidates = [...primaries, ...secondaries];
        const unread = candidates.find((i) => i.read_status !== "read");
        if (unread) {
          next = { item: unread, week: entry.week };
          break;
        }
      }
    }
    const { read, total } = progress.state !== "none" ? { read: progress.read, total: progress.total } : { read: 0, total: 0 };
    result.push({ module, readings: total, read, next, progress });
  }
  return result;
}

async function readingViews(items: ItemRow[], links: Map<string, WeekItemRow>): Promise<ReadingView[]> {
  const fileIds = items.map((i) => i.file_id).filter((id): id is string => Boolean(id));
  const files = new Map((await db.files.bulkGet(fileIds)).filter(Boolean).map((f) => [f!.id, f!]));
  const uploads = new Map(
    (await db.uploads.where("item_id").anyOf(items.map((i) => i.id)).toArray()).map((u) => [u.item_id, u]),
  );
  const cached = new Set(fileIds.length ? await db.blobs.where("file_id").anyOf(fileIds).primaryKeys() : []);
  return items.map((item) => ({
    link: links.get(item.id) ?? null,
    item,
    file: item.file_id ? files.get(item.file_id) ?? null : null,
    upload: uploads.get(item.id) ?? null,
    cached: Boolean(item.file_id && cached.has(item.file_id)),
  }));
}

async function notesFor(where: { session_id?: string; item_id?: string; week_id?: string }): Promise<NoteView[]> {
  const [field, value] = Object.entries(where)[0];
  const notes = live(await db.notes.where(field).equals(value as string).toArray());
  const views: NoteView[] = [];
  for (const note of notes) {
    const blocks = live(await db.note_blocks.where("note_id").equals(note.id).toArray())
      .sort(byPosition)
      .map((row: NoteBlockRow) => row.content);
    if (blocks.length) views.push({ note, blocks });
  }
  return views;
}

// Whether a note holds any writing.
async function hasWriting(where: { question_id: string }): Promise<boolean> {
  const notes = live(await db.notes.where("question_id").equals(where.question_id).toArray());
  for (const note of notes) {
    const blocks = live(await db.note_blocks.where("note_id").equals(note.id).toArray());
    if (blocks.some((b) => blockText(b.content).trim())) return true;
  }
  return false;
}

export async function loadWeek(week: WeekRow): Promise<WeekView> {
  const links = live(await db.week_items.where("week_id").equals(week.id).toArray()).sort(byPosition);
  const items = live((await db.items.bulkGet(links.map((l) => l.item_id))).filter(Boolean) as ItemRow[]);
  const views = await readingViews(items, new Map(links.map((l) => [l.item_id, l])));
  const ordered = links
    .map((link) => views.find((v) => v.link?.id === link.id))
    .filter((v): v is ReadingView => Boolean(v));

  const sessions = live(await db.sessions.where("week_id").equals(week.id).toArray()).sort(byPosition);
  const sessionViews: SessionView[] = [];
  for (const session of sessions) {
    const questions = live(await db.questions.where("session_id").equals(session.id).toArray()).sort(byPosition);
    const questionViews: QuestionView[] = [];
    for (const question of questions) {
      questionViews.push({ question, answered: await hasWriting({ question_id: question.id }) });
    }
    sessionViews.push({
      session,
      slides: ordered.filter((v) => v.link?.session_id === session.id),
      notes: await notesFor({ session_id: session.id }),
      recordings: live(await db.recordings.where("session_id").equals(session.id).toArray()).sort((a, b) =>
        a.modified_at.localeCompare(b.modified_at),
      ),
      questions: questionViews,
    });
  }

  const loose = ordered.filter((v) => !v.link?.session_id);
  return {
    week,
    primaries: loose.filter((v) => v.item.kind === "primary"),
    readings: loose.filter((v) => v.item.kind === "secondary"),
    summaries: loose.filter((v) => v.item.kind === "summary"),
    sessions: sessionViews,
  };
}

export async function loadModule(moduleId: string): Promise<ModuleView | null> {
  const module = await db.modules.get(moduleId);
  if (!module || module.deleted) return null;
  const weeks = live(await db.weeks.where("module_id").equals(moduleId).toArray()).sort(byWeek);
  const weekViews = await Promise.all(weeks.map(loadWeek));
  const trayItems = live(await db.items.where("tray_module_id").equals(moduleId).toArray());
  const tray = await readingViews(trayItems, new Map());
  return { module, weeks: weekViews, tray };
}

export async function loadModuleOverview(
  moduleId: string,
  now?: TeachingWeek | null,
): Promise<ModuleOverview | null> {
  const module = await db.modules.get(moduleId);
  if (!module || module.deleted) return null;

  const rawWeeks = await db.weeks.where("module_id").equals(moduleId).toArray();
  const weeks = live(rawWeeks).sort(byWeek);
  const weekIds = weeks.map((w) => w.id);

  if (weekIds.length === 0) {
    const rawTray = await db.items.where("tray_module_id").equals(moduleId).toArray();
    const trayItems = live(rawTray);
    const tray = await readingViews(trayItems, new Map());
    const foundItems = trayItems.filter((i) => pending(i));
    const found = await readingViews(foundItems, new Map());
    return {
      module,
      weeks: [],
      tray,
      found,
      empty: tray.length === 0,
    };
  }

  // Bulk queries across weeks
  const [weekItems, sessions] = await Promise.all([
    db.week_items.where("week_id").anyOf(weekIds).toArray(),
    db.sessions.where("week_id").anyOf(weekIds).toArray(),
  ]);

  const liveWeekItems = live(weekItems);
  const liveSessions = live(sessions).sort(byPosition);
  const sessionIds = liveSessions.map((s) => s.id);

  const itemIds = Array.from(new Set(liveWeekItems.map((wi) => wi.item_id)));

  const [items, notes] = await Promise.all([
    itemIds.length > 0 ? db.items.where("id").anyOf(itemIds).toArray() : [],
    sessionIds.length > 0 ? db.notes.where("session_id").anyOf(sessionIds).toArray() : [],
  ]);

  const liveItems = live(items);
  const itemMap = new Map<string, ItemRow>(liveItems.map((i) => [i.id, i]));
  const liveNotes = live(notes);
  const sessionsWithNotes = new Set(liveNotes.map((n) => n.session_id));

  // Find slide deck and reading files with thumb_key
  const relevantFileIds = liveItems
    .filter((i) => i.file_id)
    .map((i) => i.file_id as string);

  const files = relevantFileIds.length > 0
    ? await db.files.where("id").anyOf(Array.from(new Set(relevantFileIds))).toArray()
    : [];
  const fileMap = new Map<string, FileRow>(live(files).map((f) => [f.id, f]));

  // Index week items and sessions by week_id
  const weekItemsByWeek = new Map<string, WeekItemRow[]>();
  for (const wi of liveWeekItems) {
    const list = weekItemsByWeek.get(wi.week_id);
    if (list) list.push(wi);
    else weekItemsByWeek.set(wi.week_id, [wi]);
  }

  const sessionsByWeek = new Map<string, SessionRow[]>();
  for (const s of liveSessions) {
    const list = sessionsByWeek.get(s.week_id);
    if (list) list.push(s);
    else sessionsByWeek.set(s.week_id, [s]);
  }

  // Build each week's overview
  const weekOverviews: WeekOverview[] = weeks.map((week) => {
    const wis = weekItemsByWeek.get(week.id) ?? [];
    const weekSessions = sessionsByWeek.get(week.id) ?? [];

    // Readings for this week: week items not tied to a session
    const readingItems = wis
      .filter((wi) => !wi.session_id)
      .map((wi) => itemMap.get(wi.item_id))
      .filter((i): i is ItemRow => Boolean(i && !i.deleted));
    const counts = readCount(readingItems);

    // Thumbnail candidate: first slide deck with a thumb_key, then fallback to first reading
    let thumb_key: string | null = null;
    for (const wi of wis) {
      const it = itemMap.get(wi.item_id);
      if (it && it.kind === "slides" && it.file_id) {
        const file = fileMap.get(it.file_id);
        if (file?.thumb_key) {
          thumb_key = file.thumb_key;
          break;
        }
      }
    }
    if (!thumb_key) {
      for (const wi of wis) {
        const it = itemMap.get(wi.item_id);
        if (it && it.kind !== "slides" && it.file_id) {
          const file = fileMap.get(it.file_id);
          if (file?.thumb_key) {
            thumb_key = file.thumb_key;
            break;
          }
        }
      }
    }

    const sessOverviews = weekSessions.map((s) => ({
      session: s,
      hasNotes: sessionsWithNotes.has(s.id),
    }));

    const isCurrentWeek = Boolean(now && isThisWeek(week, now));

    return {
      week,
      readingCount: counts,
      thumb_key,
      sessions: sessOverviews,
      isCurrentWeek,
    };
  });

  // Tray
  const rawTray = await db.items.where("tray_module_id").equals(moduleId).toArray();
  const trayItems = live(rawTray);
  const tray = await readingViews(trayItems, new Map());

  const allItems = [...liveItems, ...trayItems];
  const foundItems = allItems.filter((i) => pending(i));
  const found = await readingViews(foundItems, new Map());

  const empty =
    tray.length === 0 &&
    weekOverviews.every((w) => w.readingCount.total === 0 && !w.thumb_key);

  return {
    module,
    weeks: weekOverviews,
    tray,
    found,
    empty,
  };
}

export async function loadWeekPage(weekId: string): Promise<{
  module: ModuleRow;
  view: WeekView;
  next: WeekRow | null;
  previous: WeekRow | null;
  sectionNotes: NoteView[];
} | null> {
  const week = await db.weeks.get(weekId);
  if (!week || week.deleted) return null;
  const module = await db.modules.get(week.module_id);
  if (!module) return null;
  const siblings = live(await db.weeks.where("module_id").equals(module.id).toArray()).sort(byWeek);
  const index = siblings.findIndex((w) => w.id === week.id);
  const sectionNotes = isSection(week)
    ? (await notesFor({ week_id: week.id })).filter((n) => !n.note.session_id && !n.note.item_id)
    : [];
  return { module, view: await loadWeek(week), next: siblings[index + 1] ?? null, previous: siblings[index - 1] ?? null, sectionNotes };
}

export async function loadAcross(term: string, number: number) {
  const modules = live(await db.modules.toArray()).sort(byPosition);
  const result: { module: ModuleRow; view: WeekView }[] = [];
  for (const module of modules) {
    const week = live(await db.weeks.where("module_id").equals(module.id).toArray()).find(
      (w) => w.term === term && w.number === number,
    );
    if (week) result.push({ module, view: await loadWeek(week) });
  }
  return result;
}

export async function loadReader(itemId: string) {
  const item = await db.items.get(itemId);
  if (!item || item.deleted) return null;
  const file = item.file_id ? (await db.files.get(item.file_id)) ?? null : null;
  const upload = (await db.uploads.where("item_id").equals(itemId).first()) ?? null;
  const highlights = live(await db.highlights.where("item_id").equals(itemId).toArray()).sort(
    (a: HighlightRow, b: HighlightRow) => a.page - b.page || (b.rects[0]?.[3] ?? 0) - (a.rects[0]?.[3] ?? 0),
  );
  const link = live(await db.week_items.where("item_id").equals(itemId).toArray())[0] ?? null;
  const week = link ? (await db.weeks.get(link.week_id)) ?? null : null;
  // The readings either side, in the order the week page shows them.
  let previous: ItemRow | null = null;
  let next: ItemRow | null = null;
  if (week) {
    const view = await loadWeek(week);
    const order = link?.session_id
      ? view.sessions.find((s) => s.session.id === link.session_id)?.slides ?? []
      : [...view.primaries, ...view.readings, ...view.summaries];
    const index = order.findIndex((r) => r.item.id === itemId);
    previous = index > 0 ? order[index - 1].item : null;
    next = index >= 0 ? order[index + 1]?.item ?? null : null;
  }
  // The session it is slides for, if any, so the reader goes back there.
  const session = link?.session_id ? (await db.sessions.get(link.session_id)) ?? null : null;
  return { item, file, upload, highlights, week, previous, next, link, session: session && !session.deleted ? session : null };
}

export async function loadSession(sessionId: string) {
  const session = await db.sessions.get(sessionId);
  if (!session || session.deleted) return null;
  const week = await db.weeks.get(session.week_id);
  if (!week) return null;
  const module = await db.modules.get(week.module_id);
  if (!module) return null;
  const view = await loadWeek(week);
  const mine = view.sessions.find((s) => s.session.id === sessionId)!;
  const audio = new Map<string, FileRow>();
  for (const recording of mine.recordings) {
    if (recording.file_id) {
      const file = await db.files.get(recording.file_id);
      if (file) audio.set(recording.id, file);
    }
  }
  return { module, week, session, view: mine, audio, readings: [...view.primaries, ...view.readings, ...view.summaries] };
}

// Where a reading sits: its module and week. Used to label search results
// and the home page.
export interface Place { module: ModuleRow; week: WeekRow | null; label: string }

export async function placesOf(itemIds: string[]): Promise<Map<string, Place>> {
  const out = new Map<string, Place>();
  if (!itemIds.length) return out;
  const modules = new Map(live(await db.modules.toArray()).map((m) => [m.id, m]));
  const links = live(await db.week_items.where("item_id").anyOf(itemIds).toArray());
  const weeks = new Map(live((await db.weeks.bulkGet([...new Set(links.map((l) => l.week_id))])).filter(Boolean) as WeekRow[]).map((w) => [w.id, w]));
  for (const link of links) {
    const week = weeks.get(link.week_id);
    const module = week ? modules.get(week.module_id) : undefined;
    if (week && module && !out.has(link.item_id)) out.set(link.item_id, { module, week, label: `${module.code} ${weekCode(week)}` });
  }
  for (const item of live((await db.items.bulkGet(itemIds.filter((id) => !out.has(id)))).filter(Boolean) as ItemRow[])) {
    const module = item.tray_module_id ? modules.get(item.tray_module_id) : undefined;
    if (module) out.set(item.id, { module, week: null, label: `${module.code} unsorted` });
  }
  return out;
}

export interface RecentView { view: ReadingView; place: Place | null }

// The readings opened most recently, on any device.
export async function loadRecent(limit = 6): Promise<RecentView[]> {
  const items = live(await db.items.orderBy("last_opened_at").reverse().limit(limit * 3).toArray())
    .filter((i) => i.last_opened_at);
  const places = await placesOf(items.map((i) => i.id));
  const views = await readingViews(items.filter((i) => places.has(i.id)).slice(0, limit), new Map());
  return views.map((view) => ({ view, place: places.get(view.item.id) ?? null }));
}

// This week's sessions in every module, for going straight to the notes.
export interface WeekSessions {
  module: ModuleRow;
  week: WeekRow;
  sessions: { session: SessionRow; words: number; questions: number; recorded: boolean }[];
  // This week's readings: how many, how many are read, and the next to read.
  readings: { total: number; read: number; next: ItemRow | null };
}

export async function loadThisWeek(term: "AT" | "WT", number: number): Promise<WeekSessions[]> {
  const modules = live(await db.modules.toArray()).sort(byPosition);
  const out: WeekSessions[] = [];
  for (const module of modules) {
    const week = live(await db.weeks.where("module_id").equals(module.id).toArray()).find((w) => w.term === term && w.number === number);
    if (!week) continue;
    const sessions = live(await db.sessions.where("week_id").equals(week.id).toArray()).sort(byPosition);
    const rows = [];
    for (const session of sessions) {
      const notes = live(await db.notes.where("session_id").equals(session.id).toArray());
      let words = 0;
      for (const note of notes) {
        const blocks = live(await db.note_blocks.where("note_id").equals(note.id).toArray());
        words += blocks.reduce((n, b) => n + blockText(b.content).split(/\s+/).filter(Boolean).length, 0);
      }
      const questions = live(await db.questions.where("session_id").equals(session.id).toArray()).length;
      const recorded = live(await db.recordings.where("session_id").equals(session.id).toArray()).length > 0;
      rows.push({ session, words, questions, recorded });
    }
    const links = live(await db.week_items.where("week_id").equals(week.id).toArray())
      .filter((l) => !l.session_id)
      .sort(byPosition);
    const items = live(await db.items.bulkGet(links.map((l) => l.item_id)).then((found) => found.filter((i): i is ItemRow => Boolean(i))));
    const order = new Map(links.map((l, i) => [l.item_id, i]));
    const ordered = items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const { read, total } = readCount(ordered);
    // Primary readings first, as the week page lists them, then secondary readings.
    const primaries = ordered.filter((i) => i.kind === "primary");
    const secondaries = ordered.filter((i) => i.kind === "secondary");
    const candidates = [...primaries, ...secondaries];
    const next = candidates.find((i) => i.read_status !== "read") ?? null;
    out.push({ module, week, sessions: rows, readings: { total, read, next } });
  }
  return out;
}

// Sessions you have opened lately, newest first, kept in the synced settings.
export async function loadRecentSessions(limit = 4): Promise<{ session: SessionRow; week: WeekRow; module: ModuleRow; at: string }[]> {
  const list = ((await db.settings.get("recent-sessions"))?.value ?? []) as { id: string; at: string }[];
  const out = [];
  for (const entry of list) {
    const session = await db.sessions.get(entry.id);
    const week = session && !session.deleted ? await db.weeks.get(session.week_id) : undefined;
    const module = week && !week.deleted ? await db.modules.get(week.module_id) : undefined;
    if (session && week && module && !module.deleted) out.push({ session, week, module, at: entry.at });
    if (out.length >= limit) break;
  }
  return out;
}
