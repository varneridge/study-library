// Limits that keep Listen well inside Cloudflare's free plan, in one place.
// On the free plan, going over a D1 limit stops the whole site saving until
// midnight UTC rather than sending a bill, and prepared audio is the one thing
// whose use grows on its own, so Listen keeps to a share of each allowance.
// worker/listen.ts enforces the Worker's limits and prepared.ts the device's.

/** Listen's share of D1's 100,000 rows written a day; the rest stays for notes and sync. */
export const WRITE_BUDGET = 30_000;
/** Prepared audio's share of R2's free 10 GB; the rest stays for readings. */
export const AUDIO_CAP_BYTES = 5 * 1024 ** 3;
/** Clearing out starts when audio reaches this share of its cap. */
export const EVICT_AT = 0.9;
/** Audio for paragraphs nobody has asked for in this many days may be cleared out, oldest first. */
export const EVICT_AFTER_DAYS = 60;
/** Reopening a reading marks its paragraphs as wanted again only after this long. */
export const REMARK_AFTER_MINUTES = 60;
/** The free plan's largest database, shown in Settings beside the database's size. */
export const DATABASE_LIMIT_BYTES = 500 * 1024 ** 2;
/** Prepared audio kept on one device; past it, what was played longest ago goes first. */
export const DEVICE_CAP_BYTES = 500 * 1024 ** 2;
/**
 * Rows D1 counts for one row written to listen_audio: the row itself and one
 * for each of its indexes, which since listen_audio_status (migration 0023)
 * are its key's and that one. Set from rows_written for one new paragraph on
 * the local database, and raised whenever listen_audio gains an index, since
 * counting too few is the direction that could stop the site saving.
 */
export const ROW_COST = 3;

/** How many of `wanted` writes fit in what is left of today's budget, given what is spent. */
export function writesThatFit(spent: number, wanted: number, budget: number): number {
  return Math.max(0, Math.min(wanted, Math.floor((budget - spent) / ROW_COST)));
}
