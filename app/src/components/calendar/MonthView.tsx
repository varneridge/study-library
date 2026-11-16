// The month: a Monday-first grid of six weeks. Each day shows its number and
// up to three events as chips, then "+N more" which opens that day. On a phone
// the chips give way to dots and a tap on a day opens it, because a cell that
// small cannot tell opening from creating.

import { type CalEvent, eventsOnDay, titleFor } from "../../lib/calendar";
import { type ISODate, formatLong, monthGrid, parseISO, todayLocal } from "../../lib/civilDate";
import { eventLabel } from "./sources";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS = 3;

// An event as a small bar with the colour of its source down the left. A
// longer event runs on across days, its ends squared where it continues.
export function Chip({ event, day, onOpen }: { event: CalEvent; day: ISODate; onOpen: (event: CalEvent) => void }) {
  const before = event.startDate < day;
  const after = event.endDate > day;
  const label = eventLabel(event);
  return (
    <button
      type="button"
      className={`cal-chip src-${event.source}${before ? " continues-before" : ""}${after ? " continues-after" : ""}`}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(event);
      }}
    >
      {!event.allDay && !before && <span className="cal-chip-time">{event.startTime}</span>}
      <span className="cal-chip-text">{event.title}</span>
    </button>
  );
}

export interface MonthViewProps {
  // Any date in the month to show.
  anchor: ISODate;
  events: CalEvent[];
  onOpen: (event: CalEvent) => void;
  // An empty part of a day was pressed, on a laptop.
  onCreate: (date: ISODate) => void;
  // A day was asked for: its number, "+N more", or any part of it on a phone.
  onSelectDay: (date: ISODate) => void;
  isPhone: boolean;
}

export function MonthView({ anchor, events, onOpen, onCreate, onSelectDay, isPhone }: MonthViewProps) {
  const today = todayLocal();
  const p = parseISO(anchor) ?? parseISO(today)!;
  const cells = monthGrid(p.year, p.month);
  return (
    <div className="cal-month" role="group" aria-label={titleFor("month", anchor)}>
      <div className="cal-weekdays" aria-hidden="true">
        {WEEKDAYS.map((name) => <div key={name} className="cal-weekday">{name}</div>)}
      </div>
      <div className="cal-days">
        {cells.map((cell) => {
          const list = eventsOnDay(events, cell.iso);
          const shown = list.slice(0, MAX_CHIPS);
          const hidden = list.length - shown.length;
          const isToday = cell.iso === today;
          return (
            <div
              key={cell.iso}
              className={`cal-day${cell.inMonth ? "" : " is-outside"}${isToday ? " is-today" : ""}`}
              onClick={() => (isPhone ? onSelectDay(cell.iso) : onCreate(cell.iso))}
            >
              <button
                type="button"
                className={`cal-daynum${isToday ? " is-today" : ""}`}
                aria-current={isToday ? "date" : undefined}
                aria-label={`${formatLong(cell.iso)}${list.length ? `, ${list.length === 1 ? "1 event" : `${list.length} events`}` : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectDay(cell.iso);
                }}
              >
                {cell.day}
              </button>
              <div className="cal-chips">
                {shown.map((event) => <Chip key={event.key} event={event} day={cell.iso} onOpen={onOpen} />)}
              </div>
              {hidden > 0 && (
                <button
                  type="button"
                  className="cal-more"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectDay(cell.iso);
                  }}
                >
                  +{hidden} more
                </button>
              )}
              {list.length > 0 && (
                <span className="cal-dots" aria-hidden="true">
                  {list.slice(0, 3).map((event) => <i key={event.key} className={`cal-dot src-${event.source}`} />)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
