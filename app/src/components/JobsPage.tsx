// The job search: every application on one page. On a wide screen it is a
// table you edit in place, with a two-row header that stays in view. On a
// phone each application is a card that opens to edit. Either way, Details
// holds notes, the timeline, the four files and Delete. Every choice opens a
// choice card, never a dropdown: a panel beside its button on a laptop, a
// sheet from the foot of the screen on a phone.

import { useLiveQuery } from "dexie-react-hooks";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/db";
import {
  addApplication, cancelNewApplication, currentStageSince, deleteApplication, discardIfBlank, formatDate,
  inStageWords, isOpen, matches, restoreApplication, saveApplication, saveAppliedDate,
  slotColumn, SLOTS, sortApplications, stageOf, summarise, type Order,
} from "../lib/jobs";
import type { ApplicationEventRow, ApplicationRow } from "../lib/types";
import { showToast, typing, useNarrow, useTitle } from "../lib/ui";
import { Icon } from "./icons";
import { shortDate } from "../lib/dates";
import { DateField, Deadline, OrderButton, SlotMark, SlotRow, slotTitle, StageButton, TextField, Timeline } from "./jobs/Controls";
import { AppSheet } from "./jobs/AppSheet";
import { ApplicationForm } from "./jobs/ApplicationForm";
import { AppList } from "./jobs/AppList";

import { EntryForm } from "./jobs/EntryForm";
import { Sheet } from "./Sheet";
import { navigate, useRoute } from "../lib/router";

type Filter = "all" | "open" | "closed";

// Below this width the table becomes cards.
const NARROW = "(max-width: 60rem)";

// Tracks the table header height so the sticky thead offsets align exactly.
function useAppsHeaderHeight() {
  const [head, setHead] = useState<HTMLTableSectionElement | null>(null);
  useLayoutEffect(() => {
    if (!head) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty("--apps-head-h", `${head.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(head);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--apps-head-h");
    };
  }, [head]);
  return setHead;
}

// A new application with nothing typed in it is let go once you leave it.
// One you filled in takes its place in the order instead.
function useDiscardWhenLeft(id: string, fresh: boolean, onLeft: (gone: boolean) => void) {
  return useCallback((e: React.FocusEvent<HTMLElement>) => {
    if (!fresh) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    // The new focus settles first, so a click inside still counts as inside.
    setTimeout(() => {
      const row = document.querySelector(`[data-app="${id}"]`);
      if (row?.contains(document.activeElement)) return;
      void discardIfBlank(id).then(onLeft);
    }, 0);
  }, [id, fresh, onLeft]);
}

function TableRow({ app, events, fresh, onLeft }: {
  app: ApplicationRow; events: ApplicationEventRow[]; fresh: boolean; onLeft: (gone: boolean) => void;
}) {
  const leave = useDiscardWhenLeft(app.id, fresh, onLeft);
  const since = currentStageSince(app, events);
  // While a new row is being filled in, Cancel in its last cell takes it away.
  const cancelNew = async () => {
    await cancelNewApplication(app.id);
    onLeft(true);
    showToast("New application cancelled.");
  };
  return (
    <tbody className={`app${isOpen(app) ? "" : " closed"}`} data-app={app.id} data-employer={app.employer} onBlur={leave}>
      <tr>
        <td className="c-employer">
          <TextField wrap className="cell-input strong" value={app.employer} label="Employer" placeholder="Employer" autoFocus={fresh} onSave={(v) => void saveApplication(app.id, { employer: v })} />
        </td>
        <td className="c-role">
          <TextField wrap className="cell-input" value={app.role} label="Role" placeholder="Role" onSave={(v) => void saveApplication(app.id, { role: v })} />
        </td>
        <td className="c-applied"><DateField value={app.applied} label="Applied" title={`Date you applied to ${app.employer || "this employer"}`} onSave={(v) => void saveAppliedDate(app, v)} /></td>
        <td className="c-stage">
          <StageButton app={app} since={since} />
          {since && isOpen(app) && <span className="stage-since">{inStageWords(since)}</span>}
        </td>
        <td className="c-deadline"><Deadline app={app} /></td>
        {SLOTS.map((slot) => <td key={slot.name} className="c-slot"><SlotMark app={app} slot={slot} /></td>)}
        <td className="c-more">
          {fresh ? (
            <button type="button" className="icon-button new-cancel" aria-label="Cancel the new application" title="Cancel" onClick={() => void cancelNew()}><Icon name="close" /></button>
          ) : (
            <button
              type="button"
              className="icon-button card-enlarge"
              aria-label={`Open card for ${app.employer || "this application"}`}
              title="Open card"
              onClick={() => navigate({ view: "jobs", app: app.id })}
            >
              <Icon name="enlarge" />
            </button>
          )}
        </td>
      </tr>
    </tbody>
  );
}


function SummaryLine({ apps }: { apps: ApplicationRow[] }) {
  const s = summarise(apps);
  if (!apps.length) return null;
  const parts = [
    `${s.open} open`,
    s.overdue ? `${s.overdue} overdue` : null,
    s.soon ? `${s.soon} due within a week` : null,
    s.offers ? `${s.offers} ${s.offers === 1 ? "offer" : "offers"}` : null,
    `${s.closed} closed`,
  ].filter(Boolean);
  return (
    <p className="jobs-summary" aria-live="polite">
      {apps.length} {apps.length === 1 ? "application" : "applications"}. {parts.join(", ")}.
    </p>
  );
}

function RecentlyDeleted() {
  const deleted = useLiveQuery(async () =>
    (await db.applications.toArray())
      .filter((a) => a.deleted && (a.employer.trim() || a.role.trim()))
      .sort((a, b) => b.modified_at.localeCompare(a.modified_at)), [], []);
  if (!deleted.length) return null;
  return (
    <section className="section jobs-bin">
      <h2>Recently deleted</h2>
      <p className="small muted">Deleted applications stay here for 90 days.</p>
      <ul className="list bin">
        {deleted.map((app) => (
          <li key={app.id}>
            <span className="label">{app.employer}{app.role && <span className="muted">, {app.role}</span>}</span>
            <span className="count">{shortDate(new Date(app.modified_at))}</span>
            <button type="button" className="quiet" onClick={async () => { await restoreApplication(app.id); showToast(`${app.employer} restored.`); }}>Restore</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function JobsPage() {
  useTitle("Job search");
  const setHead = useAppsHeaderHeight();
  const route = useRoute();
  const narrow = useNarrow(NARROW);
  const all = useLiveQuery(async () => (await db.applications.toArray()).filter((a) => !a.deleted), [], null);
  const events = useLiveQuery(() => db.application_events.toArray(), [], []);
  // Each application's live timeline entries, read once for the whole page.
  const eventsFor = useMemo(() => {
    const by = new Map<string, ApplicationEventRow[]>();
    for (const e of events) {
      if (e.deleted) continue;
      const list = by.get(e.application_id);
      if (list) list.push(e); else by.set(e.application_id, [e]);
    }
    return (id: string) => by.get(id) ?? [];
  }, [events]);
  const [filter, setFilter] = useState<Filter>("all");
  const [order, setOrder] = useState<Order>("deadline");
  const [query, setQuery] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const find = useRef<HTMLInputElement>(null);


  const add = useCallback(async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    try {
      if (window.matchMedia?.(NARROW).matches) {
        navigate({ view: "jobs", newApp: true });
        return;
      }
      setFilter("all");
      setQuery("");
      const id = await addApplication();
      setFresh(id);
    } finally {
      setTimeout(() => {
        addingRef.current = false;
        setAdding(false);
      }, 400);
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      // Nothing behind an open card or dialog answers a key.
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "/") { e.preventDefault(); find.current?.focus(); }
      if (e.key === "n" || e.key === "N") { e.preventDefault(); void add(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [add]);

  const shown = useMemo(() => {
    if (!all) return [];
    // A new application stays in view until it has been filled in.
    const kept = all.filter((a) => a.id === fresh || ((filter === "all" || (filter === "open") === isOpen(a)) && matches(a, query)));
    const sorted = sortApplications(kept.filter((a) => a.id !== fresh), order);
    const added = kept.find((a) => a.id === fresh);
    return added ? [added, ...sorted] : sorted;
  }, [all, filter, order, query, fresh]);

  if (!all) return <div className="page wide" aria-busy="true" />;

  const left = (id: string) => (_gone: boolean) => {
    setFresh((f) => (f === id ? null : f));
  };

  const counts = { all: all.length, open: all.filter(isOpen).length, closed: all.filter((a) => !isOpen(a)).length };
  const closedHeading = order === "deadline" && filter === "all" && shown.some(isOpen) && shown.some((a) => !isOpen(a));
  const jobRoute = route.view === "jobs" ? route : null;
  const currentApp = jobRoute?.app ? all.find((a) => a.id === jobRoute.app) : undefined;
  const isNarrow = narrow;

  return (
    <div className="page wide jobs">
      <div className="jobs-head">
        <h1>Applications</h1>
        <button
          type="button"
          className="button primary"
          disabled={adding}
          onClick={() => void add()}
          title="Add an application (N)"
        >
          {adding ? "Adding…" : "Add application"}
        </button>
      </div>
      <SummaryLine apps={all} />

      {all.length > 0 && (
        <div className="jobs-tools" role="group" aria-label="Show and order applications">
          <div className="segmented" role="group" aria-label="Show">
            {(["all", "open", "closed"] as const).map((f) => (
              <button key={f} type="button" className="tool" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : f === "open" ? "Open" : "Closed"} <span className="seg-count">{counts[f]}</span>
              </button>
            ))}
          </div>
          <OrderButton order={order} onChange={setOrder} />
          <input
            ref={find} type="search" className="jobs-find" placeholder="Find an employer or role" aria-label="Find an application (/)"
            inputMode="search" enterKeyHint="search" autoCorrect="off" spellCheck={false}
            value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); } }}
          />
        </div>
      )}

      {all.length === 0 ? (
        <div className="jobs-empty">
          <p>No applications yet.</p>
          <p className="muted small">Add one when you apply. Keep its stage up to date as it moves on, and the next deadline beside it, and this page orders itself by what is due.</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="muted jobs-none">{query ? `Nothing matches “${query}”.` : filter === "open" ? "No open applications." : "No closed applications."}</p>
      ) : isNarrow ? (
        <AppList apps={shown} eventsFor={eventsFor} closedHeading={closedHeading} />
      ) : (
        <div className="apps-wrap">
          <table className="apps">
            <colgroup>
              <col className="w-employer" /><col className="w-role" /><col className="w-applied" /><col className="w-stage" /><col className="w-deadline" />
              <col className="w-slot" /><col className="w-slot" /><col className="w-slot" /><col className="w-slot" /><col className="w-more" />
            </colgroup>
            <thead ref={setHead}>
              <tr>
                <th rowSpan={2} scope="col">Employer</th>
                <th rowSpan={2} scope="col">Role</th>
                <th rowSpan={2} scope="col">Applied</th>
                <th rowSpan={2} scope="col">Stage</th>
                <th rowSpan={2} scope="col">Next deadline</th>
                <th colSpan={4} scope="colgroup" className="files-head">Files</th>
                <th rowSpan={2} scope="col"><span className="sr-only">Details</span></th>
              </tr>
              <tr>
                {SLOTS.map((slot) => <th key={slot.name} scope="col" className="slot-head" title={slot.label}>{slot.short}</th>)}
              </tr>
            </thead>
            {shown.map((app, i) => (
              <Fragment key={app.id}>
                {/* In the default order, closed applications sit under their own quiet heading. */}
                {closedHeading && !isOpen(app) && (i === 0 || isOpen(shown[i - 1])) && app.id !== fresh && (
                  <tbody className="closed-head"><tr><th colSpan={10} scope="rowgroup">Closed</th></tr></tbody>
                )}
                <TableRow app={app} events={eventsFor(app.id)} fresh={fresh === app.id} onLeft={left(app.id)} />
              </Fragment>
            ))}
          </table>
        </div>
      )}


      {jobRoute?.newApp && (
        <Sheet
          open={true}
          onClose={() => navigate({ view: "jobs" })}
          title="New application"
          className="new-app-sheet"
          tall
        >
          <ApplicationForm
            mode="new"
            onSave={async (fields) => {
              const id = await addApplication(fields);
              showToast(`${fields.employer || "Application"} added.`);
              navigate({ view: "jobs", app: id });
            }}
            onCancel={() => navigate({ view: "jobs" })}
          />
        </Sheet>
      )}

      {currentApp && jobRoute?.edit && (
        <Sheet
          open={true}
          onClose={() => navigate({ view: "jobs", app: currentApp.id })}
          title={`Edit ${currentApp.employer || "application"}`}
          subtitle={currentApp.role || undefined}
          className="edit-app-sheet"
          tall
        >
          <ApplicationForm
            mode="edit"
            initialApp={currentApp}
            onSave={async (patch) => {
              await saveApplication(currentApp.id, patch);
              showToast("Application saved.");
              navigate({ view: "jobs", app: currentApp.id });
            }}
            onCancel={() => navigate({ view: "jobs", app: currentApp.id })}
          />
        </Sheet>
      )}

      {currentApp && jobRoute?.entry && (
        <Sheet
          open={true}
          onClose={() => navigate({ view: "jobs", app: currentApp.id })}
          title={jobRoute.entry === "new" ? "Add event" : "Edit timeline entry"}
          subtitle={currentApp.employer}
          className="entry-sheet"
          tall
        >
          <EntryForm
            app={currentApp}
            entry={jobRoute.entry !== "new" ? eventsFor(currentApp.id).find((e) => e.id === jobRoute.entry) : undefined}
            onDone={() => navigate({ view: "jobs", app: currentApp.id })}
            variant="sheet"
          />
        </Sheet>
      )}

      {currentApp && (
        <AppSheet
          app={currentApp}
          events={eventsFor(currentApp.id)}
          tab={jobRoute?.tab}
          onClose={() => navigate({ view: "jobs" })}
        />
      )}

      <RecentlyDeleted />
    </div>
  );
}
