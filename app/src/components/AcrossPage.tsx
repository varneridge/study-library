import { useTeachingWeek, useTermDates, weekDatesText } from "../lib/term";
import { useSuspendingLiveQuery } from "dexie-react-hooks";
import { useEffect } from "react";
import { Link } from "../App";
import { useTitle } from "../lib/ui";
import { loadAcross, type ReadingView, type WeekOverview } from "../lib/library";
import { WEEK_NUMBERS } from "../lib/modules";
import { navigate } from "../lib/router";
import { readCount } from "../lib/progress";
import { WeekCard } from "./ModulePage";
import { db } from "../lib/db";
import { countdown } from "../lib/sections";
import { shortDate } from "../lib/dates";

const KEY = "across-week";

// The first reading in a week with a thumbnail of its own, primaries first,
// so that a week with no cover picture is still shown by what is in it.
function firstThumb(groups: ReadingView[][]): string | null {
  for (const group of groups) {
    for (const view of group) {
      if (view.file?.thumb_key) return view.file.thumb_key;
    }
  }
  return null;
}

// The next key dates across dissertation modules, counting down as job
// deadlines do: amber within a week, red on the day or once passed.
function KeyDatesAhead() {
  const modules = useSuspendingLiveQuery(async () => (await db.modules.toArray()).filter((m) => !m.deleted && m.kind === "dissertation"), ["dissertation-modules"]);
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

// One week for every module, each shown as the same compact card a module's
// own page uses. Reached from the tab or the top bar, it opens on this week
// while term runs, as the phone's "This week" tab promises; in the vacations
// it opens on the week you last chose here.
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
  const data = useSuspendingLiveQuery(() => loadAcross(t, n), ["across", t, n]);
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
      {/* Each module's chosen week as a card, laid out like a module's weeks. */}
      <div className="week-grid across-week-grid">
        {data.map(({ module, view }) => {
          const overview: WeekOverview = {
            week: view.week,
            readingCount: readCount([...view.primaries, ...view.readings]),
            thumb_key: view.week.image_key ?? firstThumb([view.primaries, view.readings, view.summaries]),
            thumb_keys: [],
            sessions: [],
            isCurrentWeek,
          };
          return <WeekCard key={module.id} overview={overview} module={module} dates={dates} moduleCode={module.code} />;
        })}
      </div>
    </div>
  );
}
