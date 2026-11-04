// Video readings and manual companion transcripts.
// Videos stream via HTTP 206 Partial Content without bloating IndexedDB unless
// explicitly saved for offline use. Transcripts are attached manually by the
// user (.txt, .docx or .pdf) and never generated automatically.

import { db } from "./db";
import { extractDocxText } from "./docx";
import { update } from "./sync";
import type { FileRow } from "./types";

export const TRANSCRIPT_ACCEPT =
  ".docx,.pdf,.txt,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export interface VideoMeta {
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  transcript_file_id?: string | null;
  transcript_name?: string | null;
  transcript_text?: string | null;
  transcript_updated_at?: string | null;
}

export function isVideoMime(mime?: string | null): boolean {
  return Boolean(mime && mime.startsWith("video/"));
}

export function parseVideoMeta(meta?: string | null): VideoMeta {
  if (!meta) return {};
  try {
    const parsed = JSON.parse(meta);
    if (parsed && typeof parsed === "object") return parsed as VideoMeta;
  } catch {
    // Ignore malformed JSON
  }
  return {};
}

export async function extractTranscriptDocumentText(file: File): Promise<string> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".txt") || file.type === "text/plain") {
    return (await file.text()).trim();
  }
  if (
    lower.endsWith(".docx") ||
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return (await extractDocxText(bytes)).trim();
  }
  if (lower.endsWith(".pdf") || file.type === "application/pdf") {
    const pdfjs = await import("pdfjs-dist");
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjs.getDocument({ data: bytes }).promise;
    try {
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) pages.push(text);
      }
      return pages.join("\n\n").trim();
    } finally {
      await doc.destroy();
    }
  }
  throw new Error("Choose a TXT, Word (.docx) or PDF document for the transcript.");
}

export async function attachVideoTranscript(videoFile: FileRow, docFile: File): Promise<void> {
  const text = await extractTranscriptDocumentText(docFile);
  if (!text) {
    throw new Error("No readable text was found in that document.");
  }
  const latest = (await db.files.get(videoFile.id)) ?? videoFile;
  const currentMeta = parseVideoMeta(latest.meta);
  const nextMeta: VideoMeta = {
    ...currentMeta,
    transcript_name: docFile.name,
    transcript_text: text,
    transcript_updated_at: new Date().toISOString(),
  };
  await update("files", latest.id, { meta: JSON.stringify(nextMeta) });
}

export async function removeVideoTranscript(videoFile: FileRow): Promise<void> {
  const latest = (await db.files.get(videoFile.id)) ?? videoFile;
  const currentMeta = parseVideoMeta(latest.meta);
  if (currentMeta.transcript_file_id) {
    const oldFile = await db.files.get(currentMeta.transcript_file_id);
    if (oldFile && !oldFile.deleted) {
      await update("files", oldFile.id, { deleted: true });
    }
  }
  const nextMeta: VideoMeta = {
    ...currentMeta,
    transcript_file_id: null,
    transcript_name: null,
    transcript_text: null,
    transcript_updated_at: null,
  };
  await update("files", latest.id, { meta: JSON.stringify(nextMeta) });
}
