import { combinePhotos } from "../lib/photos";
// Files can be dropped anywhere in the app. Week and module pages decide
// for themselves where files land. Everywhere else, this takes over: on a
// session, recordings become its recording and slides become its slides;
// elsewhere a short sheet asks which module and week they belong to, with
// its best guess already chosen.

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useRef, useState } from "react";
import { db } from "../lib/db";
import { applyPlans, planFile } from "../lib/importing";
import { byPosition } from "../lib/keys";
import { byWeek, weekCode, titleAfter } from "../lib/modules";
import { parseTitle, stripExtension } from "../lib/parse";
import { navigate, type Route } from "../lib/router";
import { mimeFor } from "../lib/uploads";
import { showToast, useCloseOnBack } from "../lib/ui";
import type { ModuleRow, WeekRow } from "../lib/types";
import { addRecordingFile } from "./SessionPage";
import { importTranscript, isTranscriptFile } from "../lib/transcriptImport";

// Which module and week the current screen belongs to, if any.
async function placeOf(route: Route): Promise<{ moduleId: string | null; weekId: string | null; sessionId: string | null }> {
  const none = { moduleId: null, weekId: null, sessionId: null };
  if (route.view === "module" || route.view === "import") return { ...none, moduleId: route.id };
  let sessionId: string | null = null;
  let weekId: string | null = null;
  if (route.view === "session") sessionId = route.id;
  if (route.view === "question") sessionId = (await db.questions.get(route.id))?.session_id ?? null;
  if (route.view === "reader") {
    const link = (await db.week_items.where("item_id").equals(route.id).toArray()).find((l) => !l.deleted);
    weekId = link?.week_id ?? null;
    if (!link) return { ...none, moduleId: (await db.items.get(route.id))?.tray_module_id ?? null };
  }
  if (sessionId) weekId = (await db.sessions.get(sessionId))?.week_id ?? null;
  if (!weekId) return none;
  const week = await db.weeks.get(weekId);
  return { moduleId: week?.module_id ?? null, weekId, sessionId };
}

const isMedia = (file: File) => /^(audio|video)\//.test(mimeFor(file) ?? file.type ?? "");

function Sheet({ files, initial, onClose }: {
  files: File[]; initial: { moduleId: string | null; weekId: string | null }; onClose: () => void;
}) {
  useCloseOnBack(true, onClose);
  const ref = useRef<HTMLDialogElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // Live, so a device still fetching the library fills the list in as it arrives.
  const modules = useLiveQuery(async () => (await db.modules.toArray()).filter((m) => !m.deleted).sort(byPosition), [], [] as ModuleRow[]);
  const [weeks, setWeeks] = useState<WeekRow[]>([]);
  const [moduleId, setModuleId] = useState(initial.moduleId ?? "");
  const named = files.some((f) => parseTitle(stripExtension(f.name)).term);
  const [where, setWhere] = useState(initial.weekId ?? (named ? "named" : "tray"));
  const [busy, setBusy] = useState(false);
  const usable = files.filter((f) => mimeFor(f) && !isMedia(f));

  useEffect(() => {
    ref.current?.showModal();
    // The dialog puts focus on its first button; Add is the one you want.
    requestAnimationFrame(() => addButton.current?.focus());
  }, []);

  useEffect(() => { if (!moduleId && modules[0]) setModuleId(modules[0].id); }, [modules, moduleId]);

  useEffect(() => {
    if (!moduleId) return;
    void db.weeks.where("module_id").equals(moduleId).toArray().then((all) => setWeeks(all.filter((w) => !w.deleted).sort(byWeek)));
  }, [moduleId]);

  async function add() {
    const module = modules.find((m) => m.id === moduleId);
    if (!module) return;
    setBusy(true);
    const forced = weeks.find((w) => w.id === where);
    const plans = usable.map((file) => {
      const plan = planFile(file, weeks, forced);
      return where === "tray" ? { ...plan, weekId: null } : plan;
    });
    const count = await applyPlans(module, plans);
    onClose();
    const place = forced ? weekCode(forced) : where === "tray" ? "Unsorted" : "the weeks in their names";
    showToast(`${count} ${count === 1 ? "file" : "files"} added to ${module.code}, ${place}. Uploading now.`, {
      label: "Show me",
      run: () => navigate(forced ? { view: "week", id: forced.id } : { view: "module", id: module.id }),
    });
  }

  return (
    <dialog ref={ref} className="dialog add-sheet" onCancel={(e) => { e.preventDefault(); onClose(); }}>
      <h2>Add {usable.length} {usable.length === 1 ? "file" : "files"}</h2>
      <ul className="sheet-files small">
        {usable.slice(0, 6).map((f) => <li key={f.name}>{f.name}</li>)}
        {usable.length > 6 && <li className="muted">and {usable.length - 6} more</li>}
      </ul>
      {files.length > usable.length && (
        <p className="small muted">
          {files.length - usable.length} left out: only PDF, PowerPoint and Word files become readings.
          {files.some(isTranscriptFile) && " To add a Moodle transcript, drop it on a lecture or seminar."}
        </p>
      )}
      {modules.length === 0 ? (
        <p className="small">Create a module first, on the home page.</p>
      ) : (
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            <span>Module</span>
            <select value={moduleId} onChange={(e) => setModuleId(e.target.value)}>
              {modules.map((m) => <option key={m.id} value={m.id}>{m.code}{m.title ? `, ${m.title}` : ""}</option>)}
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            <span>Week</span>
            <select value={where} onChange={(e) => setWhere(e.target.value)}>
              {named && <option value="named">As in the file names</option>}
              <option value="tray">Unsorted, to sort later</option>
              {weeks.map((w) => <option key={w.id} value={w.id}>{weekCode(w)}{titleAfter(w, ", ")}</option>)}
            </select>
          </label>
        </div>
      )}
      <div className="row" style={{ justifyContent: "flex-end", marginTop: "0.75rem" }}>
        <button className="quiet" onClick={onClose}>Cancel</button>
        <button ref={addButton} className="button primary" disabled={busy || !usable.length || !moduleId} onClick={add}>Add</button>
      </div>
    </dialog>
  );
}

export function DropAnywhere({ route }: { route: Route }) {
  const [over, setOver] = useState(false);
  const [sheet, setSheet] = useState<{ files: File[]; initial: { moduleId: string | null; weekId: string | null } } | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth += 1; setOver(true); } };
    const leave = (e: DragEvent) => { if (hasFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) setOver(false); } };
    const overHandler = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    // Runs first, so the mark clears even when a page handles the drop itself.
    const reset = () => { depth = 0; setOver(false); };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e) || e.defaultPrevented) return;
      e.preventDefault();
      let files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      // Pictures dropped together become one reading.
      try { files = await combinePhotos(files); } catch (error) { showToast((error as Error).message); return; }
      const place = await placeOf(routeRef.current);

      // On a session, a recording and slides each know where they go.
      if (place.sessionId && routeRef.current.view === "session") {
        const media = files.filter(isMedia);
        const texts = files.filter(isTranscriptFile);
        const docs = files.filter((f) => !isMedia(f) && mimeFor(f));
        for (const file of media) await addRecordingFile(place.sessionId, file);
        for (const file of texts) {
          try { await importTranscript(place.sessionId, file); } catch (error) { showToast((error as Error).message); }
        }
        if (docs.length && place.weekId) {
          const week = await db.weeks.get(place.weekId);
          const module = week ? await db.modules.get(week.module_id) : undefined;
          if (week && module) {
            const weeks = await db.weeks.where("module_id").equals(module.id).toArray();
            await applyPlans(module, docs.map((f) => ({ ...planFile(f, weeks, week), kind: "slides" as const, sessionId: place.sessionId })));
          }
        }
        const parts = [
          media.length && `${media.length === 1 ? "a recording" : `${media.length} recordings`}`,
          texts.length && `${texts.length === 1 ? "a transcript" : `${texts.length} transcripts`}`,
          docs.length && `${docs.length} ${docs.length === 1 ? "slide deck" : "slide decks"}`].filter(Boolean);
        if (parts.length) showToast(`Added ${parts.join(" and ")} to this session. Uploading now.`);
        return;
      }
      setSheet({ files, initial: { moduleId: place.moduleId, weekId: place.weekId } });
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overHandler);
    window.addEventListener("drop", reset, true);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("drop", reset, true);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overHandler);
      window.removeEventListener("drop", drop);
    };
  }, []);

  // Week and module pages show their own, more precise, drop marks.
  const ownMarks = route.view === "week" || route.view === "import";
  return (
    <>
      {over && !ownMarks && (
        <div className="drop-banner" role="status">
          {route.view === "session"
            ? "Drop a recording, a Moodle transcript or slides to add them to this session"
            : route.view === "module"
              ? "Drop on a week to add files there, or anywhere else to choose where they go"
              : "Drop to add files. You'll choose where they go."}
        </div>
      )}
      {sheet && <Sheet files={sheet.files} initial={sheet.initial} onClose={() => setSheet(null)} />}
    </>
  );
}
