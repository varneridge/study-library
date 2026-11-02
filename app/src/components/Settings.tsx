import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { db } from "../lib/db";
import { formatBytes, keepEverything, setKeepEverything } from "../lib/files";
import { cancelAllUploads } from "../lib/uploads";
import { clearLocalData, describeFailedChange, isSyncExpired, pull, flush, pauseSync, resumeSync, api } from "../lib/sync";
import { activeSession } from "../lib/recorder";
import { loadBin } from "../lib/edits";
import { openShortcuts, showToast, useTitle, confirmAction } from "../lib/ui";
import { COLOURS, setSetting, useColourNames, useSetting } from "../lib/settings";
import { currentYear, useTermDates, type TermDates } from "../lib/term";
import { chooseAppearance, useAppearance, type Appearance, chooseAccent, useAccent, useDark, ACCENTS } from "../lib/appearance";
import { ago, processorQuiet, useProcessorStatus } from "../lib/status";
import { shortDate } from "../lib/dates";

const APPEARANCES: { value: Appearance; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Match this device" },
];

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
    showToast(queued ? `${queued} ${queued === 1 ? "thumbnail job" : "thumbnail jobs"} queued.` : "All files already have thumbnails.");
  } catch {
    showToast("Could not queue thumbnail generation. Check you are online.");
  }
}

function ProcessorState() {
  const status = useProcessorStatus();
  if (!status) return null;
  const quiet = processorQuiet(status);
  const waiting = status.queued + status.running;
  return (
    <section className="section">
      <h2>Processor</h2>
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
        straightened, two-page spreads split.
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.5rem" }}>
        <button className="button" onClick={() => void generateThumbs()}>Generate missing thumbnails</button>
        <button className="button quiet" onClick={() => void rescan()}>Read every scan again</button>
      </div>
    </section>
  );
}

// The first Monday of each term, so the home page knows which week it is.
function TermDatesSetting() {
  const dates = useTermDates();
  const year = currentYear();
  const saved = useSetting<Partial<Record<number, TermDates>>>("term-dates", {});
  const save = (term: "AT" | "WT", value: string) => {
    if (!value) return;
    void setSetting("term-dates", { ...saved, [year]: { ...dates, [term]: value } });
  };
  return (
    <section className="section">
      <h2>Term dates</h2>
      <p className="small muted">The Monday of week 1 in each term, {year}/{String(year + 1).slice(2)}. The home page uses these to show this week's notes.</p>
      <div className="row">
        <label className="field"><span>Autumn Term week 1</span><input type="date" value={dates.AT} onChange={(e) => save("AT", e.target.value)} /></label>
        <label className="field"><span>Winter Term week 1</span><input type="date" value={dates.WT} onChange={(e) => save("WT", e.target.value)} /></label>
      </div>
    </section>
  );
}

function AppearanceChoice() {
  const current = useAppearance();
  const currentAccent = useAccent();
  const dark = useDark();

  return (
    <section className="section">
      <h2>Appearance</h2>
      <p className="small muted">One theme for everything: every screen, the reader's panels and the pages themselves. It applies on every device. The reader's Aa button changes the same setting.</p>
      <div className="segmented appearance-choice" role="group" aria-label="Theme mode">
        {APPEARANCES.map((a) => (
          <button key={a.value} className={`tool theme-chip ${a.value}`} aria-pressed={current === a.value} onClick={() => void chooseAppearance(a.value)}>{a.label}</button>
        ))}
      </div>

      <h3 style={{ margin: "1.5rem 0 0.4rem", fontSize: "var(--fs-md)", fontWeight: 600 }}>Accent colour</h3>
      <p className="small muted">A touch of colour for active links, buttons and current selections.</p>
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
    </section>
  );
}

// Names for the highlight colours, shown wherever you pick or see one.
function ColourNames() {
  const names = useColourNames();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const values = draft ?? names;
  const save = (next: Record<string, string>) => {
    const clean = Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    void setSetting("highlight-colours", clean);
  };
  return (
    <section className="section">
      <h2>Highlight colours</h2>
      <p className="small muted">Give a colour a meaning, such as Argument or Evidence. Names show when you highlight and in the highlights list.</p>
      <ul className="colour-names">
        {COLOURS.map((c) => (
          <li key={c.value}>
            <span className="swatch" style={{ background: c.value }} aria-hidden="true" />
            <label className="sr-only" htmlFor={`colour-${c.value}`}>Name for {c.label.toLowerCase()}</label>
            <input
              id={`colour-${c.value}`} type="text" placeholder={c.label} value={values[c.value] ?? ""}
              onChange={(e) => setDraft({ ...values, [c.value]: e.target.value })}
              onBlur={() => { if (draft) { save(draft); setDraft(null); } }}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

const KIND_LABEL = { module: "Module", reading: "Reading", session: "Session", question: "Question", recording: "Recording" };

function Bin() {
  const entries = useLiveQuery(loadBin, []);
  const [busy, setBusy] = useState<string | null>(null);
  if (!entries) return null;
  return (
    <section className="section">
      <h2>Recently deleted</h2>
      {entries.length === 0 ? (
        <p className="small muted">Nothing deleted in the last 90 days.</p>
      ) : (
        <>
          <p className="small muted">Deleted things stay here for 90 days. Restoring brings back everything that was deleted with them.</p>
          <ul className="list bin">
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
    </section>
  );
}

export function Settings() {
  const [restarting, setRestarting] = useState(false);
  const [keep, setKeep] = useState<boolean | null>(null);
  const [estimate, setEstimate] = useState<StorageEstimate | null>(null);
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

  return (
    <div className="page">
      <h1>Settings</h1>

      <AppearanceChoice />

      <TermDatesSetting />

      <ProcessorState />

      <section className="section">
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
      </section>

      {failed && failed.length > 0 && (
        <section className="section">
          <h2>Rejected changes</h2>
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
        </section>
      )}

      <ColourNames />

      <Bin />

      <section className="section keyboard-only">
        <h2>Keyboard</h2>
        <p className="small muted" style={{ marginBottom: 0 }}>
          / opens search. On a week, [ and ] go to the previous and next week. Press ? anywhere for the full list.
        </p>
        <p><button className="button" onClick={openShortcuts}>Show keyboard shortcuts</button></p>
      </section>

      <section className="section">
        <h2>Start again on this device</h2>
        <p className="small muted">
          Removes the local copy and downloads everything again. Unsaved edits on this device are lost.
        </p>
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
      </section>
    </div>
  );
}
