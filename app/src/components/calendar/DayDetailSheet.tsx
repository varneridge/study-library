// A day's summary, opened from the month. Everything on the day is listed in
// order: all-day events and deadlines first, then timed events by when they
// start, each with its time, title, place and calendar. Pressing one opens it,
// "+ Add event" starts a new one on the day, and "Day view" opens the day's
// hours in full.

import { type CalEvent, SOURCE_BADGES, SOURCE_LABELS, describeWhen, eventsOnDay, timeLabel } from "../../lib/calendar";
import { type ISODate, formatLong } from "../../lib/civilDate";
import { isDeadline } from "./MonthView";
import { Sheet } from "./Sheet";

// The time an event starts on this day, an event begun earlier counting as midnight.
const startsAt = (event: CalEvent, day: ISODate) => (event.startDate < day ? "00:00" : event.startTime ?? "");

function inOrder(events: CalEvent[], day: ISODate): CalEvent[] {
  return eventsOnDay(events, day).slice().sort((a, b) =>
    Number(b.allDay) - Number(a.allDay)
    || Number(isDeadline(b)) - Number(isDeadline(a))
    || startsAt(a, day).localeCompare(startsAt(b, day))
    || a.title.localeCompare(b.title, "en-GB")
    || a.key.localeCompare(b.key));
}

export function DayDetailSheet({ date, events, onOpen, onAdd, onShowDay, onClose }: {
  date: ISODate;
  events: CalEvent[];
  onOpen: (event: CalEvent) => void;
  onAdd: (date: ISODate) => void;
  onShowDay: (date: ISODate) => void;
  onClose: () => void;
}) {
  const list = inOrder(events, date);
  return (
    <Sheet
      title={formatLong(date)}
      onClose={onClose}
      foot={(
        <>
          <button type="button" className="button" onClick={() => onShowDay(date)}>Day view</button>
          <span className="spacer" />
          <button type="button" className="button" onClick={onClose}>Close</button>
          <button type="button" className="button primary" onClick={() => onAdd(date)}>+ Add event</button>
        </>
      )}
    >
      {list.length === 0
        ? <p className="muted cal-day-empty">Nothing on this day yet.</p>
        : (
          <ul className="cal-agenda-list cal-day-list">
            {list.map((event) => (
              <li key={event.key}>
                <button
                  type="button"
                  className={`cal-agenda-row src-${event.source}${isDeadline(event) ? " is-deadline" : ""}`}
                  aria-label={`${event.title}, ${describeWhen(event)}, ${SOURCE_LABELS[event.source]}`}
                  onClick={() => onOpen(event)}
                >
                  <span className="cal-agenda-time">{timeLabel(event, date)}</span>
                  <span className="cal-agenda-main">
                    <span className="cal-agenda-title">{event.title}</span>
                    {event.location && <span className="cal-agenda-where">{event.location}</span>}
                  </span>
                  <span className="cal-badge"><i className="cal-dot" aria-hidden="true" />{SOURCE_BADGES[event.source]}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
    </Sheet>
  );
}
