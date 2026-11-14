// Static guards for the reader polish work. Run with: node tests/reader-polish.guard.mjs
// Each guard names the acceptance criterion it enforces (AC1 to AC6 in
// docs/architecture/reader-polish.md) so that a failure says what is unmet.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const failures = [];
const fail = (ac, msg) => failures.push(`${ac}: ${msg}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(SRC, p);
const byName = (name) => files.filter((p) => basename(p) === name);
// Strips comments so that explanatory prose cannot trip or satisfy a guard.
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// AC1: the view switcher sits in a row with other content, not in its own bar.
for (const p of files) {
  if (/board-tools/.test(code(p))) fail("AC1", `${rel(p)} still declares or renders .board-tools`);
}
const switcherHosts = files.filter((p) => p.endsWith(".tsx") && /className=["{][^"}]*view-switcher/.test(code(p)));
if (switcherHosts.length === 0) fail("AC1", "no component renders .view-switcher");

// AC2: every zoomable PDF or page preview goes through ZoomViewport.
const zv = join(SRC, "components/reader/ZoomViewport.tsx");
if (!existsSync(zv)) fail("AC2", "components/reader/ZoomViewport.tsx does not exist");
else {
  const z = code(zv);
  for (const attr of ["data-zoom-frame", "data-zoom-stage", "ResizeObserver"]) {
    if (!z.includes(attr)) fail("AC2", `ZoomViewport.tsx lacks ${attr}`);
  }
  if (!/from\s+["'][./]*lib\/zoom["']/.test(z)) fail("AC2", "ZoomViewport.tsx does not import lib/zoom");
}
const exemptPageView = new Set(["pages.tsx", "ZoomViewport.tsx", "Sidebar.tsx"]);
for (const p of files.filter((f) => f.endsWith(".tsx"))) {
  const c = code(p);
  const usesPageView = /import\s*{[^}]*\bPageView\b[^}]*}\s*from/.test(c);
  const hasZoomControls = /label=["']Zoom in["']|icon=["']zoomIn["']/.test(c);
  // A viewer either uses ZoomViewport or is itself a fixed frame marked as one
  // (the reader's own scroller, which measures itself and keeps its place).
  const usesViewport = /\bZoomViewport\b|data-zoom-frame/.test(c);
  if (usesPageView && !exemptPageView.has(basename(p)) && !usesViewport) {
    fail("AC2", `${rel(p)} renders PageView without ZoomViewport`);
  }
  // Zoom controls matter here only where PDF pages are drawn.
  if (usesPageView && hasZoomControls && !usesViewport && !/lib\/zoom["']/.test(c)) {
    fail("AC2", `${rel(p)} has zoom controls but neither ZoomViewport nor lib/zoom`);
  }
}

// AC3: no mark-as-read control or indicator in the four named components.
const readTargets = [
  ...byName("Reader.tsx"),
  ...byName("VideoReader.tsx"),
  ...byName("ReadingRow.tsx"),
  ...files.filter((p) => p.endsWith("reader/Controls.tsx") || p.endsWith("reader\\Controls.tsx")),
];
for (const name of ["Reader.tsx", "VideoReader.tsx", "ReadingRow.tsx", "Controls.tsx"]) {
  if (!readTargets.some((p) => basename(p) === name)) fail("AC3", `could not find ${name} to check`);
}
for (const p of readTargets) {
  const c = code(p);
  if (/mark\s+as\s+(un)?read/i.test(c)) fail("AC3", `${rel(p)} still offers mark as read`);
  if (/read-toggle|className=["'][^"']*\bis-read\b/.test(c)) fail("AC3", `${rel(p)} still renders a read indicator`);
  if (/\bread_status\b/.test(c)) fail("AC3", `${rel(p)} still reads or writes read_status`);
}
for (const p of files.filter((f) => f.endsWith(".css"))) {
  if (/\.read-toggle\b/.test(code(p))) fail("AC3", `${rel(p)} still styles .read-toggle`);
}

// AC4: the notes pane opens straight onto the editor, with no standing hint.
const sidebar = files.find((p) => p.endsWith("reader/Sidebar.tsx") || p.endsWith("reader\\Sidebar.tsx"));
if (!sidebar) fail("AC4", "reader/Sidebar.tsx not found");
else {
  const c = code(sidebar);
  if (/className=["'][^"']*\b(notes-hint|pane-hint|hint)\b/.test(c)) fail("AC4", "Sidebar.tsx still renders a hint element");
  const panel = c.indexOf("data-notes-panel");
  if (panel < 0) fail("AC4", "Sidebar.tsx lacks the data-notes-panel container");
  else {
    const after = c.slice(c.indexOf(">", panel) + 1).trimStart();
    if (!/^(<Suspense\b|<NoteEditor\b|\{\s*<Suspense\b)/.test(after)) {
      fail("AC4", "the first child of data-notes-panel is not the note editor");
    }
  }
}

// AC5: comments are written inside the highlight card and stored on the highlight.
const editor = byName("NoteEditor.tsx")[0];
if (!editor) fail("AC5", "NoteEditor.tsx not found");
else if (!/focusComment\s*\(\s*highlightId\s*:\s*string\s*\)\s*:\s*boolean/.test(code(editor))) {
  fail("AC5", "NoteEditorHandle lacks focusComment(highlightId: string): boolean");
}
const all = files.filter((p) => p.endsWith(".tsx")).map(code).join("\n");
for (const attr of ["data-highlight-card", "data-highlight-comment"]) {
  if (!all.includes(attr)) fail("AC5", `no component renders ${attr}`);
}
if (!/commentWriter\s*\(/.test(all)) fail("AC5", "no component uses commentWriter from lib/highlightComments");
const reader = byName("Reader.tsx")[0];
if (reader) {
  const c = code(reader);
  if (/h\.comment\s*\?\?\s*""/.test(c)) fail("AC5", "Reader.tsx still puts comments into the reconcile shape");
  if (!/reconcileShape/.test(c)) fail("AC5", "Reader.tsx does not use reconcileShape from lib/noteShape");
}

// AC6: highlighting from a selection takes one action.
if (!byName("SelectionBar.tsx").length) fail("AC6", "components/reader/SelectionBar.tsx does not exist");
if (reader && !/\bSelectionBar\b/.test(code(reader))) fail("AC6", "Reader.tsx does not render SelectionBar");
if (!/shortcutFor\s*\(/.test(all)) fail("AC6", "no component uses shortcutFor from lib/highlightSelect");
if (!/isDuplicate\s*\(/.test(all)) fail("AC6", "highlight creation does not check isDuplicate");

// The test seam must never ship in a production build.
const seam = join(SRC, "lib/testSeam.ts");
if (!existsSync(seam)) fail("E2E", "lib/testSeam.ts does not exist");
else if (!/import\.meta\.env\.(DEV|VITE_E2E)/.test(code(seam))) fail("E2E", "lib/testSeam.ts is not gated on import.meta.env");

if (failures.length) {
  console.error(failures.map((f) => `FAIL ${f}`).join("\n"));
  console.error(`${failures.length} guard(s) failed`);
  process.exit(1);
}
console.log("all reader polish guards passed");
