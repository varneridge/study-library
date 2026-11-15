// Motion that respects the reader's wish for less of it, checked each time
// rather than once, because the setting can change while the app is open.

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// How far a slide travels as it arrives, in pixels. It is kept short so the
// turn reads as a direction rather than a journey across the screen.
const SLIDE_SHIFT = 24;

// A slide arrives from the side it was turned towards: going forward it comes
// in from the right, going back from the left. Nothing moves when motion is
// reduced or the slide has not changed, so null tells the caller to skip.
export function slideKeyframes(step: number, reduced: boolean): Keyframe[] | null {
  if (reduced || !Number.isFinite(step) || step === 0) return null;
  const from = Math.sign(step) * SLIDE_SHIFT;
  return [
    { transform: `translateX(${from}px)`, opacity: 0.35 },
    { transform: "translateX(0)", opacity: 1 },
  ];
}

export const SLIDE_TIMING = { duration: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" as const };
