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
  addApplication, addManualEvent, ATTACH_ACCEPT, cancelNewApplication, attachFile, CATEGORY_LABEL, changeStage, currentStageSince, daysInStage, daysSinceApplied,
  deadlineState, deadlineWords, deleteApplication, discardIfBlank, entryDate, entryTimeText, formatDate, getTimelineEntries,
  inStageWords, isOpen, likelyNextStages, matches, normaliseUrl, removeEvent, restoreApplication, saveApplication, saveAppliedDate, saveEntry, setSlot,
  sizeText, slotColumn, slotHref, SLOTS, sortApplications, STAGE_GRID, stageOf, stageShort, stepLength, summarise, todayIso, type Order,
} from "../lib/jobs";
import type { ApplicationEventRow, ApplicationRow, FileSlot, SlotName } from "../lib/types";
import { showToast, typing, useCloseOnBack, useNarrow, useTitle } from "../lib/ui";
import { Icon } from "./icons";
import { ChoiceCard } from "./ChoiceCard";
import { shortDate } from "../lib/dates";

type Filter = "all" | "open" | "closed";
type Slot = (typeof SLOTS)[number];

// Below this width the table becomes cards.
const NARROW = "(max-width: 60rem)";
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const coarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;

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
// Another device's change shows unless you are typing in this field. Escape
// in a single line puts back what was there when you started and leaves it.
// With wrap, a single line that wraps to fit its cell rather than being cut
// off; Enter finishes it instead of starting a new line.
function TextField({ value, onSave, label, placeholder, multiline, wrap, className, autoFocus, id }: {
  value: string; onSave: (value: string) => void; label: string; placeholder?: string;
  multiline?: boolean; wrap?: boolean; className?: string; autoFocus?: boolean; id?: string;
}) {
  const [text, setText] = useState(value);
  const focused = useRef(false);
  const original = useRef(value);
  const skip = useRef(false);
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
  const revert = (el: HTMLElement) => {
    clearTimeout(timer.current);
    setText(original.current);
    // A pause may already have saved part of the change, so put it back.
    if (original.current !== value) onSave(original.current);
    skip.current = true;
    el.blur();
  };
  const common = {
    id, className, value: text, placeholder, autoFocus, "aria-label": label,
    onFocus: () => { focused.current = true; original.current = value; },
    onBlur: () => {
      focused.current = false;
      if (skip.current) { skip.current = false; return; }
      save();
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setText(e.target.value);
      clearTimeout(timer.current);
      const next = e.target.value;
      timer.current = setTimeout(() => save(next), 600);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === "Escape" && !multiline) { e.preventDefault(); e.stopPropagation(); revert(e.currentTarget); }
      else if (e.key === "Enter" && wrap) { e.preventDefault(); e.currentTarget.blur(); }
    },
  };
  if (wrap) return <textarea ref={area} rows={1} {...common} />;
  return multiline ? <textarea ref={area} rows={2} {...common} /> : <input type="text" {...common} />;
}

// A date shown as "26 Feb 2026". Choosing it opens the browser's own date
// picker, which suits a phone; the stored form is always YYYY-MM-DD. A date
// is kept on Enter or on leaving the field, never on each key typed, and
// Escape or Cancel puts back what was there. On a touch screen the picker's
// choice is kept as soon as it is made, as leaving the field there is less
// certain.
function DateField({ value, onSave, label, clearable, empty = "Add date", className }: {
  value: string | null; onSave: (value: string | null) => void; label: string; clearable?: boolean; empty?: string; className?: string;
}) {
  // "pointer" when opened by a click or tap, which also opens the picker;
  // "keys" when opened from the keyboard, so the date can be typed.
  const [editing, setEditing] = useState<false | "pointer" | "keys">(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const shown = useRef<HTMLButtonElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    if (!editing) return;
    const el = input.current;
    el?.focus();
    if (editing === "pointer") {
      try { el?.showPicker?.(); } catch { /* Some browsers only open it on a direct tap. */ }
    }
  }, [editing]);
  const start = (how: "pointer" | "keys") => { settled.current = false; setDraft(value ?? ""); setEditing(how); };
  const finish = (keep: boolean, refocus = false) => {
    if (settled.current) return;
    settled.current = true;
    if (keep && DATE_ONLY.test(draft) && draft !== value) onSave(draft);
    setEditing(false);
    if (refocus) requestAnimationFrame(() => shown.current?.focus());
  };
  if (editing) {
    return (
      <span className="date-edit">
        <input
          ref={input} type="date" value={draft} aria-label={label}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            if (coarse() && DATE_ONLY.test(next) && next !== value) onSave(next);
          }}
          onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) finish(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); finish(true, true); }
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false, true); }
          }}
        />
        <button type="button" className="quiet" onMouseDown={(e) => e.preventDefault()} onClick={() => finish(false, true)}>Cancel</button>
        {clearable && value && (
          <button
            type="button" className="quiet" onMouseDown={(e) => e.preventDefault()}
            onClick={() => { settled.current = true; onSave(null); setEditing(false); requestAnimationFrame(() => shown.current?.focus()); }}
          >
            Clear
          </button>
        )}
      </span>
    );
  }
  return (
    <button ref={shown} type="button" className={`date-show${value ? "" : " empty"}${className ? ` ${className}` : ""}`} aria-label={`${label}: ${value ? formatDate(value) : "none"}. Change`} onClick={(e) => start(e.detail === 0 ? "keys" : "pointer")}>
      {value ? formatDate(value) : empty}
    </button>
  );
}

// The stage card: every stage laid out by step, "to do" beside "done", in
// its colours, with the likely next steps first. One tap chooses.
function StageCard({ open, onClose, anchor, app, current, since, onPick, title, status, showNext = true }: {
  open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; app: ApplicationRow; current: string;
  since: string | null; onPick: (key: string) => void; title?: string; status?: string; showNext?: boolean;
}) {
  const heading = title ?? `Stage for ${app.employer || "this application"}`;
  const next = showNext ? likelyNextStages(current).filter((k) => k !== current) : [];
  // One choice per opening, so a double tap never changes the stage twice.
  const chosen = useRef(false);
  useEffect(() => { if (open) chosen.current = false; }, [open]);
  const choose = (key: string) => { if (chosen.current) return; chosen.current = true; onPick(key); };
  const tile = (key: string, words: string) => {
    const stage = stageOf(key);
    const on = key === current;
    return (
      <button key={key} type="button" className={`stage-tile cat-${stage.cat}`} aria-pressed={on} aria-label={stage.label} title={stage.label} onClick={() => choose(key)}>
        <span>{words}</span>{on && <Icon name="check" size={14} />}
      </button>
    );
  };
  return (
    <ChoiceCard
      open={open} onClose={onClose} anchor={anchor} label={heading} className="stage-card"
      initialFocus=".stage-grid [aria-pressed='true'], .stage-next button, .stage-grid button"
      title={<>
        <h2 className="choice-title">{heading}</h2>
        <p className="choice-now">{status ?? `Now: ${stageOf(current).label}${since ? `, since ${formatDate(entryDate(since))}` : ""}`}</p>
      </>}
    >
      {next.length > 0 && (
        <div className="stage-next" role="group" aria-label="Likely next">
          <span className="stage-row-label">Likely next</span>
          <div className="stage-tiles">{next.map((k) => tile(k, stageOf(k).label))}</div>
        </div>
      )}
      <div className="stage-grid" role="group" aria-label="Every stage">
        <div className="stage-row heads" aria-hidden="true"><span /><span>To do</span><span>Done</span></div>
        {STAGE_GRID.map((row) => (
          <div key={row.label} className="stage-row" role="group" aria-label={row.label}>
            <span className="stage-row-label">{row.label}</span>
            {row.extra
              ? <div className="stage-tiles stage-extra">{row.extra.map((k) => tile(k, stageShort(k)))}</div>
              : <>{row.todo ? tile(row.todo, stageShort(row.todo)) : <span />}{row.done ? tile(row.done, stageShort(row.done)) : <span />}</>}
          </div>
        ))}
      </div>
    </ChoiceCard>
  );
}

// The stage, as a chip in its colour that opens the stage card.
function StageButton({ app, since, label = "Stage" }: { app: ApplicationRow; since: string | null; label?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const stage = stageOf(app.stage);
  return (
    <>
      <button
        ref={button} type="button" className={`stage-chip cat-${stage.cat}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={`${label}: ${stage.label}. Change`} title={CATEGORY_LABEL[stage.cat]} onClick={() => setOpen(true)}
      >
        <span className="stage-chip-text">{stage.label}</span><Icon name="caret" size={14} />
      </button>
      <StageCard
        open={open} onClose={() => setOpen(false)} anchor={button} app={app} current={app.stage} since={since}
        onPick={(key) => { setOpen(false); if (key !== app.stage) void changeStage(app, key); }}
      />
    </>
  );
}

const ORDERS: { key: Order; label: string }[] = [
  { key: "deadline", label: "Next deadline" },
  { key: "applied", label: "Date applied" },
  { key: "employer", label: "Employer" },
];

function OrderButton({ order, onChange }: { order: Order; onChange: (order: Order) => void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const current = ORDERS.find((o) => o.key === order) ?? ORDERS[0];
  return (
    <>
      <button
        ref={button} type="button" className="tool order-button" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Order: ${current.label}. Change`} onClick={() => setOpen(true)}
      >
        <span className="muted">Order:</span> {current.label}<Icon name="caret" size={14} />
      </button>
      <ChoiceCard open={open} onClose={() => setOpen(false)} anchor={button} label="Order applications by" className="order-card" title={<h2 className="choice-title">Order applications by</h2>}>
        <div className="choice-rows">
          {ORDERS.map((o) => (
            <button key={o.key} type="button" className="choice-row" aria-pressed={o.key === order} onClick={() => { setOpen(false); onChange(o.key); }}>
              <span>{o.label}</span>{o.key === order && <Icon name="check" size={16} />}
            </button>
          ))}
        </div>
      </ChoiceCard>
    </>
  );
}

function Deadline({ app, editable = true }: { app: ApplicationRow; editable?: boolean }) {
  // A closed application shows no deadline at all, so a stale date never sits beside a rejection.
  if (!isOpen(app)) return <span className="deadline state-none" aria-label="No deadline, as the application is closed" />;
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

function slotStatus(value: FileSlot | null): string {
  if (!value) return "Not recorded";
  if (value.state === "na") return "Not required";
  if (value.key) return `Sent: ${value.name ?? "a file"}${value.bytes ? `, ${sizeText(value.bytes)}` : ""}`;
  if (value.url) return `Sent: ${value.url.replace(/^https?:\/\//, "")}`;
  return "Sent, no file attached";
}

// Changes a slot and says so, with Undo.
async function changeSlot(app: ApplicationRow, slot: Slot, next: FileSlot | null, message: string): Promise<void> {
  const previous = app[slotColumn(slot.name)] ?? null;
  await setSlot(app.id, slot.name, next);
  showToast(message, { label: "Undo", run: () => void setSlot(app.id, slot.name, previous) });
}

// The slot card: everything that can be done to one of the four files.
function SlotCard({ open, onClose, anchor, app, slot }: {
  open: boolean; onClose: () => void; anchor: React.RefObject<HTMLElement | null>; app: ApplicationRow; slot: Slot;
}) {
  const value = app[slotColumn(slot.name)];
  const picker = useRef<HTMLInputElement>(null);
  const [linking, setLinking] = useState(false);
  const [url, setUrl] = useState("");
  useEffect(() => { if (!open) { setLinking(false); setUrl(""); } }, [open]);
  const attached = value?.state === "saved" && Boolean(value.key || value.url);
  const link = slotHref(value);
  const who = app.employer || "this application";
  // One change per opening, so a double tap never gives two notices.
  const acted = useRef(false);
  useEffect(() => { if (open) acted.current = false; }, [open]);
  const act = (next: FileSlot | null, message: string) => {
    if (acted.current) return;
    acted.current = true;
    onClose();
    void changeSlot(app, slot, next, message);
  };
  const saveLink = () => {
    const clean = normaliseUrl(url);
    if (!clean) { showToast("That doesn't look like a web address."); return; }
    act({ state: "saved", url: clean }, `Link added for the ${slot.label === "CV" ? "CV" : slot.label.toLowerCase()}.`);
  };
  return (
    <ChoiceCard
      open={open} onClose={onClose} anchor={anchor} label={`${slot.label} for ${who}`} className="slot-card"
      initialFocus={linking ? "input[type=url]" : undefined}
      title={<><h2 className="choice-title">{slot.label} for {who}</h2><p className="choice-now">{slotStatus(value)}</p></>}
    >
      <input
        ref={picker} type="file" accept={ATTACH_ACCEPT} hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          onClose();
          await attachTo(app, slot.name, file);
        }}
      />
      {linking ? (
        <div className="choice-link">
          <label className="field">
            <span className="field-label">Link to the {slot.label === "CV" ? "CV" : slot.label.toLowerCase()}</span>
            <input
              type="url" inputMode="url" enterKeyHint="done" autoCapitalize="off" autoCorrect="off" spellCheck={false}
              value={url} autoFocus placeholder="https://" aria-label={`Link for the ${slot.label.toLowerCase()}`}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveLink(); } }}
            />
          </label>
          <div><button type="button" className="button" onClick={saveLink}>Save link</button></div>
        </div>
      ) : (
        <div className="choice-rows">
          {attached && link && (
            <button type="button" className="choice-row" onClick={() => { onClose(); window.open(link, "_blank", "noopener"); }}>
              {value?.key ? `Open ${value.name ?? "the file"}` : "Open the link"}
            </button>
          )}
          <button type="button" className="choice-row" onClick={() => picker.current?.click()}>
            {value?.state === "saved" && value.key ? "Replace the file" : "Attach a file"}
          </button>
          {!(value?.state === "saved" && value.key) && (
            <button type="button" className="choice-row" onClick={() => setLinking(true)}>
              {value?.state === "saved" && value.url ? "Change the link" : "Add a link"}
            </button>
          )}
          {value?.state !== "saved" && <button type="button" className="choice-row" onClick={() => act({ state: "saved" }, `${slot.label} marked as sent, with no file.`)}>Sent, no file</button>}
          {attached && (
            <button type="button" className="choice-row" onClick={() => act({ state: "saved" }, value?.key ? `File removed from the ${slot.label === "CV" ? "CV" : slot.label.toLowerCase()}.` : `Link removed from the ${slot.label === "CV" ? "CV" : slot.label.toLowerCase()}.`)}>
              {value?.key ? "Remove the file" : "Remove the link"}
            </button>
          )}
          {value?.state !== "na" && <button type="button" className="choice-row" onClick={() => act({ state: "na" }, `${slot.label} marked as not required.`)}>Not required</button>}
          {value && <button type="button" className="choice-row danger" onClick={() => act(null, `${slot.label} cleared.`)}>Clear</button>}
        </div>
      )}
    </ChoiceCard>
  );
}

// One of the four file marks in the table. A sent file with something
// attached opens it; any other mark opens the slot card beside it. A file
// dropped on a mark is attached to it.
function SlotMark({ app, slot }: { app: ApplicationRow; slot: Slot }) {
  const value = app[slotColumn(slot.name)];
  const link = slotHref(value);
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
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
    return <a className={`${cls} saved attached`} href={link} target="_blank" rel="noopener" title={title} aria-label={title} {...drop}><Icon name="check" size={16} /></a>;
  }
  const mark = value?.state === "saved" ? <Icon name="check" size={16} /> : value?.state === "na" ? "N/A" : <span aria-hidden="true" />;
  const kind = value?.state === "saved" ? "saved" : value?.state === "na" ? "na" : "empty";
  return (
    <>
      <button ref={button} type="button" className={`${cls} ${kind}`} title={title} aria-label={title} aria-haspopup="dialog" onClick={() => setOpen(true)} {...drop}>{mark}</button>
      <SlotCard open={open} onClose={() => setOpen(false)} anchor={button} app={app} slot={slot} />
    </>
  );
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

// A file in Details: what was sent, and Change, which opens the slot card.
function SlotRow({ app, slot }: { app: ApplicationRow; slot: Slot }) {
  const value = app[slotColumn(slot.name)];
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
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
  return (
    <li className="slot-row">
      <span className="slot-label">{slot.label}</span>
      <span className="slot-status">
        {status}
        {value?.state === "saved" && value.key && value.bytes ? <span className="muted small"> {sizeText(value.bytes)}</span> : null}
      </span>
      <button
        ref={button} type="button" className="quiet slot-change" aria-haspopup="dialog"
        aria-label={`Change the ${slot.label.toLowerCase()}`} onClick={() => setOpen(true)}
      >
        Change
      </button>
      <SlotCard open={open} onClose={() => setOpen(false)} anchor={button} app={app} slot={slot} />
    </li>
  );
}

// Adds a past event, or edits one, with its own date and, if known, time.
function EntryEditor({ app, entry, onDone }: { app: ApplicationRow; entry?: ApplicationEventRow; onDone: () => void }) {
  const today = todayIso();
  const timed = Boolean(entry && !DATE_ONLY.test(entry.at));
  const [stage, setStage] = useState(entry?.stage ?? app.stage);
  const [day, setDay] = useState(entry ? entryDate(entry.at) : today);
  const [time, setTime] = useState(timed && entry ? entryTimeText(entry.at) : "");
  const [saving, setSaving] = useState(false);
  // A ref, not state, so a second tap in the same moment is turned away too.
  const busy = useRef(false);
  const [picking, setPicking] = useState(false);
  const stageButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { stageButton.current?.focus(); }, []);
  const valid = DATE_ONLY.test(day) && day <= today;
  const save = async () => {
    if (!valid || busy.current) return;
    busy.current = true;
    setSaving(true);
    const at = time ? new Date(`${day}T${time}`).toISOString() : day;
    try {
      if (entry) {
        await saveEntry(app, entry, { stage, at });
        showToast("Timeline entry changed.");
      } else {
        await addManualEvent(app.id, stage, at);
      }
      onDone();
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  const chosen = stageOf(stage);
  return (
    <div
      className="tl-editor" role="group" aria-label={entry ? "Edit a timeline entry" : "Add a past event"}
      onKeyDown={(e) => { if (e.key === "Escape" && !picking) { e.preventDefault(); e.stopPropagation(); onDone(); } }}
    >
      <div className="tl-fields">
        <span className="field">
          <span className="field-label">Stage</span>
          <button
            ref={stageButton} type="button" className={`stage-chip cat-${chosen.cat}`} aria-haspopup="dialog"
            aria-label={`Stage for this entry: ${chosen.label}. Change`} onClick={() => setPicking(true)}
          >
            <span className="stage-chip-text">{chosen.label}</span><Icon name="caret" size={14} />
          </button>
        </span>
        <label className="field"><span className="field-label">Date</span><input type="date" value={day} max={today} onChange={(e) => setDay(e.target.value)} /></label>
        <label className="field"><span className="field-label">Time, if you know it</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
      </div>
      <div className="tl-actions">
        <button type="button" className="button" disabled={!valid || saving} onClick={() => void save()}>{saving ? "Saving…" : entry ? "Save entry" : "Add event"}</button>
        <button type="button" className="quiet" onClick={onDone}>Cancel</button>
        {entry && <button type="button" className="quiet danger tl-remove" onClick={() => { onDone(); void removeEvent(entry.id); }}>Remove entry</button>}
      </div>
      <StageCard
        open={picking} onClose={() => setPicking(false)} anchor={stageButton} app={app} current={stage} since={null}
        title="Stage for this entry" status={`Chosen: ${chosen.label}`} showNext={false}
        onPick={(key) => { setPicking(false); setStage(key); }}
      />
    </div>
  );
}

// How the application has moved on: every change of stage, oldest first,
// with how long each step took.
function Timeline({ app, events }: { app: ApplicationRow; events: ApplicationEventRow[] }) {
  const entries = getTimelineEntries(app, events);
  const [editing, setEditing] = useState<string | null>(null);
  const last = entries[entries.length - 1];
  // Changed on a device without the timeline, so no entry says when.
  const unrecorded = !last || last.stage !== app.stage;
  const sinceApplied = app.stage !== "to_apply" ? daysSinceApplied(app.applied) : null;
  return (
    <section className="timeline" aria-label={`Timeline for ${app.employer || "this application"}`}>
      <h3 className="detail-head">Timeline</h3>
      <ol className="tl-list">
        {entries.map((entry, i) => {
          if (editing === entry.id) return <li key={entry.id}><EntryEditor app={app} entry={entry} onDone={() => setEditing(null)} /></li>;
          const next = entries[i + 1];
          const dateOnly = DATE_ONLY.test(entry.at);
          const stage = stageOf(entry.stage);
          let lasted = "";
          if (next) lasted = stepLength(entry.at, next.at);
          else if (entry.stage === app.stage) {
            const days = daysInStage(entry.at);
            lasted = days === 0 ? "since today" : `${days} ${days === 1 ? "day" : "days"} so far`;
          }
          const when = formatDate(entryDate(entry.at));
          return (
            <li key={entry.id} className="tl-entry">
              <span className="tl-when">{when}{!dateOnly && <span className="tl-time"> {entryTimeText(entry.at)}</span>}</span>
              <span className={`stage-tag cat-${stage.cat}`}>{stage.label}</span>
              <span className="tl-lasted">{lasted}</span>
              {!entry.id.startsWith("virtual-") && (
                <button type="button" className="quiet tl-edit" aria-label={`Edit the entry for ${stage.label}, ${when}`} onClick={() => setEditing(entry.id)}>Edit</button>
              )}
            </li>
          );
        })}
        {unrecorded && (
          <li className="tl-entry">
            <span className="tl-when muted">Now</span>
            <span className={`stage-tag cat-${stageOf(app.stage).cat}`}>{stageOf(app.stage).label}</span>
            <span className="tl-lasted">date not recorded</span>
          </li>
        )}
      </ol>
      {sinceApplied !== null && (
        <p className="tl-since small muted">{sinceApplied === 0 ? "Applied today" : `${sinceApplied} ${sinceApplied === 1 ? "day" : "days"} since you applied`}</p>
      )}
      {editing === "new"
        ? <EntryEditor app={app} onDone={() => setEditing(null)} />
        : <button type="button" className="quiet tl-add" onClick={() => setEditing("new")}>Add a past event</button>}
    </section>
  );
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
