#!/usr/bin/env node
// Study Library design lint, from 0.40.
//
// Usage, from the repository root:
//   node scripts/check-design.mjs                         check app/src/styles.css
//   node scripts/check-design.mjs --copy app/src          also check on-screen words in .tsx/.ts
//   node scripts/check-design.mjs --write-baseline [...]  record current counts (may only lower them)
//   node scripts/check-design.mjs --json                  machine-readable report
//
// Hard rules fail on any breach. Ratchet rules fail only when a count rises above
// scripts/design-baseline.json, so the legacy stylesheet can be cleaned up phase by
// phase while new drift is refused at once. No dependencies, so it runs anywhere Node 18+ does.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cssPath = opt("--css") ?? "app/src/styles.css";
const copyDir = opt("--copy");
const baselinePath = opt("--baseline") ?? join(here, "design-baseline.json");

// ---------------------------------------------------------------- parsing
// A small brace walker: enough for one hand-written stylesheet, not a general CSS parser.
export function parseCss(src) {
  const rules = [];
  const stack = [];
  let buf = "", line = 1, startLine = 1, i = 0, quote = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (!quote && c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      const chunk = src.slice(i, end < 0 ? src.length : end + 2);
      line += (chunk.match(/\n/g) || []).length;
      i += chunk.length; continue;
    }
    if (quote) { if (c === quote && src[i - 1] !== "\\") quote = null; buf += c; }
    else if (c === '"' || c === "'") { quote = c; buf += c; }
    else if (c === "{") {
      const prelude = buf.trim().replace(/\s+/g, " "); buf = "";
      const atRule = prelude.startsWith("@");
      const node = { prelude, atRule, line: startLine, decls: [], parents: stack.map((n) => n.prelude) };
      stack.push(node);
      if (!atRule) rules.push(node);
      startLine = line;
    } else if (c === "}") {
      const node = stack.pop();
      if (node && buf.trim()) node.decls.push({ text: buf.trim(), line: startLine });
      buf = ""; startLine = line;
    } else if (c === ";") {
      const top = stack[stack.length - 1];
      if (top && buf.trim()) top.decls.push({ text: buf.trim(), line: startLine });
      buf = ""; startLine = line;
    } else {
      if (!buf.trim() && c.trim()) startLine = line;
      buf += c;
    }
    if (c === "\n") line++;
    i++;
  }
  return rules;
}

const isRoot = (r) => /^:root\b/.test(r.prelude) || r.parents.some((p) => /^:root\b/.test(p));
const inKeyframes = (r) => r.parents.some((p) => p.startsWith("@keyframes"));
const prop = (d) => d.text.slice(0, d.text.indexOf(":")).trim().toLowerCase();
const val = (d) => d.text.slice(d.text.indexOf(":") + 1).trim();

// ---------------------------------------------------------------- rules
const ALLOWED_BREAKPOINTS = new Set(["34", "44", "44.01", "48", "60", "60.01"]);
const NEW_TOKENS = ["--dur-2", "--dur-3", "--ease-settle", "--ease-in", "--press-scale", "--scrim", "--raise"];

export function checkCss(src) {
  const rules = parseCss(src);
  const hard = [];
  const counts = { hexOutsideTokens: 0, rawDurations: 0, rawEasings: 0, rawShadows: 0, offScaleBreakpoints: 0, unguardedHover: 0, rawFontSizes: 0, rawRadii: 0 };
  const where = Object.fromEntries(Object.keys(counts).map((k) => [k, []]));
  const bump = (k, line, note) => { counts[k]++; if (where[k].length < 400) where[k].push(`${line}: ${note}`); };

  for (const r of rules) {
    const active = /:active\b/.test(r.prelude);
    for (const d of r.decls) {
      if (!d.text.includes(":")) continue;
      const p = prop(d), v = val(d);
      if (active && p === "transform" && /scale\(/.test(v))
        hard.push(`press-compound ${d.line}: a press state must use the scale property with var(--press-scale), not transform: scale() (${r.prelude})`);
      if (active && p === "scale" && !/^(var\(--press-scale\)|none)(\s*!important)?$/.test(v))
        hard.push(`press-token ${d.line}: press scale must be var(--press-scale) (${r.prelude} { scale: ${v} })`);
      if ((/::backdrop\b|\.menu-backdrop\b|-scrim\b/.test(r.prelude)) && p.startsWith("background") && !/^(var\(--scrim\)|transparent|none)$/.test(v))
        hard.push(`scrim ${d.line}: a modal backdrop must use var(--scrim) (${r.prelude})`);
      if (p === "content" && /[\u2013\u2014\u00B7]|\\2013|\\2014|\\00B7|\\b7/i.test(v))
        hard.push(`dash-or-dot ${d.line}: generated content may not use dashes or middle dots (${r.prelude})`);
      if (isRoot(r)) continue;
      if (/#[0-9a-f]{3,8}\b/i.test(v.replace(/var\(--[\w-]+,\s*#[0-9a-f]{3,8}\)/gi, ""))) bump("hexOutsideTokens", d.line, r.prelude);
      if (/^(transition|animation)/.test(p) && /(^|[\s,])\d*\.?\d+m?s\b/.test(v.replace(/var\([^)]*\)/g, ""))) bump("rawDurations", d.line, r.prelude);
      if (/cubic-bezier\(/.test(v)) bump("rawEasings", d.line, r.prelude);
      if (p === "box-shadow" && /rgba?\(/.test(v)) bump("rawShadows", d.line, r.prelude);
      if (p === "font-size" && !inKeyframes(r) && /\d(rem|px|em)\b/.test(v) && !/var\(--fs-/.test(v) && !/^max\(1rem, 16px\)$/.test(v)) bump("rawFontSizes", d.line, r.prelude);
      if (p === "border-radius" && /\d(rem|px)\b/.test(v) && !/var\(--r-/.test(v) && !/^(999px|50%|0)$/.test(v)) bump("rawRadii", d.line, r.prelude);
    }
    if (/:hover\b/.test(r.prelude) && !r.parents.some((p) => /\(hover:\s*hover\)/.test(p))) bump("unguardedHover", r.line, r.prelude);
    for (const p of r.parents) for (const m of p.matchAll(/(?:max|min)-width:\s*([\d.]+)rem/g))
      if (!ALLOWED_BREAKPOINTS.has(m[1])) bump("offScaleBreakpoints", r.line, `${m[1]}rem`);
  }
  // Breakpoints on rules with no declarations of their own are still counted once per block.
  for (const m of src.matchAll(/@media[^{]*?(?:max|min)-width:\s*44\.001rem/g)) hard.push(`breakpoint-typo: 44.001rem should be 44.01rem (${m[0].slice(0, 60)})`);

  // Every press scale needs a reduced-motion reset for the control it shrinks, since the
  // global reduced-motion rule stops transitions but leaves the scale property in place.
  const reducedClasses = new Set();
  for (const r of rules) if (r.parents.some((p) => p.includes("prefers-reduced-motion")) && r.decls.some((d) => prop(d) === "scale" && /^none/.test(val(d))))
    for (const m of r.prelude.matchAll(/\.([\w-]+)/g)) reducedClasses.add(m[1]);
  for (const r of rules) {
    if (r.parents.some((p) => p.includes("prefers-reduced-motion"))) continue;
    if (!r.decls.some((d) => prop(d) === "scale" && !/^none/.test(val(d)))) continue;
    for (const sel of splitTop(r.prelude, ",")) {
      const compound = pressedCompound(sel);
      if (compound === null) continue;
      const alts = compound.startsWith(":is(") ? splitTop(compound.slice(4, compound.lastIndexOf(")")), ",") : [compound];
      for (const alt of alts) {
        const classes = [...alt.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
        if (!classes.some((c) => reducedClasses.has(c)))
          hard.push(`press-reduced-motion ${r.line}: ${alt.trim() || sel.trim()} shrinks on press but no prefers-reduced-motion rule resets its scale`);
      }
    }
  }

  const rootSrc = rules.filter((r) => r.prelude === ":root").flatMap((r) => r.decls.map(prop));
  for (const t of NEW_TOKENS) if (!rootSrc.includes(t)) hard.push(`token-missing: ${t} is not defined on :root`);
  const reduced = src.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g) || [];
  if (!reduced.some((b) => /scale:\s*none/.test(b))) hard.push("reduced-motion: no prefers-reduced-motion block resets the scale property, so presses still shrink");
  return { hard, counts, where };
}

// Splits on sep at parenthesis depth 0, so :is(a, b) and :not(...) stay whole.
function splitTop(text, sep) {
  const out = []; let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

// The compound selector that carries the first top-level :active, without the pseudo-classes
// after it: ".jobs .app-card:active:not(...)" gives ".app-card". Returns null without :active.
function pressedCompound(sel) {
  let depth = 0;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && sel.startsWith(":active", i)) {
      let j = i - 1, d = 0;
      while (j >= 0) {
        const c = sel[j];
        if (c === ")") d++;
        else if (c === "(") d--;
        else if (d === 0 && /[\s>+~]/.test(c)) break;
        j--;
      }
      return sel.slice(j + 1, i);
    }
  }
  return null;
}

// ---------------------------------------------------------------- copy
// On-screen words: dashes and middle dots in string literals and JSX text, and vague buttons.
export function checkCopy(dir) {
  const counts = { copyDashes: 0, copyMiddleDots: 0, copyVagueButtons: 0 };
  const where = { copyDashes: [], copyMiddleDots: [], copyVagueButtons: [] };
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    if (/node_modules|\.test\.|\.spec\.|__tests__/.test(p)) return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx|ts)$/.test(f) ? [p] : [];
  });
  for (const file of walk(dir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((l, n) => {
      const code = l.replace(/\/\/.*$/, "");
      if (/^\s*(\*|\/\*)/.test(l)) return;
      const at = `${relative(process.cwd(), file)}:${n + 1}`;
      if (/[\u2013\u2014]/.test(code)) { counts.copyDashes++; where.copyDashes.push(at); }
      if (/\u00B7/.test(code)) { counts.copyMiddleDots++; where.copyMiddleDots.push(at); }
      if (/>\s*(OK|Ok|Submit)\s*</.test(code)) { counts.copyVagueButtons++; where.copyVagueButtons.push(at); }
    });
  }
  return { counts, where };
}

// ---------------------------------------------------------------- main
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!existsSync(cssPath)) { console.error(`No stylesheet at ${cssPath}; pass --css <path>.`); process.exit(2); }
  const css = checkCss(readFileSync(cssPath, "utf8"));
  const copy = copyDir ? checkCopy(copyDir) : { counts: {}, where: {} };
  const counts = { ...css.counts, ...copy.counts };
  const where = { ...css.where, ...copy.where };
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};

  if (flag("--write-baseline")) {
    const next = { ...baseline };
    for (const [k, v] of Object.entries(counts)) {
      if (k in baseline && v > baseline[k] && !flag("--force")) {
        console.error(`Refusing to raise ${k} from ${baseline[k]} to ${v}; fix the new drift or pass --force with a reason in the commit.`);
        process.exit(1);
      }
      next[k] = v;
    }
    writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n");
    console.log(`Baseline written to ${baselinePath}.`);
    process.exit(0);
  }

  const ratchet = [];
  for (const [k, v] of Object.entries(counts)) {
    const limit = baseline[k] ?? 0;
    if (v > limit) ratchet.push(`${k}: ${v} is above the baseline of ${limit}; newest at ${where[k].slice(-3).join(", ")}`);
  }
  if (flag("--json")) console.log(JSON.stringify({ hard: css.hard, ratchet, counts, baseline }, null, 2));
  else {
    for (const h of css.hard) console.log(`HARD     ${h}`);
    for (const r of ratchet) console.log(`RATCHET  ${r}`);
    const lowered = Object.entries(counts).filter(([k, v]) => k in baseline && v < baseline[k]);
    for (const [k, v] of lowered) console.log(`BETTER   ${k}: ${v}, down from ${baseline[k]}; run with --write-baseline to lock it in.`);
    console.log(css.hard.length || ratchet.length ? "Design check failed." : "Design check passed.");
  }
  process.exit(css.hard.length || ratchet.length ? 1 : 0);
}
