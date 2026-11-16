// The calendar's side panel on a laptop: a button for a new event, a small
// month to jump about by, "My calendars" to show or hide each source, the
// Google Calendar card, and the next seven days. It holds no data of its own;
// the page gives it what to show and takes back what was asked. On a phone the
// calendars and the Google card alone are shown, in a sheet, as CalendarPanel.

import { useEffect, useId, useState } from "react";
import { type CalEvent, CALENDAR_SOURCES, type CalendarSource, titleFor } from "../../lib/calendar";
import { type ISODate, addDays, addMonths, formatISO, formatLong, monthGrid, parseISO, todayLocal, weekdayMon0 } from "../../lib/civilDate";
import type { GcalStatus } from "../../lib/gcal";
import { Icon } from "../icons";
import { SOURCE_LABELS } from "./sources";

const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const SHORT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const UPCOMING_SHOWN = 8;
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });

// "Synced at 10:45" today, "Synced on 15 November at 09:00" before.
function syncedText(syncedAt: string | null, today: ISODate): string {
  const t = syncedAt ? new Date(syncedAt) : null;
  if (!t || Number.isNaN(t.getTime())) return "Not synced yet";
  const time = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  if (formatISO(t.getFullYear(), t.getMonth() + 1, t.getDate()) === today) return `Synced at ${time}`;
  return `Synced on ${DATE_FORMAT.format(t)} at ${time}`;
}

function MiniMonth({ anchor, today, onSelectDate }: { anchor: ISODate; today: ISODate; onSelectDate: (date: ISODate) => void }) {
  const a = parseISO(anchor) ?? parseISO(today)!;
  const [view, setView] = useState({ year: a.year, month: a.month });
  // It follows the main view when that moves to another month.
  useEffect(() => setView({ year: a.year, month: a.month }), [a.year, a.month]);
  const first = formatISO(view.year, view.month, 1);
  const step = (delta: number) => {
    const p = parseISO(addMonths(first, delta))!;
    setView({ year: p.year, month: p.month });
  };
  return (
    <div className="cal-mini" role="group" aria-label="Choose a date">
      <div className="cal-mini-head">
        <button type="button" className="icon-button small cal-mini-prev" aria-label="Previous month" onClick={() => step(-1)}>
          <Icon name="caret" />
        </button>
        <span className="cal-mini-title">{titleFor("month", first)}</span>
        <button type="button" className="icon-button small cal-mini-next" aria-label="Next month" onClick={() => step(1)}>
          <Icon name="caret" />
        </button>
      </div>
      <div className="cal-mini-grid">
        {WEEKDAY_LETTERS.map((letter, i) => <span key={i} className="cal-mini-dow" aria-hidden="true">{letter}</span>)}
        {monthGrid(view.year, view.month).map((cell) => (
          <button
            key={cell.iso}
            type="button"
            className={`cal-mini-day${cell.inMonth ? "" : " is-outside"}${cell.iso === today ? " is-today" : ""}${cell.iso === anchor ? " is-selected" : ""}`}
            aria-current={cell.iso === today ? "date" : undefined}
            aria-label={formatLong(cell.iso)}
            onClick={() => onSelectDate(cell.iso)}
          >
            {cell.day}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface CalendarPanelProps {
  hidden: CalendarSource[];
  onToggleSource: (source: CalendarSource) => void;
  gcalStatus: GcalStatus;
  onRefreshGcal: () => void;
  // The secret address in iCal format, or null when there is none.
  gcalUrl: string | null;
  // The address as typed, trimmed, or null when it was cleared.
  onSaveGcalUrl: (url: string | null) => void;
}

// "My calendars" and the Google Calendar card.
export function CalendarPanel({ hidden, onToggleSource, gcalStatus, onRefreshGcal, gcalUrl, onSaveGcalUrl }: CalendarPanelProps) {
  const [draft, setDraft] = useState(gcalUrl ?? "");
  // The field shows the address as saved, whenever that changes.
  useEffect(() => setDraft(gcalUrl ?? ""), [gcalUrl]);
  const fieldId = useId();
  const changed = draft.trim() !== (gcalUrl ?? "");
  return (
    <div className="cal-panel">
      <fieldset className="cal-sources">
        <legend className="cal-heading">My calendars</legend>
        {CALENDAR_SOURCES.map((source) => (
          <label key={source} className={`cal-source src-${source}`}>
            <input type="checkbox" checked={!hidden.includes(source)} onChange={() => onToggleSource(source)} />
            <i className="cal-dot" aria-hidden="true" />
            <span>{SOURCE_LABELS[source]}</span>
          </label>
        ))}
      </fieldset>

      <section className="cal-card" aria-label="Google Calendar">
        <h3 className="cal-heading">Google Calendar</h3>
        <p className="small muted cal-synced">{gcalUrl ? syncedText(gcalStatus.syncedAt, todayLocal()) : "Not connected"}</p>
        {gcalStatus.error && <p className="cal-notice" role="alert">{gcalStatus.error}</p>}
        <div className="cal-card-actions">
          <button type="button" className="button" disabled={!gcalUrl || gcalStatus.refreshing} onClick={onRefreshGcal}>
            {gcalStatus.refreshing ? "Syncing..." : "Sync now"}
          </button>
        </div>
        <form
          className="cal-address"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) onSaveGcalUrl(draft.trim() || null);
          }}
        >
          <label htmlFor={fieldId} className="small muted">
            Secret address in iCal format, from the calendar's settings in Google Calendar.
          </label>
          <div className="cal-address-row">
            <input
              id={fieldId}
              type="text"
              className="cal-input"
              value={draft}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://calendar.google.com/calendar/ical/..."
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="button primary" disabled={!changed}>Save</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function dayLabel(day: ISODate, today: ISODate): string {
  if (day === today) return "Today";
  if (day === addDays(today, 1)) return "Tomorrow";
  return `${SHORT_DAYS[weekdayMon0(day)]} ${parseISO(day)!.day}`;
}

export interface CalendarSidebarProps extends CalendarPanelProps {
  // The date the main view is on.
  anchor: ISODate;
  onSelectDate: (date: ISODate) => void;
  // Events in the next seven days, in any order; the list puts them in order.
  upcomingEvents: CalEvent[];
  onOpenEvent: (event: CalEvent) => void;
  onNewEvent: () => void;
}

export function CalendarSidebar({ anchor, onSelectDate, upcomingEvents, onOpenEvent, onNewEvent, ...panel }: CalendarSidebarProps) {
  const today = todayLocal();
  const last = addDays(today, 6);
  // A longer event already under way is listed on today, not on the day it began.
  const items = upcomingEvents
    .filter((event) => event.endDate >= today && event.startDate <= last)
    .map((event) => ({ day: event.startDate < today ? today : event.startDate, event }))
    .sort((a, b) =>
      a.day.localeCompare(b.day)
      || Number(b.event.allDay) - Number(a.event.allDay)
      || (a.event.startTime ?? "").localeCompare(b.event.startTime ?? "")
      || a.event.title.localeCompare(b.event.title, "en-GB")
      || a.event.key.localeCompare(b.event.key));
  return (
    <aside className="cal-sidebar" aria-label="Calendar tools">
      <button type="button" className="button primary cal-add" onClick={onNewEvent}>+ Add event</button>
      <MiniMonth anchor={anchor} today={today} onSelectDate={onSelectDate} />
      <CalendarPanel {...panel} />
      <section className="cal-upcoming" aria-label="Next seven days">
        <h3 className="cal-heading">Next seven days</h3>
        {items.length === 0 && <p className="small muted">Nothing in the next seven days.</p>}
        <ul className="cal-up-list">
          {items.slice(0, UPCOMING_SHOWN).map(({ day, event }) => (
            <li key={event.key}>
              <button type="button" className={`cal-up-row src-${event.source}`} onClick={() => onOpenEvent(event)}>
                <i className="cal-dot" aria-hidden="true" />
                <span className="cal-up-when">{dayLabel(day, today)}</span>
                <span className="cal-up-what">
                  <span className="cal-up-title">{event.title}</span>
                  <span className="cal-up-time">{event.allDay ? "All day" : event.startTime}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {items.length > UPCOMING_SHOWN && <p className="small muted">and {items.length - UPCOMING_SHOWN} more.</p>}
      </section>
    </aside>
  );
}
