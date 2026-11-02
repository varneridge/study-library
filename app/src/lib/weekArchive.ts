// Client-side ZIP generation bundling all notes, transcripts, slides, and readings for a week.

import { db } from "./db";
import { fileBlob } from "./files";
import { readingFileName, safeFileName } from "./names";
import { blockText, findNote, noteBlocks } from "./notes";
import { weekCode, sessionLabel } from "./modules";
import type { Block, ModuleRow, WeekRow } from "./types";
import { createZip, type ZipEntry } from "./zip";

function blocksToMarkdown(blocks: Block[]): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const text = blockText(block).trim();
    if (!text && block.type === "paragraph") {
      lines.push("");
      continue;
    }
    if (block.type === "heading") {
      const level = Number(block.props?.level) || 1;
      lines.push(`${"#".repeat(Math.min(level + 1, 6))} ${text}\n`);
    } else if (block.type === "bulletListItem") {
      lines.push(`- ${text}`);
    } else if (block.type === "numberedListItem") {
      lines.push(`1. ${text}`);
    } else if (block.type === "checkListItem") {
      const checked = Boolean(block.props?.checked);
      lines.push(`- [${checked ? "x" : " "}] ${text}`);
    } else {
      lines.push(`${text}\n`);
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export async function downloadWeekArchive(
  module: ModuleRow,
  week: WeekRow,
  onProgress?: (status: string) => void,
): Promise<void> {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [];
  const code = weekCode(week);

  onProgress?.("Gathering week notes and materials…");

  // 1. Week or section notes
  const weekNote = await findNote({ week_id: week.id });
  if (weekNote) {
    const blocks = (await noteBlocks(weekNote.id)).map((nb) => nb.content);
    if (blocks.length > 0) {
      const md = blocksToMarkdown(blocks);
      if (md) {
        entries.push({
          name: `Notes - ${code}.md`,
          data: enc.encode(`# Notes for ${module.code} ${code}\n\n${md}\n`),
        });
      }
    }
  }

  // 2. Sessions, session notes, seminar questions, and transcripts
  const sessions = (await db.sessions.where("week_id").equals(week.id).toArray()).filter((s) => !s.deleted);

  for (const session of sessions) {
    const sName = session.title?.trim() || sessionLabel(session.kind);

    // Session notes and questions
    const sNote = await findNote({ session_id: session.id });
    const questions = (await db.questions.where("session_id").equals(session.id).toArray()).filter((q) => !q.deleted);

    let sessionContent = "";
    if (sNote) {
      const blocks = (await noteBlocks(sNote.id)).map((nb) => nb.content);
      if (blocks.length > 0) {
        const md = blocksToMarkdown(blocks);
        if (md) sessionContent += `${md}\n\n`;
      }
    }
    if (questions.length > 0) {
      sessionContent += `## Seminar questions\n\n${questions.map((q) => `- ${q.body}`).join("\n")}\n`;
    }
    if (sessionContent.trim()) {
      entries.push({
        name: `notes/${safeFileName(sName, "md")}`,
        data: enc.encode(`# ${sName}\n\n${sessionContent.trim()}\n`),
      });
    }

    // Transcripts
    const recordings = (await db.recordings.where("session_id").equals(session.id).toArray()).filter((r) => !r.deleted);
    for (const rec of recordings) {
      if (rec.turns && rec.turns.length > 0) {
        const transcriptText = rec.turns.map((t) => `${t.speaker}: ${t.text}`).join("\n\n");
        entries.push({
          name: `transcripts/${safeFileName(`${sName} - Transcript`, "txt")}`,
          data: enc.encode(transcriptText),
        });
      }
    }
  }

  // 3. Readings and slides files
  const links = (await db.week_items.where("week_id").equals(week.id).toArray()).filter((l) => !l.deleted);
  const items = (await db.items.bulkGet(links.map((l) => l.item_id))).filter((i): i is NonNullable<typeof i> => Boolean(i && !i.deleted));

  let fetchedCount = 0;
  for (const item of items) {
    if (!item.file_id) continue;
    const file = await db.files.get(item.file_id);
    if (!file || file.deleted) continue;

    fetchedCount++;
    onProgress?.(`Fetching file ${fetchedCount} of ${items.length}…`);

    try {
      const blob = await fileBlob(file);
      const buf = new Uint8Array(await blob.arrayBuffer());
      const fileName = readingFileName(item, file);
      const folder = item.kind === "slides" ? "slides" : "readings";
      entries.push({
        name: `${folder}/${fileName}`,
        data: buf,
      });
    } catch {
      // Continue with remaining files if one fails to load
    }
  }

  if (entries.length === 0) {
    throw new Error("No files or notes found for this week.");
  }

  onProgress?.("Building ZIP archive…");
  const zipBytes = createZip(entries);
  const zipBlob = new Blob([zipBytes.buffer as ArrayBuffer], { type: "application/zip" });
  const url = URL.createObjectURL(zipBlob);

  const a = document.createElement("a");
  a.href = url;
  a.download = safeFileName(`${module.code} - ${code} - All Content`, "zip");
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
