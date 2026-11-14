// filename: app/src/lib/highlightComments.ts
// A highlight's comment has one home: the `comment` field of its highlight
// row. The card in the notes and the popover on the page both edit that
// field, so these helpers normalise what is stored and coalesce keystrokes
// into a bounded number of writes.

export const COMMENT_MAX = 10_000;
export const COMMENT_WRITE_DELAY_MS = 400;

// Trailing whitespace is dropped, an empty comment is stored as null (which
// is how a highlight without a comment already reads), and anything longer
// than COMMENT_MAX is cut so a pasted book cannot exhaust the sync payload.
export function normaliseComment(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.replace(/\s+$/u, "");
  if (trimmed.trim() === "") return null;
  return trimmed.length > COMMENT_MAX ? trimmed.slice(0, COMMENT_MAX) : trimmed;
}

export type CommentWrite = (highlightId: string, comment: string | null) => Promise<void>;

export interface CommentWriter {
  // Records the latest draft for a highlight and schedules its write.
  set(highlightId: string, raw: string): void;
  // Writes any pending draft now, for one highlight or for all of them.
  flush(highlightId?: string): Promise<void>;
  // Whether a draft for this highlight is still waiting to be written.
  pending(highlightId: string): boolean;
  // Writes everything pending and cancels its timers. The writer still accepts
  // drafts afterwards, because React runs an effect's cleanup and then the
  // effect again on the same memoised writer (StrictMode, Fast Refresh), and a
  // writer that refused drafts after that would silently drop every comment.
  dispose(): Promise<void>;
}

type Timer = ReturnType<typeof setTimeout>;

// Debounces per highlight, so typing in two cards does not cancel either
// write. A write that fails keeps its draft pending so that the next set()
// or flush() retries it, which is the recovery path for a quota error.
export function commentWriter(write: CommentWrite, delayMs = COMMENT_WRITE_DELAY_MS): CommentWriter {
  const drafts = new Map<string, string | null>();
  const timers = new Map<string, Timer>();
  const lastWritten = new Map<string, string | null>();

  async function writeOne(id: string): Promise<void> {
    const t = timers.get(id);
    if (t !== undefined) clearTimeout(t);
    timers.delete(id);
    if (!drafts.has(id)) return;
    const value = drafts.get(id) ?? null;
    if (lastWritten.has(id) && lastWritten.get(id) === value) {
      drafts.delete(id);
      return;
    }
    drafts.delete(id);
    try {
      await write(id, value);
      lastWritten.set(id, value);
    } catch (err) {
      // Keep the draft unless a newer one arrived while this write ran.
      if (!drafts.has(id)) drafts.set(id, value);
      throw err;
    }
  }

  return {
    set(id, raw) {
      drafts.set(id, normaliseComment(raw));
      const t = timers.get(id);
      if (t !== undefined) clearTimeout(t);
      timers.set(id, setTimeout(() => void writeOne(id).catch(() => undefined), delayMs));
    },
    async flush(id) {
      const ids = id === undefined ? [...drafts.keys()] : [id];
      const results = await Promise.allSettled(ids.map((x) => writeOne(x)));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) throw failed.reason;
    },
    pending(id) {
      return drafts.has(id);
    },
    async dispose() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      await this.flush();
    },
  };
}
