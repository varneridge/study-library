import { useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect } from "react";
import { Link } from "../App";
import { useTitle } from "../lib/ui";
import { loadAcross } from "../lib/library";
import { sessionLabel, WEEK_NUMBERS } from "../lib/modules";
import { navigate } from "../lib/router";
import { clock } from "../lib/recorder";
import { recordingState } from "./Recording";
import { ReadingRow } from "./ReadingRow";
import { readCount } from "../lib/progress";
import { db } from "../lib/db";
import { countdown } from "../lib/sections";
import { shortDate } from "../lib/dates";

const KEY = "across-week";

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

// One week for every module. Reached from the tab or the top bar, it opens
// on this week while term runs, as the phone's "This week" tab promises; in
// the vacations it opens on the week you last chose here.
export function AcrossPage({ term, number }: { term?: string; number?: number }) {
  const now = useTeachingWeek();
  const dates = useTermDates();
  // Read the saved week while rendering, so the first view is already right.
  const saved = term && number ? null : /^(AT|WT)(\d{1,2})$/.exec(localStorage.getItem(KEY) ?? "");
  const current = !term && now ? now : null;
  const t = term ?? current?.term ?? saved?.[1] ?? "AT";
  const n = number ?? current?.number ?? (saved ? Number(saved[2]) : 1);
  useEffect(() => {
    if (term && number) localStorage.setItem(KEY, `${term}${number}`);
  }, [term, number]);
  const data = useLiveQuery(() => loadAcross(t, n), [t, n]);
  const isCurrentWeek = Boolean(now && !now.upcoming && now.term === t && now.number === n);
  const isUpcoming = Boolean(now && now.upcoming && now.term === t && now.number === n);
  const title = isCurrentWeek ? "This week" : isUpcoming ? `Coming up: ${t}${n}` : `Week ${t}${n}`;
  useTitle(title);

  const termKey = t === "WT" ? "WT" : "AT";
  const starts = dates[termKey] ? new Date(`${dates[termKey]}T00:00:00Z`) : null;
  if (starts) starts.setUTCDate(starts.getUTCDate() + (n - 1) * 7);
  const when = starts ? shortDate(starts, { utc: true }) : null;
  const span = weekDatesText(t, n, dates);

  return (
    <div className="page wide">
      <h1>{title}</h1>
      {span && <p className="when small muted" style={{ marginTop: "-0.25rem", marginBottom: "0.75rem" }}>{isUpcoming && when ? `Starts ${when}` : span}</p>}
      <div className="picker" role="group" aria-label="Choose a week">
        {(["AT", "WT"] as const).map((x) => (
          <div key={x} style={{ display: "contents" }}>
            <span>{x}</span>
            {WEEK_NUMBERS.map((k) => (
              <button key={k} aria-pressed={t === x && n === k} onClick={() => navigate({ view: "across", term: x, number: k }, true)}>
                {k}
              </button>
            ))}
          </div>
        ))}
      </div>
      {/* The page title comes first; the countdown follows the week picker. */}
      <KeyDatesAhead />
      {data?.map(({ module, view }) => {
        const loose = view.primaries.length + view.readings.length + view.summaries.length;
        const sessions = view.sessions;
        const progress = readCount([...view.primaries, ...view.readings]);
        const progressText = progress.total === 0
          ? null
          : progress.read === progress.total
            ? `All ${progress.total} read`
            : progress.read > 0
              ? `${progress.read} of ${progress.total} read`
              : `${progress.total} ${progress.total === 1 ? "reading" : "readings"}`;

        return (
          <section key={module.id} className="section across-module">
            <div className="section-head">
              <h2>{module.code}</h2>
              {progressText && <span className="count">{progressText}</span>}
              <span className="spacer" />
              <Link to={{ view: "week", id: view.week.id }} className="where">
                {view.week.title || (view.week.is_reading_week ? "Reading week" : "Open the week")}
              </Link>
            </div>
            {view.primaries.length > 0 && (
              <>
                <p className="group-label">Primary readings</p>
                <ul className="readings">{view.primaries.map((r) => <ReadingRow key={r.item.id} view={r} />)}</ul>
              </>
            )}
            {view.readings.length > 0 && (
              <>
                <p className="group-label">Secondary readings</p>
                <ul className="readings">{view.readings.map((r) => <ReadingRow key={r.item.id} view={r} short />)}</ul>
              </>
            )}
            {view.summaries.length > 0 && (
              <>
                <p className="group-label">Summaries</p>
                <ul className="readings">{view.summaries.map((r) => <ReadingRow key={r.item.id} view={r} short />)}</ul>
              </>
            )}
            {sessions.map(({ session, notes, slides, recordings }) => {
              const parts = [
                notes.length && ", notes",
                slides.length && ", slides",
                ...recordings.map((r) => `, ${recordingState(r) ?? (r.duration_seconds ? `recording, ${clock(r.duration_seconds)}` : "recording")}`),
              ].filter(Boolean);
              return (
                <div key={session.id} className="across-session">
                  <p className="small">
                    <Link to={{ view: "session", id: session.id }}>{session.title || sessionLabel(session.kind)}</Link>
                    <span className="muted">
                      {parts.length > 0 ? parts.join("") : ": No notes yet"}
                    </span>
                  </p>
                </div>
              );
            })}
            {loose === 0 && sessions.length === 0 && <p className="small muted">No readings or sessions in this week yet. Open the week to add them.</p>}
          </section>
        );
      })}
    </div>
  );
}
