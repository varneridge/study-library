import { readingFileName } from "../lib/names";
import { combinePhotos, isImage, READING_ACCEPT } from "../lib/photos";
import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "../App";
import type { ReadingView } from "../lib/library";
import { weekCode, byWeek, titleAfter } from "../lib/modules";
import { commit, newId, retryFile, update } from "../lib/sync";
import { fullTitle, shortTitle, titleParts, chicagoBibliography } from "../lib/titles";
import { mimeFor, onUploadProgress, queueUpload, retryUpload, sha256, uploadProgress } from "../lib/uploads";
import { deleteItem, moduleOfItem, withUndo } from "../lib/edits";
import { moveToTray, moveToWeek, nudge } from "../lib/moves";
import { confirmAction, showToast, useCloseOnBack, useOnline } from "../lib/ui";
import { useProcessorStatus, waitingText } from "../lib/status";
import { Menu } from "./Menu";
import { keepMine, lookAgain, pending, putBack, applySuggestion, viaLabel } from "../lib/citations";
import { db } from "../lib/db";
import { touchFirst } from "../lib/drag";
import { Icon } from "./icons";
import { byPosition, keysAfter } from "../lib/keys";
import type { ItemKind, ItemRow, Suggestion, WeekRow, WorkKind } from "../lib/types";

export function readable(view: ReadingView): boolean {
  if (view.file?.mime === "application/pdf") return true;
  return view.upload?.mime === "application/pdf";
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
  if (file.text_status === "failed") {
    return <span className="state problem">Processing failed. <button className="link" onClick={() => retryFile(file.id)}>Retry</button></span>;
  }
  if (file.mime !== "application/pdf") return <span className="state" title={waiting ?? undefined}>{waiting ? "Waiting to convert" : "Converting"}</span>;
  if (file.text_status === "ocr") return <span className="state" title={waiting ?? undefined}>{waiting ? "Waiting to add text" : "Adding text"}</span>;
  return null;
}

export function ReadingTitle({ view, short }: { view: ReadingView; short?: boolean }) {
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
  return <Link to={{ view: "reader", id: view.item.id }} className="name" title={label} label={label}>{body}</Link>;
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
  const page = item.read_status !== "read" && item.last_page ? `p. ${item.last_page + 1}${file?.page_count ? ` of ${file.page_count}` : ""}` : null;
  const marks = highlights ? `${highlights} ${highlights === 1 ? "highlight" : "highlights"}` : null;
  if (!page && !marks) return null;
  return <span className="state progress">{[page, marks].filter(Boolean).join(", ")}</span>;
}

export function ReadMark({ view }: { view: ReadingView }) {
  const read = view.item.read_status === "read";
  return (
    <button
      className={`mark${read ? " read" : ""}`}
      role="checkbox"
      aria-checked={read}
      title={read ? "Read. Click to mark as unread" : "Not read yet. Click to mark as read"}
      aria-label={read ? "Mark as unread" : "Mark as read"}
      onClick={() => update("items", view.item.id, { read_status: read ? "unread" : "read" })}
    />
  );
}

export async function copyReference(item: ItemRow): Promise<void> {
  const ref = chicagoBibliography(item);
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(ref);
      showToast("Reference copied.");
      return;
    }
  } catch {
    // Clipboard permission or focus error
  }
  showToast("Reference copied.");
}

export function Editor({ view, onClose, start }: { view: ReadingView; onClose: () => void; start?: Suggestion | null }) {
  useCloseOnBack(true, onClose);
  const from = start ?? view.item;
  const [draft, setDraft] = useState({
    kind: view.item.kind,
    work_kind: from.work_kind ?? (view.item.kind === "primary" ? "primary" : "article"),
    author: from.author ?? "",
    editor: from.editor ?? "",
    title: from.title,
    source: from.source ?? "",
    publisher: from.publisher ?? "",
    volume: from.volume ?? "",
    issue: from.issue ?? "",
    pages: from.pages ?? "",
    year: from.year ? String(from.year) : "",
    doc_date: view.item.doc_date ?? "",
    doi: from.doi ?? "",
  });
  const auto = view.item.suggested?.applied ? view.item.suggested : null;
  const set = (key: keyof typeof draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setDraft({ ...draft, [key]: e.target.value });

  async function save(event: React.FormEvent) {
    event.preventDefault();
    await update("items", view.item.id, {
      ...(start && view.item.suggested ? { suggested: { ...view.item.suggested, dismissed: true } } : {}),
      kind: draft.kind as ItemKind,
      work_kind: (draft.kind === "slides" ? null : draft.work_kind) as WorkKind,
      author: draft.author.trim() || null,
      editor: draft.editor.trim() || null,
      title: draft.title.trim() || view.item.title,
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

  return (
    <form className="editor" onSubmit={save}>
      {auto && !start && (
        <p className="small muted provenance">
          Filled in {viaLabel(auto.via)}.{" "}
          {auto.previous && <button type="button" className="link" onClick={() => { void putBack(view.item); onClose(); }}>Put back the old details</button>}
        </p>
      )}
      <div className="grid">
        <label className="field"><span>Type</span>
          <select value={draft.kind} onChange={(e) => {
            const k = e.target.value as ItemKind;
            setDraft({ ...draft, kind: k, work_kind: k === "primary" ? "primary" : draft.work_kind === "primary" ? "article" : draft.work_kind });
          }}>
            <option value="secondary">Reading</option>
            <option value="primary">Primary source</option>
            <option value="slides">Slides</option>
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
      <div className="grid">
        <label className="field"><span>Author</span><input type="text" value={draft.author} onChange={set("author")} placeholder="Surname, Given and Surname, Given" /></label>
        {draft.work_kind === "chapter" && (
          <label className="field"><span>Volume editor</span><input type="text" value={draft.editor} onChange={set("editor")} placeholder="Surname, Given" /></label>
        )}
      </div>
      <label className="field"><span>Title</span><input type="text" value={draft.title} onChange={set("title")} /></label>
      <div className="grid">
        <label className="field"><span>{draft.work_kind === "chapter" ? "Book title" : draft.work_kind === "article" ? "Journal" : "Source"}</span><input type="text" value={draft.source} onChange={set("source")} /></label>
        <label className="field"><span>Pages</span><input type="text" value={draft.pages} onChange={set("pages")} /></label>
        {draft.kind === "primary" ? (
          <label className="field"><span>Date</span><input type="text" value={draft.doc_date} onChange={set("doc_date")} /></label>
        ) : (
          <label className="field"><span>Year</span><input type="text" inputMode="numeric" value={draft.year} onChange={set("year")} /></label>
        )}
      </div>
      {draft.kind === "secondary" && (
        <div className="grid">
          {(draft.work_kind === "chapter" || draft.work_kind === "book") && (
            <label className="field"><span>Publisher</span><input type="text" value={draft.publisher} onChange={set("publisher")} placeholder="Publisher name" /></label>
          )}
          {draft.work_kind === "article" && (
            <>
              <label className="field"><span>Volume</span><input type="text" value={draft.volume} onChange={set("volume")} placeholder="e.g. 38" /></label>
              <label className="field"><span>Issue</span><input type="text" value={draft.issue} onChange={set("issue")} placeholder="e.g. 2" /></label>
            </>
          )}
          <label className="field"><span>DOI or URL</span><input type="text" value={draft.doi} onChange={set("doi")} placeholder="10.1080/... or https://..." /></label>
        </div>
      )}
      <div className="row">
        <button className="button primary">Save</button>
        <button type="button" className="quiet" onClick={onClose}>Cancel</button>
      </div>
    </form>
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
  const existing = (await db.files.where("sha256").equals(sha).toArray()).find((f) => !f.deleted);
  if (existing) {
    await update("items", view.item.id, { file_id: existing.id, original_file_id: null, last_page: null });
  } else {
    await update("items", view.item.id, { original_file_id: null, last_page: null });
    await queueUpload({ file_id: newId(), item_id: view.item.id, name: file.name, mime, sha256: sha, bytes: file.size, blob: file });
  }
  showToast("File replaced.");
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
  const highlights = (await db.highlights.where("item_id").equals(view.item.id).toArray()).filter((h) => !h.deleted).length;
  if (highlights > 0) {
    const ok = await confirmAction({
      title: "Delete this reading?",
      body: `Its ${highlights} ${highlights === 1 ? "highlight" : "highlights"} and notes go with it. You can restore it from Settings for 90 days.`,
      confirm: "Delete reading",
      danger: true,
    });
    if (!ok) return false;
  }
  await withUndo("Reading deleted.", deleteItem(view.item));
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
          {modules.map((m) => <option key={m.id} value={m.id}>{m.code}{m.title ? ` ${m.title}` : ""}</option>)}
        </select>
      )}
      <select aria-label="Week" value="" onChange={(e) => void go(e.target.value)} style={{ width: "auto" }}>
        <option value="">Move to week</option>
        {weeks.filter((w) => w.id !== view.link?.week_id).map((w) => <option key={w.id} value={w.id}>{weekCode(w)}{titleAfter(w)}</option>)}
        {(elsewhere || view.link) && <option value="tray">Unsorted</option>}
      </select>
      <button className="quiet" onClick={onMoved}>Done</button>
    </div>
  );
}

export function ReadingRow({
  view, short, weeks: given, drag, extra,
}: {
  view: ReadingView;
  short?: boolean;
  weeks?: WeekRow[];
  extra?: React.ReactNode;
  // From the drag-and-drop library: the row is the thing you pick up.
  drag?: {
    setNodeRef: (el: HTMLElement | null) => void;
    style?: React.CSSProperties;
    attributes?: React.HTMLAttributes<HTMLElement>;
    listeners?: Record<string, (event: never) => void>;
    dragging: boolean;
  };
}) {
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
  const online = useOnline();

  return (
    <li
      ref={drag?.setNodeRef}
      style={drag?.style}
      {...(drag?.attributes ?? {})}
      {...((drag?.listeners ?? {}) as React.HTMLAttributes<HTMLElement>)}
      // The row stays a list item for screen readers. The library's own
      // description tells them it can be picked up with the space bar.
      role={undefined}
      className={`reading${!online && !view.cached && readable(view) ? " unavailable" : ""}${drag ? " movable" : ""}${drag?.dragging ? " dragging" : ""}`}
    >
      {drag && <span className="handle" aria-hidden="true"><Icon name="grip" size={16} /></span>}
      <ReadMark view={view} />
      <ReadingTitle view={view} short={short} />
      {suggestion && weeks && (
        <button className="found" aria-expanded={comparing} onClick={() => setComparing(!comparing)} title="Study Library found this reading's details in the PDF" aria-label="Details found">
          <span className="wide-only">Details found</span><span className="narrow-only">Details</span>
        </button>
      )}
      <Progress view={view} />
      <State view={view} />
      {!online && !view.cached && readable(view) && <span className="state">Not saved on this device</span>}
      {extra}
      {weeks && (
        <Menu
          items={[
            { label: "Edit details", onSelect: () => { setEditFrom(null); setEditing(true); } },
            { label: "Copy reference", onSelect: () => void copyReference(view.item), hidden: view.item.kind === "slides" },
            { label: "Look up the details again", onSelect: () => void lookAgain(view.item), hidden: !view.file || view.file.mime !== "application/pdf" },
            // On a touch screen these stand in for dragging the row.
            { label: "Move up", onSelect: () => void nudge(view.item, view.link!, -1).then((moved) => { if (!moved) showToast("Already at the top."); }), hidden: !view.link || !touchFirst() },
            { label: "Move down", onSelect: () => void nudge(view.item, view.link!, 1).then((moved) => { if (!moved) showToast("Already at the foot."); }), hidden: !view.link || !touchFirst() },
            { label: "Move to another week or module", onSelect: () => setMoving(true) },
            { label: "Remove from this week", onSelect: () => void removeFromWeek(view), hidden: !view.link },
            { label: view.item.read_status === "read" ? "Mark as unread" : "Mark as read",
              onSelect: () => void update("items", view.item.id, { read_status: view.item.read_status === "read" ? "unread" : "read" }) },
            { label: "Download file", onSelect: () => void download(view), hidden: !view.file },
            { label: "Replace file", onSelect: () => replacer.current?.click(), hidden: Boolean(view.upload) },
            { label: "Delete reading", onSelect: () => void deleteReading(view), danger: true },
          ]}
        />
      )}
      <input
        ref={replacer} type="file" hidden accept={READING_ACCEPT}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void replaceFile(view, f); }}
      />
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
      {(editing || moving) && (
        <div style={{ flexBasis: "100%" }}>
          {editing && <Editor view={view} start={editFrom} onClose={() => { setEditing(false); setEditFrom(null); }} />}
          {moving && weeks && <MovePicker view={view} onMoved={() => setMoving(false)} />}
        </div>
      )}
    </li>
  );
}
