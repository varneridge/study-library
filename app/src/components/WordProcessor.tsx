import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { useModuleAssessment, saveModuleAssessment, getModuleAssessment } from "../lib/assessment";
import { toDocxBytes, fromDocxBytes, countDocxWords, type DocxDocument } from "../lib/docx";
import { navigate } from "../lib/router";
import { showToast, useTitle } from "../lib/ui";

const EDITOR_PATH = "/wordcraft/index.html";
const READY_TIMEOUT_MS = 20_000;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

export type WordProcessorStatus = "loading" | "ready" | "unsaved" | "saving" | "saved" | "error";

const STATUS_LABELS: Record<WordProcessorStatus, string> = {
  loading: "Loading editor…",
  ready: "Up to date",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  saved: "Saved",
  error: "Needs attention",
};

type InboundMessage =
  | { type: "wordcraft:ready" }
  | { type: "wordcraft:dirty"; dirty: boolean }
  | { type: "wordcraft:save"; payload: unknown; wordCount: number | null };

type EditorError = { kind: "load" | "save" | "file"; message: string };

type SaveJob = { bytes: Uint8Array; wordCount: number | null; version: number };

function parseMessage(data: unknown): InboundMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  switch (record.type) {
    case "wordcraft:ready":
      return { type: "wordcraft:ready" };
    case "wordcraft:dirty":
      return { type: "wordcraft:dirty", dirty: record.dirty !== false };
    case "wordcraft:save": {
      const count = record.wordCount;
      const wordCount =
        typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
      return {
        type: "wordcraft:save",
        payload: record.bytes ?? record.data ?? record.buffer,
        wordCount,
      };
    }
    default:
      return null;
  }
}

async function toBytes(payload: unknown): Promise<Uint8Array | null> {
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (ArrayBuffer.isView(payload)) {
    return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  if (typeof Blob !== "undefined" && payload instanceof Blob) {
    return new Uint8Array(await payload.arrayBuffer());
  }
  if (
    Array.isArray(payload) &&
    payload.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
  ) {
    return Uint8Array.from(payload as number[]);
  }
  return null;
}

const looksLikeDocx = (bytes: Uint8Array): boolean =>
  bytes.byteLength > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;

function formatWordCount(count: number | null, target: number | null | undefined): string {
  if (count === null) return "Word count appears after saving";
  const words = `${count.toLocaleString("en-GB")} ${count === 1 ? "word" : "words"}`;
  return target ? `${words} of ${target.toLocaleString("en-GB")}` : words;
}

export function WordProcessor({ id }: { id: string; q?: string }) {
  const module = useLiveQuery(() => db.modules.get(id), [id]);
  const assessment = useModuleAssessment(id, module?.code);

  const title = assessment.title || (module?.code ? `${module.code} Essay` : "Essay Draft");
  useTitle(title ? `${title} — Word processor` : "Word processor");

  const initialWords = countDocxWords(assessment.draft).total;
  const [wordCount, setWordCount] = useState<number | null>(initialWords);
  const [status, setStatus] = useState<WordProcessorStatus>("loading");
  const [error, setError] = useState<EditorError | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const mountedRef = useRef(true);
  const readyRef = useRef(false);
  const dirtyRef = useRef(false);
  const dirtyVersionRef = useRef(0);
  const openSeqRef = useRef(0);
  const saveSeqRef = useRef(0);
  const queuedSeqRef = useRef(0);
  const savingRef = useRef(false);
  const pendingRef = useRef<SaveJob | null>(null);

  const assessmentRef = useRef(assessment);
  assessmentRef.current = assessment;

  const moduleCode = module?.code;
  const src = `${EDITOR_PATH}?host=parent&author=${encodeURIComponent("Student")}`;

  const loadDocxBytes = useCallback(async (): Promise<Uint8Array> => {
    const row = await getModuleAssessment(id, moduleCode);
    if (mountedRef.current) {
      setWordCount(countDocxWords(row.draft).total);
    }
    if (row.docx && row.docx.byteLength > 4) {
      return new Uint8Array(row.docx);
    }
    return toDocxBytes(row.draft, { title: row.title || title, author: "Student" });
  }, [id, moduleCode, title]);

  const openDocument = useCallback(async () => {
    const seq = ++openSeqRef.current;
    try {
      const source = await loadDocxBytes();
      const target = iframeRef.current?.contentWindow;
      if (!mountedRef.current || seq !== openSeqRef.current || !target) return;
      const bytes = source.slice();
      target.postMessage(
        { type: "wordcraft:open", name: `${title || "Draft"}.docx`, bytes },
        window.location.origin,
        [bytes.buffer as ArrayBuffer],
      );
      dirtyRef.current = false;
      setError(null);
      setStatus("ready");
    } catch (err) {
      console.error("Opening the draft in WordCraft failed", err);
      if (!mountedRef.current || seq !== openSeqRef.current) return;
      setStatus("error");
      setError({ kind: "load", message: "The draft could not be opened in the word processor." });
    }
  }, [loadDocxBytes, title]);

  const processSaves = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    try {
      while (pendingRef.current) {
        const job = pendingRef.current;
        pendingRef.current = null;
        if (mountedRef.current) setStatus("saving");
        try {
          let updatedDoc: DocxDocument | null = null;
          try {
            updatedDoc = await fromDocxBytes(job.bytes);
          } catch (parseErr) {
            console.error("Parsing docx structure failed", parseErr);
            showToast("Draft saved as docx, but search text could not be refreshed.");
          }
          const computedCount = job.wordCount ?? (updatedDoc ? countDocxWords(updatedDoc).total : wordCount);

          await saveModuleAssessment(id, (prev) => ({
            ...prev,
            docx: job.bytes,
            draft: updatedDoc ?? prev.draft,
          }));

          if (!mountedRef.current) continue;
          setWordCount(computedCount);
          if (pendingRef.current) continue;
          setError(null);
          if (dirtyVersionRef.current === job.version) {
            dirtyRef.current = false;
            setStatus("saved");
            showToast("Draft saved.");
          } else {
            setStatus("unsaved");
          }
        } catch (err) {
          console.error("Saving the draft failed", err);
          dirtyRef.current = true;
          if (!mountedRef.current) continue;
          setStatus("error");
          setError({
            kind: "save",
            message: "Your latest changes could not be saved. Please try saving again.",
          });
        }
      }
    } finally {
      savingRef.current = false;
    }
  }, [id, wordCount]);

  useEffect(() => {
    mountedRef.current = true;

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parseMessage(event.data);
      if (!message) return;

      switch (message.type) {
        case "wordcraft:ready":
          readyRef.current = true;
          void openDocument();
          break;

        case "wordcraft:dirty":
          if (message.dirty) {
            dirtyVersionRef.current += 1;
            dirtyRef.current = true;
            if (!savingRef.current) setStatus("unsaved");
          } else if (!savingRef.current && !pendingRef.current) {
            dirtyRef.current = false;
            setStatus((cur) => (cur === "unsaved" ? "ready" : cur));
          }
          break;

        case "wordcraft:save": {
          const seq = ++saveSeqRef.current;
          const version = dirtyVersionRef.current;
          void (async () => {
            const bytes = await toBytes(message.payload);
            if (!mountedRef.current || seq <= queuedSeqRef.current) return;
            queuedSeqRef.current = seq;
            if (!bytes || bytes.byteLength > MAX_DOCUMENT_BYTES || !looksLikeDocx(bytes)) {
              setStatus("error");
              setError({
                kind: "file",
                message: "The editor sent a file that could not be read, so nothing was saved.",
              });
              return;
            }
            pendingRef.current = { bytes: bytes.slice(), wordCount: message.wordCount, version };
            void processSaves();
          })();
          break;
        }
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      mountedRef.current = false;
      window.removeEventListener("message", handleMessage);
    };
  }, [openDocument, processSaves]);

  useEffect(() => {
    readyRef.current = false;
    setStatus("loading");
    const timer = window.setTimeout(() => {
      if (readyRef.current || !mountedRef.current) return;
      setStatus("error");
      setError({
        kind: "load",
        message: "The word processor is taking longer than expected to load.",
      });
    }, READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [src, frameKey]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  const handleBack = () => {
    const unsaved = dirtyRef.current || savingRef.current;
    if (unsaved && !window.confirm("You have unsaved changes. Leave the editor anyway?")) {
      return;
    }
    navigate({ view: "assessment", id });
  };

  const reloadEditor = () => {
    setError(null);
    setFrameKey((k) => k + 1);
  };

  return (
    <div className="wp word-processor">
      <header className="wp-bar">
        <button type="button" className="wp-back" onClick={handleBack}>
          <span aria-hidden="true">&larr;</span> Back to module assessment
        </button>
        <div className="wp-heading">
          <h1 className="wp-title" title={title}>
            {title}
          </h1>
          <span className="wp-count">{formatWordCount(wordCount, assessment.wordTarget)}</span>
        </div>
        <span className="wp-status" data-status={status} role="status">
          {STATUS_LABELS[status]}
        </span>
      </header>

      {error && (
        <div className="wp-error" role="alert">
          <p>{error.message}</p>
          {error.kind === "load" && (
            <button type="button" className="button small" onClick={reloadEditor}>
              Reload editor
            </button>
          )}
        </div>
      )}

      <iframe
        key={frameKey}
        ref={iframeRef}
        className="wp-frame"
        src={src}
        title={`Word processor: ${title}`}
      />
    </div>
  );
}

export default WordProcessor;
