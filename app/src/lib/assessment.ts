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

export interface AssessmentData {
  title: string;
  wordTarget?: number | null;
  dueDate?: string | null;
  draft: DocxDocument;
  referenceItemIds: string[];
  previousDrafts: AssessmentSnapshot[];
  rev: number;
  updated_at?: string;
}

export function assessmentSettingKey(moduleId: string): string {
  return `assessment:${moduleId}`;
}

export function assessmentNotesKey(moduleId: string): string {
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

export function defaultAssessmentData(moduleCode?: string): AssessmentData {
  return {
    title: moduleCode ? `${moduleCode} Essay` : "Essay Draft",
    wordTarget: 2500,
    dueDate: null,
    draft: createEmptyDocxDocument(),
    referenceItemIds: EMPTY_REF_IDS,
    previousDrafts: EMPTY_DRAFTS,
    rev: 1,
  };
}

export function normaliseAssessmentData(raw: unknown, moduleCode?: string): AssessmentData {
  const fallback = defaultAssessmentData(moduleCode);
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
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title : fallback.title,
    wordTarget: typeof obj.wordTarget === "number" ? obj.wordTarget : fallback.wordTarget,
    dueDate: typeof obj.dueDate === "string" ? obj.dueDate : null,
    draft,
    referenceItemIds: Array.isArray(obj.referenceItemIds) ? obj.referenceItemIds : EMPTY_REF_IDS,
    previousDrafts: Array.isArray(obj.previousDrafts) ? obj.previousDrafts : EMPTY_DRAFTS,
    rev: typeof obj.rev === "number" ? obj.rev : 1,
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
  };
}

export function useModuleAssessment(moduleId: string, moduleCode?: string): AssessmentData {
  const row = useLiveQuery(() => db.settings.get(assessmentSettingKey(moduleId)), [moduleId]);
  return useMemo(() => normaliseAssessmentData(row?.value, moduleCode), [row?.value, moduleCode]);
}

export async function getModuleAssessment(moduleId: string, moduleCode?: string): Promise<AssessmentData> {
  const row = await db.settings.get(assessmentSettingKey(moduleId));
  return normaliseAssessmentData(row?.value, moduleCode);
}

export async function saveModuleAssessment(
  moduleId: string,
  updater: Partial<AssessmentData> | ((current: AssessmentData) => AssessmentData),
  options?: { expectedBaseRev?: number; moduleCode?: string },
): Promise<AssessmentData> {
  const key = assessmentSettingKey(moduleId);
  return withKeyLock(key, async () => {
    const existingRow = await db.settings.get(key);
    const current = normaliseAssessmentData(existingRow?.value, options?.moduleCode);

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
): Promise<AssessmentSnapshot> {
  const current = await getModuleAssessment(moduleId, moduleCode);
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
    { moduleCode },
  );
  return snapshot;
}

export async function restoreDraftSnapshot(
  moduleId: string,
  snapshotId: string,
  moduleCode?: string,
): Promise<boolean> {
  const current = await getModuleAssessment(moduleId, moduleCode);
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
    { moduleCode },
  );
  return true;
}

export async function deleteDraftSnapshot(
  moduleId: string,
  snapshotId: string,
  moduleCode?: string,
): Promise<void> {
  await saveModuleAssessment(
    moduleId,
    (prev) => ({
      ...prev,
      previousDrafts: prev.previousDrafts.filter((s) => s.id !== snapshotId),
    }),
    { moduleCode },
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
): Promise<DocxDocument> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const imported = await fromDocxBytes(bytes);
  const current = await getModuleAssessment(moduleId, moduleCode);
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
    { moduleCode },
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
