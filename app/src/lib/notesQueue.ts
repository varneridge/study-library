import { update } from "./sync";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

interface AppQueue {
  latest: string;
  persisted: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  status: SaveStatus;
  inFlight: Promise<void> | null;
  pendingText: string | null;
  retryCount: number;
}

const queues = new Map<string, AppQueue>();
const listenersByApp = new Map<string, Set<(status: SaveStatus) => void>>();

function getListeners(appId: string): Set<(status: SaveStatus) => void> {
  let set = listenersByApp.get(appId);
  if (!set) {
    set = new Set();
    listenersByApp.set(appId, set);
  }
  return set;
}

function notify(appId: string, q: AppQueue | undefined, status: SaveStatus) {
  if (q) q.status = status;
  const set = listenersByApp.get(appId);
  if (set) {
    for (const listener of set) {
      listener(status);
    }
  }
}

function cleanupIfIdle(appId: string, q: AppQueue) {
  if (
    q.latest === q.persisted &&
    !q.inFlight &&
    !q.timer &&
    q.pendingText === null
  ) {
    queues.delete(appId);
  }
}

async function flushInternal(appId: string, q: AppQueue): Promise<void> {
  if (q.timer) {
    clearTimeout(q.timer);
    q.timer = null;
  }
  if (q.latest === q.persisted) {
    notify(appId, q, "saved");
    cleanupIfIdle(appId, q);
    return;
  }
  if (q.inFlight) {
    q.pendingText = q.latest;
    return;
  }

  const textToSave = q.latest;
  notify(appId, q, "saving");

  const runWrite = async () => {
    try {
      await update("applications", appId, { notes: textToSave || null });
      q.persisted = textToSave;
      q.retryCount = 0;
      notify(appId, q, "saved");
    } catch {
      if (q.retryCount < 3) {
        q.retryCount += 1;
        setTimeout(() => {
          if (q.latest !== q.persisted) {
            void flushInternal(appId, q);
          }
        }, 1000 * q.retryCount);
      } else {
        notify(appId, q, "error");
      }
    } finally {
      q.inFlight = null;
      if (q.pendingText !== null) {
        const next = q.pendingText;
        q.pendingText = null;
        if (next !== q.persisted) {
          void flushInternal(appId, q);
        } else {
          cleanupIfIdle(appId, q);
        }
      } else {
        cleanupIfIdle(appId, q);
      }
    }
  };

  const promise = runWrite();
  q.inFlight = promise;
  await promise;
}

export const notesQueue = {
  // If queue has dirty or in-flight text, return it; otherwise return fallback
  get(appId: string, fallbackText?: string | null): string {
    const q = queues.get(appId);
    if (!q) return fallbackText ?? "";
    if (q.latest !== q.persisted || q.inFlight !== null || q.pendingText !== null) {
      return q.latest;
    }
    return fallbackText ?? "";
  },

  // Only set creates or activates a queue, taking the baseline the editor started from
  set(appId: string, text: string, baseline?: string | null) {
    let q = queues.get(appId);
    if (!q) {
      q = {
        latest: text,
        persisted: baseline ?? null,
        timer: null,
        status: "idle",
        inFlight: null,
        pendingText: null,
        retryCount: 0,
      };
      queues.set(appId, q);
    } else {
      q.latest = text;
      q.retryCount = 0;
    }

    if (q.timer) clearTimeout(q.timer);
    q.timer = setTimeout(() => {
      void flushInternal(appId, q!);
    }, 400);
  },

  async flush(appId: string): Promise<void> {
    const q = queues.get(appId);
    if (!q) return;
    await flushInternal(appId, q);
  },

  getStatus(appId: string): SaveStatus {
    return queues.get(appId)?.status ?? "idle";
  },

  getPersisted(appId: string): string | null {
    return queues.get(appId)?.persisted ?? null;
  },

  // subscribe does NOT create a queue
  subscribe(appId: string, callback: (status: SaveStatus) => void): () => void {
    const set = getListeners(appId);
    set.add(callback);
    const currentStatus = queues.get(appId)?.status ?? "idle";
    callback(currentStatus);
    return () => {
      set.delete(callback);
      if (set.size === 0) {
        listenersByApp.delete(appId);
      }
    };
  },
};

// Listen to visibilitychange and pagehide to flush any dirty queues
if (typeof window !== "undefined") {
  const onFlushAll = () => {
    for (const [appId, q] of queues.entries()) {
      if (q.latest !== q.persisted) {
        void flushInternal(appId, q);
      }
    }
  };
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") onFlushAll();
  });
  window.addEventListener("pagehide", onFlushAll);
}
