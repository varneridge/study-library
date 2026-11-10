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
import { chicagoNote, shortAuthor, shortTitle } from "./titles";
import type { ItemRow } from "./types";
import { isAssessmentEnabled } from "./assessmentEnabled";

const EMPTY_REF_IDS: string[] = [];
const EMPTY_DRAFTS: AssessmentSnapshot[] = [];
const saveLocks = new Map<string, Promise<unknown>>();

function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = saveLocks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  saveLocks.set(key, next);
  void next.finally(() => {
    if (saveLocks.get(key) === next) saveLocks.delete(key);
  });
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
  kind?: "primary" | "secondary";
  publisher?: string;
  url?: string;
  notes?: string;
}

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

  return {
    id: typeof obj.id === "string" && obj.id ? obj.id : (essayId ?? "default"),
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : undefined,
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title : fallback.title,
    wordTarget: typeof obj.wordTarget === "number" ? obj.wordTarget : fallback.wordTarget,
    dueDate: typeof obj.dueDate === "string" ? obj.dueDate : null,
    includeFootnotes: typeof obj.includeFootnotes === "boolean" ? obj.includeFootnotes : true,
    draft,
    referenceItemIds: Array.isArray(obj.referenceItemIds) ? obj.referenceItemIds : EMPTY_REF_IDS,
    customSources: Array.isArray(obj.customSources) ? obj.customSources : [],
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
  await saveModuleAssessment(
    moduleId,
    {
      title: stem || current.title,
      draft: imported,
      previousDrafts: previousDrafts.slice(0, 30),
    },
    { moduleCode, essayId },
  );
  return imported;
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
