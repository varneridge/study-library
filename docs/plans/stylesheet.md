# Plan: tidying the stylesheet

## Why this plan exists

The stylesheet at `app/src/styles.css` has grown in layers, and each layer restyled the one before it without removing what it replaced. The first layer set the original square, ruled look. A second layer, headed "Finish", tried to unify controls. A third added the phone and touch rules. The last layer, headed "Design, from 0.29", is the look the design skill describes. Because each layer only overrides the earlier ones, the file now holds a large number of declarations that never reach the screen. Several `!important` flags exist only to beat rules that are themselves dead. A few phone rules are silently cancelled by later desktop rules, so the phone looks different from what their authors intended.

None of this is visible to someone using the app today, which is why it has gone unnoticed. The cost falls on whoever changes the interface next, because they cannot tell which of three rules for `.button` is the real one without tracing the cascade by hand. That uncertainty is how the same thing ends up styled differently in two places, which the design skill asks us to avoid.

## What we are aiming for

The goal is a stylesheet where each component is defined once, in the "Design, from 0.29" look, so that reading a rule tells you what the screen shows. Tokens should be declared in one block for each theme, and the components should use only those tokens. `!important` should remain only where it overrides inline styles, third-party styles or the reduced-motion preference, and each remaining use should carry a comment saying why.

## How the work is split

The work is split into two releases and four phases, ordered so that safe refactoring comes first:

- **Release 0.34.1 (Phases 1 and 3):** Refactor without changing any computed styles or visuals on screen. Verified by cascade proofs, markup checks, targeted assertions, and the full regression suite across viewports and themes.
- **Release 0.34.2 (Phases 2 and 4):** Intentional accident corrections, semantic token convergence, and full dark-theme token parity. Verified against screenshots in `docs/design/`.

---

### Phase 1: remove what never applies (in 0.34.1)

This phase deletes duplicate rules, declarations overridden later by an equal or stronger selector, and `!important` flags that no longer win anything. Every edit in this phase leaves computed styles unchanged across all viewports, themes and input types.

The line-by-line map for Phase 1 is documented in `docs/plans/stylesheet-map.md`. It covers:
1. **Section A (Dead by cascade alone):**
   - Controls: `label.field > span` (early rule is overridden by Finish's `label.field > span`).
   - Shell: `font-family: var(--serif)` in `.brand` (Design `h1, h2, .brand` sets `var(--display)`).
   - Uppercase & letter-spacing resets: Remove `text-transform: uppercase` and `letter-spacing` from `.panel-label`, `.bin .kind`, `.palette-list .kind`, `.turn .who`, `.tv-kicker`, `.note-highlight .quote-tag`, `.rec-pill .rec-state`. Then remove the corresponding sentence-case resets in Design and redundant resets in `.app-fields` and `.apps .closed-head th`.
   - Details found: early `.found` declarations (`border`, `background`, `padding`, `color`) removed, while `font-size: var(--fs-xs)` is explicitly preserved on Design `.found`.
   - Tags: `text-transform` and `border: 0` removed from `.this-week-tag`, while `letter-spacing: normal` is preserved to guard against heading inheritance.
   - Phones: `.session-side` media query `(max-width: 48rem)` removed (never set elsewhere).
   - Search: `.hit-line.plain { padding-left: 0 }`.
   - Recordings: `margin-top: 0.5rem` in first `.transcript` rule.
   - Dialog & This week: `h2 { font-size: var(--fs-xl) }` in Finish and Home (Design `h2` sets same token).
   - Chips: `!important` on `.found { min-height: 0 !important }` removed (natural button inheritance).

2. **Section B (Dead confirmed by markup grep):**
   - `.week-page .reading`: all rows sit in `.readings`, where `.readings > li.reading` wins.
   - Early `.session`: all sessions are `<section className="session">`, where `section.session` wins.

---

### Phase 2: resolve rules that are dead by accident (in 0.34.2)

These declarations never apply because an earlier or later rule cancels them by mistake. Each is resolved intentionally:

1. **Phone menu sheet safe area and borders:** Move `.menu-panel` phone sheet rules after "Things that float", preserving `padding: 0.4rem 0 calc(0.4rem + env(safe-area-inset-bottom, 0px))` so the last menu item never sits under the iPhone home indicator, and use `border-width: 1px 0 0` with proper surface separation.
2. **Phone menu item padding:** Use `.menu-panel button[role="menuitem"]` so sheet items get comfortable 1.25rem touch padding on phones instead of desktop padding.
3. **Phone type scale:** Place `@media (max-width: 34rem) { :root { --fs-2xl: 1.625rem; --fs-xl: 1.25rem; } }` after Design's `:root` tokens so long titles do not wrap awkwardly on narrow phone screens.
4. **Button hover soft surfaces:** Remove Finish's `:hover:not(:disabled)` dark ink border rule, and ensure Design's `:hover:not(:disabled)` applies cleanly without turning outlines dark.
5. **Drop target top border:** Remove `!important` on `.readings { border-top: 0 !important; }` so `.readings.empty-target` retains its dashed border on all four sides.
6. **Keyboard focus radius:** Remove `border-radius: var(--r-xs);` from `:focus-visible` so focused buttons don't shrink corners.
7. **Text view highlight padding:** Allow `mark.hl-text { padding: 0.18em 0; }` to win over `.tv-body mark.hl-text`.
8. **Reader bar border:** Eliminate redundant 1px double rule (keep only the inset shadow on `.reader-bar`).
9. **Search box border:** Use soft `--rule-strong` with field focus ring.
10. **Section-head gap:** Accept current gap and clean up obsolete declaration.
11. **Theme chip outline:** Remove early `outline: 2px solid var(--accent)` on `.theme-chip[aria-pressed="true"]` so chips rely on Design's clean ring styling.

---

### Phase 3: component consolidations

Phase 3 work completed in 0.34.1:
- Top bar hover rules consolidated into one selector list.
- The two duplicate `(pointer: coarse), (max-width: 48rem)` query blocks unified into one.
- Three unjustified `!important` flags replaced with natural specificity: quotation action buttons (`.quote-write`, `.quote-delete`), appearance menu segmented tools (`.menu-panel.appearance .segmented .tool`), and `.found` chips.

Remaining component definitions slated for single-rule gathering alongside Phase 4:
- Surviving component single-block unifications (`.button`, fields, menus, dialogs, reader bar, and panes).
- Merging the disjoint `:root` and `:root[data-theme="*"]` token blocks.

---

### Phase 4: bring remaining styles onto tokens (in 0.34.2)

- Retire `--wash` in favour of semantic `--surface` / `--surface-hover` (for surfaces) and `--accent-soft` (for active/selection/drop highlights).
- Retire `--shadow` in favour of `--shadow-float` for floating elements.
- Semantic tokens: add `--warn`, `--live`, `--find` (with values defined for light, sepia, and dark) for key dates, recording pill, and find highlights.
- Dark theme system token parity: ensure `@media (prefers-color-scheme: dark)` defines the full token set identical to `:root[data-theme="dark"]`, enforced by the CSS unit test.
- Round leftover square shapes (`.rec-dot`, `.swatch-mini`, `kbd`, `.drag-card`, `.move-dock`, `.drop-banner`, `.pick`, `.readings.empty-target`, `.transcript`, `.first-steps`, `.annotation`, `--bn-border-radius-large`).

---

## Verification

- **Release 0.34.1 (Phases 1 & 3):**
  - Verified by cascade proofs, markup checks, targeted assertions, and the full regression suite:
    - Unit tests: `npm run test:all` (including `test_css_vars`).
    - Layout audit: `npm run e2e -- audit_layout` (171s, 0 faults across 320, 390, 768, 1280 light & dark).
    - Targeted guards in `test_reading_notes.py` (opacity at touch), `test_citations.py` (fontSize), and `test_themes.py` (border and outline).
    - Full suite of browser tests passing without regression.
  - Claude Oracle diff review before commit.
- **Release 0.34.2 (Phases 2 & 4):**
  - Design screenshot checks in `docs/design/`.
  - Contrast checks (recording pill and amber passing 4.5:1 in all themes).
  - System dark theme token parity unit test.
