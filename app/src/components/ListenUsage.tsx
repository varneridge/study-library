// "Listen audio" in Settings: how much of the free plan prepared audio uses,
// against the caps in worker/listen.ts and prepared.ts, so a limit is seen
// coming long before Cloudflare would refuse anything.

import { useEffect, useState } from "react";
import { DEVICE_CAP_BYTES, deviceAudioBytes } from "../lib/listen/prepared";

export interface ListenUsageReport {
  audioBytes: number;
  audioCap: number;
  writesToday: number;
  writeBudget: number;
  databaseBytes: number | null;
  databaseLimit: number;
  waiting: number;
}

/** A size in words: "340 MB", "1.2 GB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, "")} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Whether a use is close enough to its cap to mention: 80% or more. */
export function nearlyFull(used: number, cap: number): boolean {
  return cap > 0 && used / cap >= 0.8;
}

export function ListenUsage() {
  const [report, setReport] = useState<ListenUsageReport | null>(null);
  const [device, setDevice] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let stopped = false;
    fetch("/api/listen/usage", { credentials: "same-origin" })
      .then((r) => (r.ok ? (r.json() as Promise<ListenUsageReport>) : Promise.reject(new Error(String(r.status)))))
      .then((r) => !stopped && setReport(r))
      .catch(() => !stopped && setFailed(true));
    void deviceAudioBytes().then((b) => !stopped && setDevice(b));
    return () => {
      stopped = true;
    };
  }, []);

  const lines: Array<{ label: string; used: number; cap: number; text: string }> = [];
  if (report) {
    lines.push({ label: "Prepared audio", used: report.audioBytes, cap: report.audioCap, text: `${formatBytes(report.audioBytes)} of ${formatBytes(report.audioCap)}` });
    if (report.databaseBytes !== null) {
      lines.push({ label: "Database", used: report.databaseBytes, cap: report.databaseLimit, text: `${formatBytes(report.databaseBytes)} of ${formatBytes(report.databaseLimit)}` });
    }
    lines.push({
      label: "Listen\u2019s database writes today",
      used: report.writesToday,
      cap: report.writeBudget,
      text: `${report.writesToday.toLocaleString("en-GB")} of ${report.writeBudget.toLocaleString("en-GB")}`,
    });
  }
  if (device !== null) lines.push({ label: "Audio on this device", used: device, cap: DEVICE_CAP_BYTES, text: `${formatBytes(device)} of ${formatBytes(DEVICE_CAP_BYTES)}` });

  return (
    <>
      <h2>Listen audio</h2>
      <p className="small muted">
        Prepared audio stays within its own share of Cloudflare&rsquo;s free plan. When a share fills, the oldest audio is cleared out or new
        paragraphs wait until the next day, and reading and notes are never affected.
      </p>
      {failed && <p className="small muted">Usage could not be loaded. It needs a connection.</p>}
      <dl className="listen-usage">
        {lines.map((l) => (
          <div key={l.label} className={nearlyFull(l.used, l.cap) ? "is-near" : undefined}>
            <dt>{l.label}</dt>
            <dd>
              {l.text}
              {nearlyFull(l.used, l.cap) && ", nearly full"}
            </dd>
          </div>
        ))}
        {report && (
          <div>
            <dt>Paragraphs waiting to be prepared</dt>
            <dd>{report.waiting.toLocaleString("en-GB")}</dd>
          </div>
        )}
      </dl>
    </>
  );
}
