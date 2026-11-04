import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../App";
import { db } from "../lib/db";
import { fileBlob, formatBytes } from "../lib/files";
import { deleteLabel } from "../lib/kinds";
import { loadReader, placesOf } from "../lib/library";

type ReaderData = NonNullable<Awaited<ReturnType<typeof loadReader>>>;
import { READING_ACCEPT } from "../lib/photos";
import { citable, counts } from "../lib/progress";
import { navigate } from "../lib/router";
import { update } from "../lib/sync";
import { fullTitle, shortTitle } from "../lib/titles";
import { showToast, useNarrow, useOnline, useTitle } from "../lib/ui";
import {
  attachVideoTranscript,
  parseVideoMeta,
  removeVideoTranscript,
  TRANSCRIPT_ACCEPT,
} from "../lib/video";
import { NotesLoading } from "./ErrorBoundary";
import { Icon, IconButton } from "./icons";
import { Menu } from "./Menu";
import { ReaderSheet } from "./reader/Controls";
import {
  copyReference,
  deleteReading,
  download,
  Editor,
  MovePicker,
  replaceFile,
} from "./ReadingRow";

const NoteEditor = lazy(() => import("./NoteEditor"));

function parseTimestampSeconds(stamp: string): number | null {
  const parts = stamp.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

interface MatchSpan {
  paraIdx: number;
  start: number;
  end: number;
  matchIdx: number;
}

function renderParagraphWithHighlightsAndTimestamps(
  text: string,
  paraIdx: number,
  spans: MatchSpan[],
  activeMatchIdx: number,
  onSeek: (seconds: number) => void,
) {
  if (!spans.length) {
    // Linkify timestamps like 01:23 or 1:02:34
    const parts = text.split(/(\b\d{1,2}:\d{2}(?::\d{2})?\b)/g);
    return parts.map((part, idx) => {
      if (/^\d{1,2}:\d{2}(?::\d{2})?$/.test(part)) {
        const secs = parseTimestampSeconds(part);
        if (secs !== null) {
          return (
            <button
              key={idx}
              type="button"
              className="link video-timestamp"
              onClick={() => onSeek(secs)}
              title={`Jump to ${part}`}
            >
              {part}
            </button>
          );
        }
      }
      return <span key={idx}>{part}</span>;
    });
  }

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((span, idx) => {
    if (span.start > cursor) {
      nodes.push(<span key={`t-${idx}`}>{text.slice(cursor, span.start)}</span>);
    }
    const isCurrent = span.matchIdx === activeMatchIdx;
    nodes.push(
      <mark
        key={`m-${span.matchIdx}`}
        data-hit-index={span.matchIdx}
        className={`find-hit${isCurrent ? " current" : ""}`}
      >
        {text.slice(span.start, span.end)}
      </mark>,
    );
    cursor = span.end;
  });
  if (cursor < text.length) {
    nodes.push(<span key="t-end">{text.slice(cursor)}</span>);
  }
  return nodes;
}

export function VideoReader({ data, q }: { data: ReaderData; q?: string }) {
  const { item, file, upload } = data;
  useTitle(fullTitle(item));
  const place = useLiveQuery(async () => (await placesOf([item.id])).get(item.id) ?? null, [item.id], null);
  const narrow = useNarrow();
  const online = useOnline();

  const videoRef = useRef<HTMLVideoElement>(null);
  const transcriptInputRef = useRef<HTMLInputElement>(null);
  const replacerRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const transcriptBodyRef = useRef<HTMLDivElement>(null);

  const [sheet, setSheet] = useState<"edit" | "move" | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [finding, setFinding] = useState(Boolean(q));
  const [query, setQuery] = useState(q ?? "");
  const [hit, setHit] = useState(0);
  const [mediaError, setMediaError] = useState(false);
  const [savingOffline, setSavingOffline] = useState(false);
  const [offlineBlobUrl, setOfflineBlobUrl] = useState<string | null>(null);

  const cachedRow = useLiveQuery(
    async () => (file ? (await db.blobs.get(file.id)) ?? null : null),
    [file?.id],
    null,
  );
  const isSavedOffline = Boolean(cachedRow && file && cachedRow.r2_key === file.r2_key);

  useEffect(() => {
    if (!isSavedOffline || !cachedRow?.blob) {
      setOfflineBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(cachedRow.blob);
    setOfflineBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [isSavedOffline, cachedRow]);

  useEffect(() => {
    if (q) {
      setFinding(true);
      setQuery(q);
      setHit(0);
    }
  }, [q]);

  const meta = useMemo(() => parseVideoMeta(file?.meta), [file?.meta]);
  const transcriptParagraphs = useMemo(() => {
    if (!meta.transcript_text) return [];
    return meta.transcript_text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  }, [meta.transcript_text]);

  // Compute safe literal search spans across transcript paragraphs
  const { spansByPara, totalMatches } = useMemo(() => {
    const map = new Map<number, MatchSpan[]>();
    const needle = query.trim().toLowerCase();
    if (!finding || !needle || !transcriptParagraphs.length) {
      return { spansByPara: map, totalMatches: 0 };
    }
    let count = 0;
    transcriptParagraphs.forEach((para, paraIdx) => {
      const lower = para.toLowerCase();
      const list: MatchSpan[] = [];
      let pos = 0;
      while (pos <= lower.length - needle.length) {
        const idx = lower.indexOf(needle, pos);
        if (idx === -1) break;
        list.push({
          paraIdx,
          start: idx,
          end: idx + needle.length,
          matchIdx: count++,
        });
        pos = idx + Math.max(1, needle.length);
      }
      if (list.length) map.set(paraIdx, list);
    });
    return { spansByPara: map, totalMatches: count };
  }, [finding, query, transcriptParagraphs]);

  useEffect(() => {
    if (totalMatches === 0) {
      setHit(-1);
    } else if (hit < 0 || hit >= totalMatches) {
      setHit(0);
    }
  }, [totalMatches, hit]);

  useEffect(() => {
    if (hit < 0 || !transcriptBodyRef.current) return;
    const mark = transcriptBodyRef.current.querySelector<HTMLElement>(`mark[data-hit-index="${hit}"]`);
    mark?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [hit, query, finding]);

  const lastSavedSecRef = useRef<number>(item.last_spot?.frac ?? 0);
  const restoredSpotRef = useRef(false);
  const pendingSwapTimeRef = useRef<number | null>(null);

  const handleLoadedMetadata = () => {
    const el = videoRef.current;
    if (!el) return;
    if (pendingSwapTimeRef.current !== null && pendingSwapTimeRef.current > 0) {
      const resumeAt = pendingSwapTimeRef.current;
      pendingSwapTimeRef.current = null;
      if (resumeAt < (el.duration || Infinity)) {
        el.currentTime = resumeAt;
      }
    } else if (!restoredSpotRef.current && item.last_spot?.frac && item.last_spot.frac > 0) {
      restoredSpotRef.current = true;
      if (item.last_spot.frac < (el.duration || Infinity)) {
        el.currentTime = item.last_spot.frac;
      }
    }
    if (file && Number.isFinite(el.duration) && el.duration > 0 && !meta.duration) {
      const fileId = file.id;
      const dur = Math.round(el.duration);
      void db.files.get(fileId).then((latest) => {
        const currentMeta = parseVideoMeta(latest?.meta ?? file.meta);
        if (currentMeta.duration) return;
        void update("files", fileId, { meta: JSON.stringify({ ...currentMeta, duration: dur }) });
      });
    }
  };

  const persistPlaybackSpot = (force = false) => {
    const el = videoRef.current;
    if (!el) return;
    const nowSec = Math.floor(el.currentTime);
    if (!force && Math.abs(nowSec - lastSavedSecRef.current) < 30) return;
    lastSavedSecRef.current = nowSec;
    void update("items", item.id, { last_spot: { page: 0, frac: nowSec } });
  };

  const seekTo = (seconds: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = seconds;
    void el.play().catch(() => undefined);
  };

  const handleAttachTranscript = async (chosen: File) => {
    if (!file) {
      showToast("Wait for the video upload to finish before attaching a transcript.");
      return;
    }
    try {
      await attachVideoTranscript(file, chosen);
      showToast(`Transcript attached (${chosen.name}).`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not attach transcript.");
    }
  };

  const handleRemoveTranscript = async () => {
    if (!file) return;
    await removeVideoTranscript(file);
    showToast("Transcript removed.");
  };

  const handleToggleOffline = async () => {
    if (!file) return;
    if (isSavedOffline) {
      await db.blobs.delete(file.id);
      showToast("Offline copy removed from this device.");
      return;
    }
    if (!online) {
      showToast("Connect to the internet to save this video for offline viewing.");
      return;
    }
    setSavingOffline(true);
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        if (est.quota && est.usage !== undefined && est.quota - est.usage < file.bytes * 1.1) {
          showToast("Not enough storage space on this device to save this video offline.");
          return;
        }
      }
      if (navigator.storage?.persist) await navigator.storage.persist();
      await fileBlob(file);
      showToast("Video saved on this device for offline viewing.");
    } catch {
      showToast("Could not save video for offline viewing.");
    } finally {
      setSavingOffline(false);
    }
  };

  const backTo = place?.week
    ? ({ view: "week", id: place.week.id } as const)
    : place?.module
      ? ({ view: "module", id: place.module.id } as const)
      : item.tray_module_id
        ? ({ view: "module", id: item.tray_module_id } as const)
        : ({ view: "home" } as const);

  const viewForRow = useMemo(
    () => ({ item, file, upload, cached: isSavedOffline, link: null }),
    [item, file, upload, isSavedOffline],
  );

  const videoSrc = offlineBlobUrl ?? (file ? `/api/objects/${file.r2_key}` : undefined);
  const prevSrcRef = useRef(videoSrc);
  useEffect(() => {
    if (prevSrcRef.current !== videoSrc) {
      if (videoRef.current && videoRef.current.currentTime > 0) {
        pendingSwapTimeRef.current = videoRef.current.currentTime;
      }
      prevSrcRef.current = videoSrc;
      setMediaError(false);
    }
  }, [videoSrc]);
  const read = item.read_status === "read";

  return (
    <div className="reader video-reader">
      <header className="reader-bar">
        <div className="group">
          <Link to={backTo} className="button quiet back-link" label="Back">
            <Icon name="back" size={16} />
            <span className="wide-only">{place ? place.label : "Back"}</span>
          </Link>
          <h1 className="title" title={fullTitle(item)}>
            {shortTitle(item)}
          </h1>
        </div>
        <div className="group end">
          {counts(item) && (
            <IconButton
              icon="check"
              label={read ? "Mark as unread" : "Mark as read"}
              pressed={read}
              className="read-toggle"
              onClick={() => { void update("items", item.id, { read_status: read ? "unread" : "read" }); }}
            />
          )}
          <IconButton
            icon="search"
            label="Find in transcript"
            pressed={finding}
            onClick={() => {
              setFinding((f) => !f);
              requestAnimationFrame(() => findInputRef.current?.focus());
            }}
          />
          <IconButton
            icon="notes"
            label="Reading notes"
            pressed={notesOpen}
            onClick={() => setNotesOpen((o) => !o)}
          />
          {!narrow && file && (
            <button
              type="button"
              className="button tool"
              onClick={() => transcriptInputRef.current?.click()}
            >
              {meta.transcript_text ? "Replace transcript" : "Attach transcript"}
            </button>
          )}
          <Menu
            label="More actions"
            items={[
              { label: "Edit details", onSelect: () => setSheet("edit") },
              {
                label: meta.transcript_text ? "Replace transcript" : "Attach transcript",
                onSelect: () => transcriptInputRef.current?.click(),
                hidden: !file,
              },
              {
                label: "Remove transcript",
                onSelect: () => void handleRemoveTranscript(),
                hidden: !meta.transcript_text,
                danger: true,
              },
              {
                label: isSavedOffline
                  ? "Remove offline copy"
                  : savingOffline
                    ? "Saving offline…"
                    : `Save for offline (${file ? formatBytes(file.bytes) : ""})`,
                onSelect: () => void handleToggleOffline(),
                hidden: !file,
              },
              {
                label: "Copy reference",
                onSelect: () => void copyReference(item),
                hidden: !citable(item),
              },
              { label: "Move to another week or module", onSelect: () => setSheet("move") },
              { label: "Download file", onSelect: () => void download(viewForRow), hidden: !file },
              { label: "Replace file", onSelect: () => replacerRef.current?.click(), hidden: Boolean(upload) },
              {
                label: deleteLabel(item.kind),
                onSelect: async () => {
                  if (await deleteReading(viewForRow)) navigate(backTo);
                },
                danger: true,
              },
            ]}
          />
        </div>
      </header>

      {finding && (
        <div className="find-bar" role="search" aria-label="Find in transcript">
          <input
            ref={findInputRef}
            type="search"
            value={query}
            placeholder="Find in transcript"
            aria-label="Find in this reading"
            onChange={(e) => {
              setQuery(e.target.value);
              setHit(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFinding(false);
              if (e.key === "Enter" && totalMatches > 0) {
                setHit((h) => (e.shiftKey ? (h - 1 + totalMatches) % totalMatches : (h + 1) % totalMatches));
              }
            }}
          />
          <span className="small muted find-count">
            {!query.trim()
              ? ""
              : totalMatches === 0
                ? "No matches"
                : `${hit + 1} of ${totalMatches}`}
          </span>
          <IconButton
            icon="prev"
            label="Previous match"
            disabled={totalMatches === 0}
            onClick={() => setHit((h) => (h - 1 + totalMatches) % totalMatches)}
          />
          <IconButton
            icon="next"
            label="Next match"
            disabled={totalMatches === 0}
            onClick={() => setHit((h) => (h + 1) % totalMatches)}
          />
          <button type="button" className="quiet" onClick={() => setFinding(false)}>
            Done
          </button>
        </div>
      )}

      <div className="video-reader-body">
        {notesOpen && (
          <aside className="video-notes-pane" aria-label="Reading notes">
            <div className="video-pane-head">
              <h2>Notes</h2>
              <button type="button" className="quiet" onClick={() => setNotesOpen(false)}>
                Close
              </button>
            </div>
            <Suspense fallback={<NotesLoading />}>
              <NoteEditor
                target={{ item_id: item.id }}
                label={`Notes on ${shortTitle(item)}`}
                placeholder="Write notes as you watch…"
              />
            </Suspense>
          </aside>
        )}

        <div className="video-stage-col">
          {upload && !file ? (
            <div className="video-empty-card">
              <p>Uploading video ({ upload.name })…</p>
            </div>
          ) : !videoSrc ? (
            <div className="video-empty-card">
              <p>Video file is not available.</p>
            </div>
          ) : mediaError ? (
            <div className="video-empty-card">
              <p>This browser cannot play this video’s format or codec directly.</p>
              <button type="button" className="button primary" onClick={() => void download(viewForRow)}>
                Download video
              </button>
            </div>
          ) : (
            <div className="video-player-wrap">
              <video
                ref={videoRef}
                className="video-element"
                controls
                playsInline
                preload="metadata"
                src={videoSrc}
                onLoadedMetadata={handleLoadedMetadata}
                onTimeUpdate={() => persistPlaybackSpot(false)}
                onPause={() => persistPlaybackSpot(true)}
                onError={() => setMediaError(true)}
              />
            </div>
          )}
        </div>

        <section className="video-transcript-pane" aria-label="Transcript">
          <div className="video-pane-head">
            <div>
              <h2>Transcript / text version</h2>
              {meta.transcript_name && (
                <span className="small muted">{meta.transcript_name}</span>
              )}
            </div>
            <div className="row" style={{ gap: "0.4rem" }}>
              {file && (
                <button
                  type="button"
                  className="button small"
                  onClick={() => transcriptInputRef.current?.click()}
                >
                  {meta.transcript_text ? "Replace" : "Attach transcript"}
                </button>
              )}
              {meta.transcript_text && (
                <button
                  type="button"
                  className="quiet danger"
                  onClick={() => void handleRemoveTranscript()}
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          <div ref={transcriptBodyRef} className="video-transcript-body">
            {transcriptParagraphs.length === 0 ? (
              <div className="video-transcript-empty">
                <p className="muted">
                  No transcript or companion text document attached. Attach a TXT, Word (.docx) or PDF file to read and search alongside this video.
                </p>
                {file && (
                  <button
                    type="button"
                    className="button"
                    onClick={() => transcriptInputRef.current?.click()}
                  >
                    Attach transcript
                  </button>
                )}
              </div>
            ) : (
              transcriptParagraphs.map((para, idx) => (
                <p key={idx} className="video-transcript-para">
                  {renderParagraphWithHighlightsAndTimestamps(
                    para,
                    idx,
                    spansByPara.get(idx) ?? [],
                    hit,
                    seekTo,
                  )}
                </p>
              ))
            )}
          </div>
        </section>
      </div>

      <input
        ref={transcriptInputRef}
        type="file"
        hidden
        accept={TRANSCRIPT_ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleAttachTranscript(f);
        }}
      />
      <input
        ref={replacerRef}
        type="file"
        hidden
        accept={READING_ACCEPT}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void replaceFile(viewForRow, f);
        }}
      />

      {sheet === "edit" && (
        <ReaderSheet title="Edit details" onClose={() => setSheet(null)}>
          <Editor view={viewForRow} onClose={() => setSheet(null)} />
        </ReaderSheet>
      )}
      {sheet === "move" && (
        <ReaderSheet title="Move reading" onClose={() => setSheet(null)}>
          <MovePicker view={viewForRow} onMoved={() => setSheet(null)} />
        </ReaderSheet>
      )}
    </div>
  );
}
