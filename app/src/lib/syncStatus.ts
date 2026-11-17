// One sync status for the whole app, so that the top bar, Settings and
// anywhere else show the same symbol and the same words for the same state.

import type { SyncState } from "./sync";

export type SyncStatus = "expired" | "paused" | "offline" | "error" | "syncing" | "pending" | "synced";

export type SyncIconName = "warning" | "syncPaused" | "syncOffline" | "syncSpin" | "syncPending" | "syncDone";

export type SyncView = {
  status: SyncStatus;
  icon: SyncIconName;
  label: string;
  spinning: boolean;
  // Whether the person has to do something, or know that something went wrong.
  problem: boolean;
};

// The most urgent state wins. A session that has ended stops everything else
// from working, a pause is deliberate and short, and an offline device fails
// every push, so its last error would only repeat what offline already says.
export function syncStatus(s: SyncState): SyncStatus {
  if (s.expired) return "expired";
  if (s.paused) return "paused";
  if (!s.online) return "offline";
  if (s.error) return "error";
  if (s.busy || s.pulling) return "syncing";
  if (s.pending > 0) return "pending";
  return "synced";
}

function changes(n: number): string {
  return `${n} ${n === 1 ? "change" : "changes"}`;
}

export function syncView(s: SyncState): SyncView {
  const status = syncStatus(s);
  const n = s.pending;
  switch (status) {
    case "expired":
      return { status, icon: "warning", spinning: false, problem: true, label: "Your sign-in has ended, so nothing will sync until you sign in again." };
    case "paused":
      return { status, icon: "syncPaused", spinning: false, problem: false, label: "Sync is paused while this device starts again, and it resumes once that finishes." };
    case "offline":
      return {
        status, icon: "syncOffline", spinning: false, problem: false,
        label: n
          ? `You are offline, so ${changes(n)} will wait on this device until it reconnects.`
          : "You are offline, so new changes will wait on this device until it reconnects.",
      };
    case "error":
      return {
        status, icon: "warning", spinning: false, problem: true,
        label: n
          ? `The last sync did not finish, so ${changes(n)} will be sent when it tries again shortly.`
          : "The last sync did not finish, so it will try again shortly.",
      };
    case "syncing":
      return { status, icon: "syncSpin", spinning: true, problem: false, label: "Changes are being exchanged with the server now." };
    case "pending":
      return {
        status, icon: "syncPending", spinning: false, problem: false,
        label: `${changes(n)} ${n === 1 ? "is" : "are"} saved on this device and will be sent in a moment.`,
      };
    case "synced":
      return { status, icon: "syncDone", spinning: false, problem: false, label: "Everything on this device is saved to the server." };
  }
}
