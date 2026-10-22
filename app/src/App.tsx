import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AcrossPage } from "./components/AcrossPage";
import { Home } from "./components/Home";
import { ImportPage } from "./components/ImportPage";
import { ModulePage } from "./components/ModulePage";
import { SearchPage } from "./components/SearchPage";
import { SessionPage } from "./components/SessionPage";
import { Settings } from "./components/Settings";
import { WeekPage } from "./components/WeekPage";
import { href, navigate, useRoute, type Route } from "./lib/router";
import { startSync, stopSync, subscribeSync, type SyncState } from "./lib/sync";
import { resumeUploads } from "./lib/uploads";
import { pumpChunks, recoverRecordings } from "./lib/recorder";
import { db } from "./lib/db";
import { byPosition } from "./lib/keys";
import { openShortcuts, typing, useCloseOnBack } from "./lib/ui";
import { Overlays } from "./components/Overlays";
import { DropAnywhere } from "./components/DropAnywhere";
import { Palette } from "./components/Palette";
import { RecorderPill } from "./components/RecorderPill";
import { PageLoading } from "./components/ErrorBoundary";
import { Icon, type IconName } from "./components/icons";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { retryUpload, onUploadProgress, uploadProgress } from "./lib/uploads";
import { useAppearanceSync } from "./lib/appearance";
import { useLiveQuery } from "dexie-react-hooks";

// The reader carries pdf.js, the largest part of the app, so it loads when a
// reading is first opened rather than with the home page.
const Reader = lazy(() => import("./components/Reader").then((m) => ({ default: m.Reader })));
const opening = <PageLoading label="Opening the reading" />;
// The job search is its own part of the app, loaded when first opened.
const JobsPage = lazy(() => import("./components/JobsPage").then((m) => ({ default: m.JobsPage })));

export function Link({ to, children, className, current, title, label }: {
  to: Route; children: React.ReactNode; className?: string; current?: boolean; title?: string; label?: string;
}) {
  return (
    <a
      className={className}
      title={title}
      aria-label={label}
      aria-current={current ? "page" : undefined}
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

// Takes no space when idle, while staying a live region so changes are announced.
// While files upload, it opens a list of them with their progress.
function SyncStatus() {
  const [state, setState] = useState<SyncState | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const [, tick] = useState(0);
  const pending = useLiveQuery(() => db.outbox.count(), [], 0);
  const uploads = useLiveQuery(() => db.uploads.toArray(), [], []);
  useCloseOnBack(open, () => setOpen(false));
  useEffect(() => subscribeSync(setState), []);
  useEffect(() => onUploadProgress(() => tick((n) => n + 1)), []);
  useEffect(() => { if (!uploads.length) setOpen(false); }, [uploads.length]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  let text = "";
  let problem: string | null = null;
  if (state && !state.online) text = uploads.length ? `Offline, ${uploads.length} to upload` : "Offline";
  else if (state?.error) { text = "Sync problem"; problem = state.error; }
  else if (uploads.length) text = `Uploading ${uploads.length}`;
  else if (pending) text = "Saving";
  if (!text && !uploads.length) {
    return <span className="sync" aria-live="polite" />;
  }
  if (!uploads.length) {
    return <span className={`sync${problem ? " problem" : ""}`} title={problem ?? undefined} aria-live="polite">{text}</span>;
  }
  return (
    <span className="sync menu" ref={ref}>
      <button className={`sync-button${uploads.some((u) => u.status === "failed") ? " problem" : ""}`} aria-expanded={open} onClick={() => setOpen(!open)}>{text}</button>
      {open && (
        <div className="menu-panel uploads-panel" role="dialog" aria-label="Uploads">
          {uploads.map((u) => {
            const p = uploadProgress(u.id);
            return (
              <div key={u.id} className="upload-row">
                <span className="name" title={u.name}>{u.name}</span>
                {u.status === "failed"
                  ? <button className="link" onClick={() => retryUpload(u.id)}>Retry</button>
                  : <span className="where">{p !== undefined ? `${Math.round(p * 100)}%` : "Waiting"}</span>}
                <span className="bar"><span style={{ width: `${Math.round((p ?? 0) * 100)}%` }} /></span>
              </div>
            );
          })}
          <p className="small muted" style={{ margin: "0.5rem 0 0" }}>Uploads carry on if you close the app, and resume when you return.</p>
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

// The modules, always one click away.
function ModuleLinks({ route }: { route: Route }) {
  const modules = useLiveQuery(async () => (await db.modules.toArray()).filter((m) => !m.deleted).sort(byPosition), [], []);
  const lookedUpModule = useLiveQuery(async () => {
    if (route.view === "week") return (await db.weeks.get(route.id))?.module_id ?? null;
    let sessionId = route.view === "session" ? route.id : null;
    if (route.view === "question") sessionId = (await db.questions.get(route.id))?.session_id ?? null;
    if (sessionId) {
      const session = await db.sessions.get(sessionId);
      return session ? (await db.weeks.get(session.week_id))?.module_id ?? null : null;
    }
    return null;
  }, [route]);
  const currentModule =
    route.view === "module" || route.view === "import"
      ? route.id
      : route.view === "week" || route.view === "session" || route.view === "question"
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
  const section = route.view === "across" ? "across" : route.view === "search" ? "search" : route.view === "settings" ? "settings" : "home";
  const tabs: { key: string; to: Route; label: string; icon: IconName }[] = [
    { key: "home", to: { view: "home" }, label: "Home", icon: "home" },
    { key: "across", to: { view: "across" }, label: "This week", icon: "week" },
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
// the tab bar steps aside rather than float over it.
function useTypingClass() {
  useEffect(() => {
    const editable = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.isContentEditable || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
      return el.tagName === "INPUT" && !["checkbox", "radio", "button", "submit", "file", "range"].includes((el as HTMLInputElement).type);
    };
    const root = document.documentElement;
    const check = () => { if (!editable(document.activeElement)) root.classList.remove("typing"); };
    // A field taken off the page while it has the cursor fires no focusout,
    // so while the class is on it is checked again every half second.
    let timer: ReturnType<typeof setInterval> | undefined;
    const on = (e: FocusEvent) => {
      if (!editable(e.target)) return;
      root.classList.add("typing");
      clearInterval(timer);
      timer = setInterval(() => { check(); if (!root.classList.contains("typing")) clearInterval(timer); }, 500);
    };
    const off = () => setTimeout(check, 50);
    document.addEventListener("focusin", on);
    document.addEventListener("focusout", off);
    return () => { clearInterval(timer); document.removeEventListener("focusin", on); document.removeEventListener("focusout", off); };
  }, []);
}

// Questions no longer have pages of their own: a question and its answer
// live on its session's page. A link saved before goes there instead.
function QuestionRedirect({ id }: { id: string }) {
  useEffect(() => {
    void db.questions.get(id).then((q) => navigate(q && !q.deleted ? { view: "session", id: q.session_id } : { view: "home" }, true));
  }, [id]);
  return null;
}

export function App() {
  const route = useRoute();
  useTypingClass();
  useAppearanceSync();

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

  // Keep --topbar-h in sync with the top bar's actual height (including when wrapped).
  useLayoutEffect(() => {
    const bar = document.querySelector<HTMLElement>(".topbar");
    if (!bar) return;
    const update = () => {
      document.documentElement.style.setProperty("--topbar-h", `${bar.offsetHeight}px`);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [route.view]);

  if (route.view === "reader") {
    return <><main id="main"><ErrorBoundary key={route.id} label="reading"><Suspense fallback={opening}><Reader key={route.id} id={route.id} page={route.page} q={route.q} /></Suspense></ErrorBoundary></main><Overlays /><Palette /><DropAnywhere route={route} /><RecorderPill route={route} /></>;
  }

  if (route.view === "jobs") {
    return (
      <>
        <a className="skip" href="#main">Skip to content</a>
        <header className="topbar jobs-bar wide">
          <Link to={{ view: "jobs" }} className="brand" current={true}>Job search</Link>
          <SyncStatus />
          <nav className="topbar-nav" aria-label="Leave the job search">
            <Link to={{ view: "home" }} title="Back to your modules, readings and notes">
              <span className="wide-only">Back to Study Library</span><span className="narrow-only">Study Library</span>
            </Link>
          </nav>
        </header>
        <ExpiredBanner />
        <main id="main" tabIndex={-1}>
          <ErrorBoundary key="jobs" label="job search">
            <Suspense fallback={<PageLoading label="Opening the job search" wide />}>
              <JobsPage />
            </Suspense>
          </ErrorBoundary>
        </main>
        <Overlays />
        <RecorderPill route={route} />
      </>
    );
  }

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <Link to={{ view: "home" }} className="brand" current={route.view === "home"}>Study Library</Link>
        <SyncStatus />
        {/* On a phone the tab bar does the navigating; Go to stays up here. */}
        <button className="icon-button narrow-only goto-button" aria-label="Go to a module, week or reading" title="Go to" onClick={() => window.dispatchEvent(new Event("open-palette"))}>
          <Icon name="goto" size={22} />
        </button>
        <div className="navs">
          <ModuleLinks route={route} />
          <Link to={{ view: "across" }} className="topbar-across" current={route.view === "across"}>This week</Link>
        </div>
        <Link to={{ view: "jobs" }} className="to-jobs">
          <span className="wide-only">Job search</span><span className="narrow-only">Jobs</span>
        </Link>
        <nav className="topbar-tools" aria-label="Tools">
          <button type="button" className="topbar-btn" title="Go to (Ctrl K)" onClick={() => window.dispatchEvent(new Event("open-palette"))}>
            <span className="sr-only">Go to</span>
            <Icon name="goto" size={18} />
          </button>
          <Link to={{ view: "search" }} className="topbar-btn" current={route.view === "search"} title="Search (/)">
            <span className="sr-only">Search</span>
            <Icon name="search" size={18} />
          </Link>
          <Link to={{ view: "settings" }} className="topbar-btn" current={route.view === "settings"} title="Settings">
            <span className="sr-only">Settings</span>
            <Icon name="settings" size={18} />
          </Link>
        </nav>
      </header>
      <ExpiredBanner />
      <main id="main" tabIndex={-1}>
      <ErrorBoundary key={href(route)}>
      {route.view === "home" && <Home />}
      {route.view === "module" && <ModulePage id={route.id} />}
      {route.view === "week" && <WeekPage id={route.id} />}
      {route.view === "import" && <ImportPage id={route.id} />}
      {route.view === "across" && <AcrossPage term={route.term} number={route.number} />}
      {route.view === "settings" && <Settings />}
      {route.view === "session" && <SessionPage id={route.id} t={route.t} turn={route.turn} />}
      {route.view === "question" && <QuestionRedirect id={route.id} />}
      {route.view === "search" && <SearchPage q={route.q} />}
      </ErrorBoundary>
      </main>
      <TabBar route={route} />
      <Overlays />
      <Palette />
      <DropAnywhere route={route} />
      <RecorderPill route={route} />
    </>
  );
}
