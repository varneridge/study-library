import { combinePhotos, READING_ACCEPT } from "../lib/photos";
import { showToast } from "../lib/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { useRef, useState } from "react";
import { Link } from "../App";
import { useTitle } from "../lib/ui";
import { db } from "../lib/db";
import { applyPlans, hashPlans, planFile, type PlanKind, type PlannedFile } from "../lib/importing";
import { byWeek, weekCode } from "../lib/modules";
import { navigate } from "../lib/router";

const KINDS: { value: PlanKind; label: string }[] = [
  { value: "secondary", label: "Reading" },
  { value: "primary", label: "Primary source" },
  { value: "slides", label: "Slides" },
  { value: "week-title", label: "Week title only" },
  { value: "skip", label: "Skip" },
];

async function filesFromDrop(items: DataTransferItemList): Promise<File[]> {
  const out: File[] = [];
  const walk = async (entry: FileSystemEntry): Promise<void> => {
    if (entry.isFile) {
      out.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)));
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  };
  const entries = Array.from(items).map((item) => item.webkitGetAsEntry()).filter(Boolean) as FileSystemEntry[];
  for (const entry of entries) await walk(entry);
  return out;
}

export function ImportPage({ id }: { id: string }) {
  const module = useLiveQuery(() => db.modules.get(id), [id]);
  const weeks = useLiveQuery(async () => (await db.weeks.where("module_id").equals(id).toArray()).filter((w) => !w.deleted).sort(byWeek), [id]);
  const [plans, setPlans] = useState<PlannedFile[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const folder = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  useTitle(module ? `Import into ${module.code}` : undefined);

  if (!module || !weeks) return null;

  const add = (list: File[]) => {
    const fresh = list
      .filter((f) => !f.name.startsWith("."))
      .filter((f) => !plans.some((p) => p.file.name === f.name && p.file.size === f.size))
      .map((f) => planFile(f, weeks));
    const next = [...plans, ...fresh];
    setPlans(next);
    void hashPlans(next, () => setTick((n) => n + 1));
  };

  const edit = (index: number, change: Partial<PlannedFile>) =>
    setPlans(plans.map((p, i) => (i === index ? { ...p, ...change } : p)));

  const counted = plans.filter((p) => p.kind !== "skip" && p.kind !== "week-title");
  const unsorted = counted.filter((p) => !p.weekId).length;

  async function confirm() {
    setBusy(true);
    await applyPlans(module!, plans);
    navigate({ view: "module", id: module!.id });
  }

  return (
    <div className="page wide">
      <div className="crumbs"><Link to={{ view: "module", id: module.id }}>{module.code}</Link> / Import</div>
      <h1>Import readings</h1>
      <p className="lede">
        Files named like "(AT3) P1 Author, 'Title', date" are sorted into weeks automatically. Check the table, then import.
      </p>

      <div
        className={`pick${over ? " over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => { e.preventDefault(); setOver(false); add(await filesFromDrop(e.dataTransfer.items)); }}
      >
        <p className="touch-hide" style={{ margin: "0 0 0.75rem" }}>Drop a folder or files here</p>
        <div className="row" style={{ justifyContent: "center" }}>
          <button className="button" onClick={() => folder.current?.click()}>Choose a folder</button>
          <button className="button" onClick={() => files.current?.click()}>Choose files</button>
        </div>
        <input ref={folder} type="file" hidden multiple {...{ webkitdirectory: "" }}
          onChange={(e) => { add(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
        <input ref={files} type="file" hidden multiple accept={READING_ACCEPT}
          onChange={async (e) => {
            const chosen = Array.from(e.target.files ?? []);
            e.target.value = "";
            // Pictures chosen together become one reading.
            try { add(await combinePhotos(chosen)); } catch (error) { showToast((error as Error).message); }
          }} />
      </div>

      {plans.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="review">
              <thead>
                <tr>
                  <th>File</th><th>Week</th><th>Type</th><th>Order</th><th>Author</th><th>Title</th>
                  <th>Year or date</th><th>Source</th><th>Pages</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan, i) => (
                  <tr key={`${plan.file.name}-${i}`} className={plan.parsed.review || !plan.mime ? "flag" : undefined}>
                    <td className="file">
                      <span className="file-name" title={plan.file.name}>{plan.file.name}</span>
                      {!plan.mime && <div>Not a supported file type</div>}
                      {plan.existingFileId && <div className="muted">Already in the library</div>}
                    </td>
                    <td>
                      <select value={plan.weekId ?? ""} onChange={(e) => edit(i, { weekId: e.target.value || null })}>
                        <option value="">Unsorted</option>
                        {weeks.map((w) => <option key={w.id} value={w.id}>{weekCode(w)}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={plan.kind} onChange={(e) => edit(i, { kind: e.target.value as PlanKind })} disabled={!plan.mime}>
                        {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                      </select>
                    </td>
                    <td>
                      {plan.kind === "primary" && (
                        <input type="number" min={0} value={plan.order} style={{ width: "4.5rem", minWidth: 0 }}
                          onChange={(e) => edit(i, { order: Number(e.target.value) || 0 })} />
                      )}
                    </td>
                    <td><input type="text" value={plan.author} onChange={(e) => edit(i, { author: e.target.value })} /></td>
                    <td><input type="text" value={plan.title} onChange={(e) => edit(i, { title: e.target.value })} style={{ minWidth: "16rem" }} /></td>
                    <td>
                      {plan.kind === "primary" ? (
                        <input type="text" value={plan.docDate} onChange={(e) => edit(i, { docDate: e.target.value })} />
                      ) : (
                        <input type="text" value={plan.year} onChange={(e) => edit(i, { year: e.target.value })} style={{ width: "5rem", minWidth: 0 }} />
                      )}
                    </td>
                    <td><input type="text" value={plan.source} onChange={(e) => edit(i, { source: e.target.value })} /></td>
                    <td><input type="text" value={plan.pages} onChange={(e) => edit(i, { pages: e.target.value })} style={{ width: "6rem", minWidth: 0 }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* Kept in view at the foot of the screen, however long the list. */}
          <div className="row section import-bar">
            <button className="button primary" disabled={busy || counted.length === 0} onClick={confirm}>
              Import {counted.length} {counted.length === 1 ? "file" : "files"}
            </button>
            {unsorted > 0 && <span className="small muted">{unsorted} without a week will go to the unsorted tray.</span>}
            <button className="quiet" onClick={() => setPlans([])}>Clear</button>
          </div>
        </>
      )}
    </div>
  );
}
