// The job search: active applications and the graduate shortlist of
// prospective programmes. On a wide screen each view is a table you edit in
// place, with a sticky header. On a phone each item is a card that opens a
// read-first modal sheet. Every choice opens a choice card, never a dropdown.

import { useLiveQuery } from "dexie-react-hooks";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/db";
import {
  addApplication, cancelNewApplication, currentStageSince, discardIfBlank,
  inStageWords, isOpen, matches, restoreApplication, saveApplication, saveAppliedDate,
  SLOTS, sortApplications, summarise, type Order,
} from "../lib/jobs";
import {
  addProspect, cancelNewProspect, discardProspectIfBlank, isProspectOpen,
  matchesProspect, restoreProspect, saveProspect, sortProspects, summariseProspects,
  type ProspectOrder,
} from "../lib/prospects";
import type { ApplicationEventRow, ApplicationRow, ProspectRow } from "../lib/types";
import { showToast, typing, useNarrow, useTitle } from "../lib/ui";
import { Icon } from "./icons";
import { shortDate } from "../lib/dates";
import { DateField, Deadline, OrderButton, SlotMark, StageButton, TextField } from "./jobs/Controls";
import { NextCheck, ProspectLinkCell, ProspectOrderButton, ProspectStatusButton } from "./jobs/ProspectControls";
import { AppSheet } from "./jobs/AppSheet";
import { ApplicationForm } from "./jobs/ApplicationForm";
import { AppList } from "./jobs/AppList";
import { ProspectSheet } from "./jobs/ProspectSheet";
import { ProspectForm } from "./jobs/ProspectForm";
import { ProspectList } from "./jobs/ProspectList";
import { EntryForm } from "./jobs/EntryForm";
import { Sheet } from "./Sheet";
import { SearchField } from "./SearchField";
import { href, navigate, useRoute } from "../lib/router";

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
function useDiscardWhenLeft(id: string, fresh: boolean, discardFn: (id: string) => Promise<boolean>, attr: string, onLeft: (gone: boolean) => void) {
  return useCallback((e: React.FocusEvent<HTMLElement>) => {
    if (!fresh) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    // The new focus settles first, so a click inside still counts as inside.
    setTimeout(() => {
      const row = document.querySelector(`[${attr}="${id}"]`);
      if (row?.contains(document.activeElement)) return;
      void discardFn(id).then(onLeft);
    }, 0);
  }, [id, fresh, discardFn, attr, onLeft]);
}

function TableRow({ app, events, fresh, onLeft }: {
  app: ApplicationRow; events: ApplicationEventRow[]; fresh: boolean; onLeft: (gone: boolean) => void;
}) {
  const leave = useDiscardWhenLeft(app.id, fresh, discardIfBlank, "data-app", onLeft);
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
              onClick={() => void navigate({ view: "jobs", app: app.id })}
            >
              <Icon name="enlarge" />
            </button>
          )}
        </td>
      </tr>
    </tbody>
  );
}

function ProspectTableRow({
  prospect,
  linkedApp,
  fresh,
  onLeft,
}: {
  prospect: ProspectRow;
  linkedApp?: ApplicationRow;
  fresh: boolean;
  onLeft: (gone: boolean) => void;
}) {
  const leave = useDiscardWhenLeft(prospect.id, fresh, discardProspectIfBlank, "data-prospect", onLeft);
  const open = isProspectOpen(prospect, linkedApp);
  const cancelNew = async () => {
    await cancelNewProspect(prospect.id);
    onLeft(true);
    showToast("New programme cancelled.");
  };
  return (
    <tbody
      className={`app prospect${open ? "" : " closed"}`}
      data-prospect={prospect.id}
      data-employer={prospect.employer}
      onBlur={leave}
    >
      <tr>
        <td className="c-check c-next-check">
          <NextCheck prospect={prospect} linkedApp={linkedApp} />
        </td>
        <td className="c-last-open">
          <TextField
            wrap
            className="cell-input"
            value={prospect.last_year_open ?? ""}
            label="Last year open"
            placeholder="Last year open"
            onSave={(v) => void saveProspect(prospect.id, { last_year_open: v || null })}
          />
        </td>
        <td className="c-employer">
          <TextField
            wrap
            className="cell-input strong"
            value={prospect.employer}
            label="Employer"
            placeholder="Employer"
            autoFocus={fresh}
            onSave={(v) => void saveProspect(prospect.id, { employer: v })}
          />
        </td>
        <td className="c-programme">
          <TextField
            wrap
            className="cell-input"
            value={prospect.programme}
            label="Programme"
            placeholder="Programme"
            onSave={(v) => void saveProspect(prospect.id, { programme: v })}
          />
        </td>
        <td className="c-salary">
          <TextField
            wrap
            className="cell-input"
            value={prospect.salary ?? ""}
            label="Salary"
            placeholder="Salary"
            onSave={(v) => void saveProspect(prospect.id, { salary: v || null })}
          />
        </td>
        <td className="c-link">
          <ProspectLinkCell prospect={prospect} />
        </td>
        <td className="c-status">
          <ProspectStatusButton prospect={prospect} linkedApp={linkedApp} />
        </td>
        <td className="c-more">
          {fresh ? (
            <button
              type="button"
              className="icon-button new-cancel"
              aria-label="Cancel the new programme"
              title="Cancel"
              onClick={() => void cancelNew()}
            >
              <Icon name="close" />
            </button>
          ) : (
            <button
              type="button"
              className="icon-button card-enlarge"
              aria-label={`Open card for ${prospect.employer || "this programme"}`}
              title="Open card"
              onClick={() => void navigate({ view: "jobs", list: "shortlist", prospect: prospect.id })}
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

function ProspectSummaryLine({
  prospects,
  appsById,
}: {
  prospects: ProspectRow[];
  appsById: Map<string, ApplicationRow>;
}) {
  const s = summariseProspects(prospects, appsById);
  if (!prospects.length) return null;
  const parts = [
    `${s.open} open`,
    s.dueNow ? `${s.dueNow} to check now` : null,
    s.soon ? `${s.soon} within a week` : null,
    s.inProgress ? `${s.inProgress} in progress` : null,
    s.offers ? `${s.offers} ${s.offers === 1 ? "offer" : "offers"}` : null,
    s.closed ? `${s.closed} closed` : null,
  ].filter(Boolean);
  return (
    <p className="jobs-summary" aria-live="polite">
      {prospects.length} shortlisted {prospects.length === 1 ? "programme" : "programmes"}. {parts.join(", ")}.
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

function RecentlyDeletedProspects() {
  const deleted = useLiveQuery(async () =>
    (await db.prospects.toArray())
      .filter((p) => p.deleted && (p.employer.trim() || p.programme.trim()))
      .sort((a, b) => b.modified_at.localeCompare(a.modified_at)), [], []);
  if (!deleted.length) return null;
  return (
    <section className="section jobs-bin">
      <h2>Recently deleted</h2>
      <p className="small muted">Deleted shortlist programmes stay here for 90 days.</p>
      <ul className="list bin">
        {deleted.map((p) => (
          <li key={p.id}>
            <span className="label">{p.employer}{p.programme && <span className="muted">, {p.programme}</span>}</span>
            <span className="count">{shortDate(new Date(p.modified_at))}</span>
            <button type="button" className="quiet" onClick={async () => { await restoreProspect(p.id); showToast(`${p.employer} restored.`); }}>Restore</button>
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
  const allProspects = useLiveQuery(async () => (await db.prospects.toArray()).filter((p) => !p.deleted), [], null);
  const events = useLiveQuery(() => db.application_events.toArray(), [], []);

  const jobRoute = route.view === "jobs" ? route : null;
  const activeList = jobRoute?.list === "shortlist" ? "shortlist" : "applications";

  const appsById = useMemo(() => {
    const map = new Map<string, ApplicationRow>();
    if (all) {
      for (const a of all) map.set(a.id, a);
    }
    return map;
  }, [all]);

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

  const [prospectFilter, setProspectFilter] = useState<Filter>("all");
  const [prospectOrder, setProspectOrder] = useState<ProspectOrder>("next_check");
  const [prospectQuery, setProspectQuery] = useState("");
  const [freshProspect, setFreshProspect] = useState<string | null>(null);

  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const find = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (activeList === "shortlist" || !freshProspect) return;
    const id = freshProspect;
    void discardProspectIfBlank(id).then(() => setFreshProspect((f) => (f === id ? null : f)));
  }, [activeList, freshProspect]);

  useEffect(() => {
    if (activeList === "applications" || !fresh) return;
    const id = fresh;
    void discardIfBlank(id).then(() => setFresh((f) => (f === id ? null : f)));
  }, [activeList, fresh]);

  const add = useCallback(async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    try {
      if (activeList === "shortlist") {
        if (window.matchMedia?.(NARROW).matches) {
          void navigate({ view: "jobs", list: "shortlist", newApp: true });
          return;
        }
        setProspectFilter("all");
        setProspectQuery("");
        const id = await addProspect();
        setFreshProspect(id);
      } else {
        if (window.matchMedia?.(NARROW).matches) {
          void navigate({ view: "jobs", newApp: true });
          return;
        }
        setFilter("all");
        setQuery("");
        const id = await addApplication();
        setFresh(id);
      }
    } finally {
      setTimeout(() => {
        addingRef.current = false;
        setAdding(false);
      }, 400);
    }
  }, [activeList]);

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

  const shownProspects = useMemo(() => {
    if (!allProspects) return [];
    const kept = allProspects.filter((p) => {
      if (p.id === freshProspect) return true;
      const linked = p.application_id ? appsById.get(p.application_id) : undefined;
      const open = isProspectOpen(p, linked);
      if (prospectFilter !== "all" && (prospectFilter === "open") !== open) return false;
      return matchesProspect(p, prospectQuery, linked);
    });
    const sorted = sortProspects(kept.filter((p) => p.id !== freshProspect), prospectOrder, appsById);
    const added = kept.find((p) => p.id === freshProspect);
    return added ? [added, ...sorted] : sorted;
  }, [allProspects, prospectFilter, prospectOrder, prospectQuery, freshProspect, appsById]);

  if (!all || !allProspects) return <div className="page wide" aria-busy="true" />;

  const left = (id: string) => (_gone: boolean) => {
    setFresh((f) => (f === id ? null : f));
  };

  const leftProspect = (id: string) => (_gone: boolean) => {
    setFreshProspect((f) => (f === id ? null : f));
  };

  const counts = { all: all.length, open: all.filter(isOpen).length, closed: all.filter((a) => !isOpen(a)).length };
  const closedHeading = order === "deadline" && filter === "all" && shown.some(isOpen) && shown.some((a) => !isOpen(a));

  const prospectCounts = {
    all: allProspects.length,
    open: allProspects.filter((p) => isProspectOpen(p, p.application_id ? appsById.get(p.application_id) : undefined)).length,
    closed: allProspects.filter((p) => !isProspectOpen(p, p.application_id ? appsById.get(p.application_id) : undefined)).length,
  };
  const prospectClosedHeading =
    prospectOrder === "next_check" &&
    prospectFilter === "all" &&
    shownProspects.some((p) => isProspectOpen(p, p.application_id ? appsById.get(p.application_id) : undefined)) &&
    shownProspects.some((p) => !isProspectOpen(p, p.application_id ? appsById.get(p.application_id) : undefined));

  const currentApp = jobRoute?.app ? all.find((a) => a.id === jobRoute.app) : undefined;
  const currentProspect = jobRoute?.prospect ? allProspects.find((p) => p.id === jobRoute.prospect) : undefined;
  const isNarrow = narrow;

  return (
    <div className="page wide jobs">
      <div className="jobs-head">
        <div className="jobs-head-main">
          <h1>{activeList === "shortlist" ? "Shortlist" : "Applications"}</h1>
          <div className="segmented jobs-list-switch" role="group" aria-label="Job search views">
            <a
              href={href({ view: "jobs" })}
              className="tool"
              aria-current={activeList === "applications" ? "page" : undefined}
            >
              Applications <span className="seg-count">{all.length}</span>
            </a>
            <a
              href={href({ view: "jobs", list: "shortlist" })}
              className="tool"
              aria-current={activeList === "shortlist" ? "page" : undefined}
            >
              Shortlist <span className="seg-count">{allProspects.length}</span>
            </a>
          </div>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={adding}
          onClick={() => void add()}
          title={activeList === "shortlist" ? "Add to shortlist (N)" : "Add an application (N)"}
        >
          {adding ? "Adding…" : activeList === "shortlist" ? "Add to shortlist" : "Add application"}
        </button>
      </div>

      {activeList === "shortlist" ? (
        <>
          <ProspectSummaryLine prospects={allProspects} appsById={appsById} />

          {allProspects.length > 0 && (
            <div className="jobs-tools" role="group" aria-label="Show and order shortlist">
              <div className="segmented" role="group" aria-label="Show">
                {(["all", "open", "closed"] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="tool"
                    aria-pressed={prospectFilter === f}
                    onClick={() => setProspectFilter(f)}
                  >
                    {f === "all" ? "All" : f === "open" ? "Open" : "Closed"}{" "}
                    <span className="seg-count">{prospectCounts[f]}</span>
                  </button>
                ))}
              </div>
              <ProspectOrderButton order={prospectOrder} onChange={setProspectOrder} />
              <SearchField
                ref={find}
                className="jobs-find"
                value={prospectQuery}
                onChange={setProspectQuery}
                label="Find in shortlist (/)"
                placeholder="Find an employer, programme or salary"
              />
            </div>
          )}

          {allProspects.length === 0 ? (
            <div className="jobs-empty">
              <p>No programmes on the shortlist yet.</p>
              <p className="muted small">
                Add graduate schemes and roles you plan to apply to, with the next date to check them and when they opened last year.
              </p>
            </div>
          ) : shownProspects.length === 0 ? (
            <p className="muted jobs-none">
              {prospectQuery
                ? `Nothing matches “${prospectQuery}”.`
                : prospectFilter === "open"
                  ? "No open programmes."
                  : "No closed programmes."}
            </p>
          ) : isNarrow ? (
            <ProspectList
              prospects={shownProspects}
              appsById={appsById}
              closedHeading={prospectClosedHeading}
            />
          ) : (
            <div className="apps-wrap">
              <table className="apps shortlist-table">
                <colgroup>
                  <col className="w-check" />
                  <col className="w-last-open" />
                  <col className="w-employer" />
                  <col className="w-programme" />
                  <col className="w-salary" />
                  <col className="w-link" />
                  <col className="w-status" />
                  <col className="w-more" />
                </colgroup>
                <thead ref={setHead}>
                  <tr>
                    <th scope="col">Next check</th>
                    <th scope="col">Last year open</th>
                    <th scope="col">Employer</th>
                    <th scope="col">Programme</th>
                    <th scope="col">Salary</th>
                    <th scope="col">Link</th>
                    <th scope="col">Your status</th>
                    <th scope="col"><span className="sr-only">Details</span></th>
                  </tr>
                </thead>
                {shownProspects.map((p, i) => {
                  const linked = p.application_id ? appsById.get(p.application_id) : undefined;
                  const open = isProspectOpen(p, linked);
                  const prevLinked =
                    i > 0 && shownProspects[i - 1].application_id
                      ? appsById.get(shownProspects[i - 1].application_id!)
                      : undefined;
                  const prevOpen = i > 0 ? isProspectOpen(shownProspects[i - 1], prevLinked) : true;
                  return (
                    <Fragment key={p.id}>
                      {prospectClosedHeading && !open && (i === 0 || prevOpen) && p.id !== freshProspect && (
                        <tbody className="closed-head">
                          <tr>
                            <th colSpan={8} scope="rowgroup">Closed</th>
                          </tr>
                        </tbody>
                      )}
                      <ProspectTableRow
                        prospect={p}
                        linkedApp={linked}
                        fresh={freshProspect === p.id}
                        onLeft={leftProspect(p.id)}
                      />
                    </Fragment>
                  );
                })}
              </table>
            </div>
          )}

          {jobRoute?.newApp && (
            <Sheet
              open={true}
              onClose={() => void navigate({ view: "jobs", list: "shortlist" })}
              title="New shortlist programme"
              className="new-app-sheet new-prospect-sheet"
              tall
            >
              <ProspectForm
                mode="new"
                onSave={async (fields) => {
                  const id = await addProspect(fields);
                  showToast(`${fields.employer || "Programme"} added to shortlist.`);
                  void navigate({ view: "jobs", list: "shortlist", prospect: id });
                }}
                onCancel={() => void navigate({ view: "jobs", list: "shortlist" })}
              />
            </Sheet>
          )}

          {currentProspect && jobRoute?.edit && (
            <Sheet
              open={true}
              onClose={() => void navigate({ view: "jobs", list: "shortlist", prospect: currentProspect.id })}
              title={`Edit ${currentProspect.employer || "programme"}`}
              subtitle={currentProspect.programme || undefined}
              className="edit-app-sheet edit-prospect-sheet"
              tall
            >
              <ProspectForm
                mode="edit"
                initialProspect={currentProspect}
                onSave={async (patch) => {
                  await saveProspect(currentProspect.id, patch);
                  showToast("Programme saved.");
                  void navigate({ view: "jobs", list: "shortlist", prospect: currentProspect.id });
                }}
                onCancel={() => void navigate({ view: "jobs", list: "shortlist", prospect: currentProspect.id })}
              />
            </Sheet>
          )}

          {currentProspect && (
            <ProspectSheet
              prospect={currentProspect}
              linkedApp={currentProspect.application_id ? appsById.get(currentProspect.application_id) : undefined}
              onClose={() => void navigate({ view: "jobs", list: "shortlist" })}
            />
          )}

          <RecentlyDeletedProspects />
        </>
      ) : (
        <>
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
              <SearchField
                ref={find}
                className="jobs-find"
                value={query}
                onChange={setQuery}
                label="Find an application (/)"
                placeholder="Find an employer or role"
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
              onClose={() => void navigate({ view: "jobs" })}
              title="New application"
              className="new-app-sheet"
              tall
            >
              <ApplicationForm
                mode="new"
                onSave={async (fields) => {
                  const id = await addApplication(fields);
                  showToast(`${fields.employer || "Application"} added.`);
                  void navigate({ view: "jobs", app: id });
                }}
                onCancel={() => void navigate({ view: "jobs" })}
              />
            </Sheet>
          )}

          {currentApp && jobRoute?.edit && (
            <Sheet
              open={true}
              onClose={() => void navigate({ view: "jobs", app: currentApp.id })}
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
                  void navigate({ view: "jobs", app: currentApp.id });
                }}
                onCancel={() => void navigate({ view: "jobs", app: currentApp.id })}
              />
            </Sheet>
          )}

          {currentApp && jobRoute?.entry && (
            <Sheet
              open={true}
              onClose={() => void navigate({ view: "jobs", app: currentApp.id })}
              title={jobRoute.entry === "new" ? "Add event" : "Edit timeline entry"}
              subtitle={currentApp.employer}
              className="entry-sheet"
              tall
            >
              <EntryForm
                app={currentApp}
                entry={jobRoute.entry !== "new" ? eventsFor(currentApp.id).find((e) => e.id === jobRoute.entry) : undefined}
                onDone={() => void navigate({ view: "jobs", app: currentApp.id })}
                variant="sheet"
              />
            </Sheet>
          )}

          {currentApp && (
            <AppSheet
              app={currentApp}
              events={eventsFor(currentApp.id)}
              tab={jobRoute?.tab}
              onClose={() => void navigate({ view: "jobs" })}
            />
          )}

          <RecentlyDeleted />
        </>
      )}
    </div>
  );
}
