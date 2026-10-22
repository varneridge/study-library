import { useTeachingWeek } from "../lib/term";
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

const KEY = "across-week";

// One week for every module. Reached from the tab or the top bar, it opens
// on this week while term runs, as the phone's "This week" tab promises; in
// the vacations it opens on the week you last chose here.
export function AcrossPage({ term, number }: { term?: string; number?: number }) {
  const now = useTeachingWeek();
  // Read the saved week while rendering, so the first view is already right.
  const saved = term && number ? null : /^(AT|WT)(\d{1,2})$/.exec(localStorage.getItem(KEY) ?? "");
  const current = !term && now && !now.upcoming ? now : null;
  const t = term ?? current?.term ?? saved?.[1] ?? "AT";
  const n = number ?? current?.number ?? (saved ? Number(saved[2]) : 1);
  useEffect(() => {
    if (term && number) localStorage.setItem(KEY, `${term}${number}`);
  }, [term, number]);
  const data = useLiveQuery(() => loadAcross(t, n), [t, n]);
  const isCurrentWeek = Boolean(now && !now.upcoming && now.term === t && now.number === n);
  const title = isCurrentWeek ? "This week" : `Week ${t}${n}`;
  useTitle(title);

  return (
    <div className="page">
      <h1>{title}</h1>
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
      {data?.map(({ module, view }) => {
        const loose = view.readings.length + view.primaries.length;
        const sessions = view.sessions.filter((s) => s.notes.length || s.slides.length || s.recordings.length || s.questions.length);
        return (
          <section key={module.id} className="section across-module">
            <div className="section-head">
              <h2>{module.code}</h2>
              <Link to={{ view: "week", id: view.week.id }} className="where">
                {view.week.title || (view.week.is_reading_week ? "Reading week" : "Open the week")}
              </Link>
            </div>
            {view.readings.length > 0 && (
              <ul className="readings">{view.readings.map((r) => <ReadingRow key={r.item.id} view={r} short />)}</ul>
            )}
            {view.primaries.length > 0 && (
              <>
                <p className="group-label">Primary sources</p>
                <ul className="readings">{view.primaries.map((r) => <ReadingRow key={r.item.id} view={r} />)}</ul>
              </>
            )}
            {sessions.map(({ session, notes, slides, recordings, questions }) => (
              <div key={session.id} className="across-session">
                <p className="small">
                  <Link to={{ view: "session", id: session.id }}>{session.title || sessionLabel(session.kind)}</Link>
                  <span className="muted">
                    {[
                      notes.length && ", notes",
                      slides.length && ", slides",
                      ...recordings.map((r) => `, ${recordingState(r) ?? (r.duration_seconds ? `recording, ${clock(r.duration_seconds)}` : "recording")}`),
                    ].filter(Boolean).join("")}
                  </span>
                </p>
                {questions.length > 0 && (
                  <ol className="questions small">
                    {questions.map(({ question, answered }) => (
                      <li key={question.id}>
                        <Link to={{ view: "session", id: question.session_id }}>{question.body}</Link>
                        {answered && <span className="count"> answered</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
            {loose === 0 && sessions.length === 0 && <p className="small muted">Nothing here yet.</p>}
          </section>
        );
      })}
    </div>
  );
}
