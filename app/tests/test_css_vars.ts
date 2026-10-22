import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Custom properties set dynamically from TypeScript via style={{ "--name": ... }}
// or element.style.setProperty("--name", ...).
const SET_FROM_CODE = new Set([
  "tool",
  "hl",
  "tv-size",
  "scale-factor",
  "topbar-h",
  "jump-h",
  "apps-head-h",
]);

function findUndefinedCssVars(css: string, allowedFromCode: ReadonlySet<string>): string[] {
  const defined = new Set<string>();
  for (const m of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:/g)) {
    defined.add(m[1]);
  }
  const missing: string[] = [];
  const re = /var\(\s*--([a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    const varName = match[1];
    let depth = 1;
    let idx = match.index + match[0].length;
    let hasComma = false;
    let fallbackContent = "";
    while (idx < css.length && depth > 0) {
      const char = css[idx];
      if (char === "(") depth++;
      else if (char === ")") {
        depth--;
        if (depth === 0) break;
      } else if (char === "," && depth === 1 && !hasComma) {
        hasComma = true;
        idx++;
        continue;
      }
      if (hasComma && depth >= 1) {
        fallbackContent += char;
      }
      idx++;
    }
    const hasFallback = hasComma && fallbackContent.trim().length > 0;
    if (!defined.has(varName) && !allowedFromCode.has(varName) && !hasFallback) {
      missing.push(`--${varName}`);
    }
  }
  return missing;
}

export function registerCssVarTests(test: (name: string, fn: () => void) => void) {
  test("all CSS variables in styles.css are defined, set from code, or have fallbacks", () => {
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    const missing = findUndefinedCssVars(css, SET_FROM_CODE);
    assert.deepEqual(missing, [], `Undefined CSS variables without fallback found: ${missing.join(", ")}`);
    assert.deepEqual(
      findUndefinedCssVars(".topbar { gap: var(--s-2); height: var(--topbar-h, 3.25rem); color: var(--tool); }", SET_FROM_CODE),
      ["--s-2"],
    );
  });
}
