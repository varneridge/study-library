import { countdown, isDissertation } from "../lib/sections";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link } from "../App";
import { loadModules, type ModuleSummary } from "../lib/library";
import { progressWords } from "../lib/progress";
import { useTeachingWeek, useTermDates, type TermDates } from "../lib/term";
import { shortTitle } from "../lib/titles";
import { weekCode } from "../lib/modules";
import { createModule, PATTERNS, WEEK_NUMBERS } from "../lib/modules";
import { navigate } from "../lib/router";
import type { ModuleRow } from "../lib/types";
import { moveModule } from "../lib/edits";
import { useTitle } from "../lib/ui";

function NewModule({ onDone }: { onDone?: () => void }) {
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [pattern, setPattern] = useState(0);
  const [kind, setKind] = useState<"taught" | "dissertation">("taught");
  const [autumn, setAutumn] = useState("6");
  const [winter, setWinter] = useState("6");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    setSaving(true);
    const readingWeeks = [autumn && `AT${autumn}`, winter && `WT${winter}`].filter(Boolean) as string[];
    const id = await createModule({ code, title, pattern: PATTERNS[pattern].value, readingWeeks, kind });
    onDone?.();
    navigate({ view: "module", id });
  }

  return (
    <form onSubmit={submit} onKeyDown={(e) => { if (e.key === "Escape" && onDone) { e.preventDefault(); onDone(); } }} className="section">
      <div className="row">
        <label className="field" style={{ flex: "0 0 9rem" }}>
          <span>Code</span>
          <input type="text" value={code} onChange={(e) => setCode(e.target.value)} placeholder="HY335" required autoFocus autoCapitalize="characters" autoCorrect="off" spellCheck={false} autoComplete="off" enterKeyHint="next" />
        </label>
        <label className="field" style={{ flex: 1, minWidth: "14rem" }}>
          <span>Title</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} autoCapitalize="words" autoComplete="off" enterKeyHint="done" />
        </label>
      </div>
      <div className="field">
        <span className="small muted">This module is</span>
        <div className="segmented" role="group" aria-label="Kind of module">
          <button type="button" className="tool" aria-pressed={kind === "taught"} onClick={() => setKind("taught")}>Taught, by weeks of term</button>
          <button type="button" className="tool" aria-pressed={kind === "dissertation"} onClick={() => setKind("dissertation")}>A dissertation, by sections you name</button>
        </div>
      </div>
      {kind === "dissertation" ? (
        <p className="small muted">It starts with one section, ready to name. Add sections for chapters, sources and supervision as you go, and key dates for the countdown on the home page.</p>
      ) : (<>
      <div className="field">
        <span className="small muted">Each week has</span>
        <div className="choices">
          {PATTERNS.map((p, i) => (
            <label key={p.label}>
              <input type="radio" name="pattern" checked={pattern === i} onChange={() => setPattern(i)} />
              {p.label}
            </label>
          ))}
        </div>
      </div>
      <div className="row">
        <label className="field">
          <span>Autumn reading week</span>
          <select value={autumn} onChange={(e) => setAutumn(e.target.value)}>
            <option value="">None</option>
            {WEEK_NUMBERS.map((n) => <option key={n} value={n}>AT{n}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Winter reading week</span>
          <select value={winter} onChange={(e) => setWinter(e.target.value)}>
            <option value="">None</option>
            {WEEK_NUMBERS.map((n) => <option key={n} value={n}>WT{n}</option>)}
          </select>
        </label>
      </div>
      </>)}
      <div className="row" style={{ gap: "0.5rem" }}>
        <button className="button primary" disabled={saving || !code.trim()}>{saving ? "Creating…" : "Create module"}</button>
        {onDone && <button type="button" className="button" onClick={onDone} disabled={saving}>Cancel</button>}
      </div>
    </form>
  );
}


function nextKeyDate(module: ModuleRow) {
  if (module.kind !== "dissertation" || !module.key_dates?.length) return null;
  const coming = module.key_dates
    .map((d) => ({ ...d, when: countdown(d.date) }))
    .filter((d) => d.when.days >= -14)
    .sort((a, b) => a.date.localeCompare(b.date));
  return coming[0] ?? null;
}

function ModuleCard({
  item,
  index,
  arranging,
  dates,
  totalModules,
}: {
  item: ModuleSummary;
  index: number;
  arranging: boolean;
  dates: TermDates;
  totalModules: number;
}) {
  const { module, next, progress } = item;
  const [imgFailed, setImgFailed] = useState(false);
  const progressLabel = progressWords(progress, dates);
  const nextDate = isDissertation(module) ? nextKeyDate(module) : null;
  const hasImage = Boolean(module.image_key && !imgFailed);
  const imageSrc = module.image_key
    ? (module.image_key.startsWith("pictures/") ? `/api/${module.image_key}` : `/api/pictures/${module.image_key}`)
    : null;

  return (
    <li className={`module-card module-item${arranging ? " arranging" : ""}`}>
      <div className="module-card-cover">
        {hasImage && imageSrc ? (
          <img
            src={imageSrc}
            alt=""
            loading={index < 2 ? "eager" : "lazy"}
            onError={() => setImgFailed(true)}
          />
        ) : (
          <div className="module-card-typo-cover" aria-hidden="true">
            <span className="module-card-typo-code">{module.code}</span>
          </div>
        )}
      </div>
      <div className="module-card-body">
        {arranging ? (
          <div className="module-row">
            <span className="code">{module.code}</span>
            <span className="title">{module.title || module.code}</span>
          </div>
        ) : (
          <Link
            to={{ view: "module", id: module.id }}
            className="module-row"
            aria-label={`Open ${module.code} ${module.title || ""}`}
          >
            <span className="code">{module.code}</span>
            <span className="title">{module.title || module.code}</span>
            <span className="module-card-stretch" aria-hidden="true" />
          </Link>
        )}

        {isDissertation(module) ? (
          nextDate && (
            <span className="count">
              {nextDate.label}: {nextDate.when.words}
            </span>
          )
        ) : (
          <>
            {progressLabel && <span className="count">{progressLabel}</span>}
            {progress.state !== "none" && progress.total > 0 && progress.read > 0 && !arranging && (
              <span className="progress-line" aria-hidden="true">
                <span style={{ width: `${Math.round((progress.read / progress.total) * 100)}%` }} />
              </span>
            )}
          </>
        )}

        {next && !arranging && (
          <p className="next-up small">
            <span className="muted">Next</span>{" "}
            <Link to={{ view: "reader", id: next.item.id }}>{shortTitle(next.item)}</Link>{" "}
            <Link to={{ view: "week", id: next.week.id }} className="where">{weekCode(next.week)}</Link>
          </p>
        )}

        {arranging && (
          <span className="order">
            <button className="tool" aria-label={`Move ${module.code} up`} disabled={index === 0} onClick={() => moveModule(module.id, -1)}>↑</button>
            <button className="tool" aria-label={`Move ${module.code} down`} disabled={index === totalModules - 1} onClick={() => moveModule(module.id, 1)}>↓</button>
          </span>
        )}
      </div>
    </li>
  );
}

export function Home() {
  const week = useTeachingWeek();
  const dates = useTermDates();
  const modules = useLiveQuery(() => loadModules(week), [week?.term, week?.number, week?.upcoming]);
  const [adding, setAdding] = useState(false);
  const [arranging, setArranging] = useState(false);
  useTitle(null);
  if (!modules) return null;

  if (modules.length === 0) {
    return (
      <div className="page">
        <h1>Add your first module</h1>
        <p className="lede">Creating a module sets up all 22 weeks, with sessions in each.</p>
        <NewModule />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h1>Modules</h1>
        <span className="spacer" />
        {modules.length > 1 && (
          <button className="quiet" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
            {arranging ? "Done" : "Change order"}
          </button>
        )}
        {/* The page's own action sits by its heading, as on every page. */}
        {!adding && <button className="button" onClick={() => setAdding(true)}>Add a module</button>}
      </div>
      <ul className="module-grid">
        {modules.map((item, index) => (
          <ModuleCard
            key={item.module.id}
            item={item}
            index={index}
            arranging={arranging}
            dates={dates}
            totalModules={modules.length}
          />
        ))}
      </ul>
      {adding && <NewModule onDone={() => setAdding(false)} />}
    </div>
  );
}
