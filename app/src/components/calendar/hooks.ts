// Two small hooks the calendar's parts share: whether the screen is a phone's,
// and what the date and minute of the day are, kept current.

import { useEffect, useState, useSyncExternalStore } from "react";
import { type ISODate, todayLocal } from "../../lib/civilDate";

// The width below which the app lays itself out for a phone, as the rest of it does.
export const PHONE_QUERY = "(max-width: 44rem)";

export function usePhone(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(PHONE_QUERY);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(PHONE_QUERY).matches,
    () => false,
  );
}

export interface Now {
  date: ISODate;
  minutes: number;
}

function read(): Now {
  const d = new Date();
  return { date: todayLocal(), minutes: d.getHours() * 60 + d.getMinutes() };
}

// Today's date and the minute of the day, renewed as each minute turns and
// when the page becomes visible again, so a calendar left open overnight
// moves on by itself.
export function useClock(): Now {
  const [now, setNow] = useState(read);
  useEffect(() => {
    const renew = () => setNow((prev) => {
      const next = read();
      return prev.date === next.date && prev.minutes === next.minutes ? prev : next;
    });
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        renew();
        schedule();
      }, 60_000 - (Date.now() % 60_000) + 50);
    };
    schedule();
    const visible = () => {
      if (document.visibilityState === "visible") renew();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  return now;
}
