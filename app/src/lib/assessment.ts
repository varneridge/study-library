// Module assessment & essay storage, reference curation, snapshot history
// and DOCX import/export orchestration. Stored in the synced `settings` table
// under `assessment:<moduleId>` so it works across devices with no D1 migration.

import { useLiveQuery } from "dexie-react-hooks";
import { useMemo } from "react";
import { db } from "./db";
import {
  countDocxWords,
  fromDocxBytes,
  toDocxBlob,
  type DocxDocument,
} from "./docx";
import { commit, newId } from "./sync";
import { stripExtension } from "./parse";
import type { CiteTarget } from "./router";
import { chicagoNote, shortAuthor, shortTitle } from "./titles";
import type { AttachmentRef, ItemRow } from "./types";
import { isAssessmentEnabled } from "./assessmentEnabled";
import {
  addPassageLink,
  carryFootnoteBindings,
  createSourceLink,
  normaliseSourceCategory,
  normaliseSourceLinks,
  normaliseSourceMeta,
  removeLinksForFootnote,
  removePassageLink,
  type EssaySourceCategory,
  type SourceLink,
  type SourceMeta,
} from "./essaySources";
import { referencesByHighlight, type HighlightReference } from "./highlightReferences";

export type { CiteTarget } from "./router";

const EMPTY_REF_IDS: string[] = [];
const EMPTY_DRAFTS: AssessmentSnapshot[] = [];
const NO_REFERENCES = new Map<string, HighlightReference[]>();
const saveLocks = new Map<string, Promise<unknown>>();

function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = saveLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  saveLocks.set(key, next);
  // The caller hears of a failure from the promise returned, so the copy that only
  // clears the lock swallows it rather than reporting it a second time, unhandled.
  void next
    .finally(() => {
      if (saveLocks.get(key) === next) saveLocks.delete(key);
    })
    .catch(() => undefined);
  return next;
}

export interface AssessmentSnapshot {
  id: string;
  name: string;
  created_at: string;
  word_count: number;
  doc: DocxDocument;
}

export interface CustomSource {
  id: string;
  author?: string;
  title: string;
  year?: string;
  // "secondary" is the kind stored before course and outside reading were split,
  // and is read back as "secondary_course" by normaliseAssessmentData.
  kind?: EssaySourceCategory | "secondary";
  publisher?: string;
  url?: string;
  notes?: string;
}

// A file uploaded straight onto an essay as one of its sources, such as an archive
// scan or an article found outside the course, so it belongs to the essay rather
// than to any week of the module.
export interface AttachedPaper {
  id: string;
  title: string;
  kind: EssaySourceCategory;
  author?: string;
  year?: string;
  publisher?: string;
  url?: string;
  notes?: string;
  fileId?: string;
  r2Key?: string;
  name?: string;
  mime?: string;
  size?: number;
  added_at?: string;
}

// Anything the essay can cite apart from a reading list item.
export type EssaySource = CustomSource | AttachedPaper;

export interface ModuleEssayMeta {
  id: string;
  title: string;
  created_at?: string;
  updated_at?: string;
}

export interface AssessmentData {
  id?: string;
  enabled?: boolean;
  title: string;
  wordTarget?: number | null;
  dueDate?: string | null;
  includeFootnotes?: boolean;
  draft: DocxDocument;
  docx?: Uint8Array | null;
  referenceItemIds: string[];
  customSources?: CustomSource[];
  // The module's own papers for this essay, such as the brief and the rubric.
  adminDocuments?: AttachmentRef[];
  attachedPapers?: AttachedPaper[];
  sourceLinks?: SourceLink[];
  // What this essay knows about each of its sources, by the source's id.
  sourceMeta?: Record<string, SourceMeta>;
  previousDrafts: AssessmentSnapshot[];
  rev: number;
  updated_at?: string;
}

export function moduleEssaysKey(moduleId: string): string {
  return `module_essays:${moduleId}`;
}

export function assessmentSettingKey(moduleId: string, essayId?: string): string {
  if (essayId && essayId !== "default") {
    return `assessment:${moduleId}:${essayId}`;
  }
  return `assessment:${moduleId}`;
}

export function assessmentNotesKey(moduleId: string, essayId?: string): string {
  if (essayId && essayId !== "default") {
    return `assessment-notes:${moduleId}:${essayId}`;
  }
  return `assessment-notes:${moduleId}`;
}

export function createEmptyDocxDocument(): DocxDocument {
  return {
    blocks: [
      {
        id: "b-1",
        type: "paragraph",
        runs: [{ type: "text", text: "" }],
      },
    ],
    footnotes: [],
    comments: [],
    settings: {
      font: "Times New Roman",
      fontSizePt: 12,
      lineSpacing: 1.5,
      includeFootnotesInCount: true,
      includeQuotesInCount: true,
    },
  };
}

export function defaultAssessmentData(moduleCode?: string, essayId?: string): AssessmentData {
  return {
    id: essayId ?? "default",
    title: moduleCode ? `${moduleCode} Essay` : "Essay Draft",
    wordTarget: 2500,
    dueDate: null,
    includeFootnotes: true,
    draft: createEmptyDocxDocument(),
    referenceItemIds: EMPTY_REF_IDS,
    customSources: [],
    previousDrafts: EMPTY_DRAFTS,
    rev: 1,
  };
}

// Whether a stored value is a whole attachment, so that a malformed entry
// synced from another device is dropped rather than drawn as a broken file.
function isAttachmentRef(value: unknown): value is AttachmentRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as Partial<AttachmentRef>;
  return typeof ref.id === "string" && Boolean(ref.id)
    && typeof ref.name === "string"
    && typeof ref.mime === "string"
    && typeof ref.size === "number" && Number.isFinite(ref.size) && ref.size >= 0
    && (ref.r2Key === undefined || typeof ref.r2Key === "string");
}

// Reads the older plain "secondary" kind as course reading, leaving every other
// source exactly as stored so that nothing else about it changes on read.
function normaliseCustomSource(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const source = value as CustomSource;
  return source.kind === "secondary" ? { ...source, kind: "secondary_course" } : source;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

// Reads an uploaded paper, dropping one without an id or any name to show, since
// it could be neither opened nor listed. A paper with no stored kind was uploaded
// to the essay itself rather than set by the course, so it counts as outside reading.
export function normaliseAttachedPaper(value: unknown): AttachedPaper | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  const id = optionalText(obj.id);
  const name = optionalText(obj.name);
  const title = optionalText(obj.title) ?? name;
  if (!id || !title) return null;
  const paper: AttachedPaper = { id, title, kind: normaliseSourceCategory(obj.kind, "secondary_outside") };
  for (const field of ["author", "year", "publisher", "url", "notes", "fileId", "r2Key", "mime", "added_at"] as const) {
    const text = optionalText(obj[field]);
    if (text !== undefined) paper[field] = text;
  }
  if (name) paper.name = name;
  if (typeof obj.size === "number" && Number.isFinite(obj.size) && obj.size >= 0) paper.size = obj.size;
  return paper;
}

// Every source the essay can cite apart from its reading list items, custom
// sources first and uploaded papers after them, each in the order stored.
export function essaySourcesOf(data: Pick<AssessmentData, "customSources" | "attachedPapers">): EssaySource[] {
  return [...(data.customSources ?? []), ...(data.attachedPapers ?? [])];
}

export function normaliseAssessmentData(raw: unknown, moduleCode?: string, essayId?: string): AssessmentData {
  const fallback = defaultAssessmentData(moduleCode, essayId);
  if (!raw || typeof raw !== "object") return fallback;
  const obj = raw as Partial<AssessmentData>;
  const draft = obj.draft && Array.isArray(obj.draft.blocks)
    ? {
        blocks: obj.draft.blocks.length ? obj.draft.blocks : fallback.draft.blocks,
        footnotes: Array.isArray(obj.draft.footnotes) ? obj.draft.footnotes : [],
        comments: Array.isArray(obj.draft.comments) ? obj.draft.comments : [],
        settings: { ...fallback.draft.settings, ...(obj.draft.settings ?? {}) },
      }
    : fallback.draft;

  // Kept only when stored, so an essay that never had any reads as before.
  const adminDocuments = Array.isArray(obj.adminDocuments) ? obj.adminDocuments.filter(isAttachmentRef) : undefined;
  const attachedPapers = Array.isArray(obj.attachedPapers)
    ? obj.attachedPapers.map(normaliseAttachedPaper).filter((paper): paper is AttachedPaper => paper !== null)
    : undefined;
  const sourceLinks = Array.isArray(obj.sourceLinks) ? normaliseSourceLinks(obj.sourceLinks) : undefined;
  const sourceMeta = obj.sourceMeta !== undefined ? normaliseSourceMeta(obj.sourceMeta) : undefined;

  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : (essayId ?? "default"),
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title : fallback.title,
    wordTarget: typeof obj.wordTarget === "number" ? obj.wordTarget : fallback.wordTarget,
    dueDate: typeof obj.dueDate === "string" ? obj.dueDate : null,
    includeFootnotes: typeof obj.includeFootnotes === "boolean" ? obj.includeFootnotes : true,
    draft,
    referenceItemIds: Array.isArray(obj.referenceItemIds) ? obj.referenceItemIds : EMPTY_REF_IDS,
    customSources: Array.isArray(obj.customSources) ? (obj.customSources.map(normaliseCustomSource) as CustomSource[]) : [],
    ...(adminDocuments ? { adminDocuments } : {}),
    ...(attachedPapers ? { attachedPapers } : {}),
    ...(sourceLinks ? { sourceLinks } : {}),
    ...(sourceMeta ? { sourceMeta } : {}),
    previousDrafts: Array.isArray(obj.previousDrafts) ? obj.previousDrafts : EMPTY_DRAFTS,
    rev: typeof obj.rev === "number" ? obj.rev : 1,
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
  };
}

export function useModuleAssessment(moduleId: string, moduleCode?: string, essayId?: string): AssessmentData {
  const key = assessmentSettingKey(moduleId, essayId);
  const row = useLiveQuery(() => db.settings.get(key), [key]);
  return useMemo(() => normaliseAssessmentData(row?.value, moduleCode, essayId), [row?.value, moduleCode, essayId]);
}

export async function getModuleAssessment(
  moduleId: string,
  moduleCode?: string,
  essayId?: string,
): Promise<AssessmentData> {
  const row = await db.settings.get(assessmentSettingKey(moduleId, essayId));
  return normaliseAssessmentData(row?.value, moduleCode, essayId);
}

export async function getModuleEssays(moduleId: string, moduleCode?: string): Promise<ModuleEssayMeta[]> {
  const listRow = await db.settings.get(moduleEssaysKey(moduleId));
  const list = Array.isArray(listRow?.value) ? (listRow.value as ModuleEssayMeta[]) : null;
  if (list && list.length > 0) return list;

  const legacyRow = await db.settings.get(assessmentSettingKey(moduleId));
  if (isAssessmentEnabled(legacyRow)) {
    const data = normaliseAssessmentData(legacyRow?.value, moduleCode, "default");
    return [{ id: "default", title: data.title || (moduleCode ? `${moduleCode} Essay` : "Essay") }];
  }
  return [];
}

export function useModuleEssays(moduleId: string, moduleCode?: string): ModuleEssayMeta[] {
  const listKey = moduleEssaysKey(moduleId);
  const legacyKey = assessmentSettingKey(moduleId);
  const listRow = useLiveQuery(() => db.settings.get(listKey), [listKey]);
  const legacyRow = useLiveQuery(() => db.settings.get(legacyKey), [legacyKey]);

  return useMemo(() => {
    const list = Array.isArray(listRow?.value) ? (listRow.value as ModuleEssayMeta[]) : null;
    if (list && list.length > 0) return list;
    if (isAssessmentEnabled(legacyRow)) {
      const data = normaliseAssessmentData(legacyRow?.value, moduleCode, "default");
      return [{ id: "default", title: data.title || (moduleCode ? `${moduleCode} Essay` : "Essay") }];
    }
    return [];
  }, [listRow?.value, legacyRow, moduleCode]);
}

export async function addModuleEssay(
  moduleId: string,
  title?: string,
  moduleCode?: string,
): Promise<ModuleEssayMeta> {
  const existing = await getModuleEssays(moduleId, moduleCode);
  const id = existing.length === 0 ? "default" : newId();
  const essayTitle = title?.trim() || (moduleCode ? `${moduleCode} Essay` : "Essay");
  const meta: ModuleEssayMeta = {
    id,
    title: essayTitle,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const nextList = [...existing, meta];
  await commit([
    {
      table: "settings",
      row: {
        id: moduleEssaysKey(moduleId),
        value: nextList,
      },
    },
  ]);

  await saveModuleAssessment(
    moduleId,
    {
      id,
      enabled: true,
      title: essayTitle,
    },
    { moduleCode, essayId: id },
  );

  return meta;
}

export async function deleteModuleEssay(moduleId: string, essayId: string): Promise<void> {
  const listKey = moduleEssaysKey(moduleId);
  const listRow = await db.settings.get(listKey);
  const currentList = Array.isArray(listRow?.value) ? (listRow.value as ModuleEssayMeta[]) : [];
  const nextList = currentList.filter((e) => e.id !== essayId);

  await withKeyLock(listKey, async () => {
    if (nextList.length > 0) {
      await commit([
        {
          table: "settings",
          row: {
            id: listKey,
            value: nextList,
          },
        },
      ]);
    } else {
      await db.settings.delete(listKey);
    }
  });

  const settingKey = assessmentSettingKey(moduleId, essayId);
  const notesKey = assessmentNotesKey(moduleId, essayId);
  await db.settings.delete(settingKey);
  await db.settings.delete(notesKey);

  if (essayId === "default") {
    await db.settings.delete(assessmentSettingKey(moduleId));
  }
}

export async function renameModuleEssay(
  moduleId: string,
  essayId: string,
  title: string,
): Promise<void> {
  const cleanTitle = title.trim();
  if (!cleanTitle) return;

  const listKey = moduleEssaysKey(moduleId);
  const listRow = await db.settings.get(listKey);
  const currentList = Array.isArray(listRow?.value) ? (listRow.value as ModuleEssayMeta[]) : [];
  if (currentList.length > 0) {
    const nextList = currentList.map((e) =>
      e.id === essayId ? { ...e, title: cleanTitle, updated_at: new Date().toISOString() } : e,
    );
    await commit([
      {
        table: "settings",
        row: {
          id: listKey,
          value: nextList,
        },
      },
    ]);
  }

  await saveModuleAssessment(
    moduleId,
    { title: cleanTitle },
    { essayId },
  );
}

export async function saveModuleAssessment(
  moduleId: string,
  updater: Partial<AssessmentData> | ((current: AssessmentData) => AssessmentData),
  options?: { expectedBaseRev?: number; moduleCode?: string; essayId?: string },
): Promise<AssessmentData> {
  const essayId = options?.essayId;
  const key = assessmentSettingKey(moduleId, essayId);
  return withKeyLock(key, async () => {
    const existingRow = await db.settings.get(key);
    const current = normaliseAssessmentData(existingRow?.value, options?.moduleCode, essayId);

    let next = typeof updater === "function" ? updater(current) : { ...current, ...updater };

    // Conflict protection: if remote rev moved ahead of expectedBaseRev, preserve local draft as a snapshot
    if (
      options?.expectedBaseRev !== undefined &&
      current.rev > options.expectedBaseRev &&
      JSON.stringify(current.draft) !== JSON.stringify(next.draft)
    ) {
      const conflictSnap: AssessmentSnapshot = {
        id: newId(),
        name: `Conflict copy (${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })})`,
        created_at: new Date().toISOString(),
        word_count: countDocxWords(current.draft).total,
        doc: current.draft,
      };
      next = {
        ...next,
        previousDrafts: [conflictSnap, ...next.previousDrafts].slice(0, 30),
      };
    }

    const saved: AssessmentData = {
      ...next,
      id: next.id || essayId || "default",
      rev: (current.rev || 1) + 1,
      updated_at: new Date().toISOString(),
    };

    await commit([
      {
        table: "settings",
        row: {
          id: key,
          value: saved,
        },
      },
    ]);

    return saved;
  });
}

export async function saveDraftSnapshot(
  moduleId: string,
  name?: string,
  moduleCode?: string,
  essayId?: string,
): Promise<AssessmentSnapshot> {
  const current = await getModuleAssessment(moduleId, moduleCode, essayId);
  const wc = countDocxWords(current.draft).total;
  const stamp = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const snapshot: AssessmentSnapshot = {
    id: newId(),
    name: name?.trim() || `Draft (${stamp})`,
    created_at: new Date().toISOString(),
    word_count: wc,
    doc: structuredClone(current.draft),
  };
  await saveModuleAssessment(
    moduleId,
    (prev) => ({
      ...prev,
      previousDrafts: [snapshot, ...prev.previousDrafts].slice(0, 30),
    }),
    { moduleCode, essayId },
  );
  return snapshot;
}

export async function restoreDraftSnapshot(
  moduleId: string,
  snapshotId: string,
  moduleCode?: string,
  essayId?: string,
): Promise<boolean> {
  const current = await getModuleAssessment(moduleId, moduleCode, essayId);
  const target = current.previousDrafts.find((s) => s.id === snapshotId);
  if (!target) return false;

  const currentWords = countDocxWords(current.draft).total;
  const backups = [...current.previousDrafts];
  if (currentWords > 0) {
    backups.unshift({
      id: newId(),
      name: `Before restore (${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })})`,
      created_at: new Date().toISOString(),
      word_count: currentWords,
      doc: structuredClone(current.draft),
    });
  }

  await saveModuleAssessment(
    moduleId,
    {
      draft: structuredClone(target.doc),
      previousDrafts: backups.slice(0, 30),
    },
    { moduleCode, essayId },
  );
  return true;
}

export async function deleteDraftSnapshot(
  moduleId: string,
  snapshotId: string,
  moduleCode?: string,
  essayId?: string,
): Promise<void> {
  await saveModuleAssessment(
    moduleId,
    (prev) => ({
      ...prev,
      previousDrafts: prev.previousDrafts.filter((s) => s.id !== snapshotId),
    }),
    { moduleCode, essayId },
  );
}

export function downloadDocxFile(
  doc: DocxDocument,
  title: string,
  options?: { excludeResolvedComments?: boolean },
): void {
  const blob = toDocxBlob(doc, {
    title,
    excludeResolvedComments: options?.excludeResolvedComments,
  });
  const safeName = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "Essay Draft";
  const filename = safeName.toLowerCase().endsWith(".docx") ? safeName : `${safeName}.docx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function importAssessmentDocxFile(
  moduleId: string,
  file: File,
  moduleCode?: string,
  essayId?: string,
): Promise<DocxDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const imported = await fromDocxBytes(bytes);
  const current = await getModuleAssessment(moduleId, moduleCode, essayId);
  const currentWords = countDocxWords(current.draft).total;
  const previousDrafts = [...current.previousDrafts];

  if (currentWords > 0) {
    previousDrafts.unshift({
      id: newId(),
      name: `Before importing ${file.name}`,
      created_at: new Date().toISOString(),
      word_count: currentWords,
      doc: structuredClone(current.draft),
    });
  }

  const stem = file.name.replace(/\.docx$/i, "").trim();
  // The imported notes keep a source only where their text is the same as a note that
  // cited it, since a new document's notes cannot be paired with the old ones in order.
  let saved = imported;
  await saveModuleAssessment(
    moduleId,
    (prev) => {
      const carried = carryFootnoteBindings(prev.draft, imported, prev.sourceLinks ?? [], { pairByOrder: false });
      saved = carried.draft;
      return {
        ...prev,
        title: stem || current.title,
        draft: carried.draft,
        previousDrafts: previousDrafts.slice(0, 30),
        ...(prev.sourceLinks ? { sourceLinks: carried.sourceLinks } : {}),
      };
    },
    { moduleCode, essayId },
  );
  return saved;
}

// The group a reading is shown in on this essay: the one it was moved to, if any, and
// otherwise primary for a primary source and course reading for anything else.
export function readingCategoryOf(data: Pick<AssessmentData, "sourceMeta">, item: Pick<ItemRow, "id" | "kind">): EssaySourceCategory {
  return data.sourceMeta?.[item.id]?.category ?? (item.kind === "primary" ? "primary" : "secondary_course");
}

// Which of an essay's lists a source is held in, and where it can be moved.
export type SourceRef = { type: "reading" | "admin" | "custom" | "paper"; id: string };
export type SourceDestination = EssaySourceCategory | "admin";

function withSourceCategory(
  meta: Record<string, SourceMeta> | undefined,
  id: string,
  category: EssaySourceCategory | undefined,
): Record<string, SourceMeta> {
  const next = { ...(meta ?? {}) };
  const entry: SourceMeta = { ...(next[id] ?? {}) };
  if (category) entry.category = category;
  else delete entry.category;
  if (entry.category || entry.primaryType) next[id] = entry;
  else delete next[id];
  return next;
}

// Moves one source to a group or to the admin documents, keeping its id, so that every
// footnote and page reference that cites it still does. A reading needs its file's
// name, size and type to become an admin document, a source added by hand has no file
// and so never can, and an uploaded paper can only go there with its stored file. A
// legacy admin document with no reading of its own is given one by ensureSourceReading
// before it is moved into a group. The same data comes back when the move cannot be made.
export function moveSourceTo(
  data: AssessmentData,
  ref: SourceRef,
  to: SourceDestination,
  file?: { name: string; size: number; mime: string },
): AssessmentData {
  const admin = data.adminDocuments ?? [];
  switch (ref.type) {
    case "reading": {
      if (to !== "admin") return { ...data, sourceMeta: withSourceCategory(data.sourceMeta, ref.id, to) };
      if (!file) return data;
      return {
        ...data,
        referenceItemIds: data.referenceItemIds.filter((id) => id !== ref.id),
        adminDocuments: admin.some((doc) => doc.id === ref.id)
          ? admin
          : [...admin, { id: ref.id, name: file.name, size: file.size, mime: file.mime }],
        sourceMeta: withSourceCategory(data.sourceMeta, ref.id, undefined),
      };
    }
    case "admin": {
      if (to === "admin" || !admin.some((doc) => doc.id === ref.id)) return data;
      return {
        ...data,
        adminDocuments: admin.filter((doc) => doc.id !== ref.id),
        referenceItemIds: data.referenceItemIds.includes(ref.id) ? data.referenceItemIds : [...data.referenceItemIds, ref.id],
        sourceMeta: withSourceCategory(data.sourceMeta, ref.id, to),
      };
    }
    case "custom": {
      if (to === "admin") return data;
      return {
        ...data,
        customSources: (data.customSources ?? []).map((source) => (source.id === ref.id ? { ...source, kind: to } : source)),
      };
    }
    case "paper": {
      if (to !== "admin") {
        return {
          ...data,
          attachedPapers: data.attachedPapers?.map((paper) => (paper.id === ref.id ? { ...paper, kind: to } : paper)),
        };
      }
      const paper = data.attachedPapers?.find((p) => p.id === ref.id);
      if (!paper?.r2Key) return data;
      const doc: AttachmentRef = {
        id: paper.id,
        name: paper.name ?? paper.title,
        size: paper.size ?? 0,
        mime: paper.mime ?? "application/octet-stream",
        r2Key: paper.r2Key,
      };
      return {
        ...data,
        attachedPapers: data.attachedPapers?.filter((p) => p.id !== ref.id),
        adminDocuments: admin.some((d) => d.id === ref.id) ? admin : [...admin, doc],
      };
    }
  }
}

// Makes sure a stored file has a reading of its own, so that it opens in the reader and
// can have passages linked. A file uploaded before admin documents and essay sources had
// readings is only a key on the essay, so it is given the file row and the hidden
// reading a new upload gets, under ids made from its own, so that doing this on two
// devices makes the same rows rather than two copies. Whether a reading exists after
// this is returned, which is false for one deleted or with no stored file to make it from.
export async function ensureSourceReading(source: { id: string; name: string; size?: number; mime?: string; r2Key?: string }): Promise<boolean> {
  const existing = await db.items.get(source.id);
  if (existing) return !existing.deleted;
  if (!source.r2Key) return false;
  const fileId = `${source.id}:file`;
  await commit([
    {
      table: "files",
      row: {
        id: fileId,
        sha256: /[0-9a-f]{64}/i.exec(source.r2Key)?.[0].toLowerCase() ?? `legacy:${source.id}`,
        r2_key: source.r2Key,
        mime: source.mime ?? "application/octet-stream",
        bytes: source.size ?? 0,
        original_name: source.name,
        page_count: null,
        text_status: "pending" as const,
      },
    },
    {
      table: "items",
      row: {
        id: source.id,
        kind: "secondary" as const,
        author: null,
        title: stripExtension(source.name),
        source: null,
        pages: null,
        year: null,
        doc_date: null,
        file_id: fileId,
        original_file_id: null,
        tray_module_id: null,
        zotero_key: null,
        last_page: null,
        read_status: "unread" as const,
      },
    },
  ]);
  return true;
}

// Links a passage chosen in the reader to an essay's footnote, replacing any link that
// footnote had. The page is kept as the page number a reader sees, one more than the
// page's place in the file. A footnote renumbered by a save from the word processor
// since it was chosen is found again as the one note citing that reading with no
// passage yet. A target of "new:" and a key keeps the passage, with its note text, for
// the word processor tab with that key to add as a new footnote.
export async function linkPassage(
  target: CiteTarget,
  passage: { itemId: string; highlightId: string; quote: string; page: number; footnoteText: string },
): Promise<void> {
  const module = await db.modules.get(target.module);
  if (!module || module.deleted) throw new Error("The essay's module no longer exists, so the passage could not be linked.");
  const page = String(passage.page + 1);
  await saveModuleAssessment(
    target.module,
    (current) => {
      const links = current.sourceLinks ?? [];
      if (target.footnote.startsWith("new:")) {
        const session = target.footnote.slice("new:".length);
        const link = createSourceLink({
          id: newId(),
          sourceId: passage.itemId,
          highlightId: passage.highlightId,
          quote: passage.quote,
          page,
          footnoteText: passage.footnoteText,
          ...(session ? { awaitingInsert: session } : {}),
        });
        return { ...current, sourceLinks: [...links, link] };
      }
      const notes = current.draft.footnotes;
      let note = notes.find((n) => n.id === target.footnote);
      if (!note) {
        const withPassage = new Set(links.filter((l) => l.highlightId && l.footnoteId).map((l) => l.footnoteId));
        const citing = notes.filter((n) => n.citationItemId === passage.itemId && !withPassage.has(n.id));
        if (citing.length === 1) note = citing[0];
      }
      if (!note) throw new Error("That footnote has changed since you chose it, so choose Link to a source on it again.");
      const noteId = note.id;
      const link = createSourceLink({
        id: newId(),
        sourceId: passage.itemId,
        footnoteId: noteId,
        highlightId: passage.highlightId,
        quote: passage.quote,
        page,
      });
      return {
        ...current,
        draft: {
          ...current.draft,
          footnotes: notes.map((n) => (n.id === noteId ? { ...n, citationItemId: passage.itemId } : n)),
        },
        sourceLinks: [...removeLinksForFootnote(links, noteId), link],
      };
    },
    { moduleCode: module.code, essayId: target.essay },
  );
}

// The essays whose references draw on each highlight of a reading, kept up to date as any
// essay changes, so that a highlight's card can say it is in use before it is deleted.
export function useHighlightReferences(itemId: string): ReadonlyMap<string, HighlightReference[]> {
  return useLiveQuery(
    async () => referencesByHighlight(await db.settings.where("id").startsWith("assessment:").toArray(), await db.modules.toArray(), itemId),
    [itemId],
    NO_REFERENCES,
  );
}

const PASSAGE_NOTE_GONE = "That footnote has changed since this passage was opened, so go back to the essay and open its passage again.";

// Adds one highlight to the passage a footnote draws on, keeping the highlights it already
// has from the same source. Unlike linkPassage this never guesses at a footnote that has been
// renumbered, because a wrong guess would put the highlight on someone else's reference, so
// a footnote that is no longer in the draft is an error to report instead. The page is kept
// as the page number a reader sees, one more than the page's place in the file.
export async function addPassage(
  target: CiteTarget,
  passage: { itemId: string; highlightId: string; quote: string; page: number },
): Promise<void> {
  const module = await db.modules.get(target.module);
  if (!module || module.deleted) throw new Error("The essay's module no longer exists, so the passage could not be changed.");
  await saveModuleAssessment(
    target.module,
    (current) => {
      const notes = current.draft.footnotes;
      if (target.footnote.startsWith("new:") || !notes.some((n) => n.id === target.footnote)) throw new Error(PASSAGE_NOTE_GONE);
      return {
        ...current,
        draft: {
          ...current.draft,
          footnotes: notes.map((n) => (n.id === target.footnote ? { ...n, citationItemId: passage.itemId } : n)),
        },
        sourceLinks: addPassageLink(current.sourceLinks ?? [], {
          id: newId(),
          footnoteId: target.footnote,
          sourceId: passage.itemId,
          highlightId: passage.highlightId,
          quote: passage.quote,
          page: String(passage.page + 1),
        }),
      };
    },
    { moduleCode: module.code, essayId: target.essay },
  );
}

// Takes one highlight out of the passage a footnote draws on. The highlight itself stays in
// the reading and its notes.
export async function removePassage(target: CiteTarget, highlightId: string): Promise<void> {
  const module = await db.modules.get(target.module);
  if (!module || module.deleted) throw new Error("The essay's module no longer exists, so the passage could not be changed.");
  await saveModuleAssessment(
    target.module,
    (current) => {
      if (target.footnote.startsWith("new:") || !current.draft.footnotes.some((n) => n.id === target.footnote)) throw new Error(PASSAGE_NOTE_GONE);
      return { ...current, sourceLinks: removePassageLink(current.sourceLinks ?? [], target.footnote, highlightId) };
    },
    { moduleCode: module.code, essayId: target.essay },
  );
}

// Formats a Chicago 18th edition footnote (full note on first reference, short note thereafter).
export function formatChicagoFootnote(
  item: ItemRow,
  locator?: string | null,
  shortForm = false,
): string {
  const loc = locator?.trim() || null;
  if (shortForm) {
    const authorShort = shortAuthor(item.author) ?? "";
    const titlePart = item.title?.trim() || shortTitle(item);
    return `${authorShort ? `${authorShort}, ` : ""}${titlePart}${loc ? `, ${loc}` : ""}.`;
  }
  return chicagoNote(item, loc);
}

// The opening of the draft, for the assessment page: its first paragraphs,
// headings left out, cut at a word near the limit.
export function draftExcerpt(doc: DocxDocument, limit = 420): string {
  const parts: string[] = [];
  for (const block of doc.blocks) {
    if (block.type === "page_break" || block.type.startsWith("heading")) continue;
    const text = block.runs.map((r) => (r.type === "text" ? r.text ?? "" : "")).join("").replace(/\s+/g, " ").trim();
    if (text) parts.push(text);
    if (parts.join(" ").length >= limit) break;
  }
  const joined = parts.join(" ");
  if (joined.length <= limit) return joined;
  const cut = joined.slice(0, limit);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:.\s]+$/, "")}\u2026`;
}

// How far the draft is towards its word target, for a bar and its words.
export function wordProgress(words: number, target: number | null | undefined): { share: number; words: string } {
  const count = `${words.toLocaleString("en-GB")} ${words === 1 ? "word" : "words"}`;
  if (!target || target <= 0) return { share: 0, words: count };
  return { share: Math.min(1, words / target), words: `${words.toLocaleString("en-GB")} of ${target.toLocaleString("en-GB")} words` };
}

export { isAssessmentEnabled } from "./assessmentEnabled";

export async function enableModuleAssessment(
  moduleId: string,
  moduleCode?: string,
  essayId?: string,
): Promise<AssessmentData> {
  const existing = await getModuleEssays(moduleId, moduleCode);
  if (existing.length === 0) {
    const defaultMeta: ModuleEssayMeta = {
      id: essayId ?? "default",
      title: moduleCode ? `${moduleCode} Essay` : "Essay",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await commit([
      {
        table: "settings",
        row: {
          id: moduleEssaysKey(moduleId),
          value: [defaultMeta],
        },
      },
    ]);
  }
  return saveModuleAssessment(
    moduleId,
    (current) => ({
      ...current,
      enabled: true,
    }),
    { moduleCode, essayId },
  );
}

export async function deleteModuleAssessment(moduleId: string): Promise<void> {
  const key = assessmentSettingKey(moduleId);
  await db.settings.delete(key);
}
