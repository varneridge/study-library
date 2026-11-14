// node --test scripts/check-design.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCss, checkCopy } from "./check-design.mjs";

const tokens = `:root { --dur-2: 180ms; --dur-3: 240ms; --ease-settle: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.4, 0, 1, 1); --press-scale: 0.97; --scrim: #0004; --raise: 0 1px 2px #0002; }
@media (prefers-reduced-motion: reduce) {
  .button:active { scale: none !important; }
}
`;

test("a clean sheet has no hard failures", () => {
  const r = checkCss(tokens + `.button:active:not(:disabled) { scale: var(--press-scale); }\ndialog::backdrop { background: var(--scrim); }\n`);
  assert.deepEqual(r.hard, []);
});

test("a transform press beside a scale press is refused", () => {
  const r = checkCss(tokens + `.button:active { transform: scale(0.985); }\n`);
  assert.ok(r.hard.some((h) => h.startsWith("press-compound")));
});

test("a literal press scale is refused", () => {
  const r = checkCss(tokens + `.tool:active { scale: 0.95; }\n`);
  assert.ok(r.hard.some((h) => h.startsWith("press-token")));
});

test("a backdrop with its own tint is refused", () => {
  const r = checkCss(tokens + `.dialog::backdrop { background: color-mix(in srgb, var(--ink) 35%, transparent); }\n`);
  assert.ok(r.hard.some((h) => h.startsWith("scrim")));
});

test("missing tokens and a missing reduced-motion reset are both reported", () => {
  const r = checkCss(`.a { color: red; }\n`);
  assert.ok(r.hard.some((h) => h.includes("--press-scale")));
  assert.ok(r.hard.some((h) => h.startsWith("reduced-motion")));
});

test("a press scale with no reduced-motion reset for its control is refused", () => {
  const r = checkCss(tokens + `.jobs .app-card:active:not(:has(.button:active)) { scale: var(--press-scale); }\n`);
  assert.ok(r.hard.some((h) => h.startsWith("press-reduced-motion") && h.includes(".app-card")));
});

test("a press scale whose control is reset under reduced motion passes", () => {
  const r = checkCss(tokens + `:is(.button):active:not(:disabled) { scale: var(--press-scale); }\n`);
  assert.deepEqual(r.hard, []);
});

test("ratchet counts see drift outside :root but not inside it", () => {
  const r = checkCss(tokens + `.x { color: #123456; transition: color 0.2s ease; border-radius: 3px; }\n.y:hover { color: var(--ink); }\n@media (hover: hover) { .z:hover { color: var(--ink); } }\n@media (max-width: 52rem) { .w { color: var(--ink); } }\n`);
  assert.equal(r.counts.hexOutsideTokens, 1);
  assert.equal(r.counts.rawDurations, 1);
  assert.equal(r.counts.rawRadii, 1);
  assert.equal(r.counts.unguardedHover, 1);
  assert.equal(r.counts.offScaleBreakpoints, 1);
  assert.equal(r.counts.rawEasings, 0, "cubic-bezier inside :root is the token itself");
});

test("copy check finds dashes, middle dots and vague buttons", () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-"));
  mkdirSync(join(dir, "pages"));
  writeFileSync(join(dir, "pages", "A.tsx"), [
    "// a comment with an em dash \u2014 is ignored",
    "export const A = () => <p>Week 3 \u2014 readings</p>;",
    "export const B = () => <span>12 Oct \u00B7 Lecture</span>;",
    "export const C = () => <button>OK</button>;",
  ].join("\n"));
  const r = checkCopy(dir);
  assert.equal(r.counts.copyDashes, 1);
  assert.equal(r.counts.copyMiddleDots, 1);
  assert.equal(r.counts.copyVagueButtons, 1);
});
