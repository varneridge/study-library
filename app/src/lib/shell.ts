// Whether the app runs in its own desktop window rather than a browser tab.
// The Windows launcher opens Edge at an address carrying ?sl=desktop, and a
// shell that sets its own user agent, such as a WebView2 one, can add
// SLDesktop/1 to it instead. Either is known before the first render, so the
// app never draws one layout and then swaps to another.

const SHELL_PARAM = "sl";
const SHELL_VALUE = "desktop";
const SESSION_KEY = "sl-shell";

// Dispatched, bubbling, on a desktop tab's pane just before it is hidden, so
// that a page can pause whatever should not run unseen. A listener on window
// can tell whether it was its own tab from event.target.contains(itsElement).
export const TAB_HIDDEN_EVENT = "sl:tab-hidden";

export function detectDesktop(userAgent: string, search: string, remembered: boolean): boolean {
  return /\bSLDesktop\/\d/.test(userAgent) || new URLSearchParams(search).get(SHELL_PARAM) === SHELL_VALUE || remembered;
}

// Read once, as the module loads. The mark is kept for the window's session,
// so that a reload still knows, and taken out of the address so that no link
// or copied address carries it into an ordinary browser tab.
function readDesktop(): boolean {
  if (typeof window === "undefined") return false;
  let remembered = false;
  try {
    remembered = sessionStorage.getItem(SESSION_KEY) === SHELL_VALUE;
  } catch {
    // Storage may be blocked, and then the address or the user agent decides alone.
  }
  const desktop = detectDesktop(navigator.userAgent, location.search, remembered);
  const params = new URLSearchParams(location.search);
  if (params.has(SHELL_PARAM)) {
    params.delete(SHELL_PARAM);
    const query = params.toString();
    history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  }
  if (desktop) {
    try {
      sessionStorage.setItem(SESSION_KEY, SHELL_VALUE);
    } catch {
      // Without storage a reload falls back to the browser layout until the next launch.
    }
  }
  return desktop;
}

const DESKTOP = readDesktop();

export function isDesktop(): boolean {
  return DESKTOP;
}

function isClear(colour: string): boolean {
  return colour === "transparent" || /^rgba\(.*,\s*0\)$/.test(colour);
}

function pageBackground(dark: boolean): string {
  for (const element of [document.body, document.documentElement]) {
    if (!element) continue;
    const colour = getComputedStyle(element).backgroundColor;
    if (colour && !isClear(colour)) return colour;
  }
  return dark ? "#1f1f1f" : "#ffffff";
}

// Edge draws the desktop window's title bar itself, in the page's theme
// colour, so DWM's caption colour never reaches it, and a theme colour left at
// black, or none at all under a dark Windows theme, is what draws the black bar
// above the app. This keeps one theme-color equal to the page's own background,
// and gives the tab strip the same colour, following every change of appearance.
export function followShellColour(): () => void {
  const root = document.documentElement;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  document.head.append(meta);
  let last = "";
  const paint = () => {
    const colour = pageBackground(dark.matches);
    if (colour === last) return;
    last = colour;
    meta.content = colour;
    root.style.setProperty("--sl-shell-bg", colour);
  };
  // A background that eases from one colour to the next is read again once it settles.
  const settled = (event: TransitionEvent) => {
    if (event.target === document.body || event.target === root) paint();
  };
  paint();
  const observer = new MutationObserver(paint);
  observer.observe(root, { attributes: true });
  if (document.body) observer.observe(document.body, { attributes: true });
  dark.addEventListener("change", paint);
  document.addEventListener("transitionend", settled);
  return () => {
    observer.disconnect();
    dark.removeEventListener("change", paint);
    document.removeEventListener("transitionend", settled);
    meta.remove();
    root.style.removeProperty("--sl-shell-bg");
  };
}
