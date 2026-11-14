import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link } from "../App";
import { Icon } from "./icons";
import { loadModules, type ModuleSummary } from "../lib/library";
import { useTeachingWeek } from "../lib/term";
import { createModule, PATTERNS, WEEK_NUMBERS } from "../lib/modules";
import { navigate } from "../lib/router";
import { moveModule } from "../lib/edits";
import { showToast, useTitle } from "../lib/ui";
import type { ModuleKind } from "../lib/types";

function NewModule({ onDone }: { onDone?: () => void }) {
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [pattern, setPattern] = useState(0);
  const [kind, setKind] = useState<ModuleKind>("taught");
  const [autumn, setAutumn] = useState("6");
  const [winter, setWinter] = useState("6");
  const [saving, setSaving] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!code.trim()) return;
    if (saving) return;
    setSaving(true);
    const readingWeeks = [autumn && `AT${autumn}`, winter && `WT${winter}`].filter(Boolean) as string[];
    try {
      const id = await createModule({ code, title, pattern: PATTERNS[pattern].value, readingWeeks, kind });
      onDone?.();
      navigate({ view: "module", id });
    } catch (error) {
      // Without this the button stayed on "Creating…" for good after a failure.
      setSaving(false);
      showToast(`The module could not be created. ${(error as Error).message || "Try again in a moment."}`);
    }
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
          <button type="button" className="tool" aria-pressed={kind === "taught"} onClick={() => setKind("taught")}>Taught</button>
          <button type="button" className="tool" aria-pressed={kind === "dissertation"} onClick={() => setKind("dissertation")}>Dissertation</button>
          <button type="button" className="tool" aria-pressed={kind === "library"} onClick={() => setKind("library")}>Library</button>
        </div>
      </div>
      {kind === "dissertation" ? (
        <p className="small muted">It starts with one section, ready to name. Add sections for chapters, sources and supervision as you go, and key dates for the countdown.</p>
      ) : kind === "library" ? (
        <p className="small muted">An open library for books, secondary literature and downloaded references, organised by shelves you name (such as Historiography, Reference, or Primary sources) with no term weeks.</p>
      ) : (<>
      <p className="small muted">Weeks of term, each with its sessions, readings and notes.</p>
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


function ModuleCard({
  item,
  index,
  arranging,
  totalModules,
}: {
  item: ModuleSummary;
  index: number;
  arranging: boolean;
  totalModules: number;
}) {
  const { module } = item;
  const [imgFailed, setImgFailed] = useState(false);
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

        {arranging && (
          <span className="order">
            <button className="tool" aria-label={`Move ${module.code} up`} disabled={index === 0} onClick={() => moveModule(module.id, -1)}><Icon name="up" size={16} /></button>
            <button className="tool" aria-label={`Move ${module.code} down`} disabled={index === totalModules - 1} onClick={() => moveModule(module.id, 1)}><Icon name="down" size={16} /></button>
          </span>
        )}
      </div>
    </li>
  );
}

export function Home() {
  const week = useTeachingWeek();
  const modules = useLiveQuery(() => loadModules(week), [week?.term, week?.number, week?.upcoming]);
  const [adding, setAdding] = useState(false);
  const [arranging, setArranging] = useState(false);
  useTitle(null);
  if (!modules) return null;

  if (modules.length === 0) {
    return (
      <div className="page wide">
        <h1>Add your first module</h1>
        <p className="lede">Creating a module sets up all 22 weeks, with sessions in each.</p>
        <NewModule />
      </div>
    );
  }

  return (
    <div className="page wide">
      <div className="section-head" style={{ marginBottom: 0 }}>
        <h1>Modules</h1>
        <span className="spacer" />
        {modules.length > 1 && (
          <button className="quiet" aria-pressed={arranging} onClick={() => setArranging(!arranging)}>
            {arranging ? "Done" : "Change order"}
          </button>
        )}
        {/* The page's own action sits by its heading, as on every page. */}
        {!adding && <button className="button primary" onClick={() => setAdding(true)}>Add a module</button>}
      </div>
      {/* The new module opens where its button was, not below every card. */}
      {adding && <NewModule onDone={() => setAdding(false)} />}
      <ul className="module-grid">
        {modules.map((item, index) => (
          <ModuleCard
            key={item.module.id}
            item={item}
            index={index}
            arranging={arranging}
            totalModules={modules.length}
          />
        ))}
      </ul>
    </div>
  );
}
