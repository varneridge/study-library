import { readingFileName } from "../lib/names";
import { combinePhotos, isImage, READING_ACCEPT } from "../lib/photos";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import type { ReadingView } from "../lib/library";
import { weekCode, byWeek, titleAfter } from "../lib/modules";
import { commit, newId, retryFile, update } from "../lib/sync";
import { resolveExistingFile } from "../lib/importing";
import { fullTitle, shortTitle, titleParts, chicagoBibliography } from "../lib/titles";
import { cancelUploadsForItem, mimeFor, onUploadProgress, pump, queueUpload, retryUpload, sha256, uncancelUpload, uploadProgress } from "../lib/uploads";
import { deleteItem, moduleOfItem, withUndo } from "../lib/edits";
import { moveToTray, moveToWeek, nudge, placeInWeek } from "../lib/moves";
import { citable, minutesLeft, readingMinutes } from "../lib/progress";
import { deleteLabel, KIND_LABEL, KIND_TITLE_LABEL, KIND_GROUP } from "../lib/kinds";
import { confirmAction, showToast, useCloseOnBack, useOnline } from "../lib/ui";
import { useProcessorStatus, waitingText } from "../lib/status";
import { Menu } from "./Menu";
import { folderTitle, useFolders } from "./Folders";
import { createFolder, moveToFolder } from "../lib/folders";
import { keepMine, lookAgain, pending, putBack, applySuggestion, redoFileStep, viaLabel, parseReference, type ReferenceFields } from "../lib/citations";
export { parseReference, type ReferenceFields };
import { dragHandleProps } from "../lib/drag";
import { db } from "../lib/db";
import { Icon } from "./icons";
import { byPosition, keysAfter } from "../lib/keys";
import type { ItemKind, ItemRow, Suggestion, WeekRow, WorkKind } from "../lib/types";
import { attachVideoTranscript, isVideoMime, parseVideoMeta, removeVideoTranscript, TRANSCRIPT_ACCEPT } from "../lib/video";
import { coverShape, isTileMode, isVideoView, type ReadingViewMode } from "../lib/views";
import { requestVideoThumb } from "../lib/videoThumbs";

export function readable(view: ReadingView): boolean {
  if (view.file?.mime === "application/pdf" || isVideoMime(view.file?.mime)) return true;
  return view.upload?.mime === "application/pdf" || isVideoMime(view.upload?.mime);
}

function useProgress(id: string | undefined) {
  const [, force] = useState(0);
  useEffect(() => (id ? onUploadProgress(() => force((n) => n + 1)) : undefined), [id]);
  return id ? uploadProgress(id) : undefined;
}

// What the row says about its file. Absence says nothing.
function State({ view }: { view: ReadingView }) {
  const progress = useProgress(view.upload?.id);
  const { upload, file } = view;
  const waiting = waitingText(useProcessorStatus());
  if (upload) {
    if (upload.status === "failed") {
      return <span className="state problem">Upload failed. <button className="link" onClick={() => retryUpload(upload.id)}>Retry</button></span>;
    }
    return <span className="state">{progress !== undefined ? `Uploading ${Math.round(progress * 100)}%` : "Waiting to upload"}</span>;
  }
  if (!file) return null;
  if (isVideoMime(file.mime)) {
    const vmeta = parseVideoMeta(file.meta);
    return vmeta.transcript_text ? <span className="state">Transcript attached</span> : null;
  }
  if (file.text_status === "failed") {
    return <span className="state problem">Processing failed. <button className="link" onClick={() => retryFile(file.id)}>Retry</button></span>;
  }
  if (file.mime !== "application/pdf") return <span className="state" title={waiting ?? undefined}>{waiting ? "Waiting to convert" : "Converting"}</span>;
  if (file.text_status === "ocr") return <span className="state" title={waiting ?? undefined}>{waiting ? "Waiting to add text" : "Adding text"}</span>;
  return null;
}

export function ReadingTitle({ view, short, openInNewTab }: { view: ReadingView; short?: boolean; openInNewTab?: boolean }) {
  const label = short ? shortTitle(view.item) : fullTitle(view.item);
  const { main, sub } = titleParts(view.item);
  const body = short ? label : (
    <>
      <span className="main">{main || label}</span>
      {sub && <span className="sub">{sub}</span>}
    </>
  );
  // The full citation is the accessible name, read as one line.
  if (!readable(view)) return <span className="name" title={label} aria-label={label}>{body}</span>;
  return <Link to={{ view: "reader", id: view.item.id }} className="name" title={label} label={label} newTab={openInNewTab ? "always" : false}>{body}</Link>;
}

// Where you stopped, shown until the reading is marked read.
// How far into a reading you are, and how much you marked in it. The
// page goes once it is read; the highlights stay, as a sign of what you used.
function Progress({ view }: { view: ReadingView }) {
  const { item, file } = view;
  const highlights = useLiveQuery(
    async () => (await db.highlights.where("item_id").equals(item.id).toArray()).filter((h) => !h.deleted).length,
    [item.id], 0,
  );
  const pages = file?.page_count;
  const total = readingMinutes(pages);
  // Started: where you are and the time left. Not started: the size of it.
  const page = item.last_page
    ? `p. ${item.last_page + 1}${pages ? ` of ${pages}, ${minutesLeft(pages, item.last_page, total)} min left` : ""}`
    : pages ? `${pages} ${pages === 1 ? "p" : "pp"}, ${total} min` : null;
  const marks = highlights ? `${highlights} ${highlights === 1 ? "highlight" : "highlights"}` : null;
  if (!page && !marks) return null;
  return <span className="state progress">{[page, marks].filter(Boolean).join(", ")}</span>;
}

export async function copyReference(item: ItemRow): Promise<void> {
  const ref = chicagoBibliography(item);
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(ref);
      showToast("Reference copied.");
      return;
    }
  } catch {
    // Clipboard permission or focus error
  }
  showToast("Could not copy the reference.");
}

// Whether pasted text looks enough like a reference to fill fields straight away.
const looksLikeReference = (text: string) =>
  /\b10\.\d{4,9}\//.test(text) || (/\b(1[5-9]\d{2}|20\d{2})\b/.test(text) && /['"\u2018\u201c]/.test(text));

export function Editor({ view, onClose, start }: { view: ReadingView; onClose: () => void; start?: Suggestion | null }) {
  useCloseOnBack(true, onClose);
  const from = start ?? view.item;
  const [draft, setDraft] = useState({
    kind: view.item.kind,
    work_kind: from.work_kind ?? (view.item.kind === "primary" ? "primary" : "article"),
    author: from.author ?? "",
    editor: from.editor ?? "",
    title: from.title ?? "",
    source: from.source ?? "",
    publisher: from.publisher ?? "",
    volume: from.volume ?? "",
    issue: from.issue ?? "",
    pages: from.pages ?? "",
    year: from.year ? String(from.year) : "",
    doc_date: view.item.doc_date ?? "",
    doi: from.doi ?? "",
  });
  // The rarer fields stay tucked away unless one of them already holds something.
  const [moreFields, setMoreFields] = useState(() => Boolean(from.volume || from.issue || from.publisher || from.editor));
  const [reference, setReference] = useState("");
  // What the last quick fill did, said beside the field rather than in a
  // toast, since a toast can sit behind the card's backdrop.
  const [notice, setNotice] = useState<string | null>(null);
  const auto = view.item.suggested?.applied ? view.item.suggested : null;
  const set = (key: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft({ ...draft, [key]: e.target.value });

  const fill = (text: string) => {
    const found = parseReference(text);
    const count = Object.keys(found).length;
    if (!count) {
      setNotice("No details were recognised in that, so nothing changed.");
      return;
    }
    setDraft((d) => ({ ...d, ...found }));
    if (found.volume || found.issue || found.publisher) setMoreFields(true);
    setReference("");
    setNotice(`Filled ${count} ${count === 1 ? "field" : "fields"}. Check them before saving.`);
  };

  // A blank title is allowed, so one is made from whatever else was given.
  const titleFor = (): string => {
    const typed = draft.title.trim();
    if (typed) return typed;
    const when = draft.year.trim() || (draft.kind === "primary" ? draft.doc_date.trim() : "");
    const byline = [draft.author.trim(), when ? `(${when})` : ""].filter(Boolean).join(" ");
    return byline
      || draft.source.trim()
      || draft.doi.trim()
      || view.file?.original_name?.replace(/\.[^.]+$/, "")
      || view.item.title
      || "Untitled";
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    await update("items", view.item.id, {
      ...(start && view.item.suggested ? { suggested: { ...view.item.suggested, dismissed: true } } : {}),
      kind: draft.kind as ItemKind,
      work_kind: draft.kind === "slides" ? null : (draft.work_kind as WorkKind),
      author: draft.author.trim() || null,
      editor: draft.editor.trim() || null,
      title: titleFor(),
      source: draft.source.trim() || null,
      publisher: draft.publisher.trim() || null,
      volume: draft.volume.trim() || null,
      issue: draft.issue.trim() || null,
      pages: draft.pages.trim() || null,
      year: Number(draft.year) || null,
      doc_date: draft.doc_date.trim() || null,
      doi: draft.doi.trim() || null,
    });
    onClose();
  }

  const isVideo = isVideoMime(view.file?.mime ?? view.upload?.mime);
  const isSessionItem = Boolean(view.link?.session_id);
  const allowsSlides = isSessionItem || view.item.kind === "slides";
  const sourceLabel = draft.work_kind === "chapter" ? "Book title" : draft.work_kind === "article" ? "Journal" : "Source";

  return (
    <form className="editor editor-card" onSubmit={save}>
      {auto && !start && (
        <p className="small muted provenance">
          Filled in {viaLabel(auto.via)}.{" "}
          {auto.previous && <button type="button" className="link" onClick={() => { void putBack(view.item); onClose(); }}>Put back the old details</button>}
        </p>
      )}
      <div className="editor-card-layout">
        {/* The cover sits beside the fields, so the details can be read off it while typing. */}
        <div className="editor-card-preview">
          <Cover view={view} mode="icons" isLibrary={true} still />
        </div>
        <div className="editor-card-fields">
          {draft.kind !== "summary" && !isVideo && (
            <div className="editor-quick-fill">
              <label className="field"><span>Paste a reference or DOI to fill fields</span>
                <input
                  type="text"
                  value={reference}
                  placeholder="e.g. 10.1080/... or Smith, J. (2020) 'Article Title', Journal, 12(3), pp. 45-67"
                  onChange={(e) => setReference(e.target.value)}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text");
                    if (looksLikeReference(text)) {
                      e.preventDefault();
                      fill(text);
                    }
                  }}
                  onKeyDown={(e) => {
                    // Enter fills from the reference rather than saving half-finished details.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (reference.trim()) fill(reference);
                    }
                  }}
                />
              </label>
              <button type="button" className="quiet small" disabled={!reference.trim()} onClick={() => fill(reference)}>Fill fields</button>
            </div>
          )}
          {/* Always present and never hidden, even when empty, because a status
              that appears together with its message is often not announced. */}
          <p className="small muted editor-notice" role="status">{notice ?? ""}</p>
          {isVideo ? (
            <div className="grid grid-2">
              <label className="field"><span>Title</span><input type="text" value={draft.title} onChange={set("title")} /></label>
              <label className="field"><span>Creator or speaker</span><input type="text" value={draft.author} onChange={set("author")} /></label>
              <label className="field"><span>Year</span><input type="text" inputMode="numeric" value={draft.year} onChange={set("year")} /></label>
              <label className="field"><span>Source or URL</span><input type="text" value={draft.source} onChange={set("source")} placeholder="Channel, site or link" /></label>
            </div>
          ) : (
            <>
              <div className="grid">
                <label className="field"><span>Type</span>
                  <select value={draft.kind} onChange={(e) => {
                    const k = e.target.value as ItemKind;
                    setDraft({ ...draft, kind: k, work_kind: k === "primary" ? "primary" : draft.work_kind === "primary" ? "article" : draft.work_kind });
                  }}>
                    {isSessionItem ? (
                      <option value="slides">{KIND_TITLE_LABEL.slides}</option>
                    ) : (
                      <>
                        <option value="primary">{KIND_TITLE_LABEL.primary}</option>
                        <option value="secondary">{KIND_TITLE_LABEL.secondary}</option>
                        <option value="summary">{KIND_TITLE_LABEL.summary}</option>
                        {allowsSlides && <option value="slides">{KIND_TITLE_LABEL.slides}</option>}
                      </>
                    )}
                  </select>
                </label>
                {draft.kind === "secondary" && (
                  <label className="field"><span>Reference kind</span>
                    <select value={draft.work_kind} onChange={set("work_kind")}>
                      <option value="article">Journal article</option>
                      <option value="chapter">Book chapter</option>
                      <option value="book">Book</option>
                    </select>
                  </label>
                )}
              </div>
              {draft.kind === "summary" ? (
                <label className="field"><span>Title</span><input type="text" value={draft.title} onChange={set("title")} /></label>
              ) : (
                <>
                  <div className="grid">
                    <label className="field"><span>Author</span><input type="text" value={draft.author} onChange={set("author")} placeholder="Surname, Given and Surname, Given" /></label>
                    {draft.kind === "primary" ? (
                      <label className="field"><span>Date</span><input type="text" value={draft.doc_date} onChange={set("doc_date")} /></label>
                    ) : (
                      <label className="field"><span>Year</span><input type="text" inputMode="numeric" value={draft.year} onChange={set("year")} /></label>
                    )}
                  </div>
                  <label className="field"><span>Title</span><input type="text" value={draft.title} onChange={set("title")} /></label>
                  <div className="grid">
                    <label className="field"><span>{sourceLabel}</span><input type="text" value={draft.source} onChange={set("source")} /></label>
                    <label className="field"><span>Pages</span><input type="text" value={draft.pages} onChange={set("pages")} /></label>
                  </div>
                  <label className="field"><span>DOI or URL</span><input type="text" value={draft.doi} onChange={set("doi")} placeholder="10.1080/... or https://..." /></label>
                  <button type="button" className="quiet small" aria-expanded={moreFields} onClick={() => setMoreFields((v) => !v)}>
                    {moreFields ? "Fewer fields" : "More fields (volume, publisher, editor)"}
                  </button>
                  {moreFields && (
                    <div className="grid">
                      <label className="field"><span>Volume</span><input type="text" value={draft.volume} onChange={set("volume")} placeholder="e.g. 38" /></label>
                      <label className="field"><span>Issue</span><input type="text" value={draft.issue} onChange={set("issue")} placeholder="e.g. 2" /></label>
                      <label className="field"><span>Publisher</span><input type="text" value={draft.publisher} onChange={set("publisher")} placeholder="Publisher name" /></label>
                      <label className="field"><span>Volume editor</span><input type="text" value={draft.editor} onChange={set("editor")} placeholder="Surname, Given" /></label>
                    </div>
                  )}
                </>
              )}
            </>
          )}
          <p className="small muted">Any field can stay blank. Without a title, one is made from the others.</p>
          <div className="row">
            <button className="button primary">Save</button>
            <button type="button" className="quiet" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </form>
  );
}

// Edit details as a card in front of the page: the reading's picture at its
// ordinary size on one side and the fields on the other, stacked on a phone.
// Editing inside the row made a tile span the whole grid, which stretched its
// picture across the screen; here the row and the grid stay exactly as they
// were.
//
// The card is put in the page's body rather than in the row, so the row's own
// styles (a tile's full-width picture, a compact row's tiny one) cannot reach
// it. React still passes the card's events up to the row, though, so presses,
// keys and touches stop at the card: a drag started while selecting text would
// otherwise pick up the reading behind it, and a swipe could turn the week.
//
// Escape, Cancel and a press on the dim backdrop all close it unsaved. A press
// that began inside the card and was released outside it, as when selecting
// text in a field, does not count as a press on the backdrop.
export function EditorDialog({ view, onClose, start }: { view: ReadingView; onClose: () => void; start?: Suggestion | null }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOutside = useRef(false);
  const headingId = useId();
  const isVideo = isVideoMime(view.file?.mime ?? view.upload?.mime);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);

  // Whether a point lies on the backdrop, outside the card's own box.
  const outside = (e: React.MouseEvent<HTMLDialogElement>) => {
    if (e.target !== e.currentTarget) return false;
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
  };

  return createPortal(
    <dialog
      ref={ref}
      className={`dialog editor-dialog${isVideo ? " is-video" : ""}`}
      aria-labelledby={headingId}
      data-no-drag
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onPointerDown={(e) => { e.stopPropagation(); pressedOutside.current = outside(e); }}
      onClick={(e) => {
        e.stopPropagation();
        const close = pressedOutside.current && outside(e);
        pressedOutside.current = false;
        if (close) onClose();
      }}
      onKeyDown={(e) => e.stopPropagation()}
      onTouchStart={(e) => e.stopPropagation()}
    >
      <h2 id={headingId}>{isVideo ? "Edit video details" : "Edit details"}</h2>
      <Editor view={view} start={start} onClose={onClose} />
    </dialog>,
    document.body,
  );
}

// Slides stay with a session when they move, readings do not.
async function moveTo(view: ReadingView, week: WeekRow) {
  await moveToWeek(view.item, view.link, week);
}

export async function replaceFile(view: ReadingView, chosen: File) {
  // A picture replaces the file as a one-page PDF.
  let file = chosen;
  if (isImage(chosen)) {
    try { [file] = await combinePhotos([chosen]); } catch (error) { showToast((error as Error).message); return; }
  }
  const mime = mimeFor(file);
  if (!mime) {
    showToast("Choose a PDF, PowerPoint or Word file.");
    return;
  }
  const highlights = (await db.highlights.where("item_id").equals(view.item.id).toArray()).filter((h) => !h.deleted);
  if (highlights.length) {
    const ok = await confirmAction({
      title: "Replace the file?",
      body: `This reading has ${highlights.length} ${highlights.length === 1 ? "highlight" : "highlights"}. They stay, but will only line up if the new file has the same pages.`,
      confirm: "Replace file",
    });
    if (!ok) return;
  }
  const sha = await sha256(file);
  const resolved = await resolveExistingFile(sha);
  const prevFileId = view.item.file_id;
  const prevOriginalFileId = view.item.original_file_id;
  const prevLastPage = view.item.last_page;
  const prevLastSpot = view.item.last_spot;
  let newFileId: string | null = null;

  // Abort and remove any pending uploads for this item, remembering them so Undo can restore them.
  const pendingUploads = await cancelUploadsForItem(view.item.id);

  if (resolved) {
    await update("items", view.item.id, {
      file_id: resolved.fileId,
      original_file_id: resolved.originalFileId,
      last_page: null,
      last_spot: null,
    });
  } else {
    newFileId = newId();
    await update("items", view.item.id, {
      file_id: null,
      original_file_id: null,
      last_page: null,
      last_spot: null,
    });
    await queueUpload({
      file_id: newFileId,
      item_id: view.item.id,
      name: file.name,
      mime,
      sha256: sha,
      bytes: file.size,
      blob: file,
    });
  }
  showToast("File replaced.", {
    label: "Undo",
    run: async () => {
      if (newFileId) {
        await cancelUploadsForItem(view.item.id);
      }
      if (pendingUploads.length > 0) {
        pendingUploads.forEach((u) => uncancelUpload(u.id));
        await db.uploads.bulkPut(
          pendingUploads.map((u) => ({ ...u, status: "queued" as const, attempts: 0 }))
        );
        void pump();
      }
      await update("items", view.item.id, {
        file_id: prevFileId,
        original_file_id: prevOriginalFileId,
        last_page: prevLastPage,
        last_spot: prevLastSpot,
      });
    },
  });
}

export async function download(view: ReadingView) {
  const original = view.item.original_file_id ? await db.files.get(view.item.original_file_id) : undefined;
  const file = original ?? view.file;
  if (!file) return;
  const a = document.createElement("a");
  a.href = `/api/objects/${file.r2_key}`;
  a.download = readingFileName(view.item, file);
  document.body.append(a);
  a.click();
  a.remove();
}

async function removeFromWeek(view: ReadingView) {
  const moduleId = await moduleOfItem(view.item);
  if (!view.link || !moduleId) return;
  await moveToTray(view.item, view.link, moduleId);
}

export async function deleteReading(view: ReadingView): Promise<boolean> {
  const isVideo = isVideoMime(view.file?.mime ?? view.upload?.mime);
  const noun = isVideo ? "video" : view.item.kind === "slides" ? "slides" : view.item.kind === "summary" ? "summary" : "reading";
  const name = view.item.kind === "slides" ? "these slides" : `this ${noun}`;
  const highlights = (await db.highlights.where("item_id").equals(view.item.id).toArray()).filter((h) => !h.deleted).length;
  if (highlights > 0) {
    const ok = await confirmAction({
      title: `Delete ${name}?`,
      body: `Its ${highlights} ${highlights === 1 ? "highlight" : "highlights"} and notes go with it. You can restore it from Settings for 90 days.`,
      confirm: isVideo ? "Delete video" : deleteLabel(view.item.kind),
      danger: true,
    });
    if (!ok) return false;
  }
  const capNoun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const msg = view.item.kind === "slides" ? "Slides deleted." : `${capNoun} deleted.`;
  await withUndo(msg, deleteItem(view.item));
  return true;
}

export function MoveSelect({ view, weeks, label = "Move to week", onMoved }: {
  view: ReadingView; weeks: WeekRow[]; label?: string; onMoved?: () => void;
}) {
  return (
    <select
      aria-label={label}
      value=""
      onChange={(e) => {
        const week = weeks.find((w) => w.id === e.target.value);
        if (week) void moveTo(view, week).then(onMoved);
      }}
      style={{ width: "auto" }}
    >
      <option value="">{label}</option>
      {[...weeks].sort(byWeek).map((w) => <option key={w.id} value={w.id}>{weekCode(w)}{titleAfter(w)}</option>)}
    </select>
  );
}

// Chooses where a reading goes: a week or Unsorted, in its own module or
// another. The module defaults to the one the reading is in.
export function MovePicker({ view, onMoved }: { view: ReadingView; onMoved: () => void }) {
  useCloseOnBack(true, onMoved);
  const here = useLiveQuery(() => moduleOfItem(view.item), [view.item.id, view.item.tray_module_id, view.link?.week_id], null);
  const [chosen, setChosen] = useState<string | null>(null);
  const moduleId = chosen ?? here;
  const modules = useLiveQuery(async () => (await db.modules.toArray()).filter((m) => !m.deleted).sort(byPosition), [], []);
  const weeks = useLiveQuery(
    async () => (moduleId ? (await db.weeks.where("module_id").equals(moduleId).toArray()).filter((w) => !w.deleted).sort(byWeek) : []),
    [moduleId], [],
  );
  const target = modules.find((m) => m.id === moduleId);
  const elsewhere = Boolean(here && moduleId && moduleId !== here);
  const go = async (value: string) => {
    if (!moduleId || !value) return;
    if (value === "tray") {
      await moveToTray(view.item, view.link, moduleId, elsewhere && target ? `Moved to ${target.code}, Unsorted.` : "Moved to Unsorted.");
    } else {
      const week = weeks.find((w) => w.id === value);
      if (week) await moveToWeek(view.item, view.link, week);
    }
    onMoved();
  };
  return (
    <div className="editor row move-picker">
      {modules.length > 1 && (
        <select aria-label="Module" value={moduleId ?? ""} onChange={(e) => setChosen(e.target.value)} style={{ width: "auto" }}>
          {modules.map((m) => <option key={m.id} value={m.id}>{m.code}{m.title ? `, ${m.title}` : ""}</option>)}
        </select>
      )}
      <select aria-label="Week" value="" onChange={(e) => void go(e.target.value)} style={{ width: "auto" }}>
        <option value="">Move to week</option>
        {weeks.filter((w) => w.id !== view.link?.week_id).map((w) => <option key={w.id} value={w.id}>{weekCode(w)}{titleAfter(w)}</option>)}
        {(elsewhere || view.link) && <option value="tray">Unsorted</option>}
      </select>
      <button className="quiet" onClick={onMoved}>Cancel</button>
    </div>
  );
}

// A reading's picture: the cover or first page the processor drew, or a
// video's frame, with a play button over any video. Compact rows show it only
// when there is one; normal rows keep a place for it so titles line up; icons
// and large icons show it as the tile, with the title set in its place when
// there is no picture yet. Outside the library, rows stay text only unless the
// reading is a video, but tiles always take a picture, because there the
// picture is the tile. A still cover is never a link, as in Edit details,
// where following it would throw away what had been typed.
function Cover({ view, mode, isLibrary, still, openInNewTab }: { view: ReadingView; mode: ReadingViewMode; isLibrary?: boolean; still?: boolean; openInNewTab?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const video = isVideoView(view);
  const tile = isTileMode(mode);
  if (!video && !isLibrary && !tile) return null;
  const key = view.file?.thumb_key ?? null;
  const picture = key && failed !== key ? key : null;
  if (!picture && !video && mode === "compact") return null;
  const body = (
    <>
      {picture
        ? <img src={`/api/objects/${picture}`} alt="" loading="lazy" decoding="async" onError={() => setFailed(picture)} />
        : tile ? <span className="reading-cover-fallback">{titleParts(view.item).main || shortTitle(view.item)}</span> : null}
      {video && <span className="play-badge"><Icon name="play" size={20} /></span>}
    </>
  );
  const className = `reading-cover shape-${coverShape(view)}${picture ? "" : " is-empty"}`;
  if (still || !readable(view)) return <span className={className} aria-hidden="true">{body}</span>;
  return <Link to={{ view: "reader", id: view.item.id }} className={className} tabIndex={-1} ariaHidden={true} newTab={openInNewTab ? "always" : false}>{body}</Link>;
}

export function ReadingRow({
  view, short, weeks: given, drag, extra, mode = "compact", isLibrary = false, openInNewTab = false,
}: {
  view: ReadingView;
  short?: boolean;
  // On a page with notes, the reading opens in a new tab in front, so the notes stay open behind it.
  openInNewTab?: boolean;
  // How the folder lays its readings out. Rows unless a page says otherwise.
  mode?: ReadingViewMode;
  weeks?: WeekRow[];
  extra?: React.ReactNode;
  isLibrary?: boolean;
  // From the drag-and-drop library: the row is the thing you pick up.
  drag?: {
    setNodeRef: (el: HTMLElement | null) => void;
    style?: React.CSSProperties;
    attributes?: React.HTMLAttributes<HTMLElement>;
    listeners?: Record<string, (event: never) => void>;
    dragging: boolean;
  };
}) {
  // The shelf's folders, when this reading is on a Library shelf (Folders.tsx).
  const shelf = useFolders();
  // A reading offers the same menu wherever it appears. A page that does not
  // pass the module's weeks has them looked up here.
  const looked = useLiveQuery(async () => {
    if (given) return null;
    const moduleId = await moduleOfItem(view.item);
    return moduleId ? (await db.weeks.where("module_id").equals(moduleId).toArray()).filter((w) => !w.deleted).sort(byWeek) : null;
  }, [given, view.item.id, view.link?.week_id, view.item.tray_module_id], null);
  const weeks = given ?? looked ?? undefined;
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [editFrom, setEditFrom] = useState<Suggestion | null>(null);
  const suggestion = pending(view.item);
  const replacer = useRef<HTMLInputElement>(null);
  const transcriptPicker = useRef<HTMLInputElement>(null);
  const online = useOnline();
  const isVideo = isVideoMime(view.file?.mime ?? view.upload?.mime);
  const hasVideoTranscript = Boolean(isVideo && view.file && parseVideoMeta(view.file.meta).transcript_text);
  const isPdf = Boolean(view.file && view.file.mime === "application/pdf");
  const tile = isTileMode(mode);
  // A video with no picture yet gets one, taken on this device.
  useEffect(() => {
    if (isVideo && view.file && !view.file.thumb_key) requestVideoThumb(view.file, view.upload?.blob ?? null);
  }, [isVideo, view.file, view.upload?.blob]);

  return (
    <li
      ref={drag?.setNodeRef}
      style={drag?.style}
      /* No drag attributes: they made the whole row a focusable drag
         button, so Space after a click, or typed in Edit details, picked
         the reading up. Moving by keyboard is through the drag handle. */
      {...((drag?.listeners ?? {}) as React.HTMLAttributes<HTMLElement>)}
      // The row stays a list item for screen readers. The library's own
      // description tells them it can be picked up with the space bar.
      role={undefined}
      className={`reading mode-${mode}${tile ? " tile" : ""}${tile && (moving || comparing) ? " expanded" : ""}${!online && !view.cached && readable(view) ? " unavailable" : ""}${drag ? " movable" : ""}${drag?.dragging ? " dragging" : ""}`}
    >
      {/* On a touch screen, or when arranging, this stands in for dragging the
          whole row, and its arrow keys move the reading one place at a time. */}
      {drag && (
        <button
          type="button"
          className="drag-handle"
          data-drag-handle
          aria-label={`Drag ${shortTitle(view.item)} to reorder`}
          {...dragHandleProps((dir) => {
            if (!view.link) return;
            void nudge(view.item, view.link, dir).then((moved) => {
              if (!moved) showToast(dir < 0 ? "Already at the top." : "Already at the foot.");
            });
          })}
        >
          <Icon name="reorder" size={16} />
        </button>
      )}
      <Cover view={view} mode={mode} isLibrary={isLibrary} openInNewTab={openInNewTab} />
      <ReadingTitle view={view} short={short} openInNewTab={openInNewTab} />
      {/* What the reading's state is. In rows these sit inline, as before; in
          tiles they take a line of their own beneath the title. */}
      <span className="reading-meta">
        {suggestion && weeks && (
          <button className="found" aria-expanded={comparing} onClick={() => setComparing(!comparing)} title="Study Library found this reading's details in the PDF" aria-label="Details found">
            <span className="wide-only">Details found</span><span className="narrow-only">Details</span>
          </button>
        )}
        <Progress view={view} />
        <State view={view} />
        {!online && !view.cached && readable(view) && <span className="state">Not saved on this device</span>}
      </span>
      {extra}
      {weeks && (
        <Menu
          items={[
            { label: "Edit details", onSelect: () => { setEditFrom(null); setEditing(true); } },
            { label: "Copy reference", onSelect: () => void copyReference(view.item), hidden: !citable(view.item) },
            { label: "Move to another week or module", onSelect: () => setMoving(true) },
            ...(shelf && view.link
              ? [{
                  // On a Library shelf: into one of its folders, out of the one it is in, or into a new one.
                  label: "Move to folder",
                  items: [
                    ...shelf.folders
                      .filter((f) => f.id !== (view.link!.folder_id ?? null))
                      .map((f) => ({ label: folderTitle(f), onSelect: () => void moveToFolder(view.link!, f.id).then(() => showToast(`Moved to ${folderTitle(f)}.`)) })),
                    {
                      label: "Out of this folder, onto the shelf",
                      hidden: !view.link.folder_id || !shelf.folders.some((f) => f.id === view.link!.folder_id),
                      onSelect: () => void moveToFolder(view.link!, null).then(() => showToast("Moved onto the shelf.")),
                    },
                    {
                      label: "Into a new folder",
                      onSelect: () => void createFolder(shelf.weekId).then((id) => moveToFolder(view.link!, id)).then(() => showToast("Moved into a new folder. Rename it from its tile.")),
                    },
                  ],
                }]
              : []),
            { label: "Download file", onSelect: () => void download(view), hidden: !view.file },
            {
              // The rarer actions, and those that run a file's processing again, wait in here.
              label: "More...",
              items: [
                { label: "Read the text again (re-OCR)", onSelect: () => void redoFileStep(view.file!.id, "ocr"), hidden: isVideo || !isPdf },
                { label: "Update cover thumbnail", onSelect: () => void redoFileStep(view.file!.id, "thumb"), hidden: isVideo || !view.file },
                { label: "Look up the details again", onSelect: () => void (view.file ? redoFileStep(view.file.id, "identify") : lookAgain(view.item)), hidden: isVideo || !citable(view.item) || !isPdf },
                { label: hasVideoTranscript ? "Replace transcript" : "Attach transcript", onSelect: () => transcriptPicker.current?.click(), hidden: !isVideo || !view.file },
                { label: "Remove transcript", onSelect: () => void removeVideoTranscript(view.file!).then(() => showToast("Transcript removed.")), hidden: !hasVideoTranscript || !view.file, danger: true },
                { label: `Move to ${KIND_GROUP.primary}`, onSelect: () => void placeInWeek(view.item, view.link!, [], 0, "primary"), hidden: isVideo || !view.link || Boolean(view.link.session_id) || view.item.kind === "primary" },
                { label: `Move to ${KIND_GROUP.secondary}`, onSelect: () => void placeInWeek(view.item, view.link!, [], 0, "secondary"), hidden: isVideo || !view.link || Boolean(view.link.session_id) || view.item.kind === "secondary" },
                { label: `Move to ${KIND_GROUP.summary}`, onSelect: () => void placeInWeek(view.item, view.link!, [], 0, "summary"), hidden: isVideo || !view.link || Boolean(view.link.session_id) || view.item.kind === "summary" },
                { label: "Replace file", onSelect: () => replacer.current?.click(), hidden: Boolean(view.upload) },
                { label: "Remove from this week", onSelect: () => void removeFromWeek(view), hidden: !view.link },
              ],
            },
            { label: isVideo ? "Delete video" : deleteLabel(view.item.kind), onSelect: () => void deleteReading(view), danger: true },
          ]}
        />
      )}
      <input
        ref={replacer} type="file" hidden accept={READING_ACCEPT}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void replaceFile(view, f); }}
      />
      {isVideo && (
        <input
          ref={transcriptPicker} type="file" hidden accept={TRANSCRIPT_ACCEPT}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f && view.file) {
              void attachVideoTranscript(view.file, f)
                .then(() => showToast(`Transcript attached (${f.name}).`))
                .catch((err) => showToast(err instanceof Error ? err.message : "Could not attach transcript."));
            }
          }}
        />
      )}
      {comparing && suggestion && !editing && (
        <div className="compare" style={{ flexBasis: "100%" }}>
          <p className="small muted">Found {viaLabel(suggestion.via)}:</p>
          <dl>
            <dt>Now</dt><dd>{fullTitle(view.item)}</dd>
            <dt>Found</dt><dd className="found-title">{fullTitle({ ...view.item, ...suggestion })}</dd>
          </dl>
          <div className="row">
            <button className="button primary" onClick={() => { void applySuggestion(view.item); setComparing(false); }}>Use these details</button>
            <button className="quiet" onClick={() => { setEditFrom(suggestion); setEditing(true); setComparing(false); }}>Edit them first</button>
            <button className="quiet" onClick={() => { void keepMine(view.item); setComparing(false); }}>Keep mine</button>
          </div>
        </div>
      )}
      {moving && weeks && (
        <div className="reading-edit" style={{ flexBasis: "100%" }}>
          <MovePicker view={view} onMoved={() => setMoving(false)} />
        </div>
      )}
      {/* Edit details floats in front of the page, so the row keeps its size. */}
      {editing && <EditorDialog view={view} start={editFrom} onClose={() => { setEditing(false); setEditFrom(null); }} />}
    </li>
  );
}
