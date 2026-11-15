// How a session page shares its width between the notes and the readings
// beside them. The fraction is the notes' share, and it is kept in memory
// only, so moving between sessions keeps the same split while a fresh visit
// to the app starts evenly again.

export const DEFAULT_SPLIT = 0.5;
export const MIN_SPLIT = 0.3;
export const MAX_SPLIT = 0.7;
export const SPLIT_STEP = 0.05;

let current = DEFAULT_SPLIT;

// Rounded to thousandths so that repeated steps never drift into values such
// as 0.6500000000000001, which would show as a stray percentage to a screen reader.
const tidy = (n: number) => Math.round(n * 1000) / 1000;

export function clampSplit(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_SPLIT;
  return tidy(Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, fraction)));
}

// Where the pointer sits across the grid, as the notes' share of it. A grid
// with no width yet gives the default, since there is nothing to measure.
export function splitFromPointer(clientX: number, rect: { left: number; width: number }): number {
  if (!(rect.width > 0)) return DEFAULT_SPLIT;
  return clampSplit((clientX - rect.left) / rect.width);
}

// The two grid tracks as whole fr units summing to 1000, because integers keep
// the columns stable as the handle moves where long decimals can round
// differently from one frame to the next.
export function splitColumns(fraction: number): { "--split-a": string; "--split-b": string } {
  const a = Math.round(clampSplit(fraction) * 1000);
  return { "--split-a": `${a}fr`, "--split-b": `${1000 - a}fr` };
}

// The new split for a key pressed on the handle, or null when the key is not
// one the handle answers to, so the caller knows to leave the event alone.
export function splitFromKey(fraction: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft": return clampSplit(fraction - SPLIT_STEP);
    case "ArrowRight": return clampSplit(fraction + SPLIT_STEP);
    case "Home": return MIN_SPLIT;
    case "End": return MAX_SPLIT;
    default: return null;
  }
}

export function readSplit(): number {
  return current;
}

// Stores the split, within its limits, and hands back what was stored so a
// caller can put the same value into its own state.
export function writeSplit(fraction: number): number {
  current = clampSplit(fraction);
  return current;
}
