import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../lib/db";
import { useModuleAssessment, saveModuleAssessment, getModuleAssessment } from "../lib/assessment";
import { toDocxBytes, fromDocxBytes, countDocxWords, type DocxDocument } from "../lib/docx";
import { effectiveWordCount } from "../lib/essaySources";
import { navigate } from "../lib/router";
import { showToast, useTitle } from "../lib/ui";
import { Icon } from "./icons";
import "./WordProcessor.css";
import {
  COMPACT_BELOW_PX,
  INSETS_COMPACT,
  INSETS_REGULAR,
  STATUS_MARGIN_START,
  dockGeometry,
  editorQuery,
  parseChrome,
  type ChromeInfo,
  type ChromeInsets,
} from "../lib/wordcraftChrome";

const EDITOR_PATH = "/wordcraft/index.html";
const READY_TIMEOUT_MS = 20_000;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

// How long after the editor is ready to wait for its chrome report before
// treating it as an older build without embedded chrome, whose File tab and
// whole status bar our docks then cover.
const CHROME_TIMEOUT_MS = 4_000;

type ChromeMode = "pending" | "embedded" | "fallback";


export type WordProcessorStatus = "loading" | "ready" | "unsaved" | "saving" | "saved" | "error";

const STATUS_LABELS: Record<WordProcessorStatus, string> = {
  loading: "Loading…",
  ready: "Saved",
  unsaved: "Unsaved",
  saving: "Saving…",
  saved: "Saved",
  error: "Needs attention",
};

type InboundMessage =
  | { type: "wordcraft:ready" }
  | { type: "wordcraft:dirty"; dirty: boolean }
  | { type: "wordcraft:save"; payload: unknown }
  | { type: "wordcraft:chrome"; chrome: ChromeInfo | null };

type EditorError = { kind: "load" | "save" | "file"; message: string };

type SaveJob = { bytes: Uint8Array; version: number };

function parseMessage(data: unknown): InboundMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  switch (record.type) {
    case "wordcraft:ready":
      return { type: "wordcraft:ready" };
    case "wordcraft:dirty":
      return { type: "wordcraft:dirty", dirty: record.dirty !== false };
    case "wordcraft:save":
      return {
        type: "wordcraft:save",
        payload: record.bytes ?? record.data ?? record.buffer,
      };
    case "wordcraft:chrome":
      return { type: "wordcraft:chrome", chrome: parseChrome(record.chrome) };
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

function formatWordCount(count: number, target: number | null | undefined): string {
  const n = count.toLocaleString("en-GB");
  if (target) return `${n} of ${target.toLocaleString("en-GB")} words`;
  return `${n} ${count === 1 ? "word" : "words"}`;
}

export function WordProcessor({ id, essayId }: { id: string; essayId?: string; q?: string }) {
  const module = useLiveQuery(() => db.modules.get(id), [id]);
  const assessment = useModuleAssessment(id, module?.code, essayId);

  const title = assessment.title || (module?.code ? `${module.code} Essay` : "Essay Draft");
  useTitle(title ? `${title}: Word processor` : "Word processor");

  // Counts come from the saved draft, so the total, the breakdown and the footnote toggle
  // always agree with one another. The toggle is applied at once and then confirmed by the store.
  const counts = useMemo(() => countDocxWords(assessment.draft), [assessment.draft]);
  const storedIncludeFootnotes = assessment.includeFootnotes !== false;
  const [pendingFootnotes, setPendingFootnotes] = useState<boolean | null>(null);
  const includeFootnotes = pendingFootnotes ?? storedIncludeFootnotes;
  // The footnote figure is what the switch adds or removes, so it is read from
  // the same function as the total rather than from the raw counts.
  const withFootnotes = effectiveWordCount(counts, assessment.draft, true);
  const bodyWords = effectiveWordCount(counts, assessment.draft, false);
  const footnoteWords = Math.max(0, withFootnotes - bodyWords);
  const totalWords = includeFootnotes ? withFootnotes : bodyWords;
  const [status, setStatus] = useState<WordProcessorStatus>("loading");
  const [error, setError] = useState<EditorError | null>(null);
  const [frameKey, setFrameKey] = useState(0);

  const [isFullscreen, setIsFullscreen] = useState(false);

  const [chromeMode, setChromeMode] = useState<ChromeMode>("pending");
  const [chrome, setChrome] = useState<ChromeInfo | null>(null);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth < COMPACT_BELOW_PX);
  // The insets the editor loads with. They are part of the iframe's URL, so
  // they never change after mount; later changes go by message instead.
  const [initialInsets] = useState<ChromeInsets>(() => (compact ? INSETS_COMPACT : INSETS_REGULAR));
  const stageRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const sentStatusInsetRef = useRef<number | null>(null);

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
  const autosaveTimerRef = useRef<number | null>(null);
  const maxWaitTimerRef = useRef<number | null>(null);

  const moduleCode = module?.code;
  const src = `${EDITOR_PATH}?${editorQuery(initialInsets)}&author=${encodeURIComponent("Student")}`;

  useEffect(() => {
    const handleFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handleFs);
    return () => document.removeEventListener("fullscreenchange", handleFs);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void document.documentElement.requestFullscreen?.().catch(() => {});
    }
  }, []);

  useEffect(() => {
    setPendingFootnotes(null);
  }, [storedIncludeFootnotes]);

  const toggleFootnotes = useCallback(async () => {
    const next = !includeFootnotes;
    setPendingFootnotes(next);
    try {
      await saveModuleAssessment(id, (prev) => ({ ...prev, includeFootnotes: next }), { moduleCode, essayId });
    } catch (err) {
      console.error("Changing the footnote setting failed", err);
      if (mountedRef.current) setPendingFootnotes(null);
      showToast("Could not change the footnote setting.");
    }
  }, [id, moduleCode, essayId, includeFootnotes]);

  // A button outside the frame takes focus from the canvas, so it is handed
  // back after Undo and Redo and the student can keep typing without a click.
  const refocusEditor = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    try {
      frame.focus();
      frame.contentDocument?.getElementById("wordcraft_canvas")?.focus();
    } catch {
      // The frame is same-origin, so this can only fail while it is navigating.
    }
  }, []);

  const handleUndo = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "wordcraft:undo" }, window.location.origin);
    refocusEditor();
  }, [refocusEditor]);

  const handleRedo = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "wordcraft:redo" }, window.location.origin);
    refocusEditor();
  }, [refocusEditor]);

  const postChrome = useCallback((params: { tabInsetStart?: number; tabInsetEnd?: number; statusInsetStart?: number }) => {
    iframeRef.current?.contentWindow?.postMessage({ type: "wordcraft:chrome", ...params }, window.location.origin);
  }, []);

  const retrySaveTimerRef = useRef<number | null>(null);

  const triggerSave = useCallback(() => {
    if (savingRef.current) {
      if (retrySaveTimerRef.current === null) {
        retrySaveTimerRef.current = window.setTimeout(() => {
          retrySaveTimerRef.current = null;
          triggerSave();
        }, 1000);
      }
      return;
    }
    iframeRef.current?.contentWindow?.postMessage({ type: "wordcraft:save" }, window.location.origin);
  }, []);

  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      if (maxWaitTimerRef.current !== null) {
        window.clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
      triggerSave();
    }, 1500);

    if (maxWaitTimerRef.current === null) {
      maxWaitTimerRef.current = window.setTimeout(() => {
        maxWaitTimerRef.current = null;
        if (autosaveTimerRef.current !== null) {
          window.clearTimeout(autosaveTimerRef.current);
          autosaveTimerRef.current = null;
        }
        triggerSave();
      }, 8000);
    }
  }, [triggerSave]);

  const loadDocxBytes = useCallback(async (): Promise<Uint8Array> => {
    const row = await getModuleAssessment(id, moduleCode, essayId);
    if (row.docx && row.docx.byteLength > 4) {
      return new Uint8Array(row.docx);
    }
    return toDocxBytes(row.draft, { title: row.title || title, author: "Student" });
  }, [id, moduleCode, essayId, title]);

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

          await saveModuleAssessment(
            id,
            (prev) => ({
              ...prev,
              docx: job.bytes,
              draft: updatedDoc ?? prev.draft,
            }),
            { moduleCode, essayId },
          );

          if (!mountedRef.current) continue;
          if (pendingRef.current) continue;
          setError(null);
          if (dirtyVersionRef.current === job.version) {
            dirtyRef.current = false;
            setStatus("saved");
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
  }, [id, moduleCode, essayId]);

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
            scheduleAutosave();
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
            pendingRef.current = { bytes: bytes.slice(), version };
            void processSaves();
          })();
          break;
        }

        case "wordcraft:chrome":
          if (message.chrome) {
            setChrome(message.chrome);
            setChromeMode("embedded");
          } else {
            setChrome(null);
            setChromeMode("fallback");
          }
          break;
      }
    };

    window.addEventListener("message", handleMessage);
    return () => {
      mountedRef.current = false;
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      if (maxWaitTimerRef.current !== null) {
        window.clearTimeout(maxWaitTimerRef.current);
        maxWaitTimerRef.current = null;
      }
      if (retrySaveTimerRef.current !== null) {
        window.clearTimeout(retrySaveTimerRef.current);
        retrySaveTimerRef.current = null;
      }
      window.removeEventListener("message", handleMessage);
    };
  }, [openDocument, processSaves, scheduleAutosave]);

  useEffect(() => {
    const heartbeat = window.setInterval(() => {
      if (dirtyRef.current && !savingRef.current) {
        triggerSave();
      }
    }, 20000);
    return () => window.clearInterval(heartbeat);
  }, [triggerSave]);

  useEffect(() => {
    readyRef.current = false;
    setStatus("loading");
    setChromeMode("pending");
    setChrome(null);
    sentStatusInsetRef.current = null;
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

  // An editor that is ready but never reports its chrome is an older build, so
  // the docks settle on covering its File tab and its whole status bar.
  const editorLoading = status === "loading";
  useEffect(() => {
    if (editorLoading || chromeMode !== "pending") return;
    const timer = window.setTimeout(() => {
      setChromeMode((mode) => (mode === "pending" ? "fallback" : mode));
    }, CHROME_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [editorLoading, chromeMode, frameKey]);

  // A narrow stage uses the compact room, in which the save state shrinks to
  // its dot and the word count drops its breakdown.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < COMPACT_BELOW_PX));
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (chromeMode !== "embedded") return;
    const insets = compact ? INSETS_COMPACT : INSETS_REGULAR;
    if (chrome && chrome.tabStrip.insetStart === insets.tabStart && chrome.tabStrip.insetEnd === insets.tabEnd) return;
    postChrome({ tabInsetStart: insets.tabStart, tabInsetEnd: insets.tabEnd });
    // chrome is left out on purpose: its reply must not send the same insets again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, chromeMode, postChrome]);

  // The embedded status bar keeps exactly the room our bar takes, so "Page x
  // of y" follows it with WordCraft's own 14 point gap whatever the count says.
  useEffect(() => {
    const el = statusRef.current;
    if (chromeMode !== "embedded" || !el || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const send = () => {
      frame = 0;
      const inset = Math.max(0, Math.ceil(el.getBoundingClientRect().width) - STATUS_MARGIN_START);
      const last = sentStatusInsetRef.current;
      if (last !== null && Math.abs(last - inset) < 2) return;
      sentStatusInsetRef.current = inset;
      postChrome({ statusInsetStart: inset });
    };
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(send);
    });
    observer.observe(el);
    send();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [chromeMode, postChrome]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  useEffect(() => {
    const flush = () => {
      if (dirtyRef.current) {
        triggerSave();
      }
    };
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [triggerSave]);

  const handleBack = () => {
    const unsaved = dirtyRef.current || savingRef.current;
    if (unsaved && !window.confirm("You have unsaved changes. Leave the editor anyway?")) {
      return;
    }
    navigate({ view: "assessment", id, ...(essayId && essayId !== "default" ? { essay: essayId } : {}) });
  };

  const reloadEditor = () => {
    setError(null);
    setFrameKey((k) => k + 1);
  };

  const showBreakdown = !compact && includeFootnotes && footnoteWords > 0;
  const footnoteFigure = footnoteWords.toLocaleString("en-GB");
  const footnoteHint = includeFootnotes
    ? `${footnoteFigure} footnote ${footnoteWords === 1 ? "word is" : "words are"} counted. Select to leave them out.`
    : `${footnoteFigure} footnote ${footnoteWords === 1 ? "word is" : "words are"} left out. Select to count them.`;

  // Until the editor confirms embedded chrome, it is treated as the deployed
  // build, which still draws File and its own full status bar for us to cover.
  const geometry = dockGeometry(chromeMode === "embedded" ? chrome : null);

  // WordCraft's own colours for the surfaces, so the docks read as part of its
  // bars in light and dark themes (the fallbacks are its light theme,
  // theme.rs:307); what sits on them takes Study Library's tokens in the CSS.
  const chromeStyle = {
    "--wc-strip-top": `${geometry.back.top}px`,
    "--wc-strip-h": `${geometry.back.height}px`,
    "--wc-back-w": `${geometry.back.width}px`,
    "--wc-status-h": `${geometry.status.height}px`,
    "--wc-status-pad": `${STATUS_MARGIN_START}px`,
    "--wc-strip-bg": chrome?.colours.tabStrip ?? "#f0f0f0",
    "--wc-status-bg": chrome?.colours.statusBar ?? "#f0f0f0",
    "--wc-text": chrome?.colours.text ?? "#242424",
    "--wc-text-dim": chrome?.colours.textDim ?? "#616161",
    "--wc-border": chrome?.colours.border ?? "#e1e1e1",
    "--wc-accent": chrome?.colours.accent ?? "#3b5bdb",
  } as CSSProperties;

  return (
    <div className="wp word-processor" data-chrome={chromeMode} style={chromeStyle}>
      <h1 className="wp-title wp-sr-only">{title}</h1>

      <div className="wp-stage" ref={stageRef}>
        <iframe
          key={frameKey}
          ref={iframeRef}
          className="wp-frame"
          src={src}
          title={`Word processor: ${title}`}
        />

        {/* Takes the File tab's place, so Backstage can never be opened from here. */}
        <div className="wp-dock wp-dock--back">
          <button
            type="button"
            className="wp-back"
            title="Back to preview"
            aria-label="Back to preview"
            data-icon-only={geometry.back.iconOnly || undefined}
            onClick={handleBack}
          >
            <Icon name="back" size={15} />
            {!geometry.back.iconOnly && <span aria-hidden="true">Back</span>}
          </button>
        </div>

        {/* Our only status bar, drawn on WordCraft's own rather than beside it. */}
        <div
          className="wp-dock wp-dock--status"
          ref={statusRef}
          data-span={geometry.status.span}
          data-compact={compact || undefined}
          role="group"
          aria-label="Status bar"
        >
          <button type="button" className="wp-dock-button" title="Undo (Ctrl+Z)" aria-label="Undo" onClick={handleUndo}>
            <Icon name="undo" size={15} />
          </button>
          <button type="button" className="wp-dock-button" title="Redo (Ctrl+Y)" aria-label="Redo" onClick={handleRedo}>
            <Icon name="redo" size={15} />
          </button>

          <span className="wp-dock-rule" aria-hidden="true" />

          <span className="wp-count">{formatWordCount(totalWords, assessment.wordTarget)}</span>
          {showBreakdown && (
            <span className="wp-count-detail">{bodyWords.toLocaleString("en-GB")} body</span>
          )}

          <button
            type="button"
            role="switch"
            className="wp-switch"
            aria-checked={includeFootnotes}
            aria-label="Count footnotes in the word count"
            title={footnoteHint}
            onClick={() => void toggleFootnotes()}
          >
            <span className="wp-switch-track" aria-hidden="true">
              <span className="wp-switch-thumb" />
            </span>
            <span className="wp-switch-label">Footnotes</span>
            {!compact && (
              <span className="wp-switch-meta" aria-hidden="true">
                {footnoteFigure}
              </span>
            )}
          </button>

          <span className="wp-status-spacer" aria-hidden="true" />
          <span className="wp-dock-rule wp-dock-rule--end" aria-hidden="true" />

          <span
            className="save-status wp-status"
            data-status={status}
            data-compact={compact || undefined}
            role="status"
            aria-live="polite"
            title={STATUS_LABELS[status]}
          >
            <span className="save-status-dot" aria-hidden="true" />
            <span className={compact ? "wp-sr-only" : "save-status-label"}>{STATUS_LABELS[status]}</span>
          </span>

          <button
            type="button"
            className="wp-dock-button"
            title={isFullscreen ? "Exit full screen" : "Full screen"}
            aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
            onClick={toggleFullscreen}
          >
            <Icon name={isFullscreen ? "minimize" : "enlarge"} size={15} />
          </button>
        </div>

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
      </div>
    </div>
  );
}

export default WordProcessor;
