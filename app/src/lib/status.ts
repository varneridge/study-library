// Whether the processor is running. It lives on a laptop or a server, not
// in the app, so the app asks the Worker when it last asked for work. One
// shared poll serves every part of the screen that wants to know.

import { useEffect, useState } from "react";
import { api } from "./sync";

// One job the processor has waiting, running or failed, as Settings lists it.
export interface StatusJob {
  id: number;
  kind: string;
  status: "queued" | "running" | "failed";
  targetId: string | null;
  // What the job is for, from its payload: file, recording or item.
  targetKind: string | null;
  label: string | null;
  // The reading or recording the job is for, as the Worker found it.
  title: string | null;
  attempts: number;
  error: string | null;
  // When a job that failed and is waiting to try again may next be taken.
  runAfter: Date | null;
}

// One reading's Listen audio in one voice that a speech computer has in hand.
export interface ListenWork {
  itemId: string | null;
  voice: string;
  title: string | null;
  state: "running" | "upgrading" | "queued" | "failed";
  // Paragraphs that already play, which includes those being remade.
  ready: number;
  total: number;
  failed: number;
  requestedAt: Date | null;
}

export interface ProcessorStatus {
  seenAt: Date | null;
  // When a speech computer with a graphics card last asked for Listen audio.
  gpuSeenAt: Date | null;
  queued: number;
  running: number;
  failed: number;
  jobs: StatusJob[];
  listen: ListenWork[];
}

export interface StatusBody {
  processor_seen: number | null;
  // Absent from a Worker deployed before Listen audio was listed.
  listen_gpu_seen?: number | null;
  queued: number;
  running: number;
  failed: number;
  // Absent from a Worker deployed before the list, which then reads as empty.
  jobs?: {
    id: number;
    kind: string;
    status: StatusJob["status"];
    target_id: string | null;
    // These three are absent from a Worker deployed before titles and retries were listed.
    target_kind?: string | null;
    title?: string | null;
    run_after?: string | null;
    label: string | null;
    attempts: number;
    error: string | null;
  }[];
  listen?: {
    item_id: string | null;
    voice: string;
    title: string | null;
    state: ListenWork["state"];
    ready: number;
    total: number;
    failed: number;
    requested_at: string | null;
  }[];
}

// The processor asks every ten seconds when idle, and reports in every five
// minutes during a long job. Fifteen minutes of silence means it is off.
const QUIET_MS = 15 * 60 * 1000;
const POLL_MS = 60 * 1000;
// A speech computer with a graphics card counts as on for five minutes after
// it last asked for Listen audio, as the Worker counts it (worker/listen.ts).
const GPU_PRESENT_MS = 5 * 60 * 1000;

function dateOf(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function secondsOf(value: number | null | undefined): Date | null {
  return typeof value === "number" && value > 0 ? new Date(value * 1000) : null;
}

// The Worker's answer as the app uses it. Fields a Worker from before them
// leaves out read as empty, so an older Worker still shows its counts.
export function parseStatus(body: StatusBody): ProcessorStatus {
  return {
    seenAt: secondsOf(body.processor_seen),
    gpuSeenAt: secondsOf(body.listen_gpu_seen),
    queued: Number(body.queued) || 0,
    running: Number(body.running) || 0,
    failed: Number(body.failed) || 0,
    jobs: (body.jobs ?? []).map((job) => ({
      id: job.id, kind: job.kind, status: job.status, targetId: job.target_id,
      targetKind: job.target_kind ?? null, label: job.label, title: job.title ?? null,
      attempts: job.attempts, error: job.error, runAfter: dateOf(job.run_after),
    })),
    listen: (body.listen ?? []).map((group) => ({
      itemId: group.item_id, voice: group.voice, title: group.title, state: group.state,
      ready: Number(group.ready) || 0, total: Number(group.total) || 0, failed: Number(group.failed) || 0,
      requestedAt: dateOf(group.requested_at),
    })),
  };
}

let latest: ProcessorStatus | null = null;
const listeners = new Set<(s: ProcessorStatus | null) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

async function check(): Promise<void> {
  if (!navigator.onLine || document.visibilityState !== "visible") return;
  try {
    latest = parseStatus((await (await api("/api/status")).json()) as StatusBody);
    listeners.forEach((listener) => listener(latest));
  } catch {
    // Offline or signed out. The last answer stands.
  }
}

export function useProcessorStatus(): ProcessorStatus | null {
  const [status, setStatus] = useState(latest);
  useEffect(() => {
    listeners.add(setStatus);
    if (listeners.size === 1) {
      void check();
      timer = setInterval(() => void check(), POLL_MS);
    }
    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  return status;
}

// True when work is waiting and the processor has gone quiet.
export function processorQuiet(status: ProcessorStatus | null, now = Date.now()): boolean {
  if (!status) return false;
  return !status.seenAt || now - status.seenAt.getTime() > QUIET_MS;
}

// True while a speech computer with a graphics card is on, so it prepares Listen audio first.
export function gpuPresent(status: ProcessorStatus | null, now = Date.now()): boolean {
  return Boolean(status?.gpuSeenAt && now - status.gpuSeenAt.getTime() < GPU_PRESENT_MS);
}

export function ago(date: Date, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

// What to say when something is waiting on a processor that has gone quiet.
export function waitingText(status: ProcessorStatus | null): string | null {
  if (!processorQuiet(status)) return null;
  return status?.seenAt ? `Waiting for the processor, last seen ${ago(status.seenAt)}` : "Waiting for the processor";
}

// What each kind of job does, in words. Kinds come from the Worker's queue:
// files.ts and the files trigger (extract_text, convert, thumb, identify),
// processor.ts (ocr) and recordings.ts (prepare_audio, transcribe).
export const JOB_KIND_LABEL: Record<string, string> = {
  extract_text: "Reading the text",
  convert: "Converting to PDF",
  ocr: "Recognising the text of a scan",
  thumb: "Drawing the cover",
  identify: "Finding the citation",
  prepare_audio: "Preparing the recording",
  transcribe: "Transcribing the recording",
};

// A kind the app does not know yet, such as one a newer processor adds, is
// shown with spaces for its underscores and a capital to start.
export function jobKindLabel(kind: string): string {
  if (Object.prototype.hasOwnProperty.call(JOB_KIND_LABEL, kind)) return JOB_KIND_LABEL[kind];
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Job";
}

// How many rows of work Settings shows before See more.
export const VISIBLE_WORK = 5;

// Work that failed is not in hand, so it has no state here: each failed job
// offers Retry where it belongs, and Settings counts failed Listen audio in a note.
export type WorkState = "now" | "next" | "later";

// The work Send to top moves: one job, or one reading's Listen audio in one voice.
export type WorkTarget = { source: "job"; id: number } | { source: "listen"; itemId: string | null; voice: string };

// One row of work in hand, as Settings lists it, for a job or a reading's Listen audio.
export interface WorkRow {
  key: string;
  source: "job" | "listen";
  state: WorkState;
  // The state in words: Now, Next or Later.
  when: string;
  task: string;
  title: string | null;
  progress: string | null;
  // What Send to top moves, which Settings offers on rows that are later.
  target: WorkTarget;
}

const WHEN: Record<WorkState, string> = { now: "Now", next: "Next", later: "Later" };
const STATE_RANK: Record<WorkState, number> = { now: 0, next: 1, later: 2 };
const SOURCE_RANK: Record<WorkRow["source"], number> = { job: 0, listen: 1 };

const quoted = (title: string) => `\u201c${title}\u201d`;

function clock(date: Date): string {
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// A Kokoro voice such as bf_emma is named for its speaker and accent: a is
// American English and b British English.
export function voiceLabel(voice: string): string {
  const match = /^([ab])[fm]_([a-z]+)$/.exec(voice);
  if (!match) return `the ${voice} voice`;
  const name = match[2][0].toUpperCase() + match[2].slice(1);
  return `${name}\u2019s ${match[1] === "b" ? "British" : "American"} voice`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function jobRow(job: StatusJob, state: WorkState): WorkRow {
  const title = job.title
    ? job.targetKind === "recording" ? job.title : quoted(job.title)
    : job.label;
  const notes: string[] = [];
  if (job.attempts > 1) notes.push(`attempt ${job.attempts}`);
  if (job.status === "queued" && state === "later" && job.runAfter) notes.push(`tries again at ${clock(job.runAfter)}`);
  const progress = notes.length ? notes.join(", ").replace(/^./, (c) => c.toUpperCase()) : null;
  return {
    key: `job-${job.id}`, source: "job", state, when: WHEN[state],
    task: jobKindLabel(job.kind), title, progress,
    target: { source: "job", id: job.id },
  };
}

function listenRow(group: ListenWork, state: WorkState): WorkRow {
  const parts = [`${group.ready} of ${plural(group.total, "paragraph", "paragraphs")} ready in ${voiceLabel(group.voice)}`];
  if (group.failed > 0) parts.push(`${plural(group.failed, "paragraph", "paragraphs")} could not be made`);
  return {
    key: `listen-${group.itemId ?? ""}-${group.voice}`, source: "listen", state, when: WHEN[state],
    task: group.state === "upgrading" ? "Remaking Listen audio on the graphics card" : "Preparing Listen audio",
    title: group.title ? quoted(group.title) : null,
    progress: parts.join(", "),
    target: { source: "listen", itemId: group.itemId, voice: group.voice },
  };
}

// Every job and reading's Listen audio in hand, as one list: what is being
// done now, what each queue takes next, then what waits behind it. Failed
// jobs, and readings whose only paragraphs left have failed, are not in hand,
// so they are left out, while a reading still being made says in its
// progress how many of its paragraphs could not be made. Jobs and Listen
// audio are taken by different machines, so each queue has its own next, and
// within a state jobs come before Listen audio, each in the order the Worker
// sent, which is the order it hands work out.
export function workRows(status: ProcessorStatus, now = Date.now()): WorkRow[] {
  const rows: WorkRow[] = [];
  let jobNext = false;
  for (const job of status.jobs) {
    if (job.status === "failed") continue;
    let state: WorkState;
    if (job.status === "running") state = "now";
    else if (job.runAfter && job.runAfter.getTime() > now) state = "later";
    else if (!jobNext) {
      state = "next";
      jobNext = true;
    } else state = "later";
    rows.push(jobRow(job, state));
  }
  let listenNext = false;
  for (const group of status.listen) {
    if (group.state === "failed") continue;
    let state: WorkState;
    if (group.state === "running" || group.state === "upgrading") state = "now";
    else if (!listenNext) {
      state = "next";
      listenNext = true;
    } else state = "later";
    rows.push(listenRow(group, state));
  }
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) =>
      STATE_RANK[a.row.state] - STATE_RANK[b.row.state] ||
      SOURCE_RANK[a.row.source] - SOURCE_RANK[b.row.source] ||
      a.index - b.index)
    .map(({ row }) => row);
}

// How much is waiting, in one sentence: jobs, then readings whose Listen audio
// is still to be made. Nothing waiting needs no sentence, so it has none.
export function waitingSummary(status: ProcessorStatus): string | null {
  const jobs = status.queued + status.running;
  const readings = status.listen.filter((group) => group.state !== "failed").length;
  const parts: string[] = [];
  if (jobs) parts.push(plural(jobs, "job", "jobs"));
  if (readings) parts.push(`Listen audio for ${plural(readings, "reading", "readings")}`);
  if (!parts.length) return null;
  return `${parts.join(" and ")} ${parts.length > 1 || jobs > 1 ? "are" : "is"} waiting.`;
}

// Sends queued work to the top of its queue, then asks for the status again,
// so every list that shows it sees it move. False when it had started by then,
// which leaves it where it was, and a failed request throws.
export async function prioritiseWork(target: WorkTarget): Promise<boolean> {
  const response = await api("/api/status/prioritise", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(target),
  });
  if (!response.ok) throw new Error(`Send to top failed with ${response.status}.`);
  const { ok } = (await response.json()) as { ok?: boolean };
  await check();
  return ok === true;
}
