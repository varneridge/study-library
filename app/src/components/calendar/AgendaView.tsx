// The agenda: a plain list of the days that have something on, each under a
// heading that stays in view as you scroll, and for each event its time, title,
// place and which calendar it is from. It is the view a phone opens on.

import { type CalEvent, SOURCE_BADGES, SOURCE_LABELS, describeWhen, eventsOnDay, timeLabel } from "../../lib/calendar";
import { type ISODate, addDays, formatLong } from "../../lib/civilDate";

export function AgendaView({ from, to, events, today, canShowLater, onOpen, onShowLater }: {
  from: ISODate;
  to: ISODate;
  events: CalEvent[];
  today: ISODate;
  canShowLater: boolean;
  onOpen: (event: CalEvent) => void;
  onShowLater: () => void;
}) {
  const days: { day: ISODate; list: CalEvent[] }[] = [];
  let total = 0;
  for (let day = from; day <= to && total < 1000; day = addDays(day, 1), total++) {
    const list = eventsOnDay(events, day);
    if (list.length) days.push({ day, list });
  }
  return (
    <div className="cal-agenda">
      {days.length === 0 && <p className="cal-empty">Nothing in the next {total} days.</p>}
      {days.map(({ day, list }) => (
        <section key={day} className="cal-agenda-section" aria-label={formatLong(day)}>
          <h2 className="cal-agenda-day">
            {formatLong(day)}
            {day === today && <span className="cal-today-tag">Today</span>}
          </h2>
          <ul className="cal-agenda-list">
            {list.map((event) => (
              <li key={event.key}>
                <button
                  type="button"
                  className={`cal-agenda-row src-${event.source}`}
                  aria-label={`${event.title}, ${describeWhen(event)}, ${SOURCE_LABELS[event.source]}`}
                  onClick={() => onOpen(event)}
                >
                  <span className="cal-agenda-time">{timeLabel(event, day)}</span>
                  <span className="cal-agenda-main">
                    <span className="cal-agenda-title">{event.title}</span>
                    {event.location && <span className="cal-agenda-where">{event.location}</span>}
                  </span>
                  <span className="cal-badge"><i className="cal-dot" aria-hidden="true" />{SOURCE_BADGES[event.source]}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {canShowLater && <button type="button" className="button cal-later" onClick={onShowLater}>Show later</button>}
    </div>
  );
}
