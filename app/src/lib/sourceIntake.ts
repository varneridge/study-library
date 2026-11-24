// The source card's drafts: what a dropped file, a reading or an admin document holds
// while its details are checked and edited, and how a set of them is added to an essay
// in one go. A dropped file becomes a reading of its own, kept off the week boards as
// admin documents already are, so that every source opens in the reader and can have
// passages linked and its text searched. Nothing is written until the card is done,
// so Cancel leaves the essay exactly as it was.

import { db } from "./db";
import { resolveExistingFile } from "./importing";
import { parseTitle } from "./parse";
import { openPdfData } from "./pdfOpen";
import { combinePhotos, isImage } from "./photos";
import { commit, newId, update } from "./sync";
import { mimeFor, queueUpload, sha256 } from "./uploads";
import {
  getModuleAssessment,
  saveModuleAssessment,
  type AssessmentData,
  type AttachedPaper,
  type CustomSource,
  type EssaySource,
} from "./assessment";
import { normaliseSourceCategory, type EssaySourceCategory, type PrimaryType, type SourceMeta } from "./essaySources";
import type { AttachmentRef, ItemKind, ItemRow, WorkKind } from "./types";

export type SourceRole = "admin" | "primary" | "secondary";

// Admin documents and sources go up in one request, so they are held under the size
// that would need the upload to be sent in parts.
export const SOURCE_FILE_LIMIT = 50 * 1024 * 1024;

export interface SourceDraft {
  key: string;
  role: SourceRole;
  // A new file, or the reading, hand-added source or uploaded paper being edited.
  file?: File;
  itemId?: string;
  customId?: string;
  paperId?: string;
  // An admin document's name.
  name: string;
  title: string;
  author: string;
  year: string;
  source: string;
  pages: string;
  doc_date: string;
  doi: string;
  work_kind: "article" | "chapter" | "book";
  primaryType: PrimaryType;
  // A picture of the first page or of the image itself, as an object URL the card revokes.
  thumb: string | null;
  error?: string;
}

const withoutExtension = (name: string) => name.replace(/\.[^.]+$/, "").trim() || name;

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

const secondaryWork = (kind: WorkKind | null | undefined): SourceDraft["work_kind"] =>
  kind === "chapter" || kind === "book" ? kind : "article";

function emptyDraft(role: SourceRole): SourceDraft {
  return {
    key: newId(),
    role,
    name: "",
    title: "",
    author: "",
    year: "",
    source: "",
    pages: "",
    doc_date: "",
    doi: "",
    work_kind: "article",
    primaryType: "other",
    thumb: null,
  };
}

// A dropped file, with what its name gives in the course's naming convention, such as
// "(AT3) Hobsbawm (1962) 'The Age of Revolution'", and its name alone otherwise.
export function draftFromFile(file: File, role: SourceRole): SourceDraft {
  const stem = withoutExtension(file.name);
  const parsed = parseTitle(stem);
  return {
    ...emptyDraft(role),
    file,
    name: stem,
    title: parsed.title || stem,
    author: parsed.author ?? "",
    year: parsed.year ? String(parsed.year) : "",
    source: parsed.source ?? "",
    pages: parsed.pages ?? "",
    doc_date: parsed.doc_date ?? "",
  };
}

// A title that a PDF's own details give is used only when it reads like one, since many
// carry the name of the program that made them or of the file they were saved from.
const usableTitle = (title: string) =>
  title.length > 2 && !/^microsoft (word|powerpoint)\b/i.test(title) && !/\.(docx?|pptx?|pdf|odt|rtf)$/i.test(title);

// What the file itself says: a PDF's title, author and year from its details, with a
// picture of its first page, or a picture's own image. It never throws, because a
// damaged or locked file still leaves the details read from its name.
export async function readFileDetails(file: File): Promise<Partial<SourceDraft>> {
  if (isImage(file)) return { thumb: URL.createObjectURL(file) };
  if (mimeFor(file) !== "application/pdf") return {};
  try {
    const doc = await openPdfData(file);
    try {
      const details: Partial<SourceDraft> = {};
      const { info } = (await doc.getMetadata()) as { info?: { Title?: unknown; Author?: unknown; CreationDate?: unknown } };
      const title = typeof info?.Title === "string" ? info.Title.trim() : "";
      const author = typeof info?.Author === "string" ? info.Author.trim() : "";
      const year = typeof info?.CreationDate === "string" ? /^(?:D:)?(\d{4})/.exec(info.CreationDate)?.[1] : undefined;
      if (usableTitle(title)) details.title = title;
      if (author) details.author = author;
      if (year) details.year = year;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 160 / page.getViewport({ scale: 1 }).width });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (context) {
        await page.render({ canvasContext: context, viewport }).promise;
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (blob) details.thumb = URL.createObjectURL(blob);
      }
      return details;
    } finally {
      void doc.destroy();
    }
  } catch {
    return {};
  }
}

// Adds what the file says to a draft without overwriting what its name already gave,
// which follows the course's own convention and so is the better guess.
export function withFileDetails(draft: SourceDraft, details: Partial<SourceDraft>): SourceDraft {
  const next: SourceDraft = { ...draft, thumb: details.thumb ?? draft.thumb };
  for (const field of ["title", "author", "year"] as const) {
    const value = details[field];
    if (value && (!draft[field] || (field === "title" && draft.title === draft.name))) next[field] = value;
  }
  return next;
}

// A reading or an admin document opened again for its details to be edited.
export function draftFromItem(item: ItemRow, role: SourceRole, meta?: SourceMeta): SourceDraft {
  return {
    ...emptyDraft(role),
    itemId: item.id,
    name: item.title,
    title: item.title,
    author: item.author ?? "",
    year: item.year ? String(item.year) : "",
    source: item.source ?? "",
    pages: item.pages ?? "",
    doc_date: item.doc_date ?? "",
    doi: item.doi ?? "",
    work_kind: secondaryWork(item.work_kind),
    primaryType: meta?.primaryType ?? "other",
  };
}

// A source added by hand, or a paper uploaded before sources had readings, opened again
// for its details to be edited. Neither can become an admin document unless it has a file.
export function draftFromSource(source: EssaySource, kind: "custom" | "paper", meta?: SourceMeta): SourceDraft {
  return {
    ...emptyDraft(normaliseSourceCategory(source.kind) === "primary" ? "primary" : "secondary"),
    ...(kind === "custom" ? { customId: source.id } : { paperId: source.id }),
    name: source.title,
    title: source.title,
    author: source.author ?? "",
    year: source.year ?? "",
    source: source.publisher ?? "",
    doc_date: source.year ?? "",
    doi: source.url ?? "",
    primaryType: meta?.primaryType ?? "other",
  };
}

// A blank title is allowed, so one is made from whatever else was given, as the
// reading editor does.
function titleOf(draft: SourceDraft, fallback: string): string {
  if (draft.role === "admin") return draft.name.trim() || fallback;
  const typed = draft.title.trim();
  if (typed) return typed;
  const when = draft.role === "primary" ? draft.doc_date.trim() : draft.year.trim();
  const byline = [draft.author.trim(), when ? `(${when})` : ""].filter(Boolean).join(" ");
  return byline || draft.source.trim() || fallback;
}

function itemFields(draft: SourceDraft, fallback: string): Partial<ItemRow> {
  const title = titleOf(draft, fallback);
  if (draft.role === "admin") return { title };
  const primary = draft.role === "primary";
  return {
    kind: (primary ? "primary" : "secondary") as ItemKind,
    work_kind: primary ? "primary" : draft.work_kind,
    title,
    author: draft.author.trim() || null,
    source: draft.source.trim() || null,
    pages: draft.pages.trim() || null,
    year: primary ? null : Number(draft.year) || null,
    doc_date: primary ? draft.doc_date.trim() || null : null,
    doi: draft.doi.trim() || null,
  };
}

// Where one committed draft goes on the essay.
interface Placed {
  id: string;
  role: SourceRole;
  primaryType: PrimaryType;
  isNew: boolean;
  file: { name: string; size: number; mime: string };
}

// Stores a new file as a reading of its own, or finds the reading that already holds
// the same file, so that a paper already set in the module is added rather than copied.
async function placeFile(draft: SourceDraft, file: File): Promise<Placed> {
  if (file.size > SOURCE_FILE_LIMIT) throw new Error(`${file.name} is over 50 MB, so it cannot be added in one go.`);
  // A picture goes in as the one-page PDF the reader opens, as a picture dropped anywhere else does.
  const [prepared] = isImage(file) ? await combinePhotos([file]) : [file];
  const mime = mimeFor(prepared) ?? (prepared.type || "application/octet-stream");
  const sha = await sha256(prepared);
  const existing = await resolveExistingFile(sha);
  if (existing) {
    const reading = (await db.items.where("file_id").equals(existing.fileId).toArray()).find((i) => !i.deleted && i.kind !== "slides");
    if (reading) {
      return { id: reading.id, role: draft.role, primaryType: draft.primaryType, isNew: false, file: { name: titleOf(draft, reading.title), size: prepared.size, mime } };
    }
  }
  const id = newId();
  const fallback = withoutExtension(file.name);
  await commit([
    {
      table: "items",
      row: {
        id,
        kind: "secondary" as const,
        author: null,
        title: fallback,
        source: null,
        pages: null,
        year: null,
        doc_date: null,
        ...itemFields(draft, fallback),
        file_id: existing?.fileId ?? null,
        original_file_id: existing?.originalFileId ?? null,
        tray_module_id: null,
        zotero_key: null,
        last_page: null,
        read_status: "unread" as const,
      },
    },
  ]);
  if (!existing) {
    await queueUpload({ file_id: newId(), item_id: id, name: prepared.name, mime, sha256: sha, bytes: prepared.size, blob: prepared });
  }
  return { id, role: draft.role, primaryType: draft.primaryType, isNew: true, file: { name: titleOf(draft, fallback), size: prepared.size, mime } };
}

// Saves an edited reading or admin document's details and says where it now goes.
async function placeItem(draft: SourceDraft, itemId: string): Promise<Placed> {
  const item = await db.items.get(itemId);
  if (!item || item.deleted) throw new Error("That reading has been deleted, so its details could not be saved.");
  await update("items", itemId, itemFields(draft, item.title));
  const file = item.file_id ? await db.files.get(item.file_id) : undefined;
  return {
    id: itemId,
    role: draft.role,
    primaryType: draft.primaryType,
    isNew: false,
    file: { name: titleOf(draft, item.title), size: file?.bytes ?? 0, mime: file?.mime ?? "application/octet-stream" },
  };
}

function withMeta(meta: Record<string, SourceMeta>, id: string, change: (entry: SourceMeta) => SourceMeta): Record<string, SourceMeta> {
  const entry = change({ ...(meta[id] ?? {}) });
  const next = { ...meta };
  if (entry.category || entry.primaryType) next[id] = entry;
  else delete next[id];
  return next;
}

// Puts one placed reading in its list on the essay: the admin documents for the admin
// role, under the reading's own name, and the essay's readings otherwise. A new
// secondary source is outside reading, since the course sets its own readings in its
// weeks, and a reading that stops being primary goes back to the group its kind gives.
function applyPlaced(data: AssessmentData, placed: Placed): AssessmentData {
  const admin = data.adminDocuments ?? [];
  let meta = data.sourceMeta ?? {};
  if (placed.role === "admin") {
    const known = admin.find((doc) => doc.id === placed.id);
    const doc: AttachmentRef = known ? { ...known, name: placed.file.name } : { id: placed.id, ...placed.file };
    meta = withMeta(meta, placed.id, (entry) => ({ ...entry, category: undefined }));
    return {
      ...data,
      referenceItemIds: data.referenceItemIds.filter((id) => id !== placed.id),
      adminDocuments: known ? admin.map((d) => (d.id === placed.id ? doc : d)) : [...admin, doc],
      sourceMeta: meta,
    };
  }
  meta = withMeta(meta, placed.id, (entry) => {
    if (placed.role === "primary") return { ...entry, category: "primary", primaryType: placed.primaryType };
    const next: SourceMeta = { ...entry, primaryType: undefined };
    if (placed.isNew) next.category = "secondary_outside";
    else if (next.category === "primary") next.category = undefined;
    return next;
  });
  return {
    ...data,
    adminDocuments: admin.filter((doc) => doc.id !== placed.id),
    referenceItemIds: data.referenceItemIds.includes(placed.id) ? data.referenceItemIds : [...data.referenceItemIds, placed.id],
    sourceMeta: meta,
  };
}

// The group a hand-added source or an uploaded paper goes to for its role, keeping the
// secondary group it was in when it stays secondary.
function sourceKind(role: SourceRole, current: unknown): EssaySourceCategory {
  if (role === "primary") return "primary";
  const now = normaliseSourceCategory(current, "secondary_outside");
  return now === "primary" ? "secondary_outside" : now;
}

function sourceFields<T extends CustomSource | AttachedPaper>(source: T, draft: SourceDraft): T {
  const primary = draft.role === "primary";
  return {
    ...source,
    title: titleOf(draft, source.title),
    kind: sourceKind(draft.role, source.kind),
    author: draft.author.trim() || undefined,
    year: (primary ? draft.doc_date : draft.year).trim() || undefined,
    publisher: draft.source.trim() || undefined,
    url: draft.doi.trim() || undefined,
  };
}

// Adds or saves every draft on the card. Each file is stored as soon as it is ready, so
// one that fails, such as one over the size limit, never loses the others, and the
// essay is then changed once for all of them, inside its save lock. Files wait in the
// upload queue, so this works offline and they go up when the connection returns.
export async function commitDrafts(
  ctx: { moduleId: string; moduleCode?: string; essayId?: string },
  drafts: SourceDraft[],
): Promise<{ added: number; updated: number; failed: { key: string; message: string }[] }> {
  const failed: { key: string; message: string }[] = [];
  const placed: { key: string; placed: Placed }[] = [];
  const edits: SourceDraft[] = [];
  for (const draft of drafts) {
    try {
      if (draft.file) placed.push({ key: draft.key, placed: await placeFile(draft, draft.file) });
      else if (draft.itemId) placed.push({ key: draft.key, placed: await placeItem(draft, draft.itemId) });
      else if (draft.customId && draft.role === "admin") throw new Error("A source added by hand has no file, so it cannot be an admin document.");
      else if (draft.customId || draft.paperId) edits.push(draft);
    } catch (error) {
      failed.push({ key: draft.key, message: errorText(error, "That source could not be added, so try again in a moment.") });
    }
  }
  if (!placed.length && !edits.length) return { added: 0, updated: 0, failed };

  // A paper is only an admin document with its stored file, which is checked against the
  // essay as saved rather than as it was when the card opened.
  const missing = new Set<string>();
  try {
    const current = await getModuleAssessment(ctx.moduleId, ctx.moduleCode, ctx.essayId);
    for (const draft of edits) {
      if (draft.paperId && draft.role === "admin" && !current.attachedPapers?.find((p) => p.id === draft.paperId)?.r2Key) missing.add(draft.key);
    }
    await saveModuleAssessment(
      ctx.moduleId,
      (data) => {
        let next = placed.reduce((acc, entry) => applyPlaced(acc, entry.placed), data);
        for (const draft of edits) {
          if (missing.has(draft.key)) continue;
          const id = draft.customId ?? draft.paperId!;
          const primaryType = draft.role === "primary" ? draft.primaryType : undefined;
          next = { ...next, sourceMeta: withMeta(next.sourceMeta ?? {}, id, (entry) => ({ ...entry, primaryType })) };
          if (draft.customId) {
            next = { ...next, customSources: (next.customSources ?? []).map((s) => (s.id === id ? sourceFields(s, draft) : s)) };
          } else if (draft.role === "admin") {
            const paper = next.attachedPapers?.find((p) => p.id === id);
            if (!paper?.r2Key) continue;
            const doc: AttachmentRef = { id, name: titleOf(draft, paper.title), size: paper.size ?? 0, mime: paper.mime ?? "application/octet-stream", r2Key: paper.r2Key };
            const admin = next.adminDocuments ?? [];
            next = {
              ...next,
              attachedPapers: next.attachedPapers?.filter((p) => p.id !== id),
              adminDocuments: admin.some((d) => d.id === id) ? admin : [...admin, doc],
            };
          } else {
            next = { ...next, attachedPapers: next.attachedPapers?.map((p) => (p.id === id ? sourceFields(p, draft) : p)) };
          }
        }
        return next;
      },
      { moduleCode: ctx.moduleCode, essayId: ctx.essayId },
    );
  } catch (error) {
    const message = errorText(error, "The essay could not be saved, so try again in a moment.");
    return { added: 0, updated: 0, failed: [...failed, ...placed.map((p) => ({ key: p.key, message })), ...edits.map((d) => ({ key: d.key, message }))] };
  }

  for (const key of missing) failed.push({ key, message: "That paper has no stored file, so it cannot be an admin document." });
  const added = placed.filter((p) => drafts.find((d) => d.key === p.key)?.file).length;
  return { added, updated: placed.length - added + edits.length - missing.size, failed };
}
