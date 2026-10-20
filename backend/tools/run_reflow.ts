// Runs app/src/lib/reflow.ts over every cached PDF in backend/audit/pdfs/
// and writes the reflowed blocks and lines to backend/audit/reflow/<sha256>.json.
//
// Run from app/:
//   npx tsx ../backend/tools/run_reflow.ts

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "../../app/node_modules/pdfjs-dist/legacy/build/pdf.mjs";
import { reflow, type Block } from "../../app/src/lib/reflow";

const HERE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const AUDIT = resolve(HERE, "../audit");
const PDF_DIR = join(AUDIT, "pdfs");
const OUT_DIR = join(AUDIT, "reflow");

function renderBlockText(block: Block): string {
  return block.lines
    .map((line, i) => {
      const shown = line.hyphen ? line.text.replace(/-\s*$/, "") : line.text.replace(/\s+$/, "");
      const joiner = i < block.lines.length - 1 && !line.hyphen && !line.glue ? " " : "";
      return shown + joiner;
    })
    .join("");
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const files = readdirSync(PDF_DIR).filter((f) => f.endsWith(".pdf")).sort();
  let done = 0;
  for (const file of files) {
    const sha = file.replace(/\.pdf$/, "");
    const outPath = join(OUT_DIR, `${sha}.json`);
    if (existsSync(outPath)) {
      done += 1;
      continue;
    }
    const pdfPath = join(PDF_DIR, file);
    const t0 = performance.now();
    try {
      const data = new Uint8Array(readFileSync(pdfPath));
      const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
      const out = await reflow(doc as never);
      const elapsedMs = Math.round((performance.now() - t0) * 10) / 10;
      const payload = {
        sha256: sha,
        numPages: doc.numPages,
        words: out.words,
        usable: out.usable,
        elapsedMs,
        blocks: out.blocks.map((b) => ({
          kind: b.kind,
          text: renderBlockText(b),
          lines: b.lines,
        })),
      };
      writeFileSync(outPath, JSON.stringify(payload));
      await doc.destroy();
    } catch (err) {
      writeFileSync(
        outPath,
        JSON.stringify({
          sha256: sha,
          error: (err as Error).message,
          numPages: 0,
          words: 0,
          usable: false,
          elapsedMs: 0,
          blocks: [],
        }),
      );
    }
    done += 1;
    process.stdout.write(`\rReflowed ${done} of ${files.length} PDFs`);
  }
  console.log(`\nFinished reflowing ${files.length} PDFs into ${OUT_DIR}`);
}

void main();
