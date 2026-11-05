import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { ago, processorQuiet, useProcessorStatus } from "../lib/status";
import { shortDate } from "../lib/dates";
import { DatePicker } from "./DatePicker";
import { useFormDraft, useUnsavedChangesGuard } from "../lib/formDraft";

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
  { id: "section-processor", label: "Background processor" },
  { id: "section-device", label: "On this device" },
  { id: "section-bin", label: "Recently deleted" },
  { id: "section-danger", label: "Start again" },
];

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
    showToast(queued ? `${queued} ${queued === 1 ? "cover" : "covers"} will be cropped to their print.` : "No reading covers to crop.");
  } catch {
    showToast("Could not queue the covers. Check you are online.");
  }
}

function ProcessorState() {
  const status = useProcessorStatus();
  if (!status) return null;
  const quiet = processorQuiet(status);
  const waiting = status.queued + status.running;
  return (
    <>
      <h2>Background processor</h2>
      <p className={quiet && waiting ? "problem" : undefined}>
        {status.seenAt ? `Last asked for work ${ago(status.seenAt)}.` : "Has not asked for work yet."}
        {" "}{waiting ? `${waiting} ${waiting === 1 ? "job" : "jobs"} waiting.` : "Nothing waiting."}
      </p>
      {quiet && waiting > 0 && (
        <p className="small muted">
          Readings stay readable. New scans, slides and recordings are processed when it next runs. On the laptop, check the
          Task Scheduler task and processor.log.
        </p>
      )}
      {status.failed > 0 && <p className="small muted">{status.failed} {status.failed === 1 ? "job has" : "jobs have"} failed. Each shows Retry where it belongs.</p>}
      <p className="small muted" style={{ marginTop: "1rem" }}>
        Scans added before the processor learnt something new can be read again: French and German, pages turned upright and
        straightened, two-page spreads split. Covers made before covers were cropped to their print can be cropped too.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
        <button className="button" onClick={() => void generateThumbs()}>Generate missing thumbnails</button>
        <button className="button" onClick={() => void cropCovers()}>Crop reading covers</button>
        <button className="button quiet" onClick={() => void rescan()}>Read every scan again</button>
      </div>
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
      <div className="row" style={{ marginTop: "0.75rem", gap: "1rem", flexWrap: "wrap" }}>
        <div className="field" style={{ flex: 1, minWidth: "14rem" }}>
          <span id="label-term-at">Autumn Term week 1</span>
          <DatePicker
            value={dates.AT || null}
            label="Autumn Term week 1"
            hint="Choose the Monday of week 1. This week and the home page count from it."
            placeholder="Choose date"
            onChange={(d) => onChange("AT", d || "")}
          />
        </div>
        <div className="field" style={{ flex: 1, minWidth: "14rem" }}>
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
      <p className="small muted">Theme mode and accent palette across every screen, the reader panels and the pages themselves. Syncs across all your devices.</p>
      <div className="segmented appearance-choice" role="group" aria-label="Appearance" style={{ marginTop: "0.75rem" }}>
        {APPEARANCES.map((a) => (
          <button key={a.value} className={`tool theme-chip ${a.value}`} aria-pressed={current === a.value} onClick={() => void chooseAppearance(a.value)}>{a.label}</button>
        ))}
      </div>

      <h3 style={{ margin: "1.5rem 0 0.4rem", fontSize: "var(--fs-md)", fontWeight: 600 }}>Accent colour</h3>
      <p className="small muted">A touch of colour for active links, buttons and current selections.</p>
      <div className="accent-grid" role="group" aria-label="Accent colour" style={{ marginTop: "0.5rem" }}>
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
      <h3 style={{ margin: "0 0 0.4rem", fontSize: "var(--fs-md)", fontWeight: 600 }}>Highlight colours</h3>
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
  const entries = useLiveQuery(loadBin, []);
  const [busy, setBusy] = useState<string | null>(null);
  if (!entries) return null;
  return (
    <>
      <h2>Recently deleted</h2>
      {entries.length === 0 ? (
        <p className="small muted">Nothing deleted in the last 90 days.</p>
      ) : (
        <>
          <p className="small muted">Deleted things stay here for 90 days. Restoring brings back everything that was deleted with them.</p>
          <ul className="list bin" style={{ marginTop: "0.75rem" }}>
            {entries.map((entry) => (
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

  const scrollToSection = (id: string) => {
    isNavigatingRef.current = true;
    setActiveSection(id);
    const el = document.getElementById(id);
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
          <section id="section-appearance" className="settings-section">
            <AppearanceChoice />
            <ColourNames
              values={colourNamesDraft.draft}
              onChange={(col, name) => colourNamesDraft.setField(col, name)}
            />
          </section>

          <section id="section-term-dates" className="settings-section">
            <TermDatesSetting
              dates={termDatesDraft.draft}
              onChange={(term, val) => termDatesDraft.setField(term, val)}
            />
          </section>

          <section id="section-shortcuts" className="settings-section keyboard-only">
            <h2>Keyboard shortcuts</h2>
            <p className="small muted" style={{ margin: "0.2rem 0 0.6rem" }}>
              / opens search. On a week, [ and ] navigate between weeks. Press ? anywhere for the full list.
            </p>
            <div>
              <button type="button" className="button" onClick={openShortcuts}>Show keyboard shortcuts</button>
            </div>
          </section>

          <section id="section-processor" className="settings-section">
            <ProcessorState />
          </section>

          <section id="section-device" className="settings-section">
            <h2>On this device</h2>
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
                <h3 style={{ margin: "0 0 0.4rem", fontSize: "var(--fs-md)", fontWeight: 600 }}>Rejected changes</h3>
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

          <section id="section-bin" className="settings-section">
            <Bin />
          </section>

          <section id="section-danger" className="settings-section danger-section">
            <h2 style={{ color: "var(--danger)" }}>Start again on this device</h2>
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
