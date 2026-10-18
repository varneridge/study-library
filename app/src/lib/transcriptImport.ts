// Reading transcripts downloaded from Moodle into speaker turns.
//
// Moodle's text download gives a "SPEAKER 0" line, then what they said, then
// a blank line, over and over. Consecutive blocks from one speaker are
// joined, so a turn only ends when someone else starts talking. Caption files
// (.vtt and .srt) are read too: their times are kept, and a voice tag such
// as <v Lucinda Platt> names the speaker.

import { insert, newId } from "./sync";
import type { Turn } from "./types";

// A line naming who speaks next: "SPEAKER 0", or a short name ending in a colon.
const SPEAKER = /^(?:speaker\s+\d+|[A-Z][\w.' -]{0,40}:)$/i;
const TIME = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;

function seconds(stamp: string): number {
  const parts = stamp.replace(",", ".").split(":").map(Number);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

// Joins blocks from the same speaker into one turn.
function merge(blocks: Turn[]): Turn[] {
  const out: Turn[] = [];
  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.speaker === block.speaker) last.text = `${last.text} ${text}`;
    else out.push({ speaker: block.speaker, text, ...(block.start != null ? { start: block.start } : {}) });
  }
  return out;
}

function readCaptions(source: string): Turn[] {
  const blocks: Turn[] = [];
  for (const cue of source.replace(/\r/g, "").split(/\n\s*\n/)) {
    const lines = cue.split("\n").filter((l) => l.trim() && !/^WEBVTT|^NOTE\b|^\d+$/.test(l.trim()));
    const timing = lines.findIndex((l) => l.includes("-->"));
    if (timing < 0) continue;
    const start = TIME.exec(lines[timing])?.[0];
    let text = lines.slice(timing + 1).join(" ");
    let speaker = "Speaker";
    const voice = /<v(?:\.[^ >]*)?\s+([^>]+)>/.exec(text);
    if (voice) speaker = voice[1].trim();
    else {
      const named = /^([A-Z][\w.' -]{0,40}):\s+/.exec(text);
      if (named) { speaker = named[1]; text = text.slice(named[0].length); }
    }
    text = text.replace(/<[^>]+>/g, "");
    blocks.push({ speaker, text, start: start ? seconds(start) : null });
  }
  return merge(blocks);
}

function readText(source: string): Turn[] {
  const blocks: Turn[] = [];
  let speaker: string | null = null;
  let lines: string[] = [];
  const close = () => {
    if (speaker && lines.length) blocks.push({ speaker, text: lines.join(" ") });
    lines = [];
  };
  for (const raw of source.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    // A speaker line stands alone, short, after a blank line or at the start.
    if (line && lines.length === 0 && SPEAKER.test(line) && line.split(" ").length <= 5) {
      close();
      speaker = line.replace(/:$/, "").trim();
      continue;
    }
    if (!line) { close(); continue; }
    if (!speaker) speaker = "Speaker";
    lines.push(line);
  }
  close();
  return merge(blocks);
}

export function readTranscript(name: string, source: string): Turn[] {
  if (/\.(vtt|srt)$/i.test(name) || /^WEBVTT/.test(source.trim()) || /-->/.test(source.slice(0, 500))) return readCaptions(source);
  return readText(source);
}

// "SPEAKER 0" becomes "Speaker 1", which reads better and counts from one.
export function speakerLabel(speaker: string, names: Record<string, string>): string {
  if (!speaker.trim()) return "";
  const named = names[speaker]?.trim();
  if (named) return named;
  const n = /^speaker\s+(\d+)$/i.exec(speaker);
  return n ? `Speaker ${Number(n[1]) + 1}` : speaker;
}

export function isTranscriptFile(file: File): boolean {
  return /\.(txt|vtt|srt)$/i.test(file.name) || /^text\/(plain|vtt)$/.test(file.type);
}

// Adds a transcript to a session as a recording of its own, with no audio.
// The server indexes each turn for search.
export async function importTranscript(sessionId: string, file: File): Promise<number> {
  const turns = readTranscript(file.name, await file.text());
  if (!turns.length) throw new Error(`${file.name} has no transcript in it that can be read.`);
  await insert("recordings", {
    id: newId(), session_id: sessionId, source: "upload", file_id: null, duration_seconds: null,
    status: "done", turns,
  });
  return turns.length;
}

// Long turns read better broken into paragraphs, at the end of a sentence
// after roughly a hundred and twenty words. A line break in the text, which
// the transcription model sometimes gives, always starts a new paragraph.
export function paragraphs(text: string, words = 120): string[] {
  return text.split(/\n+/).flatMap((block) => sentenceGroups(block, words));
}

function sentenceGroups(text: string, words: number): string[] {
  if (!text.trim()) return [];
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  const out: string[] = [];
  let current = "";
  let count = 0;
  for (const sentence of sentences) {
    current += sentence;
    count += sentence.split(/\s+/).filter(Boolean).length;
    if (count >= words) { out.push(current.trim()); current = ""; count = 0; }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

// Ums, uhs and ers, for a cleaner read. The stored transcript keeps them.
export function tidy(text: string): string {
  return text.split("\n").map(tidyLine).join("\n");
}

function tidyLine(text: string): string {
  return text
    // Fillers first, so the repeats they hid ("the um the") join up.
    .replace(/(^|[\s,])(?:um+|uh+|er+|erm+|mhm)[,.]?(?=\s|$)/gi, "$1")
    .replace(/\s+([,.?!])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .replace(/\b(\w+)(?:,? \1\b)+/gi, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,]+/, "")
    .replace(/(^|[.?!]\s+)([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .trim();
}
