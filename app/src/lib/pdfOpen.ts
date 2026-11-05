// Opening a PDF quickly, however long it is. A reading kept on this device
// opens from there at once. A large one that is not, such as a whole book,
// opens straight from the server a piece at a time, so its first pages show
// before the rest has arrived; the whole file is then kept for next time and
// for reading offline. A long document no longer waits for every page's size
// before it shows: every page starts the size of the first, and the real
// sizes follow in the background.

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { fileBlob, isCached } from "./files";
import type { FileRow } from "./types";

if (typeof window !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
}

export interface PageSize { width: number; height: number }

// From this size, a reading not yet on this device opens a piece at a time.
export const STREAM_FROM_BYTES = 8 * 1024 * 1024;
// Each piece fetched while reading.
export const RANGE_CHUNK_BYTES = 512 * 1024;
// Up to this many pages every size is read before the pages show.
export const EXACT_SIZES_UP_TO = 80;
// How long the first pages have to themselves before the whole file follows.
const KEEP_AFTER_MS = 4000;
// How long a long document's first pages have before its other sizes are read.
const SIZES_AFTER_MS = 2500;
const SIZE_BATCH = 24;

export function shouldStream(bytes: number | null | undefined, cached: boolean, online: boolean): boolean {
  return !cached && online && (bytes ?? 0) >= STREAM_FROM_BYTES;
}

export async function openPdfData(blob: Blob): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
}

export async function openPdf(file: FileRow): Promise<PDFDocumentProxy> {
  const online = typeof navigator === "undefined" || navigator.onLine;
  if (shouldStream(file.bytes, await isCached(file), online)) {
    try {
      const doc = await pdfjs.getDocument({
        url: `/api/objects/${file.r2_key}`,
        rangeChunkSize: RANGE_CHUNK_BYTES,
        // Only what is being read is fetched; the rest waits.
        disableAutoFetch: true,
        disableStream: true,
      }).promise;
      setTimeout(() => { void fileBlob(file).catch(() => undefined); }, KEEP_AFTER_MS);
      return doc;
    } catch {
      // A server or connection that cannot send pieces gets the whole file.
    }
  }
  return openPdfData(await fileBlob(file));
}

export function sameSize(a: PageSize, b: PageSize): boolean {
  return Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;
}

export function estimatedSizes(first: PageSize, count: number): PageSize[] {
  return Array.from({ length: count }, () => ({ ...first }));
}

async function sizesOf(doc: PDFDocumentProxy, from: number, to: number): Promise<PageSize[]> {
  return Promise.all(
    Array.from({ length: to - from }, async (_, i) => {
      const viewport = (await doc.getPage(from + i + 1)).getViewport({ scale: 1 });
      return { width: viewport.width, height: viewport.height };
    }),
  );
}

// The size of every page of a short document, or for a long one the size of
// its first page for every page, to be refined by exactPageSizes.
export async function pageSizes(doc: PDFDocumentProxy): Promise<PageSize[]> {
  if (doc.numPages <= EXACT_SIZES_UP_TO) {
    const all: PageSize[] = [];
    for (let from = 0; from < doc.numPages; from += 32) all.push(...await sizesOf(doc, from, Math.min(doc.numPages, from + 32)));
    return all;
  }
  return estimatedSizes((await sizesOf(doc, 0, 1))[0], doc.numPages);
}

// Every page's real size, read in the background a few pages at a time. Null
// when every page is the size of the first, as in most books, so nothing moves.
export async function exactPageSizes(doc: PDFDocumentProxy, first: PageSize, stopped: () => boolean): Promise<PageSize[] | null> {
  await new Promise((resolve) => setTimeout(resolve, SIZES_AFTER_MS));
  const all: PageSize[] = [first];
  let differs = false;
  for (let from = 1; from < doc.numPages; from += SIZE_BATCH) {
    if (stopped()) return null;
    for (const size of await sizesOf(doc, from, Math.min(doc.numPages, from + SIZE_BATCH))) {
      if (!sameSize(size, first)) differs = true;
      all.push(size);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  return differs && !stopped() ? all : null;
}
