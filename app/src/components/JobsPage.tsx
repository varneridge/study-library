// The job search: every application on one page. On a wide screen it is a
// table you edit in place, with a two-row header that stays in view. On a
// phone each application is a card that opens to edit. Either way, Details
// holds notes, the four files and Delete.

import { useLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { db } from "../lib/db";
import {
  addApplication, ATTACH_ACCEPT, attachFile, CATEGORY_LABEL, deadlineState, deadlineWords, deleteApplication, discardIfBlank,
  formatDate, isOpen, matches, normaliseUrl, restoreApplication, saveApplication, setSlot, sizeText, slotColumn, slotHref,
  SLOTS, sortApplications, STAGES, stageOf, summarise, type Order,
} from "../lib/jobs";
import type { ApplicationRow, FileSlot, SlotName } from "../lib/types";
import { showToast, typing, useNarrow, useTitle } from "../lib/ui";
import { Icon } from "./icons";
import { Menu } from "./Menu";
import { shortDate } from "../lib/dates";

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

// A text field that saves as you type, after a pause, and on leaving it.
// Another device's change shows unless you are typing in this field.
// With wrap, a single line that wraps to fit its cell rather than being cut
// off; Enter finishes it instead of starting a new line.
function TextField({ value, onSave, label, placeholder, multiline, wrap, className, autoFocus, id }: {
  value: string; onSave: (value: string) => void; label: string; placeholder?: string;
  multiline?: boolean; wrap?: boolean; className?: string; autoFocus?: boolean; id?: string;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (!focused.current) setText(value); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  const save = (next = text) => {
    clearTimeout(timer.current);
    const clean = multiline ? next.replace(/[ \t]+$/gm, "").trim() : next.replace(/\s+/g, " ").trim();
    if (clean !== value) onSave(clean);
  };
  const common = {
    id, className, value: text, placeholder, autoFocus, "aria-label": label,
    onFocus: () => { focused.current = true; },
    onBlur: () => { focused.current = false; save(); },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      clearTimeout(timer.current);
      const next = e.target.value;
      timer.current = setTimeout(() => save(next), 600);
    },
  };
  if (wrap) {
    return (
      <textarea
        ref={area} rows={1} {...common}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
      />
    );
  }
  return multiline ? <textarea ref={area} rows={2} {...common} /> : <input type="text" {...common} />;
}

// A date shown as "26 Feb 2026". Choosing it opens the browser's own date
// picker, which suits a phone; the stored form is always YYYY-MM-DD.
function DateField({ value, onSave, label, clearable, empty = "Add date", className }: {
  value: string | null; onSave: (value: string | null) => void; label: string; clearable?: boolean; empty?: string; className?: string;
}) {
  // "pointer" when opened by a click or tap, which also opens the picker;
  // "keys" when opened from the keyboard, so the date can be typed.
  const [editing, setEditing] = useState<false | "pointer" | "keys">(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editing) return;
    const el = input.current;
    el?.focus();
    if (editing === "pointer") {
      try { el?.showPicker?.(); } catch { /* Some browsers only open it on a direct tap. */ }
    }
  }, [editing]);
  if (editing) {
    return (
      <span className="date-edit">
        <input
          ref={input} type="date" value={value ?? ""} aria-label={label}
          onChange={(e) => { if (e.target.value) onSave(e.target.value); }}
          onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setEditing(false); }}
          onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); setEditing(false); } }}
        />
        {clearable && value && (
          <button type="button" className="quiet" onClick={() => { onSave(null); setEditing(false); }}>Clear</button>
        )}
      </span>
    );
  }
  return (
    <button type="button" className={`date-show${value ? "" : " empty"}${className ? ` ${className}` : ""}`} aria-label={`${label}: ${value ? formatDate(value) : "none"}. Change`} onClick={(e) => setEditing(e.detail === 0 ? "keys" : "pointer")}>
      {value ? formatDate(value) : empty}
    </button>
  );
}

function StageSelect({ app, label = "Stage" }: { app: ApplicationRow; label?: string }) {
  const stage = stageOf(app.stage);
  return (
    <select
      className={`stage-chip cat-${stage.cat}`}
      value={app.stage}
      aria-label={label}
      title={CATEGORY_LABEL[stage.cat]}
      onChange={(e) => void saveApplication(app.id, { stage: e.target.value })}
    >
      {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      {!STAGES.some((s) => s.key === app.stage) && <option value={app.stage}>{app.stage}</option>}
    </select>
  );
}

function Deadline({ app, editable = true }: { app: ApplicationRow; editable?: boolean }) {
  const state = deadlineState(app);
  const words = deadlineWords(app);
  return (
    <span className={`deadline state-${state}`}>
      {editable
        ? <DateField value={app.next_deadline} label="Next deadline" clearable empty="None" className="deadline-date" onSave={(v) => void saveApplication(app.id, { next_deadline: v })} />
        : <span className="deadline-date">{app.next_deadline ? formatDate(app.next_deadline) : ""}</span>}
      {words && <span className="deadline-words">{words}</span>}
    </span>
  );
}

function slotTitle(label: string, slot: FileSlot | null): string {
  if (!slot) return `${label}: not recorded`;
  if (slot.state === "na") return `${label}: not required`;
  if (slot.key) return `${label}: ${slot.name ?? "file"}. Open it`;
  if (slot.url) return `${label}: ${slot.url}. Open the link`;
  return `${label}: sent, no file attached`;
}

// One of the four file marks in the table. A sent file with something
// attached opens it; any other mark opens Details at the files. A file
// dropped on a mark is attached to it.
function SlotMark({ app, slot, onOpen }: { app: ApplicationRow; slot: (typeof SLOTS)[number]; onOpen: () => void }) {
  const value = app[slotColumn(slot.name)];
  const link = slotHref(value);
  const [over, setOver] = useState(false);
  const drop = {
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } },
    onDragLeave: () => setOver(false),
    onDrop: async (e: React.DragEvent) => {
      const file = e.dataTransfer.files[0];
      setOver(false);
      if (!file) return;
      e.preventDefault();
      await attachTo(app, slot.name, file);
    },
  };
  const title = slotTitle(slot.label, value);
  const cls = `slot${over ? " over" : ""}`;
  if (link) {
    return <a className={`${cls} saved attached`} href={link} target="_blank" rel="noopener" title={title} aria-label={title} {...drop}>✓</a>;
  }
  if (value?.state === "saved") return <button type="button" className={`${cls} saved`} title={title} aria-label={title} onClick={onOpen} {...drop}>✓</button>;
  if (value?.state === "na") return <button type="button" className={`${cls} na`} title={title} aria-label={title} onClick={onOpen} {...drop}>N/A</button>;
  return <button type="button" className={`${cls} empty`} title={title} aria-label={title} onClick={onOpen} {...drop}><span aria-hidden="true" /></button>;
}

async function attachTo(app: ApplicationRow, slot: SlotName, file: File): Promise<boolean> {
  try {
    showToast(`Attaching ${file.name}`, undefined, 3000);
    const value = await attachFile(file);
    await setSlot(app.id, slot, value);
    showToast(`${SLOTS.find((s) => s.name === slot)!.label} attached to ${app.employer || "the application"}.`);
    return true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "That file could not be attached.");
    return false;
  }
}

// A slot in Details, with what can be done to it.
function SlotRow({ app, slot, narrow }: { app: ApplicationRow; slot: (typeof SLOTS)[number]; narrow: boolean }) {
  const value = app[slotColumn(slot.name)];
  const picker = useRef<HTMLInputElement>(null);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (next: FileSlot | null) => void setSlot(app.id, slot.name, next);
  const attached = value?.state === "saved" && (value.key || value.url);
  const link = slotHref(value);

  let status: React.ReactNode = <span className="muted">Not recorded</span>;
  if (value?.state === "na") status = <span className="muted">Not required</span>;
  if (value?.state === "saved") {
    status = value.key
      ? <a href={link!} target="_blank" rel="noopener">{value.name ?? "Open file"}</a>
      : value.url
        ? <a href={link!} target="_blank" rel="noopener" className="slot-url">{value.url.replace(/^https?:\/\//, "")}</a>
        : <span>Sent, no file attached</span>;
  }

  const saveLink = () => {
    const clean = normaliseUrl(url);
    if (!clean) { showToast("That doesn't look like a web address."); return; }
    set({ state: "saved", url: clean });
    setLinking(false);
    setUrl("");
  };

  return (
    <li className="slot-row">
      <span className="slot-label">{slot.label}</span>
      <span className="slot-status">
        {status}
        {value?.state === "saved" && value.key && value.bytes ? <span className="muted small"> {sizeText(value.bytes)}</span> : null}
      </span>
      <span className="slot-actions">
        <input
          ref={picker} type="file" accept={ATTACH_ACCEPT} hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            await attachTo(app, slot.name, file);
            setBusy(false);
          }}
        />
        {linking ? (
          <span className="link-edit">
            <input
              type="url" inputMode="url" enterKeyHint="done" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              value={url} autoFocus placeholder="https://" aria-label={`Link for the ${slot.label.toLowerCase()}`}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveLink(); } if (e.key === "Escape") setLinking(false); }}
            />
            <button type="button" className="quiet" onClick={saveLink}>Save</button>
            <button type="button" className="quiet" onClick={() => setLinking(false)}>Cancel</button>
          </span>
        ) : narrow ? (
          // On a phone the choices sit in one menu, which opens as a sheet.
          <Menu
            label={`Change the ${slot.label.toLowerCase()}`}
            items={[
              { label: value?.state === "saved" && value.key ? `Open ${value.name ?? "the file"}` : "Open the link", onSelect: () => { if (link) window.open(link, "_blank", "noopener"); }, hidden: !attached },
              { label: busy ? "Attaching" : value?.state === "saved" && value.key ? "Replace the file" : "Attach a file", onSelect: () => picker.current?.click() },
              { label: value?.state === "saved" && value.url ? "Change the link" : "Add a link", onSelect: () => setLinking(true), hidden: Boolean(value?.state === "saved" && value.key) },
              { label: "Sent, no file", onSelect: () => set({ state: "saved" }), hidden: value?.state === "saved" },
              { label: value?.state === "saved" && value.key ? "Remove the file" : "Remove the link", onSelect: () => set({ state: "saved" }), hidden: !attached },
              { label: "Not required", onSelect: () => set({ state: "na" }), hidden: value?.state === "na" },
              { label: "Clear", onSelect: () => set(null), hidden: !value, danger: true },
            ]}
          />
        ) : (
          <>
            <button type="button" className="quiet" disabled={busy} onClick={() => picker.current?.click()}>
              {busy ? "Attaching" : value?.state === "saved" && value.key ? "Replace" : "Attach file"}
            </button>
            {!(value?.state === "saved" && value.key) && <button type="button" className="quiet" onClick={() => setLinking(true)}>{value?.state === "saved" && value.url ? "Change link" : "Add link"}</button>}
            {value?.state !== "saved" && <button type="button" className="quiet" onClick={() => set({ state: "saved" })}>Sent, no file</button>}
            {attached && <button type="button" className="quiet" onClick={() => set({ state: "saved" })}>{value?.key ? "Remove file" : "Remove link"}</button>}
            {value?.state !== "na" && <button type="button" className="quiet" onClick={() => set({ state: "na" })}>Not required</button>}
            {value && <button type="button" className="quiet" onClick={() => set(null)}>Clear</button>}
          </>
        )}
      </span>
    </li>
  );
}

function Details({ app, narrow, focusEmployer, onDone }: { app: ApplicationRow; narrow: boolean; focusEmployer: boolean; onDone?: () => void }) {
  return (
    <div className="app-details">
      {narrow && (
        <div className="app-fields">
          <label>Employer<TextField value={app.employer} label="Employer" placeholder="Required" autoFocus={focusEmployer} onSave={(v) => void saveApplication(app.id, { employer: v })} /></label>
          <label>Role<TextField value={app.role} label="Role" placeholder="Required" onSave={(v) => void saveApplication(app.id, { role: v })} /></label>
          <div className="field-pair">
            <span className="field"><span className="field-label">Applied</span><DateField value={app.applied} label="Applied" onSave={(v) => void saveApplication(app.id, { applied: v })} /></span>
            <span className="field"><span className="field-label">Next deadline</span><Deadline app={app} /></span>
          </div>
          <span className="field"><span className="field-label">Stage</span><StageSelect app={app} /></span>
        </div>
      )}
      <div className="app-notes">
        <TextField
          multiline value={app.notes ?? ""} label={`Notes on ${app.employer || "this application"}`}
          placeholder="Notes: contacts, interview times, what they asked"
          onSave={(v) => void saveApplication(app.id, { notes: v || null })}
        />
      </div>
      <ul className="slot-list" aria-label="Files">
        {SLOTS.map((slot) => <SlotRow key={slot.name} app={app} slot={slot} narrow={narrow} />)}
      </ul>
      <div className="app-foot">
        {/* On a phone the card closes from its foot, where the thumb is after editing. */}
        {onDone && <button type="button" className="button" onClick={onDone}>Done</button>}
        <button
          type="button" className="quiet danger"
          onClick={async () => {
            await deleteApplication(app.id);
            showToast(`${app.employer || "Application"} deleted.`, { label: "Undo", run: () => void restoreApplication(app.id) });
          }}
        >
          Delete application
        </button>
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

function TableRow({ app, open, fresh, onToggle, onLeft }: {
  app: ApplicationRow; open: boolean; fresh: boolean; onToggle: (to?: boolean) => void; onLeft: (gone: boolean) => void;
}) {
  const leave = useDiscardWhenLeft(app.id, fresh, onLeft);
  return (
    <tbody className={`app${isOpen(app) ? "" : " closed"}${open ? " expanded" : ""}`} data-app={app.id} data-employer={app.employer} onBlur={leave}>
      <tr>
        <td className="c-employer">
          <TextField wrap className="cell-input strong" value={app.employer} label="Employer" placeholder="Employer" autoFocus={fresh} onSave={(v) => void saveApplication(app.id, { employer: v })} />
        </td>
        <td className="c-role">
          <TextField wrap className="cell-input" value={app.role} label="Role" placeholder="Role" onSave={(v) => void saveApplication(app.id, { role: v })} />
        </td>
        <td className="c-applied"><DateField value={app.applied} label="Applied" onSave={(v) => void saveApplication(app.id, { applied: v })} /></td>
        <td className="c-stage"><StageSelect app={app} /></td>
        <td className="c-deadline"><Deadline app={app} /></td>
        {SLOTS.map((slot) => <td key={slot.name} className="c-slot"><SlotMark app={app} slot={slot} onOpen={() => onToggle(true)} /></td>)}
        <td className="c-more"><DetailsToggle open={open} app={app} onToggle={() => onToggle()} /></td>
      </tr>
      {open && (
        <tr className="details-row">
          <td colSpan={10}><Details app={app} narrow={false} focusEmployer={false} /></td>
        </tr>
      )}
    </tbody>
  );
}

function Card({ app, open, fresh, onToggle, onLeft }: {
  app: ApplicationRow; open: boolean; fresh: boolean; onToggle: (to?: boolean) => void; onLeft: (gone: boolean) => void;
}) {
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
          {app.next_deadline && <span className="card-due">Due <Deadline app={app} editable={false} /></span>}
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
      {open && <Details app={app} narrow focusEmployer={fresh} onDone={() => {
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
  const [filter, setFilter] = useState<Filter>("all");
  const [order, setOrder] = useState<Order>("deadline");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const find = useRef<HTMLInputElement>(null);

  const add = useCallback(async () => {
    if (adding) return;
    setAdding(true);
    try {
      setFilter("all");
      setQuery("");
      const id = await addApplication();
      setFresh(id);
      // On a phone the new card opens, with the employer ready to type.
      if (window.matchMedia?.(NARROW).matches) setOpen((s) => new Set(s).add(id));
    } finally {
      setAdding(false);
    }
  }, [adding]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
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

  return (
    <div className="page wide jobs">
      <div className="jobs-head">
        <h1>Applications</h1>
        <button type="button" className="button primary" disabled={adding} onClick={() => void add()} title="Add an application (N)">{adding ? "Adding…" : "Add application"}</button>
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
          <label className="jobs-order">
            <span className="muted small">Order</span>
            <select aria-label="Order" value={order} onChange={(e) => setOrder(e.target.value as Order)}>
              <option value="deadline">Next deadline</option>
              <option value="applied">Date applied</option>
              <option value="employer">Employer</option>
            </select>
          </label>
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
            <Card key={app.id} app={app} open={open.has(app.id)} fresh={fresh === app.id} onToggle={toggle(app.id)} onLeft={left(app.id)} />
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
            {shown.map((app) => (
              <TableRow key={app.id} app={app} open={open.has(app.id)} fresh={fresh === app.id} onToggle={toggle(app.id)} onLeft={left(app.id)} />
            ))}
          </table>
        </div>
      )}

      <RecentlyDeleted />
    </div>
  );
}
