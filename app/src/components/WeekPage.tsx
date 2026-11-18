import { NotesLoading } from "./ErrorBoundary";
import { AddTile } from "./AddTile";
import { addMeeting, isLibrary, isSyllabus, moduleHasNotes, moduleHasSessions, moduleHasMeetings } from "../lib/sections";
import { combinePhotos, READING_ACCEPT } from "../lib/photos";
import { useLiveQuery, useSuspendingLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "../App";
import { db } from "../lib/db";
import { prefetch, PREFETCH_MAX_BYTES } from "../lib/files";
import { applyPlans, planFile, addSlides, sessionDeck, SLIDES_ACCEPT } from "../lib/importing";
import { byPosition } from "../lib/keys";
import { clock } from "../lib/recorder";
import { loadWeekPage, type NoteView, type ReadingView, type SessionView } from "../lib/library";
import { sessionLabel, weekCode, SESSION_KINDS, titleAfter, isSection } from "../lib/modules";
import { update } from "../lib/sync";
import type { FileRow, FolderRow, ModuleRow, RecordingRow, WeekRow } from "../lib/types";
import { recordingState } from "./Recording";
import { Menu } from "./Menu";
import { addSession, reorderSessions, setReadingWeek, deleteSessionAsking, deleteSection } from "../lib/edits";
import { navigate } from "../lib/router";
import { showToast, typing, useTitle, useSwipe } from "../lib/ui";
import { isThisWeek, useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { blockText } from "../lib/notes";
import { Icon } from "./icons";
import { TitleEdit } from "./TitleEdit";
import { FolderContext, FolderHeader } from "./Folders";
import { linksAt, moveToFolder, shelfFolders } from "../lib/folders";
import { WeekBoard } from "./WeekBoard";
import { sessionMaterials } from "../lib/sessionMaterials";
import { uploadModulePicture } from "../lib/uploads";
import { importTranscript, isTranscriptFile } from "../lib/transcriptImport";
import { downloadWeekArchive } from "../lib/weekArchive";
import { KIND_GROUP } from "../lib/kinds";
import { closestCenter, DndContext, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { droppedOrder, dragHandleProps, steppedOrder, swallowClickAfterDrag, useDragSensors, useOptimisticOrder } from "../lib/drag";

// When a week runs, and whether that is now, in the slim line above the title.
export function WeekWhen({ week }: { week: WeekRow }) {
  const dates = useTermDates();
  const now = useTeachingWeek();
  const text = weekDatesText(week.term, week.number, dates);
  if (!text) return null;
  return (
    <span className="week-when">
      {text}
      {isThisWeek(week, now) && <span className="this-week-tag">This week</span>}
    </span>
  );
}

function TitleEditor({ week, editing, setEditing }: { week: WeekRow; editing: boolean; setEditing: (on: boolean) => void }) {
  if (!editing && isSection(week)) {
    return (
      <h1
        className="editable"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
        title="Click to rename this section"
      >
        {weekCode(week)}
      </h1>
    );
  }
  if (!editing) {
    return (
      <h1
        className="editable"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); } }}
        title="Click to rename this week"
      >
        {week.title ? <><span className="week-code-inline">{weekCode(week)}</span>{" "}{week.title}</> : week.is_reading_week ? `${weekCode(week)} reading week` : weekCode(week)}
      </h1>
    );
  }
  return (
    <TitleEdit
      value={week.title ?? ""}
      label={isSection(week) ? "Section name" : "Week title"}
      placeholder={isSection(week) ? `Section ${week.number}` : `A title for ${weekCode(week)}`}
      onSave={(next) => {
        setEditing(false);
        if (next.trim() !== (week.title ?? "")) void update("weeks", week.id, { title: next.trim() || null });
      }}
      onCancel={() => setEditing(false)}
    />
  );
}

function recordingLine(recording: RecordingRow): string {
  const state = recordingState(recording);
  if (state) return state;
  if (recording.status === "failed") return "Recording could not be processed";
  return recording.duration_seconds ? `Recording, ${clock(recording.duration_seconds)}` : "Recording";
}

// Where dropped files go depends on where they land: on a session they
// become its slides, replacing any it already has, on primary readings they become primary readings, on
// summaries they become summaries, and anywhere else they are secondary
// readings, unless their names say otherwise.
export interface FileTarget { kind: "auto" | "primary" | "secondary" | "summary" | "slides"; sessionId?: string; label: string }

async function addFiles(added: File[], module: ModuleRow, week: WeekRow, target?: FileTarget, folderId?: string | null) {
  // Pictures added together become one reading, a page each.
  let files: File[];
  try { files = await combinePhotos(added); } catch (error) { showToast((error as Error).message); return; }
  // Moodle transcripts go to the session they were dropped on, or the
  // week's first lecture when dropped elsewhere.
  const texts = files.filter(isTranscriptFile);
  if (texts.length) {
    const sessions = (await db.sessions.where("week_id").equals(week.id).toArray()).filter((s) => !s.deleted).sort(byPosition);
    const session = sessions.find((s) => s.id === target?.sessionId) ?? sessions.find((s) => s.kind === "lecture") ?? sessions[0];
    if (!session) showToast("This week has no session to add a transcript to.");
    else {
      for (const file of texts) {
        try { await importTranscript(session.id, file); } catch (error) { showToast((error as Error).message); return; }
      }
      showToast(`Transcript added to the ${session.title || sessionLabel(session.kind).toLowerCase()}.`);
    }
    files = files.filter((f) => !isTranscriptFile(f));
    if (!files.length) return;
  }
  const docOnly = isSyllabus(week) || isLibrary(module);
  const effectiveTarget = target ?? (docOnly ? { kind: "summary" as const, label: "documents" } : undefined);
  // Checked before the files go in, since afterwards every session has slides.
  const replacing = effectiveTarget?.kind === "slides" && effectiveTarget.sessionId
    ? Boolean(await sessionDeck(week.id, effectiveTarget.sessionId))
    : false;
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const plans = files.map((file) => {
    const plan = planFile(file, weeks, week);
    const targetKind = effectiveTarget?.kind;
    if (targetKind === "slides") return { ...plan, kind: "slides" as const, sessionId: effectiveTarget?.sessionId ?? null };
    if (targetKind === "primary" && plan.kind !== "skip" && plan.kind !== "week-title") {
      return { ...plan, kind: "primary" as const, sessionId: null };
    }
    if (targetKind === "secondary" && plan.kind !== "skip" && plan.kind !== "week-title") {
      return { ...plan, kind: "secondary" as const, sessionId: null };
    }
    if (targetKind === "summary" && plan.kind !== "skip" && plan.kind !== "week-title") {
      return { ...plan, kind: "summary" as const, sessionId: null };
    }
    return plan;
  });
  // Readings added inside a folder go into it; the links that are new afterwards are this drop's.
  const before = folderId ? new Set((await db.week_items.where("week_id").equals(week.id).toArray()).map((l) => l.id)) : null;
  const count = await applyPlans(module, plans);
  if (!count) return;
  if (folderId && before) {
    const added = (await db.week_items.where("week_id").equals(week.id).toArray()).filter((l) => !before.has(l.id) && !l.deleted && !l.session_id);
    for (const link of added) await moveToFolder(link, folderId);
  }
  // A session keeps one deck, so a drop on it is told as slides added or
  // replaced rather than as a count of files that may have replaced each other.
  if (effectiveTarget?.kind === "slides" && effectiveTarget.sessionId) {
    showToast(`Slides ${replacing ? "replaced" : "added"} for ${effectiveTarget.label}. Uploading now.`);
  } else {
    showToast(`${count} ${count === 1 ? "file" : "files"} added to ${weekCode(week)}${effectiveTarget?.kind === "slides" ? `, ${effectiveTarget.label}` : ""}. Uploading now.`);
  }
}

function targetOf(element: Element | null, week: WeekRow, isDocumentOnly?: boolean): FileTarget {
  if (isDocumentOnly) return { kind: "summary", label: "documents" };
  const zone = element?.closest("[data-drop]") as HTMLElement | null;
  if (zone?.dataset.drop === "slides") return { kind: "slides", sessionId: zone.dataset.session, label: zone.dataset.label ?? "slides" };
  if (zone?.dataset.drop === "primary") return { kind: "primary", label: KIND_GROUP.primary.toLowerCase() };
  if (zone?.dataset.drop === "summary") return { kind: "summary", label: KIND_GROUP.summary.toLowerCase() };
  if (zone?.dataset.drop === "readings") return { kind: "secondary", label: KIND_GROUP.secondary.toLowerCase() };
  return { kind: "auto", label: weekCode(week) };
}

const KINDS = SESSION_KINDS;
const NO_SESSIONS: SessionView[] = [];
const NO_FOLDERS: FolderRow[] = [];
const NoteEditor = lazy(() => import("./NoteEditor"));

function SectionNotes({ weekId, code }: { weekId: string; code: string }) {
  const target = useMemo(() => ({ week_id: weekId }), [weekId]);
  return (
    <section id="section-notes" className="section section-notes">
      <h2 className="group-label">Notes</h2>
      <Suspense fallback={<NotesLoading />}>
        <NoteEditor target={target} label={`Notes on ${code}`} placeholder="Notes on this section" />
      </Suspense>
    </section>
  );
}

// How much of a session's notes a card shows; the card clamps it to four lines.
const PREVIEW_CHARS = 360;

function notePreview(notes: NoteView[], limit: number): string {
  const texts = notes
    .flatMap((n) => n.blocks)
    .map(blockText)
    .map((t) => t.trim())
    .filter(Boolean);
  return texts.join(" ").slice(0, limit);
}

// The card that morphs into the session page is the one last opened from
// here, so the way back lands on the same card. A plain variable is enough:
// it is read when the week page renders and written as a card is opened.
let morphSessionId: string | null = null;
const MORPH_NAME = "session-notes";

// A session's card, which a mouse or a pen can drag from anywhere that is not
// a control and a finger from its "#" handle, once the week has two or more.
function WeekSessionCard({
  view, count, morph, dropOver, onAddSlides, onStep,
}: {
  view: SessionView; count: number; morph: boolean; dropOver: boolean; onAddSlides: (sessionId: string) => void; onStep: (direction: -1 | 1) => void;
}) {
  const { session, slides, recordings, notes } = view;
  const [renaming, setRenaming] = useState(false);
  const movable = count > 1;
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: session.id, disabled: !movable });
  const kindLabel = sessionLabel(session.kind);
  const label = session.title || kindLabel;
  const preview = notePreview(notes, PREVIEW_CHARS);
  const materials = sessionMaterials(session.kind, { slides: slides.length, recordings: recordings.length });
  const shownRecordings = recordings.slice(0, 2);

  const head = (
    <span className="wsc-head">
      <span className={`wsc-badge ${session.kind}`}>{kindLabel}</span>
      {session.title && <span className="wsc-title">{session.title}</span>}
    </span>
  );
  const body = preview
    ? <span className="wsc-preview">{preview}</span>
    : <span className="wsc-prompt"><Icon name="notes" size={15} /><span>{`Start your ${kindLabel.toLowerCase()} notes`}</span></span>;

  return (
    <article
      ref={setNodeRef}
      {...(listeners as React.HTMLAttributes<HTMLElement> | undefined)}
      className={`week-session-card${preview ? "" : " empty"}${dropOver ? " drop-over" : ""}${movable ? " movable" : ""}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition, ...(morph ? { viewTransitionName: MORPH_NAME } : {}) }}
      // Any session takes dropped slides, and a session that has some
      // already has them replaced by the new deck.
      data-drop="slides"
      data-session={session.id}
      data-label={label}
      // Capture runs before the link navigates, so the name is on this card
      // when the browser takes its picture of the old page.
      onClickCapture={(e) => {
        if (!(e.target as Element).closest("a")) return;
        morphSessionId = session.id;
        e.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".week-session-card").forEach((card) => { card.style.viewTransitionName = ""; });
        e.currentTarget.style.viewTransitionName = MORPH_NAME;
      }}
    >
      {renaming ? (
        <div className="wsc-body">
          <TitleEdit
            level={2}
            value={session.title ?? ""}
            label="Session name"
            placeholder={kindLabel}
            onSave={(next) => {
              setRenaming(false);
              if (next.trim() !== (session.title ?? "")) void update("sessions", session.id, { title: next.trim() || null });
            }}
            onCancel={() => setRenaming(false)}
          />
          {body}
        </div>
      ) : (
        <Link to={{ view: "session", id: session.id }} className="wsc-body" title={`Open ${label}`}>
          {head}
          {body}
        </Link>
      )}

      {materials.length > 0 && (
        <div className="wsc-meta">
          {materials.map((m) => {
            if (m.kind === "slides") return (
              <span key="slides" className="wsc-chip" title={`${m.count} slide deck${m.count === 1 ? "" : "s"}`}>
                <Icon name="slides" size={14} />
                <span>{m.count === 1 ? (slides[0]?.item.title || "Slides") : `${m.count} slide decks`}</span>
              </span>
            );
            if (m.kind === "add-slides") return (
              <button key="add-slides" type="button" className="wsc-add-chip" onClick={() => onAddSlides(session.id)} title="Add slides (PDF or PowerPoint)">
                <Icon name="add" size={13} />
                <span>Add slides</span>
              </button>
            );
            return [
              ...shownRecordings.map((r) => (
                <Link key={r.id} to={{ view: "session", id: session.id }} className="wsc-chip" title="Open the recording">
                  <Icon name="play" size={13} />
                  <span>{recordingLine(r)}</span>
                </Link>
              )),
              m.count > shownRecordings.length && <span key="more-recordings" className="wsc-chip">{`${m.count - shownRecordings.length} more`}</span>,
            ];
          })}
        </div>
      )}

      {/* The handle stands beside the card's link rather than inside its
          heading, since a button inside a link would open the session on a tap. */}
      {movable && (
        <div className="wsc-drag">
          <button
            type="button"
            className="drag-handle"
            data-drag-handle
            aria-label={`Drag ${label} to reorder`}
            {...dragHandleProps(onStep)}
          >
            <Icon name="reorder" size={16} />
          </button>
        </div>
      )}

      <div className="wsc-menu">
        <Menu
          label={`More actions for ${label}`}
          items={[
            { label: "Rename", onSelect: () => setRenaming(true) },
            ...KINDS.filter((k) => k.value !== session.kind && session.kind !== "supervision").map((k) => ({
              label: `Make this a ${k.label.toLowerCase()}`,
              onSelect: () => void update("sessions", session.id, { kind: k.value }),
            })),
            { label: "Delete session", onSelect: () => void deleteSessionAsking(session, label), danger: true },
          ]}
        />
      </div>
    </article>
  );
}

/** The week's blank row for a new session: pressing it offers a seminar or a lecture, as the week asks for both. */
function SessionAddRow({ empty, onAdd }: { empty: boolean; onAdd: (kind: "seminar" | "lecture") => void }) {
  const [choosing, setChoosing] = useState(false);
  if (choosing) {
    return (
      <div className="week-add-row row session-add-choice" role="group" aria-label="Add a session to this week" style={{ gap: "0.5rem" }}>
        <button type="button" className="button" autoFocus onClick={() => { setChoosing(false); onAdd("seminar"); }}>Seminar</button>
        <button type="button" className="button" onClick={() => { setChoosing(false); onAdd("lecture"); }}>Lecture</button>
        <button type="button" className="quiet" onClick={() => setChoosing(false)}>Cancel</button>
      </div>
    );
  }
  return (
    <AddTile
      as="div"
      variant="row"
      label={empty ? "No sessions yet. Add a seminar or lecture" : "New session"}
      announce="Add a session to this week"
      onAdd={() => setChoosing(true)}
    />
  );
}

export function WeekPage({ id, folder: folderId }: { id: string; folder?: string }) {
  const data = useSuspendingLiveQuery(() => loadWeekPage(id), ["week-page", id]);
  // A Library shelf's folders (lib/folders.ts), and the open one when the route names it.
  const folders = useLiveQuery(() => shelfFolders(id), [id]) ?? NO_FOLDERS;
  const weeks = useLiveQuery(async () => {
    if (!data) return [];
    return (await db.weeks.where("module_id").equals(data.module.id).toArray()).filter((w) => !w.deleted);
  }, [data?.module.id]);
  const [over, setOver] = useState<FileTarget | null>(null);
  const [renaming, setRenaming] = useState(false);
  const addTargetRef = useRef<FileTarget | undefined>(undefined);
  const picker = useRef<HTMLInputElement>(null);
  const coverPicker = useRef<HTMLInputElement>(null);
  const sessionPicker = useRef<HTMLInputElement>(null);
  const prefetched = useRef<string | null>(null);
  const sensors = useDragSensors();
  // The sessions in their own order, running ahead of the database for the
  // moment after a drop so that a card does not jump back before it lands.
  const [sessions, setSessionOrder] = useOptimisticOrder(data?.view.sessions ?? NO_SESSIONS, (s) => s.session.id, data);

  const onPickCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !data) return;
    try {
      const key = await uploadModulePicture(file, isLibrary(data.module) ? 2 / 3 : undefined);
      await update("weeks", data.view.week.id, { image_key: key });
      showToast("Cover picture set.");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not upload cover picture.");
    }
  };

  const onRemoveCover = async () => {
    if (!data) return;
    await update("weeks", data.view.week.id, { image_key: null });
    showToast("Cover picture removed.");
  };

  useEffect(() => {
    if (!data) return;
    if (data.module.last_opened_week_id !== id) void update("modules", data.module.id, { last_opened_week_id: id });
    if (prefetched.current === id) return;
    prefetched.current = id;
    void (async () => {
      const ids = [data.view.week.id, data.next?.id].filter(Boolean) as string[];
      const links = (await db.week_items.where("week_id").anyOf(ids).toArray()).filter((l) => !l.deleted);
      const items = (await db.items.bulkGet(links.map((l) => l.item_id))).filter(Boolean);
      const files = (await db.files.bulkGet(items.map((i) => i!.file_id).filter(Boolean) as string[])).filter(Boolean) as FileRow[];
      // Large books open from the server a piece at a time, so they are not
      // fetched whole in the background just because their week was opened.
      await prefetch(files, PREFETCH_MAX_BYTES);
    })();
  }, [data, id]);

  useTitle(data ? `${data.module.code} ${weekCode(data.view.week)}` : undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "[" && data?.previous) navigate({ view: "week", id: data.previous.id });
      if (e.key === "]" && data?.next) navigate({ view: "week", id: data.next.id });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [data?.previous, data?.next]);

  // On a phone, swipe left for the next week and right for the one before,
  // as the links at the foot of the page do.
  const nextId = data?.next?.id, previousId = data?.previous?.id;
  const goNext = useCallback(() => { if (nextId) navigate({ view: "week", id: nextId }); }, [nextId]);
  const goPrevious = useCallback(() => { if (previousId) navigate({ view: "week", id: previousId }); }, [previousId]);
  useSwipe(nextId ? goNext : null, previousId ? goPrevious : null);

  if (data === null) return <div className="page"><p className="muted">This week no longer exists.</p></div>;
  const { module, view } = data;
  const section = isSection(view.week);
  const week = view.week;
  const hasSectionNotes = (data.sectionNotes ?? []).some((n) => n.blocks.some((b) => blockText(b).trim()));
  const isDocumentOnly = isSyllabus(week) || isLibrary(module);
  // On a Library shelf, folders sit at the front and the readings in them are
  // shown only inside them; everything else stays loose on the shelf.
  const library = isLibrary(module);
  const openFolder = library && folderId ? folders.find((f) => f.id === folderId) ?? null : null;
  const here = (views: ReadingView[]) =>
    library ? views.filter((v) => linksAt([{ folder_id: v.link?.folder_id ?? null }], folders, openFolder?.id ?? null).length > 0) : views;
  const viewsIn = (fid: string) => [...view.primaries, ...view.readings, ...view.summaries].filter((v) => v.link?.folder_id === fid);

  // Sessions keep their own order. The card last opened from here, or else
  // the first, is the one that morphs into its session page.
  const morphId = sessions.some((s) => s.session.id === morphSessionId) ? morphSessionId : sessions[0]?.session.id ?? null;
  const showMain = moduleHasNotes(module) && (view.sessions.length > 0 || section || moduleHasSessions(module));
  const sessionIds = sessions.map((s) => s.session.id);
  const saveSessionOrder = (next: string[] | null) => {
    if (!next) return;
    setSessionOrder(next);
    reorderSessions(week.id, next).catch((error: unknown) => {
      setSessionOrder(null);
      showToast(`The new order could not be saved. ${(error as Error).message || "Try again in a moment."}`);
    });
  };
  const onSessionDragEnd = (event: DragEndEvent) => {
    swallowClickAfterDrag();
    saveSessionOrder(droppedOrder(sessionIds, String(event.active.id), event.over ? String(event.over.id) : null));
  };
  const pickSlides = (sessionId: string) => {
    if (sessionPicker.current) {
      sessionPicker.current.dataset.session = sessionId;
      sessionPicker.current.click();
    }
  };

  async function toggleReadingWeek() {
    const { kept } = await setReadingWeek(week, module, !week.is_reading_week);
    if (kept) showToast(`Marked as a reading week. ${kept === 1 ? "One session" : `${kept} sessions`} with notes or recordings stayed.`);
  }

  const onDrop = (event: React.DragEvent) => {
    setOver(null);
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void addFiles(Array.from(event.dataTransfer.files), module, week, targetOf(event.target as Element, week, isDocumentOnly), openFolder?.id ?? null);
  };
  const overText = over
    ? isDocumentOnly
      ? `Drop to add documents to ${weekCode(week)}${titleAfter(week, ", ")}`
      : over.kind === "slides"
        ? view.sessions.some((s) => s.session.id === over.sessionId && s.slides.length > 0)
          ? `Drop to replace the slides in ${over.label}`
          : `Drop to add slides to ${over.label}`
        : over.kind === "primary"
          ? `Drop to add primary readings to ${weekCode(week)}`
          : over.kind === "secondary"
            ? `Drop to add secondary readings to ${weekCode(week)}${titleAfter(week, ", ")}`
            : over.kind === "summary"
              ? `Drop to add summaries to ${weekCode(week)}`
              : `Drop to add files to ${weekCode(week)}${titleAfter(week, ", ")}`
    : null;

  const handleDownloadArchive = async () => {
    try {
      showToast("Preparing archive…");
      await downloadWeekArchive(module, week, (status) => showToast(status));
      showToast("Archive downloaded.");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not create archive.");
    }
  };

  return (
    <FolderContext.Provider value={library ? { folders, current: openFolder?.id ?? null, weekId: week.id } : null}>
    <div
      className={`page wide week-page dropzone${over ? " over" : ""}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        const next = targetOf(e.target as Element, week, isDocumentOnly);
        if (next.kind !== over?.kind || next.sessionId !== over?.sessionId) setOver(next);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
      onDrop={onDrop}
    >
      {overText && <div className="drop-banner" role="status">{overText}</div>}
      {/* The tab and Back already say where the week sits, so the line above the
          title keeps only when it runs and the way to the weeks either side. */}
      <div className="week-crumbs page-topline">
        <WeekWhen week={week} />
        <nav className="week-nav week-nav-top" aria-label="Other weeks">
          {data.previous ? (
            <Link
              to={{ view: "week", id: data.previous.id }}
              className="week-nav-btn prev"
              title={section ? "Previous section (press [)" : "Previous week (press [)"}
            >
              <span className="nav-dir back" aria-hidden="true"><Icon name="down" size={14} /></span>
              <span>{weekCode(data.previous)}</span>
            </Link>
          ) : (
            <span className="week-nav-btn disabled" aria-hidden="true">
              <span className="nav-dir back"><Icon name="down" size={14} /></span>
            </span>
          )}
          {data.next ? (
            <Link
              to={{ view: "week", id: data.next.id }}
              className="week-nav-btn next"
              title={section ? "Next section (press ])" : "Next week (press ])"}
            >
              <span>{weekCode(data.next)}</span>
              <span className="nav-dir next" aria-hidden="true"><Icon name="down" size={14} /></span>
            </Link>
          ) : (
            <span className="week-nav-btn disabled" aria-hidden="true">
              <span className="nav-dir next"><Icon name="down" size={14} /></span>
            </span>
          )}
        </nav>
      </div>
      <div className="section-head" style={{ marginBottom: 0, alignItems: "center" }}>
        {/* The week's own actions sit beside its title, which they act upon,
            and the buttons for adding to the week stay at the far end. */}
        {openFolder ? (
          <FolderHeader folder={openFolder} week={week} shelfTitle={week.title || weekCode(week)} />
        ) : (
        <div className="page-title-group">
            <TitleEditor week={week} editing={renaming} setEditing={setRenaming} />
            {section ? (
              <Menu
                label={isLibrary(module) ? "More actions for this shelf" : "More actions for this section"}
                items={[
                  { label: isLibrary(module) ? "Rename shelf" : "Rename section", onSelect: () => setRenaming(true) },
                  { label: "Set cover picture", onSelect: () => coverPicker.current?.click() },
                  { label: "Remove cover picture", onSelect: onRemoveCover, hidden: !week.image_key },
                  { label: isLibrary(module) ? "Download all shelf content" : "Download all section content", onSelect: () => void handleDownloadArchive() },
                  { label: isLibrary(module) ? "Delete shelf" : "Delete section", danger: true, onSelect: async () => { await deleteSection(week, module.id); navigate({ view: "module", id: module.id }); } },
                ]}
              />
            ) : (
              <Menu
                label="More actions for this week"
                items={[
                  { label: week.title ? "Rename week" : "Give the week a title", onSelect: () => setRenaming(true) },
                  { label: week.is_reading_week ? "Make this a teaching week" : "Make this a reading week", onSelect: () => void toggleReadingWeek() },
                  { label: "Set cover picture", onSelect: () => coverPicker.current?.click() },
                  { label: "Remove cover picture", onSelect: onRemoveCover, hidden: !week.image_key },
                  ...(moduleHasSessions(module) ? KINDS.map((k) => ({ label: `Add a ${k.label.toLowerCase()}`, onSelect: () => void addSession(week, k.value) })) : []),
                  { label: "Download all week content", onSelect: () => void handleDownloadArchive() },
                  { label: "Clear the week title", onSelect: () => void update("weeks", week.id, { title: null }), hidden: !week.title },
                ]}
              />
            )}
          </div>
        )}
        {isDocumentOnly ? (
          <button
            className="button primary"
            onClick={() => {
              addTargetRef.current = { kind: "summary", label: "documents" };
              picker.current?.click();
            }}
          >
            Add document
          </button>
        ) : (
          // Each reading group has its own Add button, so this one takes the
          // files as their names say rather than asking what they are first.
          <button
            className="button primary"
            onClick={() => {
              addTargetRef.current = undefined;
              picker.current?.click();
            }}
          >
            Add files
          </button>
        )}
        {section && moduleHasMeetings(module) && (
          <button className="button" onClick={async () => navigate({ view: "session", id: await addMeeting(week.id) })}>Add a meeting</button>
        )}
        <input ref={coverPicker} type="file" hidden accept="image/*" onChange={onPickCover} />
        <input
          ref={picker} type="file" multiple hidden accept={READING_ACCEPT}
          onChange={(e) => {
            const target = addTargetRef.current;
            addTargetRef.current = undefined;
            if (e.target.files) void addFiles(Array.from(e.target.files), module, week, target, openFolder?.id ?? null);
            e.target.value = "";
          }}
        />
      </div>

      {section && moduleHasNotes(module) && (
        <div className="week-notes-bar" role="navigation" aria-label="Notes">
          <a href="#section-notes" className={`button week-note-btn${hasSectionNotes ? " has-notes" : " empty"}`}>
            <Icon name="notes" size={16} />
            <span>{hasSectionNotes ? "Section notes" : "Add section notes"}</span>
          </a>
        </div>
      )}

      {/* Two columns: the notes and sessions on the left, the readings beside them on the right. */}
      <div className={`week-layout${showMain ? "" : " readings-only"}`}>
        {showMain && (
          <div className="week-main-col">
            {(view.sessions.length > 0 || (!section && moduleHasSessions(module))) && (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onSessionDragEnd} onDragCancel={swallowClickAfterDrag}>
              <div className="week-sessions">
                <SortableContext items={sessionIds} strategy={verticalListSortingStrategy}>
                  {sessions.map((sessionView) => (
                    <WeekSessionCard
                      key={sessionView.session.id}
                      view={sessionView}
                      count={sessions.length}
                      morph={sessionView.session.id === morphId}
                      dropOver={over?.kind === "slides" && over.sessionId === sessionView.session.id}
                      onAddSlides={pickSlides}
                      onStep={(direction) => saveSessionOrder(steppedOrder(sessionIds, sessionView.session.id, direction))}
                    />
                  ))}
                </SortableContext>
                {/* A week starts as a blank slate, offering both kinds of session in
                    one click. With one session, a quiet row offers another, and once
                    there are two the week's menu adds any more. */}
                {/* Sessions are added from a blank row at the end, which offers each kind (AddTile.tsx). */}
                {!section && moduleHasSessions(module) && (
                  <SessionAddRow
                    empty={view.sessions.length === 0}
                    onAdd={(kind) => void addSession(week, kind)}
                  />
                )}
              </div>
              </DndContext>
            )}
            {/* A section's own notes: a chapter's plan, an argument, what to find. */}
            {section && <SectionNotes weekId={week.id} code={weekCode(week)} />}
          </div>
        )}

        {/* Each group lights up for a drop of its own; the whole board only for files whose names decide. */}
        <aside className="week-readings-col" style={{ viewTransitionName: "session-side" }}>
          <div data-drop="readings" className={over?.kind === "auto" ? "drop-over-lists" : undefined}>
            <WeekBoard
              week={week}
              primaries={here(view.primaries)}
              readings={here(view.readings)}
              summaries={here(view.summaries)}
              folders={library && !openFolder ? folders : undefined}
              folderViews={library && !openFolder ? viewsIn : undefined}
              weeks={weeks ?? []}
              moduleId={module.id}
              isLibrary={isLibrary(module)}
              isSyllabus={isSyllabus(week)}
              dropKind={over?.kind ?? null}
              onAddTo={isDocumentOnly ? undefined : (kind) => {
                addTargetRef.current = { kind, label: KIND_GROUP[kind].toLowerCase() };
                picker.current?.click();
              }}
            />
            {isDocumentOnly && over && !view.readings.length && !view.primaries.length && !view.summaries?.length && (
              <div className="section"><div className="readings empty-target file-target">{`Documents for ${weekCode(week)}`}</div></div>
            )}
          </div>
        </aside>
      </div>

      <input
        ref={sessionPicker} type="file" multiple hidden accept={SLIDES_ACCEPT}
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          const sessionId = e.target.dataset.session ?? null;
          e.target.value = "";
          if (!sessionId) return;
          try {
            const added = await addSlides(sessionId, files);
            // The card offers this only to a session without slides.
            if (added) showToast("Slides added.");
          } catch (error) {
            showToast(`The slides could not be added. ${(error as Error).message || "Try again in a moment."}`);
          }
        }}
      />
    </div>
    </FolderContext.Provider>
  );
}
