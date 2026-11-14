// The seam through which the browser acceptance tests (e2e/reader-polish.spec.ts)
// create fixtures and inspect results. It is installed on window.__sl in the
// development server and in builds made with VITE_E2E set, and the literal
// import.meta.env checks below are what let the bundler drop it from a
// production build, so they must not be rewritten into a helper variable.
//
// The seam deliberately holds no knowledge of the app's tables. The app's own
// data layer is registered once, in src/lib/testSeamBackend.ts, through
// setSeamBackend, so that fixtures are created by the same functions the user
// interface uses and cannot drift from the real row shapes.
import type { HighlightRow } from "./types";

export interface SeedOptions {
  pdfBase64: string;
  title?: string;
  kind?: "primary" | "secondary" | "slides";
}

export interface Seeded {
  itemId: string;
  weekUrl: string;
  readerUrl: string;
}

export interface StudyLibraryTestSeam {
  // Adds a PDF reading to a new week through the app's own add-file flow, and
  // derives both URLs from the app's own route serialiser.
  seedReader(o: SeedOptions): Promise<Seeded>;
  // Every highlight row for the reading, including deleted ones, so that tests
  // can tell a removed highlight from one that never existed.
  highlights(itemId: string): Promise<HighlightRow[]>;
  // The number of top-level blocks in the reading's notes document.
  noteBlockCount(itemId: string): Promise<number>;
}

let backend: StudyLibraryTestSeam | null = null;

// Registers the app's data layer. Calling it again replaces the earlier backend.
export function setSeamBackend(next: StudyLibraryTestSeam): void {
  backend = next;
}

function registered(): StudyLibraryTestSeam {
  if (backend === null) {
    throw new Error(
      "No test seam backend is registered. Call setSeamBackend() from src/lib/testSeamBackend.ts, wiring seedReader, highlights and noteBlockCount to the app's own data layer.",
    );
  }
  return backend;
}

// Decodes a base64 string to bytes, for backends that must hand the app a File
// or Blob. A malformed string raises a clear error rather than a DOMException.
export function pdfBytes(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new Error("The fixture PDF is not valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function seamEnabled(): boolean {
  return Boolean(import.meta.env.DEV || import.meta.env.VITE_E2E);
}

// Assigns window.__sl when the environment allows it, and does nothing
// otherwise. It is safe to call more than once. Methods look the backend up
// when they are called, so the order of installation and registration is free,
// and they are async so that a missing backend rejects rather than throws.
export function installTestSeam(): void {
  if (typeof window === "undefined") return;
  if (!(import.meta.env.DEV || import.meta.env.VITE_E2E)) return;
  const seam: StudyLibraryTestSeam = {
    seedReader: async (o) => registered().seedReader(o),
    highlights: async (itemId) => registered().highlights(itemId),
    noteBlockCount: async (itemId) => registered().noteBlockCount(itemId),
  };
  (window as unknown as { __sl?: StudyLibraryTestSeam }).__sl = seam;
}
