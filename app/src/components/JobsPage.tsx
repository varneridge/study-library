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
import { showToast, typing, useCloseOnBack, useNarrow, useTitle } from "../lib/ui";
import { Icon } from "./icons";
import { shortDate } from "../lib/dates";
import { DateField, Deadline, OrderButton, SlotMark, SlotRow, slotTitle, StageButton, TextField, Timeline } from "./jobs/Controls";

type Filter = "all" | "open" | "closed";

// Below this width the table becomes cards.
const NARROW = "(max-width: 60rem)";

// The table header stays in view just under the top bar, whatever its height.
function useTopbarHeight(): void {
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>(".topbar");
    if (!bar) return;
    const set = () => {
      document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
      const head = document.querySelector<HTMLElement>(".apps thead");
      if (head) document.documentElement.style.setProperty("--apps-head-h", `${head.offsetHeight}px`);
    };
    set();
    const observer = new ResizeObserver(set);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
}

function Details({ app, events, narrow, focusEmployer, onDone }: {
  app: ApplicationRow; events: ApplicationEventRow[]; narrow: boolean; focusEmployer: boolean; onDone: () => void;
}) {
  const remove = async () => {
    await deleteApplication(app.id);
    showToast(`${app.employer || "Application"} deleted.`, { label: "Undo", run: () => void restoreApplication(app.id) });
  };
  const notes = (
    <TextField
      multiline value={app.notes ?? ""} label={`Notes on ${app.employer || "this application"}`}
      placeholder="Notes: contacts, interview times, what they asked"
      onSave={(v) => void saveApplication(app.id, { notes: v || null })}
    />
  );
  const files = <ul className="slot-list" aria-label="Files">{SLOTS.map((slot) => <SlotRow key={slot.name} app={app} slot={slot} />)}</ul>;
  if (narrow) {
    return (
      <div className="app-details">
        <div className="app-fields">
          <label>Employer<TextField value={app.employer} label="Employer" placeholder="Required" autoFocus={focusEmployer} onSave={(v) => void saveApplication(app.id, { employer: v })} /></label>
          <label>Role<TextField value={app.role} label="Role" placeholder="Required" onSave={(v) => void saveApplication(app.id, { role: v })} /></label>
          <div className="field-pair">
            <span className="field"><span className="field-label">Applied</span><DateField value={app.applied} label="Applied" onSave={(v) => void saveAppliedDate(app, v)} /></span>
            <span className="field"><span className="field-label">Next deadline</span><Deadline app={app} /></span>
          </div>
          <span className="field"><span className="field-label">Stage</span><StageButton app={app} since={currentStageSince(app, events)} /></span>
        </div>
        <div className="app-notes">{notes}</div>
        <Timeline app={app} events={events} />
        {files}
        {/* On a phone the card closes from its foot, where the thumb is after editing. */}
        <div className="app-foot"><button type="button" className="button" onClick={onDone}>Done</button></div>
        {/* Delete stands apart from Done, as dangerous actions do. */}
        <div className="app-danger"><button type="button" className="quiet danger" onClick={remove}>Delete application</button></div>
      </div>
    );
  }
  return (
    <div className="app-details wide">
      <div className="app-notes"><h3 className="detail-head">Notes</h3>{notes}</div>
      <Timeline app={app} events={events} />
      <div className="app-files"><h3 className="detail-head">Files</h3>{files}</div>
      <div className="app-foot">
        <button type="button" className="button" onClick={onDone}>Close</button>
        <button type="button" className="quiet danger" onClick={remove}>Delete application</button>
      </div>
    </div>
  );
}

function DetailsToggle({ open, onToggle, app }: { open: boolean; onToggle: () => void; app: ApplicationRow }) {
  return (
    <button
      type="button" className={`icon-button details-toggle${open ? " open" : ""}`}
      aria-expanded={open} aria-label={`Details for ${app.employer || "this application"}`} title="Notes, files and Delete"
      onClick={onToggle}
    >
      <Icon name="caret" />
    </button>
  );
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

function TableRow({ app, events, open, fresh, onToggle, onLeft }: {
  app: ApplicationRow; events: ApplicationEventRow[]; open: boolean; fresh: boolean; onToggle: (to?: boolean) => void; onLeft: (gone: boolean) => void;
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
    <tbody className={`app${isOpen(app) ? "" : " closed"}${open ? " expanded" : ""}`} data-app={app.id} data-employer={app.employer} onBlur={leave}>
      <tr>
        <td className="c-employer">
          <TextField wrap className="cell-input strong" value={app.employer} label="Employer" placeholder="Employer" autoFocus={fresh} onSave={(v) => void saveApplication(app.id, { employer: v })} />
        </td>
        <td className="c-role">
          <TextField wrap className="cell-input" value={app.role} label="Role" placeholder="Role" onSave={(v) => void saveApplication(app.id, { role: v })} />
        </td>
        <td className="c-applied"><DateField value={app.applied} label="Applied" onSave={(v) => void saveAppliedDate(app, v)} /></td>
        <td className="c-stage">
          <StageButton app={app} since={since} />
          {since && isOpen(app) && <span className="stage-since">{inStageWords(since)}</span>}
        </td>
        <td className="c-deadline"><Deadline app={app} /></td>
        {SLOTS.map((slot) => <td key={slot.name} className="c-slot"><SlotMark app={app} slot={slot} /></td>)}
        <td className="c-more">
          {fresh
            ? <button type="button" className="icon-button new-cancel" aria-label="Cancel the new application" title="Cancel" onClick={() => void cancelNew()}><Icon name="close" /></button>
            : <DetailsToggle open={open} app={app} onToggle={() => onToggle()} />}
        </td>
      </tr>
      {open && (
        <tr className="details-row">
          <td colSpan={10}>
            <Details
              app={app} events={events} narrow={false} focusEmployer={false}
              onDone={() => { onToggle(false); requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-app="${app.id}"] .details-toggle`)?.focus()); }}
            />
          </td>
        </tr>
      )}
    </tbody>
  );
}

function Card({ app, events, open, fresh, onToggle, onLeft }: {
  app: ApplicationRow; events: ApplicationEventRow[]; open: boolean; fresh: boolean; onToggle: (to?: boolean) => void; onLeft: (gone: boolean) => void;
}) {
  useCloseOnBack(open, () => onToggle(false));
  const leave = useDiscardWhenLeft(app.id, fresh, onLeft);
  const stage = stageOf(app.stage);
  return (
    <li className={`app-card${isOpen(app) ? "" : " closed"}${open ? " expanded" : ""}`} data-app={app.id} onBlur={leave}>
      <button type="button" className="card-head" aria-expanded={open} onClick={() => onToggle()}>
        <span className="card-top">
          <span className="card-employer">{app.employer || <span className="muted">New application</span>}</span>
          <span className={`stage-tag cat-${stage.cat}`} title={stage.label}>{stage.label}</span>
        </span>
        {app.role && <span className="card-role">{app.role}</span>}
        <span className="card-meta">
          {app.applied && <span>Applied {formatDate(app.applied)}</span>}
          {app.next_deadline && isOpen(app) && <span className="card-due">Due <Deadline app={app} editable={false} /></span>}
        </span>
        <span className="card-slots" aria-label="Files">
          {SLOTS.map((slot) => {
            const value = app[slotColumn(slot.name)];
            const mark = value?.state === "saved" ? "✓" : value?.state === "na" ? "N/A" : "";
            return (
              <span key={slot.name} className={`mini-slot${value ? ` ${value.state}` : ""}`} title={slotTitle(slot.label, value)}>
                {slot.short} <b>{mark || <span aria-label="not recorded">·</span>}</b>
              </span>
            );
          })}
        </span>
      </button>
      {open && <Details app={app} events={events} narrow focusEmployer={fresh} onDone={() => {
        onToggle(false);
        requestAnimationFrame(() => document.querySelector(`[data-app="${app.id}"] .card-head`)?.scrollIntoView({ block: "nearest" }));
      }} />}
    </li>
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
  useTopbarHeight();
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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  const find = useRef<HTMLInputElement>(null);

  const add = useCallback(async () => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    try {
      setFilter("all");
      setQuery("");
      const id = await addApplication();
      setFresh(id);
      // On a phone the new card opens, with the employer ready to type.
      if (window.matchMedia?.(NARROW).matches) setOpen((s) => new Set(s).add(id));
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

  const toggle = (id: string) => (to?: boolean) => setOpen((current) => {
    const next = new Set(current);
    const want = to ?? !next.has(id);
    if (want) next.add(id); else next.delete(id);
    return next;
  });
  const left = (id: string) => (gone: boolean) => {
    setFresh((f) => (f === id ? null : f));
    if (gone) setOpen((s) => { const n = new Set(s); n.delete(id); return n; });
  };
  const counts = { all: all.length, open: all.filter(isOpen).length, closed: all.filter((a) => !isOpen(a)).length };
  const closedHeading = order === "deadline" && filter === "all" && shown.some(isOpen) && shown.some((a) => !isOpen(a));

  return (
    <div className="page wide jobs">
      <div className="jobs-head">
        <h1>Applications</h1>
        <button
          type="button"
          className="button primary"
          disabled={adding}
          onClick={(e) => {
            e.currentTarget.disabled = true;
            void add();
          }}
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
      ) : narrow ? (
        <ul className="app-cards">
          {shown.map((app) => (
            <Card key={app.id} app={app} events={eventsFor(app.id)} open={open.has(app.id)} fresh={fresh === app.id} onToggle={toggle(app.id)} onLeft={left(app.id)} />
          ))}
        </ul>
      ) : (
        <div className="apps-wrap">
          <table className="apps">
            <colgroup>
              <col className="w-employer" /><col className="w-role" /><col className="w-applied" /><col className="w-stage" /><col className="w-deadline" />
              <col className="w-slot" /><col className="w-slot" /><col className="w-slot" /><col className="w-slot" /><col className="w-more" />
            </colgroup>
            <thead>
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
                <TableRow app={app} events={eventsFor(app.id)} open={open.has(app.id)} fresh={fresh === app.id} onToggle={toggle(app.id)} onLeft={left(app.id)} />
              </Fragment>
            ))}
          </table>
        </div>
      )}

      <RecentlyDeleted />
    </div>
  );
}
