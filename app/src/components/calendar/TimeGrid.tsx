// The week and the day: one grid for both, seven columns or one. Events lasting
// all day sit in a strip above. Below, the twenty-four hours scroll, each 48
// pixels tall, with a gutter of times at the left, a line for now in today's
// column, and the day's events placed so that none overlap. Pressing an empty
// part of a column starts a new event at that half hour.

import { useLayoutEffect, useRef } from "react";
import { type CalEvent, SOURCE_LABELS, describeWhen, eventsOnDay, hhmm, layoutDay, timeLabel } from "../../lib/calendar";
import { type ISODate, formatLong, parseISO, weekdayMon0 } from "../../lib/civilDate";
import type { Now } from "./hooks";
import { Chip } from "./MonthView";

// The one place the height of an hour is set; the stylesheet reads it as --hour-h.
export const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function TimeGrid({ days, events, now, onOpen, onCreate, onDay }: {
  days: ISODate[];
  events: CalEvent[];
  now: Now;
  onOpen: (event: CalEvent) => void;
  onCreate: (date: ISODate, time: string) => void;
  onDay: (date: ISODate) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // On first showing, the morning is in view, or the hour before now if today is.
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const from = days.includes(now.date) ? Math.max(0, now.minutes - 60) : 7 * 60;
    box.scrollTop = (from / 60) * HOUR_PX;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = (e: React.MouseEvent<HTMLDivElement>, day: ISODate) => {
    if (e.target !== e.currentTarget) return;
    const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
    onCreate(day, hhmm(Math.min(Math.floor((y / HOUR_PX) * 2) * 30, 23 * 60 + 30)));
  };

  const style = { "--days": days.length, "--hour-h": `${HOUR_PX}px` } as React.CSSProperties;
  return (
    <div className="cal-timegrid" style={style}>
      <div className="cal-tg-head">
        <div className="cal-tg-corner" />
        {days.map((day) => {
          const p = parseISO(day)!;
          const body = (
            <>
              <span className="cal-tg-dow">{WEEKDAYS[weekdayMon0(day)]}</span>
              <span className={`cal-tg-num${day === now.date ? " is-today" : ""}`}>{p.day}</span>
            </>
          );
          return days.length > 1 ? (
            <button
              key={day}
              type="button"
              className="cal-tg-dayhead"
              aria-current={day === now.date ? "date" : undefined}
              aria-label={formatLong(day)}
              onClick={() => onDay(day)}
            >
              {body}
            </button>
          ) : (
            <div key={day} className="cal-tg-dayhead" aria-current={day === now.date ? "date" : undefined}>{body}</div>
          );
        })}
      </div>

      <div className="cal-tg-allday">
        <div className="cal-tg-corner cal-tg-alldaylabel">All day</div>
        {days.map((day) => (
          <div key={day} className="cal-tg-allcell">
            {eventsOnDay(events, day).filter((e) => e.allDay).map((event) => <Chip key={event.key} event={event} day={day} onOpen={onOpen} />)}
          </div>
        ))}
      </div>

      <div className="cal-tg-scroll" ref={scrollRef}>
        <div className="cal-tg-body">
          <div className="cal-tg-gutter" aria-hidden="true">
            {HOURS.map((h) => <span key={h} className="cal-hour" style={{ top: h * HOUR_PX }}>{hhmm(h * 60)}</span>)}
          </div>
          {days.map((day) => (
            <div
              key={day}
              className="cal-tg-col"
              role="group"
              aria-label={formatLong(day)}
              onClick={(e) => create(e, day)}
            >
              {layoutDay(events, day).map(({ event, top, height, col, cols }) => {
                const label = `${event.title}, ${describeWhen(event)}, ${SOURCE_LABELS[event.source]}`;
                return (
                  <button
                    key={event.key}
                    type="button"
                    className={`cal-event src-${event.source}`}
                    style={{
                      top: (top / 60) * HOUR_PX,
                      height: Math.max((height / 60) * HOUR_PX - 2, 18),
                      left: `${(col / cols) * 100}%`,
                      width: `${100 / cols}%`,
                    }}
                    aria-label={label}
                    title={label}
                    onClick={() => onOpen(event)}
                  >
                    <span className="cal-event-title">{event.title}</span>
                    {height >= 45 && <span className="cal-event-time">{timeLabel(event, day)}</span>}
                    {height >= 75 && event.location && <span className="cal-event-where">{event.location}</span>}
                  </button>
                );
              })}
              {day === now.date && <div className="cal-now" style={{ top: (now.minutes / 60) * HOUR_PX }} aria-hidden="true" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
