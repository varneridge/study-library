import { useLiveQuery, useSuspendingLiveQuery } from "dexie-react-hooks";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { db } from "../lib/db";
import { formatBytes, keepEverything, setKeepEverything } from "../lib/files";
import { cancelAllUploads } from "../lib/uploads";
import { clearLocalData, describeFailedChange, isSyncExpired, pull, flush, pauseSync, resumeSync, api } from "../lib/sync";
import { activeSession } from "../lib/recorder";
import { loadBin } from "../lib/edits";
import { openShortcuts, showToast, useTitle, confirmAction } from "../lib/ui";
import { COLOURS, setSetting, useColourNames } from "../lib/settings";
import { currentYear, defaultDates, useTermDates, type TermDates } from "../lib/term";
import { chooseAppearance, useAppearance, type Appearance, chooseAccent, useAccent, useDark, ACCENTS } from "../lib/appearance";
import { ago, gpuPresent, prioritiseWork, processorQuiet, refreshProcessorStatus, useProcessorStatus, VISIBLE_WORK, waitingSummary, workRows, type ProcessorStatus, type WorkRow } from "../lib/status";
import { shortDate } from "../lib/dates";
import { isDesktop, needsConnecting, setNeedsConnecting, subscribeNeedsConnecting } from "../lib/shell";
import { DatePicker } from "./DatePicker";
import { ListenUsage } from "./ListenUsage";
import { Pronunciations } from "./Pronunciations";
import { SpeechState } from "./SpeechState";
import { useFormDraft, useUnsavedChangesGuard } from "../lib/formDraft";
import { availableUpdate, currentVersion, installedVersion, INSTALLER_DOWNLOAD_URL, INSTALLER_FILE_NAME, updateHref, type Release } from "../lib/update";
import { SyncIcon, useSyncView } from "./icons";

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match this device" },
];

const SECTIONS = [
  { id: "section-appearance", label: "Appearance" },
  { id: "section-term-dates", label: "Term dates" },
  { id: "section-shortcuts", label: "Shortcuts" },
  { id: "section-processor", label: "Processor and speech" },
  { id: "section-updates", label: "Updates" },
  { id: "section-device", label: "On this device" },
  { id: "section-bin", label: "Recently deleted" },
  { id: "section-danger", label: "Start again" },
];

// The parts of Processor and speech that fold away until asked for.
type Panel = "pronunciations" | "listen-audio" | "maintenance" | "reconnect";

// Links from before Processor and speech name sections that now live inside
// it, so each still scrolls to the part it named, opening it if it is folded.
const SECTION_ALIASES: Record<string, { section: string; open?: Panel }> = {
  "section-pronunciations": { section: "section-processor", open: "pronunciations" },
  "section-listen-audio": { section: "section-processor", open: "listen-audio" },
  "section-speech": { section: "section-processor" },
};

// How many deleted things Recently deleted shows before See more.
const VISIBLE_BIN = 5;

// What kind of device this is, since each does different work: the desktop
// app can be the background processor and has a speech server of its own, a
// browser on a computer only syncs and plays, and a phone or tablet cannot
// connect a computer at all.
type DeviceKind = "desktop-app" | "browser" | "phone";

function deviceKind(): DeviceKind {
  if (isDesktop()) return "desktop-app";
  if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) return "phone";
  return "browser";
}

// Whether the background processor is connected. It needs connecting when the
// desktop launcher said this computer lacks its credentials, or when no
// processor has asked for work recently, and is still being checked until the
// first status arrives.
export type ProcessorConnection = "checking" | "connected" | "needs";

export function connectionOf(status: ReturnType<typeof useProcessorStatus>, unpaired: boolean): ProcessorConnection {
  if (unpaired) return "needs";
  if (!status) return "checking";
  return status.seenAt && !processorQuiet(status) ? "connected" : "needs";
}

export function useNeedsConnecting(): boolean {
  return useSyncExternalStore(subscribeNeedsConnecting, needsConnecting, () => false);
}

const CONNECTION_LABEL: Record<ProcessorConnection, string> = {
  checking: "Checking",
  connected: "Connected",
  needs: "Needs connecting",
};

function ConnectionBadge({ connection }: { connection: ProcessorConnection }) {
  return (
    <p className="small connection-badge" role="status" aria-live="polite">
      <span aria-hidden="true" className={`connection-dot is-${connection}`} />
      {CONNECTION_LABEL[connection]}
    </p>
  );
}

function needsNote(unpaired: boolean, seen: boolean, device: DeviceKind): string {
  if (unpaired) return "This computer has not been connected yet, so press Connect this computer below and choose Open when Edge asks.";
  if (device === "phone") {
    return seen
      ? "No processor has asked for work recently, so check that the desktop app is running on the Windows computer that processes."
      : "No computer has been connected yet, so open Settings on the Windows computer that will do the processing and connect it there.";
  }
  if (seen) return "No processor has asked for work recently, so check that the desktop app is running on the computer that processes, or connect this one below.";
  return "No computer has been connected yet, so connect one below to process scans, slides and recordings.";
}

// What the background computer does, said for the device reading it.
const PROCESSOR_INTRO: Record<DeviceKind, string> = {
  "desktop-app":
    "Scans, slides, recordings and Listen audio are processed by whichever connected Windows computer is on, which can be this one. Speech on this computer says what this desktop app's own voice can do.",
  browser:
    "Scans, slides, recordings and Listen audio are processed on a background Windows computer running the desktop app, not in this browser, which only shows how that work is going.",
  phone:
    "Scans, slides, recordings and Listen audio are processed on a background Windows computer, not on this phone or tablet, which only shows how that work is going.",
};

// What this device does for itself, as against the background computer's work.
const DEVICE_INTRO: Record<DeviceKind, string> = {
  "desktop-app":
    "The desktop app keeps this computer's copy of your library in sync, saves readings to read offline, plays Listen audio and checks GitHub for updates. Processing is described under Processor and speech.",
  browser:
    "This browser keeps its own copy of your library in sync, saves readings to read offline and plays Listen audio. It processes nothing itself, so closing it never stops the background computer's work.",
  phone:
    "This phone or tablet keeps its own copy of your library in sync, saves readings to read offline and plays Listen audio. It processes nothing itself, so it only needs to be online to send and receive changes.",
};

function normalizeColours(obj: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const k of Object.keys(obj).sort()) {
    const val = obj[k]?.trim();
    if (val) clean[k] = val;
  }
  return clean;
}

// Whether the processor that adds text, converts slides and transcribes is
// running, and how much is waiting for it.
async function rescan() {
  const ok = await confirmAction({
    title: "Read every scan again?",
    body: "Each reading is checked on the processor. Scans are rebuilt from their pages with its current OCR: French and German, pages turned upright and straightened, spreads split. A highlight on a rebuilt page may sit a little out of place afterwards. Readings with good text are left alone. New work always goes first. A term's readings can take the processor a few hours, and every reading stays open to read meanwhile.",
    confirm: "Read every scan again",
  });
  if (!ok) return;
  try {
    const { queued } = (await (await api("/api/rescan", { method: "POST" })).json()) as { queued: number };
    showToast(queued ? `${queued} ${queued === 1 ? "reading" : "readings"} will be checked and read again where it helps.` : "Every reading is already waiting to be processed.");
  } catch {
    showToast("The rescan could not be started. Check you are online.");
  }
}

async function generateThumbs() {
  try {
    const { queued } = (await (await api("/api/thumbs", { method: "POST" })).json()) as { queued: number };
    showToast(queued ? `${queued} ${queued === 1 ? "slide thumbnail job" : "slide thumbnail jobs"} queued.` : "All slide decks already have thumbnails.");
  } catch {
    showToast("Could not queue thumbnail generation. Check you are online.");
  }
}

async function cropCovers() {
  try {
    const { queued } = (await (await api("/api/thumbs?covers=1", { method: "POST" })).json()) as { queued: number };
    showToast(queued ? `${queued} ${queued === 1 ? "cover" : "covers"} will be redrawn.` : "No reading covers to redraw.");
  } catch {
    showToast("Could not queue the covers. Check you are online.");
  }
}

function ConnectComputer({ heading = true }: { heading?: boolean }) {
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchLink = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/connect", { method: "POST", redirect: "manual", credentials: "same-origin" });
      if (res.status === 200) {
        const data = (await res.json()) as { link: string };
        setLink(data.link);
      } else if (res.type === "opaqueredirect" || res.status === 401) {
        setError("Your session has expired. Refresh the page to sign in again.");
      } else if (res.status === 503) {
        setError(
          "The Worker has no processor settings yet, so run wrangler secret put PROCESSOR_KEY, PROCESSOR_ACCESS_CLIENT_ID and PROCESSOR_ACCESS_CLIENT_SECRET."
        );
      } else if (res.status === 403) {
        setError("Connecting a computer needs your own sign-in rather than a service token.");
      } else {
        setError(`Could not generate a connection link (HTTP ${res.status}).`);
      }
    } catch {
      setError("Could not generate a connection link. Check you are online.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchLink();
  }, []);

  return (
    <div className={heading ? "settings-subgroup" : undefined}>
      {heading && <h3 className="settings-subhead">This computer</h3>}
      {loading && <p className="small muted">Preparing connection link…</p>}
      {error && (
        <div>
          <p className="small problem">{error}</p>
          <button type="button" className="button" style={{ marginTop: "0.4rem" }} onClick={() => void fetchLink()}>
            Retry
          </button>
        </div>
      )}
      {link && !error && (
        <div>
          {/* Pressing it hands the credentials to the launcher, so the status
              from then on follows whether the processor asks for work. */}
          <a href={link} className="button primary" onClick={() => setNeedsConnecting(false)}>
            Connect this computer
          </a>
          <p className="small muted" style={{ marginTop: "0.5rem" }}>
            Open Study Library once on this computer first. When Edge asks, choose Open, and tick Always allow to skip the question next time.
          </p>
        </div>
      )}
    </div>
  );
}

// A part of a section that folds away. Its contents are drawn the first time
// it opens and kept while it is folded, so nothing typed in it is lost and a
// part that fetches something, such as a connection link, waits until asked.
function Disclosure({
  id,
  title,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary?: string;
  open: boolean;
  onToggle: (open: boolean) => void;
  children: ReactNode;
}) {
  const [drawn, setDrawn] = useState(open);
  useEffect(() => {
    if (open) setDrawn(true);
  }, [open]);
  return (
    <div id={id} className={`settings-disclosure${open ? " is-open" : ""}`}>
      <h3 className="settings-disclosure-head">
        <button
          type="button"
          className="settings-disclosure-toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => onToggle(!open)}
        >
          <span className="settings-disclosure-title">{title}</span>
          {summary && <span className="settings-disclosure-summary">{summary}</span>}
        </button>
      </h3>
      <div id={`${id}-body`} className="settings-disclosure-body" hidden={!open}>
        {(open || drawn) && children}
      </div>
    </div>
  );
}

// See more and Show fewer for a list that starts short.
function MoreToggle({ hidden, expanded, controls, onToggle }: { hidden: number; expanded: boolean; controls: string; onToggle: () => void }) {
  return (
    <button type="button" className="quiet more-toggle" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}>
      {expanded ? "Show fewer" : `See ${hidden} more`}
    </button>
  );
}

// Every job and reading's Listen audio the background computer has in hand,
// on a soft panel of its own: five at first, and the rest on asking, which
// scroll inside the panel so a long queue never pushes the rest of the
// section down the page. Failed work is not listed, and with nothing in hand
// the panel is left out, since an empty list says nothing worth reading. Work
// waiting behind what comes next offers Send to top, one request at a time,
// and Refresh asks for the list now rather than at the next minute's poll.
function WorkList({ status }: { status: ProcessorStatus | null }) {
  const [all, setAll] = useState(false);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      if (!(await refreshProcessorStatus())) showToast("Could not refresh the work in hand. Check you are online.");
    } finally {
      setRefreshing(false);
    }
  };
  const rows = useMemo(() => (status ? workRows(status) : []), [status]);
  const sendToTop = async (row: WorkRow) => {
    setSending(true);
    try {
      const moved = await prioritiseWork(row.target);
      showToast(moved ? "Sent to the top of the queue." : "That work has already started, so it stays where it is.");
    } catch {
      showToast("Could not send that work to the top. Check you are online.");
    } finally {
      setSending(false);
    }
  };
  const shown = all ? rows : rows.slice(0, VISIBLE_WORK);
  // The Worker lists failed jobs after the rest, so the jobs in hand it listed are those before them.
  const jobsListed = status ? status.jobs.filter((job) => job.status !== "failed").length : 0;
  const jobsTotal = status ? status.queued + status.running : 0;
  if (status && rows.length === 0) return null;
  return (
    <div className="work-panel">
      <div className="work-panel-head">
        <h3 className="settings-subhead">Work in hand</h3>
        <button
          type="button"
          className="quiet work-refresh"
          aria-label="Refresh work in hand"
          aria-busy={refreshing}
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      {!status ? (
        <p className="small muted">Checking what the background computer has in hand…</p>
      ) : (
        <>
          {/* Expanded, the list scrolls inside the panel, and can take focus so the keyboard can scroll it too. */}
          <ul id="work-list" className={`work-list${all ? " is-expanded" : ""}`} aria-label="Work in hand" tabIndex={all ? 0 : undefined}>
            {shown.map((row) => (
              <li key={row.key} className={`work-row is-${row.state}`}>
                <span className={`work-when is-${row.state}`}>{row.when}</span>
                <span className="work-body">
                  <span className="work-task">{row.task}</span>
                  {row.title && <span className="work-title">{row.title}</span>}
                  {row.progress && <span className="work-progress">{row.progress}</span>}
                </span>
                {row.state === "later" && (
                  <button
                    type="button"
                    className="quiet work-send"
                    aria-label={`Send to top: ${row.task}${row.title ? `, ${row.title}` : ""}`}
                    disabled={sending}
                    onClick={() => void sendToTop(row)}
                  >
                    Send to top
                  </button>
                )}
              </li>
            ))}
          </ul>
          {rows.length > VISIBLE_WORK && (
            <MoreToggle hidden={rows.length - VISIBLE_WORK} expanded={all} controls="work-list" onToggle={() => setAll((v) => !v)} />
          )}
          {jobsTotal > jobsListed && (
            <p className="small muted work-note">
              The first {jobsListed} of {jobsTotal} jobs are listed, since the rest follow once these are done.
            </p>
          )}
        </>
      )}
    </div>
  );
}

// Where the background computer stands, said for this device.
function ProcessorFacts({ status, connection, unpaired, device }: {
  status: ProcessorStatus;
  connection: ProcessorConnection;
  unpaired: boolean;
  device: DeviceKind;
}) {
  const quiet = processorQuiet(status);
  const waiting = status.queued + status.running;
  const summary = waitingSummary(status);
  const listening = status.listen.some((group) => group.state !== "failed");
  // Readings whose Listen audio failed outright are left out of Work in hand, so they are counted here.
  const listenFailed = status.listen.filter((group) => group.state === "failed").length;
  return (
    <>
      {connection === "needs" && <p className="small muted">{needsNote(unpaired, Boolean(status.seenAt), device)}</p>}
      <p className={quiet && waiting ? "small problem" : "small"}>
        {status.seenAt ? `It last asked for work ${ago(status.seenAt)}.` : "It has not asked for work yet."}
        {summary && ` ${summary}`}
      </p>
      {quiet && waiting > 0 && (
        <p className="small muted">
          Readings stay readable. New scans, slides and recordings are processed when it next runs. On that computer, check the
          Task Scheduler task and processor.log.
        </p>
      )}
      {listenFailed > 0 && (
        <p className="small muted">
          Listen audio for {listenFailed} {listenFailed === 1 ? "reading" : "readings"} could not be made, and opening a reading in Listen
          tries its paragraphs again.
        </p>
      )}
      {listening && (
        <p className="small muted">
          {gpuPresent(status)
            ? "A computer with a graphics card is on, so it prepares Listen audio first and quickly."
            : "No computer with a graphics card is on, so a computer without one prepares Listen audio, more slowly."}
        </p>
      )}
    </>
  );
}

function ProcessorState({ device, isOpen, onPanel }: {
  device: DeviceKind;
  isOpen: (panel: Panel) => boolean;
  onPanel: (panel: Panel, open: boolean) => void;
}) {
  const status = useProcessorStatus();
  const unpaired = useNeedsConnecting();
  const connection = connectionOf(status, unpaired);
  return (
    <>
      <h2>Processor and speech</h2>
      <p className="small muted">{PROCESSOR_INTRO[device]}</p>
      {/* The work list sits beside the status on a wide screen and below it on a narrow one. */}
      <div className="processor-layout">
        <div className="processor-status">
          <h3 className="settings-subhead">The background computer</h3>
          <ConnectionBadge connection={connection} />
          {status ? (
            <ProcessorFacts status={status} connection={connection} unpaired={unpaired} device={device} />
          ) : (
            <p className="small muted">Checking the processor…</p>
          )}
          {device === "desktop-app" && (
            <div id="section-speech" className="settings-subgroup">
              <SpeechState />
            </div>
          )}
        </div>
        <WorkList status={status} />
      </div>
      {/* A connected processor needs no link, so the panel only appears once it needs connecting. */}
      {connection === "needs" && device !== "phone" && <ConnectComputer />}
      <div className="settings-disclosures">
        <Disclosure
          id="section-pronunciations"
          title="Pronunciations"
          summary="Words Listen says wrongly, and how they should sound"
          open={isOpen("pronunciations")}
          onToggle={(open) => onPanel("pronunciations", open)}
        >
          <Pronunciations />
        </Disclosure>
        {/* Usage is asked for only once the panel opens, as a folded part waits until asked. */}
        <Disclosure
          id="section-listen-audio"
          title="Listen audio"
          summary="How much of the free plan prepared audio uses"
          open={isOpen("listen-audio")}
          onToggle={(open) => onPanel("listen-audio", open)}
        >
          <ListenUsage />
        </Disclosure>
        <Disclosure
          id="processor-maintenance"
          title="Maintenance"
          summary="Read scans again, draw thumbnails and covers"
          open={isOpen("maintenance")}
          onToggle={(open) => onPanel("maintenance", open)}
        >
          <p className="small muted">
            Scans added before the processor learnt something new can be read again: French and German, pages turned upright and
            straightened, two-page spreads split. Covers can also be redrawn as full uncropped pages.
          </p>
          <div className="settings-actions">
            <button className="button" onClick={() => void generateThumbs()}>Generate missing thumbnails</button>
            <button className="button" onClick={() => void cropCovers()}>Redraw reading covers</button>
            <button className="button" onClick={() => void rescan()}>Read every scan again</button>
          </div>
        </Disclosure>
        {connection === "connected" && device !== "phone" && (
          <Disclosure
            id="processor-reconnect"
            title="Reconnect this computer"
            summary="Only needed after its credentials change"
            open={isOpen("reconnect")}
            onToggle={(open) => onPanel("reconnect", open)}
          >
            <ConnectComputer heading={false} />
          </Disclosure>
        )}
      </div>
    </>
  );
}

// Inside the desktop app this would only offer what is already installed, so
// it shows nowhere but a browser.
function DesktopDownload() {
  if (isDesktop()) return null;
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const windows = /Windows/.test(agent);
  return (
    <div className="settings-subgroup">
      <h3 className="settings-subhead">Desktop app</h3>
      <p className="small muted">
        The Windows desktop app opens Study Library in a window of its own and lets that computer act as the background processor.
      </p>
      <a href={INSTALLER_DOWNLOAD_URL} download={INSTALLER_FILE_NAME} className="button" style={{ marginTop: "0.5rem", textDecoration: "none" }}>
        Download desktop app
      </a>
      {!windows && (
        <p className="small muted" style={{ marginTop: "0.5rem" }}>
          The desktop app runs only on Windows, so the installer saved here is for copying to a Windows computer.
        </p>
      )}
    </div>
  );
}

// Where sync stands on this device, in the same symbol and words as the top bar.
function SyncLine() {
  const view = useSyncView();
  return (
    <p className={view.problem ? "small problem" : "small muted"} style={{ marginTop: "0.5rem" }}>
      <SyncIcon view={view} size={16} showLabel />
    </p>
  );
}

// Checks GitHub for a newer release of Study Library, in a section of its own.
// The desktop app compares its installed version, which trails the page's own
// until the installer runs, since the page itself always comes from the web.
function UpdateSettings({ device }: { device: DeviceKind }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [release, setRelease] = useState<Release | null>(null);
  const [installed, setInstalled] = useState(currentVersion);

  useEffect(() => {
    if (device !== "desktop-app") return;
    let live = true;
    void installedVersion(true).then((version) => {
      if (live) setInstalled(version);
    });
    return () => {
      live = false;
    };
  }, [device]);

  async function check() {
    setBusy(true);
    setStatus("Checking GitHub for a newer release…");
    try {
      // Asked again here, so that a check made before the first answer arrived never compares the page's version.
      const version = await installedVersion(device === "desktop-app");
      setInstalled(version);
      const found = await availableUpdate(fetch, version);
      setRelease(found);
      setStatus(found ? `Study Library ${found.version} is available.` : "This is the latest version of Study Library.");
    } catch {
      setStatus("GitHub could not be reached, so the check did not finish. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Updates</h2>
      <p className="small muted">
        {device === "desktop-app"
          ? `This desktop app is Study Library ${installed}. Checking compares it with the latest release on GitHub.`
          : `You are using Study Library ${installed} on this device. Checking compares it with the latest release on GitHub.`}
      </p>
      <div className="settings-actions">
        <button type="button" className="button" onClick={() => void check()} disabled={busy}>
          Check for updates
        </button>
        {release && (
          <a href={updateHref(release)} className="button primary" style={{ textDecoration: "none" }}>
            Update to {release.version}
          </a>
        )}
      </div>
      {status && <p className="small muted" role="status" style={{ marginTop: "0.5rem" }}>{status}</p>}
    </>
  );
}

// The first Monday of each term, so the home page knows which week it is.
function TermDatesSetting({
  dates,
  onChange,
}: {
  dates: TermDates;
  onChange: (term: "AT" | "WT", value: string) => void;
}) {
  const year = currentYear();
  return (
    <>
      <h2>Term dates</h2>
      <p className="small muted">The Monday of week 1 in each term, {year}/{String(year + 1).slice(2)}. The home page uses these to show this week's notes.</p>
      {/* The two dates sit side by side at their own width, so no empty field stretches between them. */}
      <div className="term-dates">
        <div className="field">
          <span id="label-term-at">Autumn Term week 1</span>
          <DatePicker
            value={dates.AT || null}
            label="Autumn Term week 1"
            hint="Choose the Monday of week 1. This week and the home page count from it."
            placeholder="Choose date"
            onChange={(d) => onChange("AT", d || "")}
          />
        </div>
        <div className="field">
          <span id="label-term-wt">Winter Term week 1</span>
          <DatePicker
            value={dates.WT || null}
            label="Winter Term week 1"
            hint="Choose the Monday of week 1. This week and the home page count from it."
            placeholder="Choose date"
            onChange={(d) => onChange("WT", d || "")}
          />
        </div>
      </div>
    </>
  );
}

function AppearanceChoice() {
  const current = useAppearance();
  const currentAccent = useAccent();
  const dark = useDark();

  return (
    <>
      <h2>Appearance</h2>
      <p className="small muted">The theme and the accent colour, which marks links, buttons and the current choice, apply to every screen, the reader panels and the pages themselves, and sync across all your devices.</p>
      {/* The theme and the accent sit side by side wherever both rows fit, and the accent drops below where they do not. */}
      <div className="appearance-layout">
        <div>
          <h3 className="settings-subhead">Theme</h3>
          {/* Each theme is a pill with a swatch of its own page colour, laid out like the accents beside it.
              The label stays on the button as its name, which the theme tests look for. */}
          <div className="theme-pills" role="group" aria-label="Appearance">
            {APPEARANCES.map((a) => (
              <button
                key={a.value}
                type="button"
                className={`theme-chip theme-pill ${a.value}`}
                aria-pressed={current === a.value}
                aria-label={a.label}
                onClick={() => void chooseAppearance(a.value)}
              >
                <span className="theme-swatch" aria-hidden="true" />
                <span className="theme-name">{a.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <h3 className="settings-subhead">Accent colour</h3>
          <div className="accent-grid" role="group" aria-label="Accent colour">
            {ACCENTS.map((acc) => {
              const hex = dark ? acc.darkHex : acc.lightHex;
              const active = currentAccent === acc.value;
              return (
                <button
                  key={acc.value}
                  type="button"
                  className={`accent-btn${active ? " is-active" : ""}`}
                  aria-pressed={active}
                  onClick={() => void chooseAccent(acc.value)}
                >
                  <span className="accent-swatch" style={{ backgroundColor: hex }} aria-hidden="true" />
                  <span className="accent-name">{acc.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

// Names for the highlight colours, shown wherever you pick or see one.
function ColourNames({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (colour: string, name: string) => void;
}) {
  return (
    <div className="settings-subgroup">
      <h3 className="settings-subhead">Highlight colours</h3>
      <p className="small muted">Give a colour a meaning, such as Argument or Evidence. Names show when you highlight and in the highlights list.</p>
      <ul className="colour-names">
        {COLOURS.map((c) => (
          <li key={c.value}>
            <span className="swatch" style={{ background: c.value }} aria-hidden="true" />
            <label className="sr-only" htmlFor={`colour-${c.value}`}>Name for {c.label.toLowerCase()}</label>
            <input
              id={`colour-${c.value}`} type="text" placeholder={c.label} value={values[c.value] ?? ""}
              onChange={(e) => onChange(c.value, e.target.value)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

const KIND_LABEL = { module: "Module", reading: "Reading", session: "Session", question: "Question", recording: "Recording" };

function Bin() {
  const entries = useSuspendingLiveQuery(loadBin, ["settings-bin"]);
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = all ? entries : entries.slice(0, VISIBLE_BIN);
  return (
    <>
      <h2>Recently deleted</h2>
      {entries.length === 0 ? (
        <p className="small muted">Nothing deleted in the last 90 days.</p>
      ) : (
        <>
          <p className="small muted">Deleted things stay here for 90 days. Restoring brings back everything that was deleted with them.</p>
          <ul id="bin-list" className="list bin" style={{ marginTop: "0.75rem" }}>
            {shown.map((entry) => (
              <li key={entry.key}>
                <span className="kind">{KIND_LABEL[entry.kind]}</span>
                <span className="label">
                  {entry.label}
                  {entry.context && <span className="muted">, {entry.context}</span>}
                </span>
                <span className="count">{shortDate(new Date(entry.deletedAt))}</span>
                <button
                  className="quiet"
                  disabled={busy === entry.key}
                  onClick={async () => {
                    setBusy(entry.key);
                    await entry.restore();
                    setBusy(null);
                    showToast(`${KIND_LABEL[entry.kind]} restored.`);
                  }}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
          {entries.length > VISIBLE_BIN && (
            <MoreToggle hidden={entries.length - VISIBLE_BIN} expanded={all} controls="bin-list" onToggle={() => setAll((v) => !v)} />
          )}
        </>
      )}
    </>
  );
}

export function Settings() {
  const [restarting, setRestarting] = useState(false);
  const [keep, setKeep] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
  const [activeSection, setActiveSection] = useState("section-appearance");
  const isNavigatingRef = useRef(false);
  const device = useMemo(deviceKind, []);
  const [openPanels, setOpenPanels] = useState<ReadonlySet<Panel>>(() => new Set());
  const isOpen = useCallback((panel: Panel) => openPanels.has(panel), [openPanels]);
  const setPanel = useCallback((panel: Panel, open: boolean) => {
    setOpenPanels((current) => {
      if (current.has(panel) === open) return current;
      const next = new Set(current);
      if (open) next.add(panel);
      else next.delete(panel);
      return next;
    });
  }, []);

  // Term dates draft state with useFormDraft
  const rawTermDates = useTermDates();
  const baseTermDates = useMemo(
    () => rawTermDates,
    [rawTermDates.AT, rawTermDates.WT]
  );
  const year = currentYear();
  const termDatesDraft = useFormDraft(baseTermDates);

  // Colour names draft state with useFormDraft and normalisation
  const rawColourNames = useColourNames();
  const baseColourNames = useMemo(
    () => normalizeColours(rawColourNames),
    [JSON.stringify(rawColourNames)]
  );
  const colourNamesDraft = useFormDraft(baseColourNames, { normalize: normalizeColours });

  const [savingSettings, setSavingSettings] = useState(false);

  const isDirty = termDatesDraft.isDirty || colourNamesDraft.isDirty;
  useUnsavedChangesGuard(isDirty, "settings");

  const handleSaveAll = async () => {
    setSavingSettings(true);
    let anyError = false;

    if (termDatesDraft.isDirty) {
      try {
        await termDatesDraft.save(async (patch) => {
          const row = await db.settings.get("term-dates");
          const latestStored = (row?.value as Partial<Record<number, TermDates>>) || {};
          const currentYearDates = latestStored[year] || {};
          const defaults = defaultDates(year);
          await setSetting("term-dates", {
            ...latestStored,
            [year]: { ...defaults, ...currentYearDates, ...patch },
          });
        });
      } catch {
        anyError = true;
        showToast("Could not save term dates. Check you are online.");
      }
    }

    if (colourNamesDraft.isDirty) {
      try {
        await colourNamesDraft.save(async (patch) => {
          const row = await db.settings.get("highlight-colours");
          const latestStored = (row?.value as Record<string, string>) || {};
          const merged = normalizeColours({ ...latestStored, ...patch });
          await setSetting("highlight-colours", merged);
        });
      } catch {
        anyError = true;
        showToast("Could not save highlight colours.");
      }
    }

    setSavingSettings(false);
    if (!anyError) {
      showToast("Settings saved.");
    }
  };

  const handleDiscardAll = () => {
    termDatesDraft.reset();
    colourNamesDraft.reset();
  };

  const cached = useLiveQuery(async () => {
    let bytes = 0;
    let count = 0;
    await db.blobs.each((b) => { bytes += b.bytes; count += 1; });
    return { bytes, count };
  }, []);
  const failed = useLiveQuery(() => db.failed.toArray(), []);
  useTitle("Settings");

  useEffect(() => {
    void keepEverything().then(setKeep);
    void navigator.storage?.estimate?.().then(setEstimate);
  }, [cached?.count]);

  // Scroll spy with IntersectionObserver
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (isNavigatingRef.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id);
            break;
          }
        }
      },
      { rootMargin: "-20% 0px -60% 0px" }
    );

    for (const section of SECTIONS) {
      const el = document.getElementById(section.id);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, []);

  // Scrolls to a section, or to a part inside it when target names one that is on the screen.
  const scrollToSection = (id: string, target = id) => {
    isNavigatingRef.current = true;
    setActiveSection(id);
    const el = document.getElementById(target) ?? document.getElementById(id);
    if (el) {
      const reduceMotion =
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    }
    const onScrollEnd = () => {
      clearTimeout(timer);
      isNavigatingRef.current = false;
      window.removeEventListener("scrollend", onScrollEnd);
    };
    const timer = setTimeout(() => {
      isNavigatingRef.current = false;
      window.removeEventListener("scrollend", onScrollEnd);
    }, 700);
    if ("onscrollend" in window) {
      window.addEventListener("scrollend", onScrollEnd, { once: true });
    }
  };

  // A link to a section scrolls to it, and an old link to a part that now
  // lives inside Processor and speech opens that part first, then scrolls to it
  // once it is drawn.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const follow = () => {
      const hash = window.location.hash.replace(/^#/, "");
      if (!hash) return;
      if (SECTIONS.some((s) => s.id === hash)) {
        scrollToSection(hash);
        return;
      }
      const alias = SECTION_ALIASES[hash];
      if (!alias) return;
      if (alias.open) setPanel(alias.open, true);
      requestAnimationFrame(() => scrollToSection(alias.section, hash));
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  const isCoarse = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const visibleSections = SECTIONS.filter((s) => !isCoarse || s.id !== "section-shortcuts");

  return (
    <div className="page wide">
      <div className="section-head" style={{ marginBottom: "1.25rem" }}>
        <div>
          <h1>Settings</h1>
          <p className="small muted" style={{ margin: "0.25rem 0 0" }}>Preferences, themes, study dates, and storage on this device.</p>
        </div>
      </div>

      <div className="settings-desk">
        <nav className="settings-sidebar" aria-label="Settings sections">
          {visibleSections.map((sec) => (
            <a
              key={sec.id}
              href={`#${sec.id}`}
              className={`settings-nav-item${activeSection === sec.id ? " is-active" : ""}`}
              aria-current={activeSection === sec.id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                scrollToSection(sec.id);
              }}
            >
              {sec.label}
            </a>
          ))}
        </nav>

        <div className="settings-content">
          <section id="section-appearance" className="settings-section settings-card">
            <AppearanceChoice />
            <ColourNames
              values={colourNamesDraft.draft}
              onChange={(col, name) => colourNamesDraft.setField(col, name)}
            />
          </section>

          <section id="section-term-dates" className="settings-section settings-card">
            <TermDatesSetting
              dates={termDatesDraft.draft}
              onChange={(term, val) => termDatesDraft.setField(term, val)}
            />
          </section>

          <section id="section-shortcuts" className="settings-section settings-card keyboard-only">
            <h2>Keyboard shortcuts</h2>
            <p className="small muted" style={{ margin: "0.2rem 0 0.6rem" }}>
              / opens search. On a week, [ and ] navigate between weeks. Press ? anywhere for the full list.
            </p>
            <div>
              <button type="button" className="button" onClick={openShortcuts}>Show keyboard shortcuts</button>
            </div>
          </section>

          <section id="section-processor" className="settings-section settings-card">
            <ProcessorState device={device} isOpen={isOpen} onPanel={setPanel} />
          </section>

          <section id="section-updates" className="settings-section settings-card">
            <UpdateSettings device={device} />
            <DesktopDownload />
          </section>

          <section id="section-device" className="settings-section settings-card">
            <h2>On this device</h2>
            <p className="small muted">{DEVICE_INTRO[device]}</p>
            <SyncLine />
            <label className="choices" style={{ marginTop: "0.75rem" }}>
              <input
                type="checkbox"
                checked={Boolean(keep)}
                onChange={(e) => { setKeep(e.target.checked); void setKeepEverything(e.target.checked); }}
              />
              Keep every reading available offline
            </label>
            <p className="small muted">
              Without this, a week's files are saved when you open it, along with the next week's.
            </p>
            {cached && cached.count > 0 && (
              <p className="small">{cached.count} files saved, using {formatBytes(cached.bytes)}.</p>
            )}
            {estimate?.quota && (
              <p className="small muted">This browser allows up to {formatBytes(estimate.quota)} for the app.</p>
            )}

            {failed && failed.length > 0 && (
              <div className="settings-subgroup">
                <h3 className="settings-subhead">Rejected changes</h3>
                <p className="small muted">The server turned these down. They are kept here so nothing disappears silently.</p>
                <ul className="list small">
                  {failed.slice(-20).map((f) => {
                    const cleanError = (f.error || "").replace(/\.+$/, "");
                    return (
                      <li key={f.id} style={{ padding: "0.4rem 0" }}>
                        <span>{describeFailedChange(f.table)}</span>
                        {cleanError && <details className="small muted"><summary>Details</summary>{cleanError}</details>}
                      </li>
                    );
                  })}
                </ul>
                <button className="quiet" onClick={() => db.failed.clear()}>Clear this list</button>
              </div>
            )}
          </section>

          <section id="section-bin" className="settings-section settings-card">
            <Bin />
          </section>

          <section id="section-danger" className="settings-section settings-card danger-section danger-card">
            <h2>Start again on this device</h2>
            <p className="small muted">
              Removes the local copy and downloads everything again from the server. Unsaved edits on this device are lost.
            </p>
            <div style={{ marginTop: "0.75rem" }}>
              <button
                className="button danger"
                disabled={restarting}
                onClick={async () => {
                  if (restarting) return;
                  if (!navigator.onLine) {
                    showToast("You are offline. Connect to the internet before restarting.");
                    return;
                  }
                  if (isSyncExpired()) {
                    showToast("Sign in again before restarting.");
                    return;
                  }
                  setRestarting(true);
                  let didPause = false;
                  try {
                    if (activeSession() !== null) {
                      showToast("A recording is active. Finish or cancel the recording first.");
                      return;
                    }
                    const chunkCount = await db.chunks.count();
                    if (chunkCount > 0) {
                      showToast("Audio is still being saved. Wait a moment and try again.");
                      return;
                    }
                    const outboxCount = await db.outbox.count();
                    const uploadsCount = await db.uploads.count();
                    if (outboxCount > 0 || uploadsCount > 0) {
                      await flush();
                    }
                    const initialPending = (await db.outbox.count()) + (await db.uploads.count());
                    if (initialPending > 0) {
                      const proceed = await confirmAction({
                        title: "Unsaved changes on this device",
                        body: initialPending === 1
                          ? "1 unsent edit or upload has not reached the server yet and will be lost forever."
                          : `${initialPending} unsent edits or uploads have not reached the server yet and will be lost forever.`,
                        confirm: "Discard and start again",
                        danger: true,
                      });
                      if (!proceed) return;
                    } else {
                      const ok = await confirmAction({
                        title: "Start again on this device?",
                        body: "Removes the local database and downloads everything fresh from the server.",
                        confirm: "Download everything again",
                        danger: true,
                      });
                      if (!ok) return;
                    }

                    await pauseSync();
                    didPause = true;

                    const postPausePending = (await db.outbox.count()) + (await db.uploads.count());
                    if (postPausePending > initialPending) {
                      const diff = postPausePending - initialPending;
                      const proceed = await confirmAction({
                        title: "New changes arrived",
                        body: diff === 1
                          ? "1 new change was queued just now. Discard and download a fresh copy anyway?"
                          : `${diff} new changes were queued just now. Discard and download a fresh copy anyway?`,
                        confirm: "Discard and start again",
                        danger: true,
                      });
                      if (!proceed) return;
                    }

                    try {
                      await api("/api/ping");
                    } catch {
                      showToast("The server cannot be reached right now, so nothing was removed.");
                      return;
                    }

                    await cancelAllUploads();
                    await clearLocalData();
                    resumeSync();
                    didPause = false;
                    const ok = await pull({ join: true });
                    if (ok) {
                      showToast("Downloaded fresh copy from the server.");
                    } else {
                      showToast("Could not download everything. Check your internet connection.");
                    }
                  } catch (err) {
                    showToast(err instanceof Error ? err.message : "Could not restart on this device.");
                  } finally {
                    if (didPause) {
                      resumeSync();
                    }
                    setRestarting(false);
                  }
                }}
              >
                {restarting ? "Downloading…" : "Download everything again"}
              </button>
            </div>
          </section>
        </div>
      </div>

      {isDirty && (
        <div className="settings-sticky-bar" role="region" aria-label="Unsaved settings changes">
          <span className="small strong">You have unsaved changes</span>
          <button
            type="button"
            className="button primary small"
            disabled={savingSettings}
            onClick={() => void handleSaveAll()}
          >
            {savingSettings ? "Saving…" : "Save changes"}
          </button>
          <button
            type="button"
            className="button small"
            disabled={savingSettings}
            onClick={handleDiscardAll}
          >
            Discard
          </button>
        </div>
      )}
    </div>
  );
}
