import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
// First among the app's own modules, so that the desktop mark is read from the
// address before any module that loads the router has a chance to rewrite it.
import { followShellColour, followWindowControls, isDesktop, setNeedsConnecting } from "./lib/shell";
import { AcrossPage } from "./components/AcrossPage";
import { Home } from "./components/Home";
import { ModulePage } from "./components/ModulePage";
import { AssessmentPage } from "./components/AssessmentPage";
import { SearchPage } from "./components/SearchPage";
import { SessionPage } from "./components/SessionPage";
import { Settings, connectionOf, useNeedsConnecting } from "./components/Settings";
import { WeekPage } from "./components/WeekPage";
import { href, navigate, useRoute, type Route } from "./lib/router";
import { INSTALLER_DOWNLOAD_URL, INSTALLER_FILE_NAME, openInDesktopHref } from "./lib/update";
import { flush, pull, startSync, stopSync, subscribeSync } from "./lib/sync";
import type { SyncView } from "./lib/syncStatus";
import { useProcessorStatus } from "./lib/status";
import { resumeUploads } from "./lib/uploads";
import { pumpChunks, recoverRecordings } from "./lib/recorder";
import { db } from "./lib/db";
import { byPosition } from "./lib/keys";
import { openShortcuts, typing, useCloseOnBack } from "./lib/ui";
import { Overlays } from "./components/Overlays";
import { Palette } from "./components/Palette";
import { DropAnywhere } from "./components/DropAnywhere";
import { RecorderPill } from "./components/RecorderPill";
import { PageLoading } from "./components/ErrorBoundary";
import { Icon, SyncIcon, useSyncView, type IconName } from "./components/icons";
import { DesktopTabBar, useDesktopTabs } from "./components/TabBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { retryUpload, onUploadProgress, uploadProgress } from "./lib/uploads";
import { useAppearanceSync, useAccentSync } from "./lib/appearance";
import { useLiveQuery } from "dexie-react-hooks";
import { UpdateBanner } from "./components/UpdateBanner";

// The reader carries pdf.js, the largest part of the app, so it loads when a
// reading is first opened rather than with the home page.
const Reader = lazy(() => import("./components/Reader").then((m) => ({ default: m.Reader })));
const opening = <PageLoading label="Opening the reading" />;
const WordProcessor = lazy(() => import("./components/WordProcessor").then((m) => ({ default: m.WordProcessor })));
const openingEssay = <PageLoading label="Opening the word processor" />;
// The job search is its own part of the app, loaded when first opened.
const JobsPage = lazy(() => import("./components/JobsPage").then((m) => ({ default: m.JobsPage })));
// The calendar is the third part of the app, loaded when first opened.
const CalendarPage = lazy(() => import("./components/calendar/CalendarPage").then((m) => ({ default: m.CalendarPage })));

export function Link({ to, children, className, current, currentSide, title, label, tabIndex, ariaHidden }: {
  to: Route; children: React.ReactNode; className?: string; current?: boolean; title?: string; label?: string;
  tabIndex?: number; ariaHidden?: boolean;
  // The side of the app you are on, in the switch, rather than this very page.
  currentSide?: boolean;
}) {
  return (
    <a
      className={className}
      title={title}
      aria-label={label}
      aria-current={current ? "page" : currentSide ? "true" : undefined}
      tabIndex={tabIndex}
      aria-hidden={ariaHidden ? true : undefined}
      href={href(to)}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

// A menu in the top bar closes on Back, on Escape and on a press anywhere
// outside it, so every menu there lets go in the same way.
function useMenuDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useCloseOnBack(open, close);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open, close, ref]);
}

// A compact icon in the top bar, in the manner of Word's save indicator. Its
// symbol and words come from useSyncView, so the top bar shows exactly what
// Settings and everywhere else show for the same state. Pressing it opens the
// details, with the upload list beneath them, and the live region inside
// announces problems and going offline without anything being opened.
function SyncStatus() {
  const view = useSyncView();
  const [open, setOpen] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const wasBusy = useRef(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [, tick] = useState(0);
  const uploads = useLiveQuery(() => db.uploads.toArray(), [], []);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, close, ref);
  useEffect(() => onUploadProgress(() => tick((n) => n + 1)), []);

  const failedUploads = uploads.filter((u) => u.status === "failed");
  // A failed upload is not part of the sync state, so it borrows the set's
  // warning symbol rather than drawing a symbol of its own.
  const shown: SyncView = failedUploads.length > 0 && !view.problem
    ? {
        ...view, icon: "warning", spinning: false, problem: true,
        label: failedUploads.length === 1
          ? "1 upload could not finish, so open this to retry it."
          : `${failedUploads.length} uploads could not finish, so open this to retry them.`,
      }
    : view;
  const busy = !shown.problem && (shown.status === "syncing" || shown.status === "pending");

  // The tick shows for a moment after work finishes, so a save is confirmed
  // rather than passing unseen, and is withdrawn at once if a problem appears.
  useEffect(() => {
    if (busy || shown.problem) setJustSynced(false);
    else if (wasBusy.current) setJustSynced(true);
    wasBusy.current = busy;
  }, [busy, shown.problem]);
  useEffect(() => {
    if (!justSynced) return;
    const timer = window.setTimeout(() => setJustSynced(false), 1800);
    return () => window.clearTimeout(timer);
  }, [justSynced]);

  // Routine syncs change the symbol but are not announced, so a screen reader
  // is not interrupted every time the app checks for changes.
  const announcement = shown.problem || shown.status === "offline" ? shown.label : "";

  // The symbol spins by itself, so the button carries no busy class that
  // would spin it a second time.
  return (
    <span className="sync menu" ref={ref}>
      <button
        type="button"
        className={`topbar-btn sync-indicator${shown.problem ? " problem" : justSynced ? " done" : ""}`}
        aria-label={shown.label}
        title={shown.label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <SyncIcon view={shown} size={18} />
        <span className="sr-only" aria-live="polite">{announcement}</span>
      </button>
      {open && (
        <div className="menu-panel sync-panel" role="dialog" aria-label="Sync status">
          <p className="sync-message" style={{ margin: 0 }}>
            {shown.label}
            {shown.status === "error" && (
              <>
                {" "}
                <button type="button" className="button small" onClick={() => void flush().then(() => pull()).catch(() => undefined)}>Try again</button>
              </>
            )}
          </p>
          {uploads.length > 0 && (
            <>
              {uploads.map((u) => {
                const p = uploadProgress(u.id);
                return (
                  <div key={u.id} className="upload-row">
                    <span className="name" title={u.name}>{u.name}</span>
                    {u.status === "failed"
                      ? <button type="button" className="link" onClick={() => retryUpload(u.id)}>Retry</button>
                      : <span className="where">{p !== undefined ? `${Math.round(p * 100)}%` : "Waiting"}</span>}
                    <span className="bar"><span style={{ width: `${Math.round((p ?? 0) * 100)}%` }} /></span>
                  </div>
                );
              })}
              <p className="small muted" style={{ margin: "0.5rem 0 0" }}>Uploads carry on if you close the app, and resume when you return.</p>
            </>
          )}
        </div>
      )}
    </span>
  );
}

function ExpiredBanner() {
  const [expired, setExpired] = useState(false);
  useEffect(() => subscribeSync((s) => setExpired(s.expired)), []);
  if (!expired) return null;
  return (
    <div className="banner" role="status">
      <span>Your Cloudflare Access session has ended. Edits are kept on this device until you sign in again.</span>
      <button className="button" onClick={() => location.reload()}>Reload</button>
    </div>
  );
}

// The screen drawn as a line glyph, at the weight of the bar's other icons,
// so that the button reads as handing the page to a computer.
function DesktopGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2.5 3h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM6 14h4M8 11.5V14"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// In a browser, the page in view can be handed to the desktop app, or the app
// downloaded by anyone who does not have it yet. It is the one filled button
// in the bar, as Word's Share is, because it is the only thing there that
// takes you somewhere outside the app. It sits among the tools, so on a
// phone, where the desktop app is of no use, it goes with them.
function OpenOnDesktop({ route }: { route: Route }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, close, ref);
  return (
    <span className="menu open-desktop" ref={ref}>
      <button
        type="button"
        className="topbar-btn open-desktop-btn"
        // The name holds where the words are hidden, between a phone and a laptop.
        aria-label="Open on desktop"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <DesktopGlyph />
        <span>Open on desktop</span>
        <span className="open-desktop-chevron" aria-hidden="true"><Icon name="down" size={14} /></span>
      </button>
      {open && (
        <div className="menu-panel open-desktop-panel" role="menu" aria-label="Open on desktop">
          <a role="menuitem" className="menu-link" href={openInDesktopHref(href(route))} onClick={close}>
            Open in desktop
          </a>
          <a role="menuitem" className="menu-link" href={INSTALLER_DOWNLOAD_URL} download={INSTALLER_FILE_NAME} onClick={close}>
            Download desktop app
          </a>
        </div>
      )}
    </span>
  );
}

// In the desktop window, a small dot on Settings shows that the background
// processor needs connecting, so the state is plain at a glance without
// adding anything to an ordinary browser tab.
function ConnectionDot() {
  const status = useProcessorStatus();
  const unpaired = useNeedsConnecting();
  if (connectionOf(status, unpaired) !== "needs") return null;
  return (
    <span className="sl-connect-dot" title="The background processor needs connecting">
      <span className="sr-only">, the background processor needs connecting</span>
    </span>
  );
}

// The modules, always one click away.
function ModuleLinks({ route }: { route: Route }) {
  const modules = useLiveQuery(async () => (await db.modules.toArray()).filter((m) => !m.deleted).sort(byPosition), [], []);
  const lookedUpModule = useLiveQuery(async () => {
    if (route.view === "week") return (await db.weeks.get(route.id))?.module_id ?? null;
    let sessionId = route.view === "session" ? route.id : null;
    if (sessionId) {
      const session = await db.sessions.get(sessionId);
      return session ? (await db.weeks.get(session.week_id))?.module_id ?? null : null;
    }
    return null;
  }, [route]);
  const currentModule =
    route.view === "module" || route.view === "assessment"
      ? route.id
      : route.view === "week" || route.view === "session"
        ? lookedUpModule
        : null;
  // The home page lists every module itself, so the bar does not repeat them there.
  if (modules.length < 2 || route.view === "home") return null;
  return (
    <>
      <span className="topbar-sep" aria-hidden="true" />
      <nav className="modules-nav" aria-label="Modules">
        {modules.map((m) => (
          <Link key={m.id} to={{ view: "module", id: m.id }} current={currentModule === m.id} title={m.title ?? undefined}>{m.code}</Link>
        ))}
      </nav>
    </>
  );
}

// The phone's tab bar: four places, always in reach of a thumb. It is for
// going somewhere, never for an action, as Apple's guidelines put it. Each
// tab stays lit for every page within its section.
function TabBar({ route }: { route: Route }) {
  useEffect(() => {
    document.documentElement.classList.add("with-tabs");
    return () => document.documentElement.classList.remove("with-tabs");
  }, []);
  const section = route.view === "calendar" || route.view === "search" || route.view === "settings" ? route.view : "home";
  const tabs: { key: string; to: Route; label: string; icon: IconName }[] = [
    { key: "home", to: { view: "home" }, label: "Home", icon: "home" },
    { key: "calendar", to: { view: "calendar" }, label: "Calendar", icon: "calendar" },
    { key: "search", to: { view: "search" }, label: "Search", icon: "search" },
    { key: "settings", to: { view: "settings" }, label: "Settings", icon: "settings" },
  ];
  return (
    <nav className="tab-bar" aria-label="Sections">
      {tabs.map((tab) => (
        <Link key={tab.key} to={tab.to} className={`tab${section === tab.key ? " on" : ""}`} current={section === tab.key}>
          <Icon name={tab.icon} size={22} />
          <span>{tab.label}</span>
        </Link>
      ))}
    </nav>
  );
}

// While a field has the cursor on a touch screen, the keyboard is up, so
// the tab bar steps aside rather float over it. While it is up, the
// cursor is also kept clear of the keyboard: whenever the visible area
// shrinks or the caret moves, a caret that has slipped under the keyboard is
// brought back into view by scrolling the nearest scrolling pane.
const KEYBOARD_CLEARANCE = 28;
const SCROLL_PANES = ".scroller, .pane-body, .session-notes, .sheet-dialog";

function useTypingClass() {
  useEffect(() => {
    const editable = (el: EventTarget | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
      return el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "file", "range"].includes((el as HTMLInputElement).type);
    };
    const root = document.documentElement;
    const viewport = window.visualViewport;

    // The pane that scrolls the caret, preferring the app's known scrolling
    // panes and otherwise any ancestor that can still scroll further down.
    const scrollParent = (start: Node | null): HTMLElement | null => {
      let node: HTMLElement | null = start instanceof HTMLElement ? start : start?.parentElement ?? null;
      for (; node && node !== document.body; node = node.parentElement) {
        const canScroll = node.scrollHeight > node.clientHeight + 1;
        if (canScroll && node.matches(SCROLL_PANES)) return node;
        if (canScroll && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node;
      }
      return null;
    };

    let frame = 0;
    // A smooth scroll takes a moment, and the caret reports its old place
    // until it ends, so a second correction is held back until it has settled.
    let settleUntil = 0;
    const ensureVisible = () => {
      if (!viewport || !root.classList.contains("typing")) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (performance.now() < settleUntil) return;
        const active = document.activeElement;
        if (!editable(active)) return;
        const coarse = window.matchMedia("(pointer: coarse)").matches;
        const selection = window.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
        let rect: DOMRect | null = range && active!.contains(range.startContainer) ? range.getBoundingClientRect() : null;
        if (!rect || (rect.width === 0 && rect.height === 0)) {
          if (active!.isContentEditable && range && active!.contains(range.startContainer)) {
            const lineEl = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
            rect = lineEl ? lineEl.getBoundingClientRect() : null;
          } else {
            rect = active!.getBoundingClientRect();
          }
        }
        if (!rect || (rect.width === 0 && rect.height === 0)) return;
        const topLimit = viewport.offsetTop;
        const bottomLimit = viewport.offsetTop + viewport.height - (coarse ? KEYBOARD_CLEARANCE : 0);
        const delta = rect.bottom > bottomLimit ? rect.bottom - bottomLimit : rect.top < topLimit ? rect.top - topLimit : 0;
        if (delta === 0) return;
        const behavior: ScrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
        const pane = scrollParent(range && active!.contains(range.startContainer) ? range.startContainer : active);
        const paneHasRoom = pane !== null && (delta > 0 ? pane.scrollTop + pane.clientHeight < pane.scrollHeight - 1 : pane.scrollTop > 0);
        if (paneHasRoom) pane.scrollBy({ top: delta, behavior });
        else window.scrollBy({ top: delta, behavior });
        settleUntil = performance.now() + 350;
      });
    };
    const onSelection = () => {
      if (window.matchMedia("(pointer: coarse)").matches) ensureVisible();
    };

    // On touch devices, watch viewport resize/scroll and selection moves for the
    // on-screen keyboard; on desktop, only pan on actual typing (input) and only
    // by the minimum needed if the caret goes off-screen.
    let watching = false;
    const watch = (yes: boolean) => {
      if (yes === watching) return;
      watching = yes;
      const coarse = window.matchMedia("(pointer: coarse)").matches;
      if (yes) {
        viewport?.addEventListener("resize", ensureVisible);
        document.addEventListener("input", ensureVisible, true);
        if (coarse) {
          viewport?.addEventListener("scroll", ensureVisible);
          document.addEventListener("selectionchange", onSelection);
        }
      } else {
        viewport?.removeEventListener("resize", ensureVisible);
        document.removeEventListener("input", ensureVisible, true);
        viewport?.removeEventListener("scroll", ensureVisible);
        document.removeEventListener("selectionchange", onSelection);
        cancelAnimationFrame(frame);
      }
    };

    const check = () => {
      if (!editable(document.activeElement)) {
        root.classList.remove("typing");
        watch(false);
      }
    };
    // A field taken off the page while it has the cursor fires no focusout,
    // so while the class is on it is checked again every half second.
    let timer: ReturnType<typeof setInterval> | undefined;
    const on = (e: FocusEvent) => {
      if (!editable(e.target)) return;
      root.classList.add("typing");
      watch(true);
      if (window.matchMedia("(pointer: coarse)").matches) ensureVisible();
      clearInterval(timer);
      timer = setInterval(() => { check(); if (!root.classList.contains("typing")) clearInterval(timer); }, 500);
    };
    const off = () => setTimeout(check, 50);
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", off);
    return () => {
      clearInterval(timer);
      watch(false);
      document.removeEventListener("focusin", on);
      document.removeEventListener("focusout", off);
    };
  }, []);
}


// Study Library, the calendar and the job search share one top bar. The brand
// names the side you are on and leads to its home, the switch moves between
// the three sides, and the sync indicator, Search and Settings sit in the same
// place on all of them.
type Side = "study" | "calendar" | "jobs";

function sideOf(route: Route): Side {
  return route.view === "jobs" ? "jobs" : route.view === "calendar" ? "calendar" : "study";
}

function SideSwitch({ side }: { side: Side }) {
  return (
    <nav className="side-switch" aria-label="Study, calendar or job search">
      <Link to={{ view: "home" }} className="side-study" currentSide={side === "study"}>Study</Link>
      <Link to={{ view: "calendar" }} className="to-calendar" currentSide={side === "calendar"}>Calendar</Link>
      <Link to={{ view: "jobs" }} className="to-jobs" currentSide={side === "jobs"}>
        <span className="wide-only">Job search</span><span className="narrow-only">Jobs</span>
      </Link>
    </nav>
  );
}

function TopBar({ route }: { route: Route }) {
  const side = sideOf(route);
  const desktop = isDesktop();
  return (
    <header className={`topbar${side === "jobs" ? " jobs-bar wide" : side === "calendar" ? " calendar-bar wide" : ""}`}>
      {side === "jobs"
        ? <Link to={{ view: "jobs" }} className="brand" current={true}>Job search</Link>
        : side === "calendar"
          ? <Link to={{ view: "calendar" }} className="brand" current={true}>Calendar</Link>
          : <Link to={{ view: "home" }} className="brand" current={route.view === "home"}>Study Library</Link>}
      {side === "study" && (
        <div className="navs">
          <ModuleLinks route={route} />
        </div>
      )}
      {/* A direct child of the bar rather than one of the tools, so it stays
          in view on a phone, where the tab bar takes over the tools. On a wider
          screen TabBar.css orders the switch, the sync indicator and the tools
          into one group on the right, leaving the phone's own order alone. */}
      <SyncStatus />
      <SideSwitch side={side} />
      <nav className="topbar-tools" aria-label="Tools">
        {!desktop && <OpenOnDesktop route={route} />}
        <Link to={{ view: "search" }} className="topbar-btn" current={route.view === "search"} title="Search (/)">
          <span className="sr-only">Search</span>
          <Icon name="search" size={18} />
        </Link>
        <Link to={{ view: "settings" }} className="topbar-btn" current={route.view === "settings"} title="Settings">
          <span className="sr-only">Settings</span>
          <Icon name="settings" size={18} />
          {desktop && <ConnectionDot />}
        </Link>
      </nav>
    </header>
  );
}

// Remounting clears a page's state and error, so only a change of page does
// it: the reading keeps its place when its page or search changes, and This
// week, the calendar and the job search keep theirs across their own query values.
function pageKey(route: Route): string {
  switch (route.view) {
    case "across":
    case "calendar":
    case "jobs":
      return route.view;
    case "reader":
      return `reader:${route.id}`;
    case "essay":
      return `essay:${route.id}:${route.essay ?? "default"}`;
    // shortcut: session, assessment and search still remount on any query change, narrow their keys once each is checked for props read only on mount.
    default:
      return href(route);
  }
}

const failureLabels: Partial<Record<Route["view"], string>> = { reader: "reading", essay: "word processor", jobs: "job search", calendar: "calendar" };

function Page({ route }: { route: Route }) {
  switch (route.view) {
    case "home": return <Home />;
    case "module": return <ModulePage id={route.id} />;
    case "week": return <WeekPage key={`${route.id}:${route.folder ?? ""}`} id={route.id} folder={route.folder} />;
    case "assessment": return <AssessmentPage id={route.id} essayId={route.essay} />;
    case "across": return <AcrossPage term={route.term} number={route.number} />;
    case "settings": return <Settings />;
    case "session": return <SessionPage id={route.id} rec={route.rec} t={route.t} turn={route.turn} />;
    case "search": return <SearchPage q={route.q} />;
    // The lazy parts keep their own boundary, so a first visit shows their
    // skeleton rather than holding the old page while the code downloads.
    case "reader": return <Suspense fallback={opening}><Reader id={route.id} page={route.page} q={route.q} /></Suspense>;
    case "essay": return <Suspense fallback={openingEssay}><WordProcessor id={route.id} essayId={route.essay} q={route.q} /></Suspense>;
    case "jobs": return <Suspense fallback={<PageLoading label="Opening the job search" wide />}><JobsPage /></Suspense>;
    case "calendar": return <Suspense fallback={<PageLoading label="Opening the calendar" wide />}><CalendarPage route={route} /></Suspense>;
  }
}

// One page with its loading and error boundaries. The Suspense boundary stays
// mounted, so a page change waits on the old page rather than a blank one.
function PageSlot({ route }: { route: Route }) {
  return (
    <Suspense fallback={<PageLoading label="Opening the page" wide />}>
      <ErrorBoundary key={pageKey(route)} label={failureLabels[route.view]}>
        <Page route={route} />
      </ErrorBoundary>
    </Suspense>
  );
}

export function App() {
  const current = useRoute();
  const desktop = isDesktop();
  const tabs = useDesktopTabs(current, desktop);
  // The page in front: the active tab's in the desktop window, and otherwise the router's own.
  const route = desktop ? tabs.activeRoute : current;
  const bare = route.view === "reader" || route.view === "essay";
  useTypingClass();
  useAppearanceSync();
  useAccentSync();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("connect") === "processor") {
      // The launcher adds this for as long as this computer lacks its
      // processor credentials, so Settings and the top bar can say so.
      setNeedsConnecting(true);
      params.delete("connect");
      const qs = params.toString();
      const targetHash = window.location.hash || "#section-processor";
      const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ""}${targetHash}`;
      window.history.replaceState(window.history.state, "", newUrl);
      navigate({ view: "settings" });
    }
  }, []);

  // The desktop window paints its title bar and tabs in the page's own
  // background, moves the tabs into the title bar while an installed window's
  // controls overlay is in force, and lets a reading or an essay fill the
  // space beneath the tabs.
  useEffect(() => {
    if (!desktop) return;
    const root = document.documentElement;
    root.classList.add("sl-desktop");
    const stopColour = followShellColour();
    const stopControls = followWindowControls();
    return () => {
      stopColour();
      stopControls();
      root.classList.remove("sl-desktop", "sl-bare");
    };
  }, [desktop]);
  useEffect(() => {
    if (desktop) document.documentElement.classList.toggle("sl-bare", bare);
  }, [desktop, bare]);

  useEffect(() => {
    // "/" goes to search from anywhere outside a text field.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "?" && !typing(e)) { e.preventDefault(); openShortcuts(); return; }
      // The reader uses "/" to find within the reading, and the job search to
      // find an application.
      const view = new URLSearchParams(location.search).get("v");
      if (view === "reader" || view === "jobs") return;
      if (e.key === "/" && !typing(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        navigate({ view: "search" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    startSync();
    void resumeUploads();
    void recoverRecordings();
    const online = () => {
      void resumeUploads();
      void pumpChunks();
    };
    window.addEventListener("online", online);
    return () => {
      stopSync();
      window.removeEventListener("online", online);
    };
  }, []);

  // Keep --topbar-h in sync with the top bar's actual height (including when
  // wrapped), counting the desktop tabs as well, since both stay in view
  // whether the tabs sit beneath the bar or up in the title bar.
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>(".topbar");
    if (!bar) return;
    const strip = document.querySelector<HTMLElement>(".sl-tabs");
    const update = () => {
      document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight + (strip?.offsetHeight ?? 0)}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    if (strip) ro.observe(strip);
    return () => ro.disconnect();
  }, [route.view]);

  // Every child keeps its place whatever the view, so a change of page never
  // remounts the top bar, the overlays or the recorder. In the desktop window
  // the tabs are the window's top row, above the top bar in one sticky block,
  // so that they read as a single header on one surface, and in the frameless
  // window that row also carries the window controls. Each tab keeps its own
  // page, hidden rather than unmounted while another is in front, so that it
  // comes back exactly as it was left.
  return (
    <>
      {!bare && <a className="skip" href="#main">Skip to content</a>}
      <div className={desktop ? "sl-chrome" : undefined}>
        {desktop && <DesktopTabBar tabs={tabs.tabs} commands={tabs.commands} />}
        {!bare && <TopBar route={route} />}
      </div>
      {!bare && <UpdateBanner />}
      {!bare && <ExpiredBanner />}
      <main id="main" tabIndex={bare ? undefined : -1}>
        {desktop
          ? tabs.panes.map((pane) => (
              <div key={pane.id} ref={tabs.paneRef(pane.id)} className="sl-pane" style={pane.active ? undefined : { display: "none" }}>
                <PageSlot route={pane.route} />
              </div>
            ))
          : <PageSlot route={route} />}
      </main>
      {!bare && route.view !== "jobs" && <TabBar route={route} />}
      <Overlays />
      {/* Go to, opened anywhere with Ctrl K as the shortcuts list says. */}
      <Palette />
      {route.view !== "essay" && route.view !== "jobs" && route.view !== "calendar" && <DropAnywhere route={route} />}
      <RecorderPill route={route} />
    </>
  );
}
