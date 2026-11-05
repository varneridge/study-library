// Field, stage, slot and timeline controls for the job search page.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  addManualEvent, ATTACH_ACCEPT, attachFile, CATEGORY_LABEL, changeStage, daysInStage, daysSinceApplied,
  deadlineState, deadlineWords, entryDate, entryTimeText, formatDate, getTimelineEntries,
  isOpen, likelyNextStages, normaliseUrl, removeEvent, saveApplication, saveEntry, setSlot,
  sizeText, slotColumn, slotHref, SLOTS, STAGE_GRID, stageOf, stageShort, stepLength, todayIso, type Order,
} from "../../lib/jobs";
import type { ApplicationEventRow, ApplicationRow, FileSlot, SlotName } from "../../lib/types";
import { showToast } from "../../lib/ui";
import { Icon } from "../icons";
import { ChoiceCard } from "../ChoiceCard";
import { EntryForm } from "./EntryForm";
import { FileName } from "../FileName";
import { DatePickerDialog } from "../DatePicker";
import { parseUK } from "../../lib/civilDate";


export type Slot = (typeof SLOTS)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const coarse = () => window.matchMedia?.("(pointer: coarse)").matches ?? false;

// A text field that saves as you type, after a pause, and on leaving it.
// Another device's change shows unless you are typing in this field. Escape
// in a single line puts back what was there when you started and leaves it.
// With wrap, a single line that wraps to fit its cell rather than being cut
// off; Enter finishes it instead of starting a new line.
export function TextField({ value, onSave, label, placeholder, multiline, wrap, className, autoFocus, id }: {
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
export function DateField({ value, onSave, label, title, hint, clearable, empty = "Add date", className }: {
  value: string | null; onSave: (value: string | null) => void; label: string; clearable?: boolean; empty?: string; className?: string;
  // The date card's title and the line beneath it, saying what the date is for.
  title?: string; hint?: string;
}) {
  const [editing, setEditing] = useState<false | "pointer" | "keys">(false);
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const shown = useRef<HTMLButtonElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    if (!editing) return;
    const el = input.current;
    el?.focus();
  }, [editing]);
  const start = (how: "pointer" | "keys") => { settled.current = false; setDraft(value ?? ""); setEditing(how); };
  const finish = (keep: boolean, refocus = false) => {
    if (settled.current) return;
    settled.current = true;
    const clean = parseUK(draft);
    if (keep && clean && clean !== value) onSave(clean);
    setEditing(false);
    if (refocus) requestAnimationFrame(() => shown.current?.focus());
  };
  if (editing === "keys") {
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
    <>
      <button ref={shown} type="button" className={`date-show${value ? "" : " empty"}${className ? ` ${className}` : ""}`} aria-label={`${label}: ${value ? formatDate(value) : "none"}. Change`} onClick={(e) => start(e.detail === 0 ? "keys" : "pointer")}>
        {value ? formatDate(value) : empty}
      </button>
      {editing === "pointer" && (
        <DatePickerDialog
          triggerRef={shown}
          value={value}
          label={label}
          title={title}
          hint={hint}
          clearable={clearable}
          onSelect={(next) => {
            setEditing(false);
            if (next !== value) onSave(next);
            requestAnimationFrame(() => shown.current?.focus());
          }}
          onDismiss={(returnFocus) => {
            setEditing(false);
            if (returnFocus !== false) {
              requestAnimationFrame(() => shown.current?.focus());
            }
          }}
        />
      )}
    </>
  );
}

// The stage card: every stage laid out by step, "to do" beside "done", in
// its colours, with the likely next steps first. One tap chooses.
export function StageCard({ open, onClose, anchor, app, current, since, onPick, title, status, showNext = true }: {
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
export function StageButton({ app, since, label = "Stage" }: { app: ApplicationRow; since: string | null; label?: string }) {
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

export function OrderButton({ order, onChange }: { order: Order; onChange: (order: Order) => void }) {
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

export function Deadline({ app, editable = true }: { app: ApplicationRow; editable?: boolean }) {
  // A closed application shows no deadline at all, so a stale date never sits beside a rejection.
  if (!isOpen(app)) return <span className="deadline state-none" aria-label="No deadline, as the application is closed" />;
  const state = deadlineState(app);
  const words = deadlineWords(app);
  return (
    <span className={`deadline state-${state}`}>
      {editable
        ? <DateField value={app.next_deadline} label="Next deadline" title={`Next deadline for ${app.employer || "this application"}`} hint="Applications are ordered by what is due next." clearable empty="None" className="deadline-date" onSave={(v) => void saveApplication(app.id, { next_deadline: v })} />
        : <span className="deadline-date">{app.next_deadline ? formatDate(app.next_deadline) : ""}</span>}
      {words && <span className="deadline-words">{words}</span>}
    </span>
  );
}

export function slotTitle(label: string, slot: FileSlot | null): string {
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

// The slot card: everything that can be done to one of the four files.
export function SlotCard({ open, onClose, anchor, app, slot }: {
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
              {value?.key && value.name ? <span style={{ display: "flex", gap: "0.25rem", minWidth: 0, overflow: "hidden" }}>Open <FileName name={value.name} /></span> : value?.key ? "Open the file" : "Open the link"}
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
export function SlotMark({ app, slot }: { app: ApplicationRow; slot: Slot }) {
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

// A file in Details: what was sent, and Change, which opens the slot card.
export function SlotRow({ app, slot }: { app: ApplicationRow; slot: Slot }) {
  const value = app[slotColumn(slot.name)];
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const link = slotHref(value);
  let status: React.ReactNode = <span className="muted">Not recorded</span>;
  if (value?.state === "na") status = <span className="muted">Not required</span>;
  if (value?.state === "saved") {
    status = value.key
      ? <a href={link!} target="_blank" rel="noopener">{value.name ? <FileName name={value.name} /> : "Open file"}</a>
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

// How the application has moved on: every change of stage, oldest first,
// with how long each step took.
export function Timeline({
  app,
  events,
  onEditEntry,
  onAddEntry,
}: {
  app: ApplicationRow;
  events: ApplicationEventRow[];
  onEditEntry?: (id: string) => void;
  onAddEntry?: () => void;
}) {
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
          if (editing === entry.id) {
            return (
              <li key={entry.id}>
                <EntryForm app={app} entry={entry} onDone={() => setEditing(null)} variant="inline" />
              </li>
            );
          }
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
                <button
                  type="button"
                  className="quiet tl-edit"
                  aria-label={`Edit the entry for ${stage.label}, ${when}`}
                  onClick={() => (onEditEntry ? onEditEntry(entry.id) : setEditing(entry.id))}
                >
                  Edit
                </button>
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
      {editing === "new" ? (
        <EntryForm app={app} onDone={() => setEditing(null)} variant="inline" />
      ) : (
        <button
          type="button"
          className="quiet tl-add"
          onClick={() => (onAddEntry ? onAddEntry() : setEditing("new"))}
        >
          Add a past event
        </button>
      )}
    </section>
  );
}
