// The sheet an event opens in. A new event or one of your own is a form: a
// title, All day, when it starts and ends, a category, a place and notes. Moving
// the start carries the end with it, so the length is kept. The same form serves
// every way in, from the month, the hours, the summary of a day and the buttons
// alike: a new event starts at 09:00 to 10:00 unless it was started at a time,
// and unticking All day brings the times back rather than leaving them blank.
// Delete is at once, with a notice that offers Undo, and leaving with edits not
// yet saved asks first.
// An event from Google Calendar is shown to read, and is changed in Google.

import { useId, useRef, useState } from "react";
import {
  type CalEvent,
  CATEGORY_LABELS,
  DRAFT_ERROR_TEXT,
  type DraftError,
  EVENT_CATEGORIES,
  type EventDraft,
  type EventSeed,
  SOURCE_LABELS,
  blankDraft,
  describeWhen,
  draftFromRow,
  hhmm,
  moveStart,
  validateDraft,
} from "../../lib/calendar";
import { type SheetTarget, useSheetTarget } from "../../lib/calendarEvents";
import { createEvent, deleteEvent, editEvent } from "../../lib/calendarStore";
import { useUnsavedChangesGuard } from "../../lib/formDraft";
import type { CalendarEventRow } from "../../lib/types";
import { showToast } from "../../lib/ui";
import { DatePicker } from "../DatePicker";
import { usePhone } from "./hooks";
import { Sheet } from "./Sheet";

// Where a new event starts when nothing chose a time for it; it lasts an hour.
export const DEFAULT_START = "09:00";
const DEFAULT_MINUTES = 60;

// A timed draft always has both times, so the pickers never open empty.
function withTimes(d: EventDraft): EventDraft {
  if (d.allDay || (d.startTime && d.endTime)) return d;
  const startTime = d.startTime ?? DEFAULT_START;
  const [h, m] = startTime.split(":").map(Number);
  return { ...d, startTime, endTime: hhmm(Math.min(h * 60 + m + DEFAULT_MINUTES, 23 * 60 + 59)) };
}

function Reading({ event, onClose }: { event: CalEvent; onClose: () => void }) {
  return (
    <Sheet title={event.title} onClose={onClose} foot={<button type="button" className="button" onClick={onClose}>Close</button>}>
      <p className="cal-read-when">{describeWhen(event)}</p>
      {event.location && <p className="cal-read-where">{event.location}</p>}
      {event.notes && <p className="cal-read-notes">{event.notes}</p>}
      <p className="small muted">From {SOURCE_LABELS[event.source]}. Change it there, and it will change here at the next sync.</p>
    </Sheet>
  );
}

function Form({ row, seed, onClose }: { row: CalendarEventRow | null; seed: EventSeed; onClose: () => void }) {
  const phone = usePhone();
  const [initial] = useState<EventDraft>(() => (row ? draftFromRow(row) : withTimes(blankDraft(seed))));
  const [draft, setDraft] = useState<EventDraft>(initial);
  const [error, setError] = useState<DraftError | "save" | null>(null);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const titleErrorId = useId();
  const whenErrorId = useId();

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const { disarm } = useUnsavedChangesGuard(dirty, "event");

  const change = (patch: Partial<EventDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
  };
  const setAllDay = (allDay: boolean) => {
    setDraft((d) => (allDay ? { ...d, allDay } : withTimes({ ...d, allDay })));
    setError(null);
  };
  const start = (patch: { startDate?: string; startTime?: string | null }) => {
    setDraft((d) => moveStart(d, patch));
    setError(null);
  };

  const save = async () => {
    const problem = validateDraft(draft);
    if (problem) {
      setError(problem);
      if (problem === "title") titleRef.current?.focus();
      return;
    }
    setSaving(true);
    try {
      if (row) await editEvent(row, draft);
      else await createEvent(draft);
      disarm();
      showToast(row ? "Event saved." : "Event added.");
      onClose();
    } catch {
      setError("save");
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!row) return;
    setSaving(true);
    try {
      await deleteEvent(row);
      disarm();
      onClose();
    } catch {
      setError("save");
      setSaving(false);
    }
  };

  const titleProblem = error === "title";
  const whenProblem = error === "bad_date" || error === "bad_time" || error === "end_before_start";

  return (
    <Sheet
      title={row ? "Edit event" : "New event"}
      onClose={onClose}
      foot={(
        <>
          {row && (
            <button type="button" className="button danger cal-delete" disabled={saving} onClick={() => void remove()}>
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button" disabled={saving} onClick={onClose}>Cancel</button>
          <button type="submit" form={formId} className="button primary" disabled={saving}>Save</button>
        </>
      )}
    >
      <form
        id={formId}
        className="cal-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="cal-field">
          <span>Title</span>
          <input
            ref={titleRef}
            type="text"
            className="cal-input"
            value={draft.title}
            autoFocus={!row && !phone}
            aria-invalid={titleProblem || undefined}
            aria-describedby={titleProblem ? titleErrorId : undefined}
            onChange={(e) => change({ title: e.target.value })}
          />
          {titleProblem && <span id={titleErrorId} className="cal-error" role="alert">{DRAFT_ERROR_TEXT.title}</span>}
        </label>

        <label className="cal-check">
          <input type="checkbox" checked={draft.allDay} onChange={(e) => setAllDay(e.target.checked)} />
          <span>All day</span>
        </label>

        <div className="cal-field" role="group" aria-label="Starts">
          <span aria-hidden="true">Starts</span>
          <div className="cal-when">
            <DatePicker label="Start date" value={draft.startDate} onChange={(date) => date && start({ startDate: date })} />
            {!draft.allDay && (
              <input
                type="time"
                step={900}
                className="cal-input cal-time"
                aria-label="Start time"
                value={draft.startTime ?? ""}
                onChange={(e) => start({ startTime: e.target.value || null })}
              />
            )}
          </div>
        </div>

        <div className="cal-field" role="group" aria-label="Ends">
          <span aria-hidden="true">Ends</span>
          <div className="cal-when">
            <DatePicker label="End date" value={draft.endDate} min={draft.startDate} onChange={(date) => date && change({ endDate: date })} />
            {!draft.allDay && (
              <input
                type="time"
                step={900}
                className="cal-input cal-time"
                aria-label="End time"
                aria-invalid={error === "end_before_start" || error === "bad_time" || undefined}
                aria-describedby={whenProblem ? whenErrorId : undefined}
                value={draft.endTime ?? ""}
                onChange={(e) => change({ endTime: e.target.value || null })}
              />
            )}
          </div>
          {whenProblem && <span id={whenErrorId} className="cal-error" role="alert">{DRAFT_ERROR_TEXT[error]}</span>}
        </div>

        <div className="cal-field" role="group" aria-label="Category">
          <span aria-hidden="true">Category</span>
          <div className="segmented">
            {EVENT_CATEGORIES.map((category) => (
              <button key={category} type="button" className="tool" aria-pressed={draft.category === category} onClick={() => change({ category })}>
                {CATEGORY_LABELS[category]}
              </button>
            ))}
          </div>
        </div>

        <label className="cal-field">
          <span>Location</span>
          <input type="text" className="cal-input" value={draft.location} onChange={(e) => change({ location: e.target.value })} />
        </label>

        <label className="cal-field">
          <span>Notes</span>
          <textarea className="cal-input" rows={3} value={draft.notes} onChange={(e) => change({ notes: e.target.value })} />
        </label>

        {error === "save" && <p className="cal-error" role="alert">This could not be saved. Try again.</p>}
      </form>
    </Sheet>
  );
}

// eventKey is "new", or the key of one of your own events or a Google one.
export function EventSheet({ eventKey, seed, onClose }: { eventKey: string; seed: EventSeed; onClose: () => void }) {
  const target: SheetTarget | undefined = useSheetTarget(eventKey);
  if (!target) return null;
  if (target.kind === "google") return <Reading event={target.event} onClose={onClose} />;
  if (target.kind === "missing") {
    return (
      <Sheet title="Event not found" onClose={onClose} foot={<button type="button" className="button" onClick={onClose}>Close</button>}>
        <p className="muted">This event has been deleted, or the link is not to one of yours.</p>
      </Sheet>
    );
  }
  return <Form key={target.kind === "personal" ? target.row.id : "new"} row={target.kind === "personal" ? target.row : null} seed={seed} onClose={onClose} />;
}
