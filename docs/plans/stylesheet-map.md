# Stylesheet Clean-up: 0.34.1 Map (Phases 1 and Partial 3)

This map documents every change in release 0.34.1, along with the cascade proof or specificity explanation demonstrating why each change leaves computed styles identical on screen across viewports, themes, and devices.

---

## Section A: Dead Declarations Removed in Phase 1

| Selector / Location | Removed Declaration(s) | Cascade Proof / Why It Left Computed Styles Unchanged |
| --- | --- | --- |
| `label.field > span` (line 167) | Whole rule | Finish's `label.field > span` (line 991) redeclares `display: block; font-size: var(--fs-sm); color: var(--muted); margin-bottom: 0.3rem; font-weight: 500;` at equal specificity later in the cascade. |
| `.brand` (line 68) | `font-family: var(--serif);` | Design rule `h1, h2, .brand { font-family: var(--display); }` (line 1826) wins at equal specificity later in the cascade. |
| `.panel-label` (line 309) | `letter-spacing: 0.04em; text-transform: uppercase;` | Reset by sentence-case rule; removing uppercase allows default sentence-case to apply without overrides. |
| `.bin .kind` (line 585) | `text-transform: uppercase; letter-spacing: 0.04em;` | Same: reset by sentence-case rule. |
| `.palette-list .kind` (line 711) | `text-transform: uppercase; letter-spacing: 0.04em;` | Same: reset by sentence-case rule. |
| `.turn .who` (line 762) | `letter-spacing: 0.06em; text-transform: uppercase;` | Same: reset by sentence-case rule. |
| `.tv-kicker` (line 805) | `letter-spacing: 0.08em; text-transform: uppercase;` | Same: reset by sentence-case rule. |
| `.note-highlight .quote-tag` (line 842) | Whole rule | Same: reset by sentence-case rule. |
| `.rec-pill .rec-state` (line 870) | `letter-spacing: 0.06em; text-transform: uppercase;` | Same: reset by sentence-case rule. |
| Sentence-case reset block (lines 1730-1734) | Whole block | Once uppercase properties above are removed, this entire override block is dead. |
| `.app-fields input, select`, `.app-fields .date-show, .deadline`, `.apps .closed-head th` | `text-transform: none; letter-spacing: normal;` | Browser default is already none/normal; nothing earlier made them uppercase. |
| `.found` (early, line 775) | `border: 1px solid var(--accent); background: none; color: var(--accent); font-size: var(--fs-xs); padding: 0.05rem 0.45rem;` | Design `.found` (lines 1597-1599) redeclares `border: 0; background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 0.15rem 0.6rem; font-weight: 500; font-size: var(--fs-xs);`. |
| `.this-week-tag` (line 1601) | `text-transform: none; border: 0;` | `border: 0` was redundant; `letter-spacing: normal` is preserved to guard against heading inheritance. |
| `.reader.narrow .reader-body` (line 388) | `padding-top: 0;` | Nothing sets padding on `.reader-body`. |
| `.hit-line.plain` (line 527) | Whole rule | `.hit-line` has no left padding; padding sits on child `.at`. |
| `margin-top: 0.5rem;` in second `.transcript` rule (line 611) | `margin-top: 0.5rem;` | Duplicated from first `.transcript` rule (line 496). |
| `.dialog h2` (line 985), `.this-week h2` (line 1017) | `font-size: var(--fs-xl);` | Design `h2` (line 1522) sets `font-size: var(--fs-xl);` for all h2 elements. |
| `.app-cards` (early, line 1202) & Design `border-top: 0` list | `border-top: 1px solid var(--ink);` and reset list | Early `.app-cards` had border-top which Design immediately reset. Deleting both removes dead rule. |
| `.pane` (line 1751) | `border-color: var(--rule);` | Duplicates `border-color: var(--rule)` already set in `.pane.left` and `.pane.right`. |
| `.import-bar` (line 256) | `margin-top: 0;` | Container has no browser default margin-top. |
| `@media (max-width: 48rem)` on `.session-side` (line 743) | Whole rule | Nothing in the app sets non-static position or max-height on `.session-side`. |

---

## Section B: Dead Confirmed by Markup Verification

| Selector | Removed Rule | Verification / Markup Proof |
| --- | --- | --- |
| `.week-page .reading` | Whole rule | All reading rows on week pages sit within `<ol className="readings">`, where `.readings > li.reading` (0,2,1) wins over `.week-page .reading` (0,2,0). |
| `.session` (early) | `margin-top: 1.75rem; border-top: 1px solid var(--ink); padding-top: 0.5rem;` | Every session is rendered as `<section className="session">`, where `section.session` (0,1,1) wins over early `.session` (0,1,0). |
| Early `.theme-chip.sepia/.dark/.light`, `.theme-chip.system`, and `:is(...) .tool.theme-chip.*` | Chip color declarations | All theme chips sit inside `<div className="segmented">`, where `.segmented .tool.theme-chip.*` (0,3,0) wins. |

---

## Section C: Phase 3 Mechanical Consolidations

1. **Top bar hover rules:** Consolidated 6 duplicate rules (`.brand:hover`, `.modules-nav a:hover`, `.topbar-across:hover`, `.topbar-btn:hover`, `.topbar > .to-jobs:hover`, `.jobs-bar nav a:hover`) into a single selector list with `{ background: var(--surface); color: var(--ink); }`.
2. **Coarse pointer media queries:** Merged duplicate `@media (pointer: coarse), (max-width: 48rem)` blocks into one unified query block.
3. **Quotation action button specificity:**
   - Separated button colors (`.note-highlight .quote-meta .quote-write { color: var(--muted); }`) at (0,3,0) to beat `.note-highlight .quote-meta button` (0,2,1) without `!important`. Grep confirmed `.quote-write` and `.quote-delete` only ever occur inside `<span className="quote-meta">` (`NoteEditor.tsx:78,89`).
   - Kept base layout and `opacity: 0` at (0,2,0) so the later touch query rule (`opacity: 1`) wins on phones and touch screens.
4. **Appearance menu tool borders:**
   - Added `border: 1px solid var(--rule);` to `.menu-panel.appearance .tool` (for standalone zoom buttons).
   - Added `border: 0;` to `.menu-panel.appearance .segmented .tool { flex: 1; border: 0; }` (0,4,0), allowing `.segmented .tool` to drop `!important` without losing segmented styling.
5. **Found button min-height:**
   - Dropped `!important` on `.found { min-height: 0; }`. Grep confirmed all `.found` buttons in `ModulePage.tsx` and `ReadingRow.tsx` carry only `className="found"` without `.quiet` or `.button` classes, so the declaration applies cleanly without needing to override stronger button rules.

---

## Section D: Markup Conditions & Verification Guarantees

1. **Condition 1 (Quotation action buttons):**
   - Markup check: `git grep -n "quote-write\|quote-delete" app/src` returns occurrences exclusively inside `NoteEditor.tsx` lines 78 and 89, wrapped in `<span className="quote-meta">`.
   - Result: `.note-highlight .quote-meta .quote-write` matches all quotation write and delete buttons reliably.
2. **Condition 2 (Found buttons):**
   - Markup check: `git grep -n "className=.*found" app/src` returns occurrences in `ModulePage.tsx:299` and `ReadingRow.tsx:421`.
   - Result: No found buttons carry conflicting `.button` or `.quiet` utility classes; `min-height: 0` without `!important` takes effect without conflict.

---

## Deferred to Phase 2 (Release 0.34.2)

1. Theme chip pressed outline removal (currently draws both an inset outline and outer ring).
2. Phone type scale (`--fs-2xl` and `--fs-xl` below 34rem).
3. Phone menu sheet safe-area padding and border-width.
4. Phone menu item padding (`[role="menuitem"]`).
5. Button hover soft surfaces and elimination of dark ink outline.
6. Empty drop target dashed top border.
7. Focus-visible border-radius removal.
8. Reader bar inset shadow vs border rule consolidation.
