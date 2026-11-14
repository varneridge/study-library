import { navigate } from "../lib/router";
import { shortDate } from "../lib/dates";
import { deleteSection } from "../lib/edits";
import { moveSection, addSection, isDissertation, isLibrary, moduleHasSessions, saveKeyDates, countdown, coverLabel, type CoverVariant } from "../lib/sections";

import { Menu } from "./Menu";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { fullTitle } from "../lib/titles";
import { applySuggestion, keepMine, viaLabel } from "../lib/citations";
import { update, newId } from "../lib/sync";
import { db } from "../lib/db";
import { applyPlans, planFile } from "../lib/importing";
import { showToast, useCloseOnBack, useTitle } from "../lib/ui";
import type { ReadingView, WeekOverview } from "../lib/library";
import type { ModuleRow, WeekRow } from "../lib/types";
import { useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { Link } from "../App";
import { loadModuleOverview } from "../lib/library";
import { sessionLabel, weekCode, isSection } from "../lib/modules";
import { BlockView } from "./BlockView";
import { uploadModulePicture } from "../lib/uploads";
import { downloadWeekArchive } from "../lib/weekArchive";
import { MoveSelect, ReadingRow } from "./ReadingRow";
import { ModuleSettings } from "./ModuleSettings";
import { Icon } from "./icons";
import { setSetting, useSetting } from "../lib/settings";
import { DatePicker } from "./DatePicker";
import { AssessmentCard } from "./AssessmentPage";
import {
  addModuleEssay,
  assessmentSettingKey,
  enableModuleAssessment,
  isAssessmentEnabled,
  useModuleEssays,
} from "../lib/assessment";


function formatReadingCount(counts: { read: number; total: number }): string | null {
  const { read, total } = counts;
  if (total === 0) return null;
  if (read === 0) return `${total} ${total === 1 ? "reading" : "readings"}`;
  if (read === total) return `all ${total} read`;
  return `${read} of ${total} read`;
}

// Details found in PDFs, all in one place: tick the ones to use.
function CitationReview({ views, onClose }: { views: ReadingView[]; onClose: () => void }) {
  useCloseOnBack(true, onClose);
  const ref = useRef<HTMLDialogElement>(null);
  const [chosen, setChosen] = useState(() => new Set(views.map((v) => v.item.id)));
  useEffect(() => { ref.current?.showModal(); }, []);
  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    setChosen(next);
  };
  return (
    <dialog ref={ref} className="dialog review-citations" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2>Check the details found</h2>
      <p className="small muted">Study Library read these PDFs and found fuller details. Untick any you would rather keep as they are.</p>
      <ul className="citation-list">
        {views.map(({ item }) => (
          <li key={item.id}>
            <label>
              <input type="checkbox" checked={chosen.has(item.id)} onChange={() => toggle(item.id)} />
              <span>
                <span className="was">{fullTitle(item)}</span>
                <span className="now">{fullTitle({ ...item, ...item.suggested! })}</span>
                <span className="via small muted">Found {viaLabel(item.suggested!.via)}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="quiet" onClick={async () => { for (const v of views) await keepMine(v.item); onClose(); }}>Keep all as they are</button>
        <button className="button primary" disabled={!chosen.size} onClick={async () => {
          for (const v of views) {
            if (chosen.has(v.item.id)) await applySuggestion(v.item, true);
            else await keepMine(v.item);
          }
          showToast(`${chosen.size} ${chosen.size === 1 ? "reading" : "readings"} updated.`);
          onClose();
        }}>Use {chosen.size} of {views.length}</button>
      </div>
    </dialog>
  );
}

async function addFilesTo(files: File[], module: ModuleRow, week: WeekRow) {
  const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
  const count = await applyPlans(module, files.map((file) => planFile(file, weeks, week)));
  if (count) showToast(`${count} ${count === 1 ? "file" : "files"} added to ${weekCode(week)}. Uploading now.`);
}

function TraySection({ tray, weeks }: { tray: ReadingView[]; weeks: WeekRow[] }) {
  return (
    <div className="section tray" style={{ marginTop: "2.5rem", marginBottom: "2rem" }}>
      <div className="section-head"><h2>Unsorted</h2></div>
      <ul className="readings">
        {tray.map((r) => (
          <ReadingRow key={r.item.id} view={r} weeks={weeks} extra={<MoveSelect view={r} weeks={weeks} label="Choose a week" />} />
        ))}
      </ul>
    </div>
  );
}

function WeekCoverImage({

  thumbKey,
  title,
  code,
  isSec,
  isShelf,
  weekNumber,
  covers,
}: {
  thumbKey: string | null;
  covers?: string[];
  title?: string | null;
  code: string;
  isSec: boolean;
  isShelf?: boolean;
  weekNumber: number;
}) {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const failed = thumbKey !== null && failedKey === thumbKey;
  const [failedCovers, setFailedCovers] = useState<string[]>([]);
  const shown = (covers ?? []).filter((key) => !failedCovers.includes(key));

  if ((!thumbKey || failed) && shown.length) {
    return (
      <div className="shelf-covers">
        {/* One cover, whole; the next takes its place if it cannot be shown. */}
        {shown.slice(0, 1).map((key) => (
          <img
            key={key}
            src={`/api/objects/${key}`}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailedCovers((was) => [...was, key])}
          />
        ))}
      </div>
    );
  }

  if (!thumbKey || failed) {
    const label = coverLabel(
      { title, code, number: weekNumber },
      isShelf ? "shelf" : isSec ? "section" : "week",
    );
    return (
      <div className="week-card-cover-fallback">
        <span className="week-card-cover-display" title={label}>{label}</span>
      </div>
    );
  }
  return (
    <img
      src={`/api/objects/${thumbKey}`}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailedKey(thumbKey)}
    />
  );
}


function WeekCard({
  overview,
  module,
  dates,
  renaming,
  onStartRename,
  onEndRename,
}: {
  overview: WeekOverview;
  module: ModuleRow;
  dates: ReturnType<typeof useTermDates>;
  renaming: boolean;
  onStartRename: () => void;
  onEndRename: () => void;
}) {
  const { week, readingCount, thumb_key, thumb_keys, sessions, isCurrentWeek } = overview;
  const [fileOver, setFileOver] = useState(false);
  const coverPickerRef = useRef<HTMLInputElement>(null);
  const summary = formatReadingCount(readingCount);
  const isSec = isSection(week);
  const isShelf = isLibrary(module);
  const code = weekCode(week);


  const onPickCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      // A shelf's picture is cut to the shelf's own upright shape.
      const key = await uploadModulePicture(file, isShelf ? 2 / 3 : undefined);
      await update("weeks", week.id, { image_key: key });
      showToast("Cover picture set.");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not upload cover picture.");
    }
  };

  const onRemoveCover = async () => {
    await update("weeks", week.id, { image_key: null });
    showToast("Cover picture removed.");
  };

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
    <article
      id={`week-${code}`}
      data-drop-week={week.id}
      className={`week-card week${isShelf ? " is-shelf is-library" : ""}${isCurrentWeek ? " this-week" : ""}${fileOver ? " drop-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          setFileOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setFileOver(false);
      }}
      onDrop={(e) => {
        setFileOver(false);
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        void addFilesTo(Array.from(e.dataTransfer.files), module, week);
      }}
    >
      <Link
        to={{ view: "week", id: week.id }}
        className="week-card-cover week-card-cover-link"
        tabIndex={-1}
        ariaHidden={true}
      >
        <WeekCoverImage
          thumbKey={thumb_key}
          title={week.title}
          code={code}
          isSec={isSec}
          isShelf={isShelf}
          weekNumber={week.number}
          covers={thumb_keys}
        />

      </Link>
      {isCurrentWeek && <span className="this-week-tag this-week-pill">This week</span>}
      <div className="week-card-actions">
        <Menu
          label={`More actions for ${code}`}
          items={isSec ? [
            { label: isLibrary(module) ? "Rename shelf" : "Rename", onSelect: onStartRename },
            { label: "Set cover picture", onSelect: () => coverPickerRef.current?.click() },
            { label: "Remove cover picture", onSelect: onRemoveCover, hidden: !week.image_key },
            { label: "Move up", onSelect: () => void moveSection(week, -1).then((ok) => { if (!ok) showToast(isLibrary(module) ? "Already the first shelf." : "Already the first section."); }) },
            { label: "Move down", onSelect: () => void moveSection(week, 1).then((ok) => { if (!ok) showToast(isLibrary(module) ? "Already the last shelf." : "Already the last section."); }) },
            { label: isLibrary(module) ? "Download all shelf content" : "Download all section content", onSelect: () => void handleDownloadArchive() },
            { label: isLibrary(module) ? "Delete shelf" : "Delete section", danger: true, onSelect: () => void deleteSection(week, module.id) },
          ] : [
            { label: "Set cover picture", onSelect: () => coverPickerRef.current?.click() },
            { label: "Remove cover picture", onSelect: onRemoveCover, hidden: !week.image_key },
            { label: "Download all week content", onSelect: () => void handleDownloadArchive() },
          ]}
        />
      </div>
      <input ref={coverPickerRef} type="file" hidden accept="image/*" onChange={onPickCover} />

      <div className="week-card-body">
        <div className="week-card-meta">
          <span className="week-code week-card-code">{code}</span>
          {!isSec && (
            <span className="week-card-dates">{weekDatesText(week.term, week.number, dates)}</span>
          )}
        </div>

        {renaming ? (
          <input
            className="title-input section-name"
            type="text"
            defaultValue={week.title ?? ""}
            autoFocus
            placeholder={isLibrary(module) ? `Shelf ${week.number}` : `Section ${week.number}`}
            aria-label="Section name"
            enterKeyHint="done"
            onBlur={(e) => {
              onEndRename();
              void update("weeks", week.id, { title: e.target.value.trim() || null });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") onEndRename();
            }}
          />
        ) : (
          <Link to={{ view: "week", id: week.id }} className="week-title week-card-title-link">
            {isSec ? (
              week.title || (isLibrary(module) ? `Shelf ${week.number}` : `Section ${week.number}`)
            ) : (
              week.title || (week.is_reading_week ? <span className="reading-weeks week-card-title-reading-week">Reading week</span> : code)
            )}
          </Link>
        )}

        {!week.is_reading_week && moduleHasSessions(module) && sessions.length > 0 && (
          <div className="week-card-sessions week-head">
            {sessions.map(({ session, hasNotes }) => (
              <Link
                key={session.id}
                to={{ view: "session", id: session.id }}
                className={`session-link week-card-session-link${hasNotes ? " has-notes" : ""}`}
                title={`Notes for the ${(session.title || sessionLabel(session.kind)).toLowerCase()}`}
              >
                {session.title || sessionLabel(session.kind)}
              </Link>
            ))}
          </div>
        )}
        {week.is_reading_week && (
          <div className="week-card-sessions reading-week-placeholder">
            <span className="reading-weeks">Independent study</span>
          </div>
        )}

        {summary && (
          <div className="week-card-footer">
            <span className="count week-card-count">{summary}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function KeyDates({ module }: { module: ModuleRow }) {
  const dates = module.key_dates ?? [];
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState("");
  const [date, setDate] = useState("");
  const add = async () => {
    if (saving || !label.trim() || !date) return;
    setSaving(true);
    try {
      await saveKeyDates(module, [...dates, { id: newId(), label: label.trim(), date }]);
      setLabel(""); setDate(""); setAdding(false);
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="key-dates section" aria-label="Key dates">
      <div className="section-head">
        <h2>Key dates</h2>
        <span className="spacer" />
        {!adding && <button className="quiet" onClick={() => setAdding(true)}>Add a date</button>}
      </div>
      {dates.length === 0 && !adding && <p className="small muted">The proposal, chapter drafts, the submission. Each counts down on the This week page.</p>}
      <ul className="key-date-list">
        {dates.map((d) => (
          <li key={d.id}>
            <span className="kd-label">{d.label}</span>
            <span className={`kd-when ${countdown(d.date).state}`}>{shortDate(new Date(`${d.date}T00:00:00`), { year: true })}, {countdown(d.date).words}</span>
            <button className="quiet small" aria-label={`Remove ${d.label}`} onClick={() => void saveKeyDates(module, dates.filter((x) => x.id !== d.id))}>Remove</button>
          </li>
        ))}
      </ul>
      {adding && (
        <div className="row key-date-add">
          <label className="field" style={{ flex: 1 }}><span>What</span>
            <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Chapter 2 draft" autoFocus enterKeyHint="next" />
          </label>
          <div className="field"><span>When</span>
            <DatePicker value={date || null} onChange={(d) => setDate(d || "")} label="Key date" placeholder="Choose date" title={label.trim() ? `Date for ${label.trim()}` : "Date for this key date"} hint="It counts down on the home page." />
          </div>
          <button className="button primary" disabled={saving || !label.trim() || !date} onClick={() => void add()}>{saving ? "Adding…" : "Add"}</button>
          <button className="quiet" disabled={saving} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      )}
    </section>
  );
}

export function ModulePage({ id }: { id: string }) {
  const now = useTeachingWeek();
  const dates = useTermDates();
  const data = useLiveQuery(() => loadModuleOverview(id, now), [id, now]);
  const isCollapsed = useSetting<boolean>(`collapse:admin:${id}`, false);
  const essays = useModuleEssays(id, data?.module.code);
  const assessmentRow = useLiveQuery(() => db.settings.get(assessmentSettingKey(id)), [id]);
  const hasAssessment = isAssessmentEnabled(assessmentRow) || essays.length > 0;
  const [forcedOpen, setForcedOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  const scrolledRef = useRef(false);
  useTitle(data?.module.code);


  useEffect(() => {
    if (data && !scrolledRef.current) {
      scrolledRef.current = true;
      const targetWeek =
        data.weeks.find((w) => w.isCurrentWeek)?.week ??
        (data.module.last_opened_week_id
          ? data.weeks.find((w) => w.week.id === data.module.last_opened_week_id)?.week
          : null);
      if (targetWeek) {
        const code = weekCode(targetWeek);
        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        setTimeout(() => {
          document.getElementById(`week-${code}`)?.scrollIntoView({
            behavior: reduce ? "auto" : "smooth",
            block: "nearest",
          });
        }, 80);
      }
    }
  }, [data]);

  useEffect(() => {
    if (!data) return;
    const isSaveData = (navigator as unknown as { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (typeof window !== "undefined" && navigator.onLine && !isSaveData && "caches" in window) {
      const keysToPrefetch = data.weeks
        .flatMap((w) => [w.thumb_key, ...w.thumb_keys])
        .filter((k): k is string => Boolean(k))
        .slice(0, 8);
      if (keysToPrefetch.length > 0) {
        void caches.open("study-pictures-v1").then((cache) => {
          for (const key of keysToPrefetch) {
            const url = `/api/objects/${key}`;
            void cache.match(url).then((hit) => {
              if (!hit) {
                void fetch(url).then((res) => {
                  if (res.ok) void cache.put(url, res.clone());
                }).catch(() => {});
              }
            });
          }
        });
      }
    }
  }, [data]);

  if (data === undefined) return null;
  if (data === null) return <div className="page"><p className="muted">This module no longer exists.</p></div>;

  const { module, weeks, tray, found, empty } = data;
  const dissertation = isDissertation(module);
  const library = isLibrary(module);
  const customSectionsOnly = dissertation || library;
  const customSections = weeks.filter((w) => w.week.term === "S");
  const termWeeks = weeks.filter((w) => w.week.term !== "S");
  const adminOpen = !isCollapsed || forcedOpen;
  // The page's main action, guarded so a double tap makes one section, not two.
  const addOneSection = async () => {
    if (addingSection) return;
    setAddingSection(true);
    try {
      const newWeekId = await addSection(module.id, library ? "New shelf" : null);
      navigate({ view: "week", id: newWeekId });
    } catch (error) {
      showToast(`The ${library ? "shelf" : "section"} could not be added. ${(error as Error).message || "Try again in a moment."}`);
    } finally {
      setAddingSection(false);
    }
  };
  const toggleAdmin = () => {
    if (adminOpen) {
      setForcedOpen(false);
      setRenamingId(null);
      void setSetting(`collapse:admin:${id}`, true);
    } else {
      setForcedOpen(false);
      void setSetting(`collapse:admin:${id}`, false);
    }
  };



  return (
    <div className="page wide">
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h1>{module.code}</h1>
        <span className="spacer" />
        {found.length > 0 && (
          <button className="found" onClick={() => setReviewing(true)}>
            Details found for {found.length} {found.length === 1 ? "reading" : "readings"}
          </button>
        )}
        <button className="quiet" aria-pressed={editing} onClick={() => setEditing(!editing)}>Edit module</button>
        {customSectionsOnly && (
          <button className="button primary" disabled={addingSection} onClick={() => void addOneSection()}>
            {library ? "Add a shelf" : "Add a section"}
          </button>
        )}
      </div>
      {module.title && <p className="lede">{module.title}</p>}
      {reviewing && found.length > 0 && <CitationReview views={found} onClose={() => setReviewing(false)} />}
      {editing && <ModuleSettings module={module} weeks={weeks.map((w) => w.week)} onClose={() => setEditing(false)} />}
      {module.description && module.description.length > 0 && (
        <details className="section" style={{ marginTop: "1rem" }}>
          <summary className="small muted">About this module</summary>
          <BlockView blocks={module.description} />
        </details>
      )}

      {dissertation && <KeyDates module={module} />}
      {empty && !customSectionsOnly && (
        <div className="first-steps">
          <p><strong>Add this module's readings.</strong> <span className="touch-hide">Drop a folder of files anywhere on this page, or on a single week below. </span>You can also open a week and choose Add files.</p>
          <p className="small muted">Files named like "(AT3) Author, 'Title'" go to their weeks by themselves. The rest wait in Unsorted.</p>
        </div>
      )}

      {/* The syllabus, admin and the assessment, each a card opened like a week. */}
      {!library && (
        <section className="section course-materials" style={{ marginTop: "1rem" }}>
          <div className="section-head" style={{ marginBottom: adminOpen ? "0.75rem" : 0 }}>
            <h2 style={{ margin: 0 }}>
              <button
                type="button"
                className="section-toggle"
                aria-expanded={adminOpen}
                aria-controls={`admin-grid-${module.id}`}
                onClick={toggleAdmin}
              >
                <Icon name={adminOpen ? "down" : "caret"} size={16} />
                <span>Course materials & assessments</span>
                <span className="toggle-count">({(customSectionsOnly ? 0 : customSections.length) + (essays.length > 0 ? essays.length : (hasAssessment ? 1 : 0))})</span>
              </button>
            </h2>
            <Menu
              label="Add to course materials"
              trigger={
                <>
                  <Icon name="plus" size={14} />
                  <span>Add</span>
                  <Icon name="caret" size={12} />
                </>
              }
              items={[
                {
                  label: "Admin",
                  onSelect: async () => {
                    await addSection(module.id, "Admin");
                    setForcedOpen(true);
                    void setSetting(`collapse:admin:${id}`, false);
                    showToast("Admin section added.");
                  },
                },
                {
                  label: "Essay",
                  onSelect: async () => {
                    await addModuleEssay(module.id, "Essay", module.code);
                    setForcedOpen(true);
                    void setSetting(`collapse:admin:${id}`, false);
                    showToast("Essay added.");
                  },
                },
              ]}
            />
          </div>
          <div id={`admin-grid-${module.id}`} className="week-grid" hidden={!adminOpen}>
            {!customSectionsOnly && customSections.map((ov) => (
              <WeekCard
                key={ov.week.id}
                overview={ov}
                module={module}
                dates={dates}
                renaming={renamingId === ov.week.id}
                onStartRename={() => setRenamingId(ov.week.id)}
                onEndRename={() => setRenamingId(null)}
              />
            ))}
            {essays.length > 0 ? (
              essays.map((essay) => (
                <AssessmentCard
                  key={essay.id}
                  module={module}
                  essayId={essay.id}
                  title={essay.title}
                  renaming={renamingId === essay.id}
                  onStartRename={() => setRenamingId(essay.id)}
                  onEndRename={() => setRenamingId(null)}
                />
              ))
            ) : hasAssessment ? (
              <AssessmentCard module={module} />
            ) : null}
          </div>
        </section>
      )}



      <div className="week-grid">
        {(customSectionsOnly ? weeks : termWeeks).map((ov) => (
          <WeekCard
            key={ov.week.id}
            overview={ov}
            module={module}
            dates={dates}
            renaming={renamingId === ov.week.id}
            onStartRename={() => setRenamingId(ov.week.id)}
            onEndRename={() => setRenamingId(null)}
          />
        ))}
      </div>

      {tray.length > 0 && <TraySection tray={tray} weeks={weeks.map((w) => w.week)} />}
    </div>
  );
}
