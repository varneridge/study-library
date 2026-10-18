// Position keys. Sorting them as strings gives the display order.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export function keyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

export function keysAfter(last: string | null, count: number): string[] {
  return generateNKeysBetween(last, null, count);
}

export function byPosition<T extends { position: string }>(a: T, b: T): number {
  return a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
}
