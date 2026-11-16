// The month: a Monday-first grid of the weeks the month touches, five or six,
// sized so that the whole month fits the screen without scrolling. Each day
// shows its number and as many events as its height allows, then "+N more".
// Pressing a day, its number or "+N more" opens that day's summary, so a look
// at a day never starts an event by accident; the small "+" beside the number
// does that instead. On a phone the chips give way to dots.

import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { type CalEvent, type CalendarSource, eventsOnDay, titleFor } from "../../lib/calendar";
import { type ISODate, formatLong, monthGrid, parseISO, todayLocal } from "../../lib/civilDate";
import { eventLabel } from "./sources";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// How many chips a day shows before it has been measured.
const DEFAULT_SLOTS = 3;
// These mirror styles.css: a day's padding, the height of its number, and the
// gap between chips. The chip's own height is read from --chip-h.
const DAY_PAD_REM = 0.25;
const DAYNUM_REM = 1.75;
const CHIP_GAP_PX = 2;

// Sources whose entries are things due rather than things to attend.
export const DEADLINE_SOURCES: readonly CalendarSource[] = ["deadline", "check", "essay"];
export const isDeadline = (event: CalEvent) => DEADLINE_SOURCES.includes(event.source);

// An event as a small bar. An all-day event is a filled bar with the colour of
// its source down the left, a timed one a dot, its time and its title, and a
// deadline is outlined. A longer event runs on across days, its ends squared
// where it continues.
export function Chip({ event, day, onOpen }: { event: CalEvent; day: ISODate; onOpen: (event: CalEvent) => void }) {
  const before = event.startDate < day;
  const after = event.endDate > day;
  const timed = !event.allDay && !before && !after;
  const kind = isDeadline(event) ? " is-deadline" : timed ? " is-timed" : "";
  const label = eventLabel(event);
  return (
    <button
      type="button"
      className={`cal-chip src-${event.source}${kind}${before ? " continues-before" : ""}${after ? " continues-after" : ""}`}
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

function toPx(value: string, rem: number): number {
  const n = parseFloat(value);
  return value.trim().endsWith("rem") ? n * rem : n;
}

// How many rows of chips fit in a day, kept current as the grid is resized.
// Every week is the same height, so one measurement serves every day.
function useChipSlots(ref: RefObject<HTMLDivElement | null>, rows: number, enabled: boolean): number {
  const [slots, setSlots] = useState(DEFAULT_SLOTS);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || !enabled) return;
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const chip = toPx(getComputedStyle(box).getPropertyValue("--chip-h") || "1.25rem", rem);
      const inner = box.clientHeight / rows - 2 * DAY_PAD_REM * rem - 1;
      setSlots(Math.max(0, Math.floor((inner - DAYNUM_REM * rem) / (chip + CHIP_GAP_PX))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref, rows, enabled]);
  return slots;
}

export interface MonthViewProps {
  // Any date in the month to show.
  anchor: ISODate;
  events: CalEvent[];
  onOpen: (event: CalEvent) => void;
  // The "+" beside a day's number was pressed, on a laptop.
  onCreate: (date: ISODate) => void;
  // A day was asked for: any part of it, its number or "+N more".
  onSelectDay: (date: ISODate) => void;
  isPhone: boolean;
}

export function MonthView({ anchor, events, onOpen, onCreate, onSelectDay, isPhone }: MonthViewProps) {
  const today = todayLocal();
  const p = parseISO(anchor) ?? parseISO(today)!;
  // Whole weeks after the month's last day are dropped, so a month is five or six weeks.
  const grid = monthGrid(p.year, p.month);
  let last = grid.length - 1;
  while (last > 0 && !grid[last].inMonth) last--;
  const cells = grid.slice(0, Math.ceil((last + 1) / 7) * 7);
  const rows = cells.length / 7;
  const daysRef = useRef<HTMLDivElement>(null);
  const slots = useChipSlots(daysRef, rows, !isPhone);

  return (
    <div className="cal-month" role="group" aria-label={titleFor("month", anchor)} style={{ "--month-rows": rows } as React.CSSProperties}>
      <div className="cal-weekdays" aria-hidden="true">
        {WEEKDAYS.map((name, i) => <div key={name} className={`cal-weekday${i >= 5 ? " is-weekend" : ""}`}>{name}</div>)}
      </div>
      <div ref={daysRef} className="cal-days">
        {cells.map((cell, i) => {
          const list = eventsOnDay(events, cell.iso);
          // When not every event fits, the last row is given to "+N more".
          const shown = list.length <= slots ? list : list.slice(0, Math.max(0, slots - 1));
          const hidden = list.length - shown.length;
          const isToday = cell.iso === today;
          const name = formatLong(cell.iso);
          return (
            <div
              key={cell.iso}
              className={`cal-day${cell.inMonth ? "" : " is-outside"}${i % 7 >= 5 ? " is-weekend" : ""}${isToday ? " is-today" : ""}`}
              onClick={() => onSelectDay(cell.iso)}
            >
              <div className="cal-day-head">
                <button
                  type="button"
                  className={`cal-daynum${isToday ? " is-today" : ""}`}
                  aria-current={isToday ? "date" : undefined}
                  aria-label={`${name}${list.length ? `, ${list.length === 1 ? "1 event" : `${list.length} events`}` : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectDay(cell.iso);
                  }}
                >
                  {cell.day}
                </button>
                {!isPhone && (
                  <button
                    type="button"
                    className="cal-day-add"
                    aria-label={`Add event on ${name}`}
                    title="Add event"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCreate(cell.iso);
                    }}
                  >
                    <span aria-hidden="true">+</span>
                  </button>
                )}
              </div>
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
