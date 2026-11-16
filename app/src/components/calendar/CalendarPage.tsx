// The calendar. It reads where it is from the route (a date, a view, an event),
// gathers the events for the dates on screen, keeps the Google cache fresh, and
// hands the rest to the views. On a laptop a side panel stands beside the view,
// and the toolbar can fold it away to give the view the width; on a phone the
// toolbar, the view, a button for a new event and a sheet of calendars take its
// place. A day pressed in the month opens its summary, and every new event,
// however it was asked for, opens the same form with its times ready.

import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AGENDA_DAYS,
  type CalEvent,
  CALENDAR_SETTINGS_ID,
  type CalendarMode,
  type CalendarSource,
  type EventSeed,
  defaultMode,
  rangeFor,
  readCalendarSettings,
  startOfWeek,
  stepAnchor,
  titleFor,
} from "../../lib/calendar";
import { type ISODate, addDays } from "../../lib/civilDate";
import { useCalendarEvents } from "../../lib/calendarEvents";
import { saveCalendarSettings } from "../../lib/calendarStore";
import { db } from "../../lib/db";
import { refreshGoogle, useGcalStatus } from "../../lib/gcal";
import { navigate, type Route } from "../../lib/router";
import { typing } from "../../lib/ui";
import { AgendaView } from "./AgendaView";
import { CalendarPanel, CalendarSidebar, type CalendarSidebarProps } from "./CalendarSidebar";
import { CalendarToolbar } from "./CalendarToolbar";
import { DayDetailSheet } from "./DayDetailSheet";
import { useClock, usePhone } from "./hooks";
import { DEFAULT_START, EventSheet } from "./EventSheet";
import { MonthView } from "./MonthView";
import { Sheet } from "./Sheet";
import { TimeGrid } from "./TimeGrid";

type CalendarRoute = Extract<Route, { view: "calendar" }>;

// "Show later" can add this many more pages of the agenda before the arrows are the way on.
const MAX_LATER = 6;

// Whether the side panel was last folded away is kept in this browser alone.
const SIDEBAR_KEY = "calendar.sidebar";
function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== "hidden";
  } catch {
    return true;
  }
}

// The side panel with the next seven days read for it, whatever dates the view shows.
// It is a part of its own so that a phone, which has no side panel, never reads them.
function SidebarWithUpcoming(props: Omit<CalendarSidebarProps, "upcomingEvents"> & { today: ISODate; hidden: CalendarSource[] }) {
  const { today, ...rest } = props;
  const upcomingEvents = useCalendarEvents(today, addDays(today, 6), props.hidden) ?? [];
  return <CalendarSidebar {...rest} upcomingEvents={upcomingEvents} />;
}

// A phone has no Week, so a link to one opens its Day.
function modeFor(route: CalendarRoute, phone: boolean): CalendarMode {
  const mode = route.mode ?? defaultMode(phone);
  return phone && mode === "week" ? "day" : mode;
}

export function CalendarPage({ route }: { route: CalendarRoute }) {
  const phone = usePhone();
  const now = useClock();
  const today = now.date;
  const anchor = route.date ?? today;
  const mode = modeFor(route, phone);

  // Show later extends the agenda from the date it was pressed on, and starts again on any other.
  const [later, setLater] = useState({ anchor: "", pages: 0 });
  const pages = later.anchor === anchor ? later.pages : 0;
  const base = rangeFor(mode, anchor);
  const range = mode === "agenda" ? { from: base.from, to: addDays(base.to, AGENDA_DAYS * pages) } : base;

  const settingsRow = useLiveQuery(() => db.settings.get(CALENDAR_SETTINGS_ID), []);
  const settings = readCalendarSettings(settingsRow && !settingsRow.deleted ? settingsRow.value : undefined);
  const events = useCalendarEvents(range.from, range.to, settings.hidden) ?? [];
  const gcal = useGcalStatus();

  // Where a new event starts, when it was asked for from a day or a time; a link to a new event starts on the date shown.
  const [seed, setSeed] = useState<EventSeed | null>(null);
  const [calendarsOpen, setCalendarsOpen] = useState(false);
  // The day whose summary is open, from the month.
  const [dayOpen, setDayOpen] = useState<ISODate | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const toggleSidebar = () => {
    const next = !sidebarOpen;
    setSidebarOpen(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "shown" : "hidden");
    } catch {
      // Without storage the choice lasts until the page is left.
    }
  };
  const pageRef = useRef<HTMLElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Whether the open sheet was pushed on by this page, so that closing it can step back.
  const pushedSheet = useRef(false);
  useEffect(() => {
    if (!route.event) pushedSheet.current = false;
  }, [route.event]);

  // Google is read when the page opens and when the connection returns.
  useEffect(() => {
    void refreshGoogle();
    const online = () => void refreshGoogle();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, []);

  // Headings that stick below the toolbar need to know how tall it is.
  useLayoutEffect(() => {
    const bar = toolbarRef.current;
    const page = pageRef.current;
    if (!bar || !page) return;
    const update = () => page.style.setProperty("--cal-toolbar-h", `${bar.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [phone]);

  // What the calendars panel asks for, in the sidebar and in the phone's sheet.
  const panel = {
    hidden: settings.hidden,
    onToggleSource: (source: CalendarSource) =>
      void saveCalendarSettings({ hidden: settings.hidden.includes(source) ? settings.hidden.filter((s) => s !== source) : [...settings.hidden, source] }),
    gcalStatus: gcal,
    onRefreshGcal: () => void refreshGoogle({ force: true }),
    gcalUrl: settings.icsUrl,
    onSaveGcalUrl: (url: string | null) => void saveCalendarSettings({ icsUrl: url }).then(() => refreshGoogle({ force: true })),
  };

  // Moving about changes the link without adding a step to Back.
  const go = (patch: Partial<Omit<CalendarRoute, "view">>) => void navigate({ ...route, ...patch }, { replace: true });
  const step = (dir: -1 | 1) => go({ date: stepAnchor(mode, anchor, dir) });
  const toToday = () => go({ date: undefined });
  const setMode = (next: CalendarMode) => go({ mode: next });
  // Opening a day from a month is a step in, so Back returns to the month.
  const showDay = (date: ISODate) => void navigate({ ...route, date, mode: "day" });

  const openEvent = (event: CalEvent) => {
    if (event.to) {
      void navigate(event.to);
      return;
    }
    pushedSheet.current = true;
    void navigate({ ...route, event: event.key });
  };
  const addEvent = (next: EventSeed) => {
    setSeed(next);
    pushedSheet.current = true;
    void navigate({ ...route, event: "new" });
  };
  // A new event on a day with no time chosen starts at the usual hour, wherever it was asked for.
  const addOn = (date: ISODate) => addEvent({ date, time: DEFAULT_START });
  const closeSheet = () => {
    if (pushedSheet.current) history.back();
    else void navigate({ ...route, event: undefined }, { replace: true });
  };

  // Google Calendar's own keys, for when no field or card has the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e) || route.event || document.querySelector('[aria-modal="true"]')) return;
      const next = (dir: -1 | 1) => go({ date: stepAnchor(mode, anchor, dir) });
      switch (e.key) {
        case "t": toToday(); break;
        case "j": case "ArrowRight": next(1); break;
        case "k": case "ArrowLeft": next(-1); break;
        case "m": setMode("month"); break;
        case "w": if (!phone) setMode("week"); break;
        case "d": setMode("day"); break;
        case "a": setMode("agenda"); break;
        case "c": addOn(anchor); break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const weekDays = mode === "week" ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor), i)) : [anchor];

  return (
    <section ref={pageRef} className={`page wide cal-page is-${mode}${phone ? " is-phone" : ""}`} aria-label="Calendar">
      <div className={`cal-layout${!phone && sidebarOpen ? "" : " is-solo"}`}>
        {!phone && sidebarOpen && (
          <SidebarWithUpcoming
            {...panel}
            today={today}
            onOpenEvent={openEvent}
            onNewEvent={() => addOn(anchor)}
          />
        )}
        <div className="cal-main">
          <div ref={toolbarRef} className="cal-toolbar-wrap">
            <CalendarToolbar
              mode={mode}
              title={titleFor(mode, anchor)}
              onToday={toToday}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onModeChange={setMode}
              onNewEvent={() => addOn(anchor)}
              onOpenCalendars={() => setCalendarsOpen(true)}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
              isPhone={phone}
            />
          </div>
          {phone && gcal.error && <p className="cal-notice" role="status">{gcal.error}</p>}
          {mode === "month" && (
            <MonthView
              anchor={anchor}
              events={events}
              onOpen={openEvent}
              onCreate={addOn}
              onSelectDay={setDayOpen}
              isPhone={phone}
            />
          )}
          {(mode === "week" || mode === "day") && (
            <TimeGrid
              days={weekDays}
              events={events}
              now={now}
              onOpen={openEvent}
              onCreate={(date, time) => addEvent({ date, time })}
              onDay={showDay}
            />
          )}
          {mode === "agenda" && (
            <AgendaView
              from={range.from}
              to={range.to}
              events={events}
              today={today}
              canShowLater={pages < MAX_LATER}
              onOpen={openEvent}
              onShowLater={() => setLater({ anchor, pages: pages + 1 })}
            />
          )}
        </div>
      </div>

      {phone && (
        <button type="button" className="cal-fab" aria-label="Add event" onClick={() => addOn(anchor)}>
          <span aria-hidden="true">+</span>
        </button>
      )}
      {/* The summary steps aside while an event from it is open, and returns when that closes. */}
      {dayOpen && !route.event && (
        <DayDetailSheet
          date={dayOpen}
          events={events}
          onOpen={openEvent}
          onAdd={addOn}
          onShowDay={(date) => {
            setDayOpen(null);
            showDay(date);
          }}
          onClose={() => setDayOpen(null)}
        />
      )}
      {route.event && <EventSheet eventKey={route.event} seed={seed ?? { date: anchor }} onClose={closeSheet} />}
      {calendarsOpen && (
        <Sheet title="Calendars" onClose={() => setCalendarsOpen(false)} foot={<button type="button" className="button" onClick={() => setCalendarsOpen(false)}>Done</button>}>
          <CalendarPanel {...panel} />
        </Sheet>
      )}
    </section>
  );
}
