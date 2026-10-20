import { db } from "../lib/db";
import { countdown } from "../lib/sections";
import { useLiveQuery } from "dexie-react-hooks";
import { useState } from "react";
import { Link } from "../App";
import { loadModules, loadRecent, loadRecentSessions, loadThisWeek, type WeekSessions } from "../lib/library";
import { sessionLabel } from "../lib/modules";
import { useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { shortDate } from "../lib/dates";
import { shortTitle } from "../lib/titles";
import { weekCode } from "../lib/modules";
import { createModule, PATTERNS, WEEK_NUMBERS } from "../lib/modules";
import { navigate, type Route } from "../lib/router";
import type { WeekRow } from "../lib/types";
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

// Each of this week's sessions, one tap from its notes.
// The week's readings: how many are done, and one tap to the next.
function ReadingsTile({ week, readings }: { week: WeekRow; readings: WeekSessions["readings"] }) {
  const { total, read, next } = readings;
  const state = !total ? "None added yet" : read === total ? `All ${total} read` : `${read} of ${total} read`;
  const to: Route = next ? { view: "reader", id: next.id } : { view: "week", id: week.id };
  return (
    <Link to={to} className={`tw-session tw-readings${total && read === total ? " done" : ""}`} title={next ? `Open ${shortTitle(next)}` : undefined}>
      <span className="tw-name">Readings</span>
      <span className="tw-state">{state}</span>
      {next && <span className="tw-next">Next: {shortTitle(next)}</span>}
    </Link>
  );
}

function ThisWeek() {
  const week = useTeachingWeek();
  const dates = useTermDates();
  const rows = useLiveQuery(() => (week ? loadThisWeek(week.term, week.number) : Promise.resolve([])), [week?.term, week?.number], []);
  if (!week || !rows.length) return null;
  const starts = new Date(`${dates[week.term]}T00:00:00Z`);
  starts.setUTCDate(starts.getUTCDate() + (week.number - 1) * 7);
  const when = shortDate(starts, { utc: true });
  const span = weekDatesText(week.term, week.number, dates);
  return (
    <section className="this-week">
      <div className="section-head">
        <h2>{week.upcoming ? `Coming up: ${week.term}1` : `This week: ${week.term}${week.number}`}</h2>
        <span className="when small muted">{week.upcoming ? `Starts ${when}` : span}</span>
        <span className="spacer" />
      </div>
      <ul className="tw-list">
        {rows.map(({ module, week: w, sessions, readings }) => (
          <li key={module.id} className="tw-module">
            {/* This opens the week, so it names the week; the module itself is listed below. */}
            <Link to={{ view: "week", id: w.id }} className="tw-head" title={`Open ${module.code} ${weekCode(w)}`}>
              <span className="code">{module.code} {weekCode(w)}</span>
              <span className="title">{w.title || module.title}</span>
            </Link>
            {w.is_reading_week && !readings.total ? (
              <p className="small muted tw-reading">Reading week</p>
            ) : (
              <div className="tw-sessions">
                <ReadingsTile week={w} readings={readings} />
                {sessions.map(({ session, words, questions, recorded }) => (
                  <Link key={session.id} to={{ view: "session", id: session.id }} className="tw-session">
                    <span className="tw-name">{session.title || sessionLabel(session.kind)}</span>
                    <span className="tw-state">
                      {words ? `${words.toLocaleString("en-GB")} words` : "No notes yet"}
                      {questions ? `, ${questions} ${questions === 1 ? "question" : "questions"}` : ""}
                      {recorded ? ", recorded" : ""}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Home() {
  const modules = useLiveQuery(loadModules, []);
  const recent = useLiveQuery(() => loadRecent(6), [], []);
  const notes = useLiveQuery(() => loadRecentSessions(4), [], []);
  // Readings and notes you opened, in one list, newest first.
  const opened = [
    ...recent.map((r) => ({ kind: "reading" as const, at: r.view.item.last_opened_at ?? "", reading: r })),
    ...notes.map((n) => ({ kind: "notes" as const, at: n.at, notes: n })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
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
      <KeyDatesAhead />
      <ThisWeek />
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
      <ul className="list section">
        {modules.map(({ module, readings, read, next }, index) => (
          <li key={module.id} className={arranging ? "arranging" : "module-item"}>
            <Link to={{ view: "module", id: module.id }} className="module-row">
              <span className="code">{module.code}</span>
              <span className="title">{module.title}</span>
              {readings > 0 && <span className="count">{read ? `${read} of ${readings} read` : `${readings} ${readings === 1 ? "reading" : "readings"}`}</span>}
            </Link>
            {read > 0 && !arranging && (
              <span className="progress-line" aria-hidden="true"><span style={{ width: `${Math.round((read / readings) * 100)}%` }} /></span>
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
                <button className="tool" aria-label={`Move ${module.code} down`} disabled={index === modules.length - 1} onClick={() => moveModule(module.id, 1)}>↓</button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {adding && <NewModule onDone={() => setAdding(false)} />}

      {opened.length > 0 && (
        <section className="section">
          <h2>Recently opened</h2>
          <ul className="recent section" style={{ marginTop: "0.6rem" }}>
            {opened.map((entry) => {
              if (entry.kind === "notes") {
                const { session, week, module } = entry.notes;
                const name = session.title || sessionLabel(session.kind);
                return (
                  <li key={`n-${session.id}`}>
                    <Link to={{ view: "session", id: session.id }} className="name">{name} notes</Link>
                    <Link to={{ view: "week", id: week.id }} className="where">{module.code} {weekCode(week)}</Link>
                  </li>
                );
              }
              const { view, place } = entry.reading;
              const { item, file } = view;
              const at = item.read_status === "read"
                ? "Read"
                : item.last_page
                  ? `p. ${item.last_page + 1}${file?.page_count ? ` of ${file.page_count}` : ""}`
                  : null;
              return (
                <li key={item.id}>
                  <Link to={{ view: "reader", id: item.id }} className="name">{shortTitle(item)}</Link>
                  {at && <span className="count">{at}</span>}
                  {place && (
                    place.week
                      ? <Link to={{ view: "week", id: place.week.id }} className="where">{place.label}</Link>
                      : <span className="where">{place.label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

// The next key dates across dissertation modules, counting down as job
// deadlines do: amber within a week, red on the day or once passed.
function KeyDatesAhead() {
  const modules = useLiveQuery(async () => (await db.modules.toArray()).filter((m) => !m.deleted && m.kind === "dissertation"), [], []);
  const coming = modules
    .flatMap((m) => (m.key_dates ?? []).map((d) => ({ ...d, module: m, when: countdown(d.date) })))
    // Ones a fortnight past are let go; the rest show, soonest first.
    .filter((d) => d.when.days >= -14)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 4);
  if (!coming.length) return null;
  return (
    <section className="key-dates-ahead" aria-label="Key dates">
      <h2>Coming up</h2>
      <ul>
        {coming.map((d) => (
          <li key={d.id} className={d.when.state}>
            <Link to={{ view: "module", id: d.module.id }} className="kd-row">
              {/* Days to go, large; once passed, the word says so. */}
              <span className={`kd-days${d.when.days < 0 ? " small-word" : ""}`}>{d.when.days >= 0 ? d.when.days : "Past"}</span>
              <span className="kd-text">
                <span className="kd-label">{d.label}</span>
                <span className="kd-sub">{d.module.code}, {shortDate(new Date(`${d.date}T00:00:00`), { year: true })}, {d.when.words}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
