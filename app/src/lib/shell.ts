// Whether the app runs in its own desktop window rather than a browser tab.
// The Windows launcher opens Edge at an address carrying ?sl=desktop, a shell
// that sets its own user agent, such as a WebView2 one, can add SLDesktop/1 to
// it instead, and an installed window on Windows, which reports the standalone
// display mode, counts as well, so that a window opened from its Start menu
// entry rather than by the launcher still has its tabs. Each is known before
// the first render, so the app never draws one layout and then swaps to another.

const SHELL_PARAM = "sl";
const SHELL_VALUE = "desktop";
const SESSION_KEY = "sl-shell";
// Kept for the window's session once the launcher says this computer lacks its
// processor credentials, until "Connect this computer" is pressed.
const CONNECT_KEY = "sl-needs-connect";
const CONNECT_EVENT = "sl:connect-changed";
// The colour of the app's light page, used only when nothing else can be read.
const LIGHT_FALLBACK = "#FCFCFB";

// Dispatched, bubbling, on a desktop tab's pane just before it is hidden, so
// that a page can pause whatever should not run unseen. A listener on window
// can tell whether it was its own tab from event.target.contains(itsElement).
export const TAB_HIDDEN_EVENT = "sl:tab-hidden";

export function detectDesktop(userAgent: string, search: string, remembered: boolean, standalone = false): boolean {
  return (
    /\bSLDesktop\/\d/.test(userAgent) ||
    new URLSearchParams(search).get(SHELL_PARAM) === SHELL_VALUE ||
    remembered ||
    (standalone && /\bWindows NT\b/.test(userAgent))
  );
}

// Read once, as the module loads, which App arranges to happen before the
// router can rewrite the address. The mark is kept for the window's session,
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
  const standalone = typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches;
  const desktop = detectDesktop(navigator.userAgent, location.search, remembered, standalone);
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

// Whether the launcher said, when it opened this window, that this computer
// still lacks its processor credentials.
export function needsConnecting(): boolean {
  try {
    return sessionStorage.getItem(CONNECT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setNeedsConnecting(needs: boolean): void {
  try {
    if (needs) sessionStorage.setItem(CONNECT_KEY, "1");
    else sessionStorage.removeItem(CONNECT_KEY);
  } catch {
    // Without storage the status falls back to whether a processor has been seen.
  }
  window.dispatchEvent(new Event(CONNECT_EVENT));
}

export function subscribeNeedsConnecting(listener: () => void): () => void {
  window.addEventListener(CONNECT_EVENT, listener);
  return () => window.removeEventListener(CONNECT_EVENT, listener);
}

function isClear(colour: string): boolean {
  return colour === "transparent" || /^rgba\(.*,\s*0\)$/.test(colour);
}

// The colour the app is drawn on. The body, the root and the app's mount are
// asked first, and then the app's own --bg token through a probe, whose last
// resort is Canvas in the colour scheme the app declares. The system's dark
// scheme is never consulted, because falling back to near black under a light
// page is what painted the theme colour, and with it Edge's title bar and the
// tab strip, as a black bar above the app.
function pageBackground(): string {
  for (const element of [document.body, document.documentElement, document.getElementById("root")]) {
    if (!element) continue;
    const colour = getComputedStyle(element).backgroundColor;
    if (colour && !isClear(colour)) return colour;
  }
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;width:0;height:0;background-color:var(--bg, var(--paper, Canvas))";
  (document.body ?? document.documentElement).append(probe);
  const colour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return colour && !isClear(colour) ? colour : LIGHT_FALLBACK;
}

// Edge draws the desktop window's title bar itself, in the page's theme
// colour, so DWM's caption colour never reaches it. This keeps a single
// theme-color equal to the page's own background, puts it back if other code
// adds or changes one, and gives the tab strip the same colour, following
// every change of appearance.
export function followShellColour(): () => void {
  const root = document.documentElement;
  const dark = window.matchMedia("(prefers-color-scheme: dark)");
  const metas = () => document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  metas().forEach((meta) => meta.remove());
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  document.head.append(meta);
  let last = "";
  const paint = () => {
    metas().forEach((other) => {
      if (other !== meta) other.remove();
    });
    const colour = pageBackground();
    if (meta.content !== colour) meta.content = colour;
    if (colour === last) return;
    last = colour;
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
  observer.observe(document.head, { childList: true });
  observer.observe(meta, { attributes: true, attributeFilter: ["content"] });
  // A page following the device's appearance changes colour without any attribute changing.
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
