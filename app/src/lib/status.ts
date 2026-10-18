// Whether the processor is running. It lives on a laptop or a server, not
// in the app, so the app asks the Worker when it last asked for work. One
// shared poll serves every part of the screen that wants to know.

import { useEffect, useState } from "react";
import { api } from "./sync";

export interface ProcessorStatus {
  seenAt: Date | null;
  queued: number;
  running: number;
  failed: number;
}

// The processor asks every ten seconds when idle, and reports in every five
// minutes during a long job. Fifteen minutes of silence means it is off.
const QUIET_MS = 15 * 60 * 1000;
const POLL_MS = 60 * 1000;

let latest: ProcessorStatus | null = null;
const listeners = new Set<(s: ProcessorStatus | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function check(): Promise<void> {
  if (!navigator.onLine || document.visibilityState !== "visible") return;
  try {
    const body = (await (await api("/api/status")).json()) as { processor_seen: number | null; queued: number; running: number; failed: number };
    latest = {
      seenAt: body.processor_seen ? new Date(body.processor_seen * 1000) : null,
      queued: body.queued, running: body.running, failed: body.failed,
    };
    listeners.forEach((listener) => listener(latest));
  } catch {
    // Offline or signed out. The last answer stands.
  }
}

export function useProcessorStatus(): ProcessorStatus | null {
  const [status, setStatus] = useState(latest);
  useEffect(() => {
    listeners.add(setStatus);
    if (listeners.size === 1) {
      void check();
      timer = setInterval(() => void check(), POLL_MS);
    }
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return status;
}

// True when work is waiting and the processor has gone quiet.
export function processorQuiet(status: ProcessorStatus | null, now = Date.now()): boolean {
  if (!status) return false;
  return !status.seenAt || now - status.seenAt.getTime() > QUIET_MS;
}

export function ago(date: Date, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

// What to say when something is waiting on a processor that has gone quiet.
export function waitingText(status: ProcessorStatus | null): string | null {
  if (!processorQuiet(status)) return null;
  return status?.seenAt ? `Waiting for the processor, last seen ${ago(status.seenAt)}` : "Waiting for the processor";
}
