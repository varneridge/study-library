// The bar above a view. At the left, Today, one step back and one forward, and
// the heading for what is shown, in Literata Display. At the right, the choice
// of view and, on a laptop, the button for a new event, or on a phone the
// button for the list of calendars. A phone is offered Agenda, Day and Month;
// Week has seven columns too narrow to press.

import type { CalendarMode } from "../../lib/calendar";
import { Icon } from "../icons";

const DESKTOP_MODES: { mode: CalendarMode; label: string }[] = [
  { mode: "month", label: "Month" },
  { mode: "week", label: "Week" },
  { mode: "day", label: "Day" },
  { mode: "agenda", label: "Agenda" },
];
const PHONE_MODES: { mode: CalendarMode; label: string }[] = [
  { mode: "agenda", label: "Agenda" },
  { mode: "day", label: "Day" },
  { mode: "month", label: "Month" },
];
// What one step moves by, for the buttons' names.
const STEP_UNIT: Record<CalendarMode, string> = { month: "month", week: "week", day: "day", agenda: "60 days" };

export interface CalendarToolbarProps {
  mode: CalendarMode;
  title: string;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onModeChange: (mode: CalendarMode) => void;
  onNewEvent: () => void;
  // The list of calendars, which a phone has no side panel to show.
  onOpenCalendars?: () => void;
  isPhone: boolean;
}

export function CalendarToolbar({ mode, title, onToday, onPrev, onNext, onModeChange, onNewEvent, onOpenCalendars, isPhone }: CalendarToolbarProps) {
  const modes = isPhone ? PHONE_MODES : DESKTOP_MODES;
  return (
    <div className="cal-toolbar">
      <div className="cal-toolbar-start">
        <div className="cal-nav">
          <button type="button" className="button cal-today" onClick={onToday}>Today</button>
          <button type="button" className="icon-button cal-prev" aria-label={`Previous ${STEP_UNIT[mode]}`} onClick={onPrev}>
            <Icon name="caret" />
          </button>
          <button type="button" className="icon-button cal-next" aria-label={`Next ${STEP_UNIT[mode]}`} onClick={onNext}>
            <Icon name="caret" />
          </button>
        </div>
        <h1 className="cal-title" aria-live="polite">{title}</h1>
      </div>
      <div className="cal-toolbar-end">
        <div className="segmented cal-modes" role="group" aria-label="View">
          {modes.map((m) => (
            <button key={m.mode} type="button" className="tool" aria-pressed={mode === m.mode} onClick={() => onModeChange(m.mode)}>
              {m.label}
            </button>
          ))}
        </div>
        {isPhone
          ? onOpenCalendars && <button type="button" className="button cal-calendars" onClick={onOpenCalendars}>Calendars</button>
          : <button type="button" className="button primary cal-add" onClick={onNewEvent}>+ Add event</button>}
      </div>
    </div>
  );
}
