# Plan: Laptop top bar, week groups, home module grid, and module week grid

This plan covers four connected changes to Study Library:

1. **The top bar above the phone layout (`> 44rem` / `704px`):** one height, one row at every width from `768px` to `1440px`, lined up with the page's content column using percentages of the bar's own width (not `100vw`, so the scrollbar does not offset it), using the tab bar's icons where a symbol is commonly known and words where a symbol would need explaining, one name for every page, one way to mark the current page everywhere, and the job search top bar built on the same structure and spacing while keeping its own content. **Built and live as 0.33.1.**
2. **Week groups, summaries and progress (Part G):** each week holds Primary readings, Secondary readings and Summaries; a summary is a file such as a handout that opens in the reader but is never ticked, counted, cited or offered by `@`; and a module's progress counts only the current teaching week's primary and secondary readings.
3. **The home page:** a grid of module cards in your chosen order, keeping `Add a module` and `Arrange`, with a picture chosen in module settings (resized on the device and working offline) or a typographic cover in `--display`, replacing `This week`, `Recently opened` and the dissertation countdown on the home page.
4. **The module page:** a grid of week cards (or dissertation section cards) on both laptop and phone, each showing its code, title, dates, reading progress and a 16:9 thumbnail (first slide of that week's slides, seminar note picture, any note picture in the week, or a typographic cover), with `This week` standing out, working offline and staying fast across 22 weeks.

Each part deploys on its own, with its own version and a row in section 17 of `DEBRIEF.md`. Section 7 sets out the order.

> **Spacing values.** `styles.css` has no spacing tokens. Every spacing in this plan is the plain `rem` value `styles.css` already uses for that spacing (`0.25rem`, `0.5rem`, `0.75rem`, `1rem`, `1.25rem`). Undefined `var(--s-*)` tokens are what broke 0.33.0: the browser discarded every declaration that used them. The unit test added in 0.33.1 now fails on any `var()` naming a property that is defined nowhere.

---

## 1. What you see now

Screenshots from `npm run e2e -- audit_layout` are in `app/tests/e2e/shots/` and `app/tests/e2e/shots/audit/`.

### 1.1 The laptop and tablet top bar (before Part 1)

This describes the bar before 0.33.1, kept as the record of why Part 1 was built. Section 3 describes what was built.

Relevant screenshots:
- `app/tests/e2e/shots/audit/w768-ipad-mini_light_01-home_fault_67.png` (tablet `768px`, light)
- `app/tests/e2e/shots/audit/w768-ipad-mini_dark_01-home_fault_72.png` (tablet `768px`, dark)
- `app/tests/e2e/shots/audit/w1024-laptop_light_01-home_fault_85.png` (`1024px`, light)
- `app/tests/e2e/shots/audit/w1280-desktop_light_01-home_fault_94.png` (`1280px`, light)
- `app/tests/e2e/shots/audit/w1280-desktop_dark_08-settings_fault_101.png` (`1280px`, dark, Settings open)
- `app/tests/e2e/shots/ux-2-module.png` (`1440px`, module page with module links in the top bar)
- `app/tests/e2e/shots/jobs-1-table.png` (`1440px`, Job search top bar)

What happened before 0.33.1 in `app/src/App.tsx` and `app/src/styles.css`:
- **Out of alignment with the page column:** `.topbar` used `padding: 0.7rem max(1.25rem, calc((100vw - 72rem) / 2 + 1.25rem))`, which lined up with `.page.wide` (`72rem`, used only by `JobsPage`), while every study page uses `.page` (`max-width: 46rem`). Using `100vw` also ignored the Windows scrollbar (about 16px wide), shifting the bar about 8px to the right of the page content.
- **Wrapping at tablet widths (`768px` to `896px`):** `@media (max-width: 56rem)` set `.topbar { flex-wrap: wrap }` and hid `.wide-only`, so `Study Library`, `Go to` and `Week across modules` each wrapped onto two lines, making the bar `74px` tall.
- **Reserved empty gap in `SyncStatus`:** `.sync-status` had `min-width: 7.5rem` even when idle and empty.
- **Words where icons are standard:** `Go to`, `Search` and `Settings` were text links on a laptop, while the phone already used the `goto`, `search` and `settings` icons.
- **Two names for the same page:** `Week across modules` (or `Across`) on a laptop, `This week` on a phone.
- **Three ways to mark the current page:** a soft accent pill, a bottom border and an inset shadow, all at once on some links.
- **Inconsistent bar structure for Job search:** a separate `jobs-bar` with its own spacing.

### 1.2 The home page

Relevant screenshots:
- `app/tests/e2e/shots/ux-3-home.png` (`1440px`, light, with `This week: AT1`, `Modules` list and `Recently opened`)
- `app/tests/e2e/shots/dissertation-1-home.png` (`1440px`, light, with `Coming up` dissertation countdown above `This week`)
- `app/tests/e2e/shots/audit/w390-iphone14_light_01-home_fault_35.png` (`390px` phone, light)
- `docs/design/laptop-home.png` and `docs/design/phone-home.png`

What happens today in `app/src/components/Home.tsx`:
- Before you reach your modules, the page stacks `KeyDatesAhead` (`<h2>Coming up</h2>`) and `ThisWeek` (`<h2>This week: AT1</h2>`), which also places `<h2>` headings above `<h1>Modules</h1>` (noted in section 16 of `DEBRIEF.md`).
- Modules are flat full-width rows (`.module-row`) with a single line of text, a progress bar and a `Next:` reading line.
- Below `Modules` sits `Recently opened` (`<h2>Recently opened</h2>`), duplicating what `Go to` (`Ctrl+K`) already offers from anywhere in the app.
- **Progress counts two different things.** The module row's bar comes from `loadModules` in `app/src/lib/library.ts`, which counts every week's loose items (primary and secondary readings, never slides) across the whole module. The `Readings` tile in `This week` comes from `loadThisWeek`, which counts every item linked to this week, slides included. Neither is what the module's progress should mean (Part G).

### 1.3 The module page

Relevant screenshots:
- `app/tests/e2e/shots/ux-2-module.png` (`1440px`, light, taught module with 22-week strip and expandable week rows)
- `app/tests/e2e/shots/editing-2-module-settings.png` (`1440px`, light, `ModuleSettings` panel open on a module page)
- `app/tests/e2e/shots/dissertation-2-module.png` (`1440px`, light, dissertation module with `KeyDates` and sections)
- `docs/design/laptop-module.png`

What happens today in `app/src/components/ModulePage.tsx`:
- Below the header, term meta and 22-button `.jump` strip, every week is a full-width expandable accordion row (`.week` / `WeekBlock`) with a caret, `AT1`, title, dates, reading counter, session chips and `.week-gist`.
- Expanding weeks inline creates a very long single-column page that mixes week navigation with full reading lists, while clicking into `WeekPage` (`/?v=week&id=...`) is a separate view with the same readings plus notes, slides and seminar questions.
- On load, `loadModule(moduleId)` calls `Promise.all(weeks.map(loadWeek))`, running roughly 150 IndexedDB queries across all 22 weeks (including every question highlight, every session note block and cache checks for every reading) even before you open a single week.

### 1.4 The two groups in a week

What happens today:
- `items.kind` is `secondary`, `primary` or `slides` (`app/migrations/0001_init.sql`, with a `CHECK` constraint; `ItemKind` in `app/src/lib/types.ts`).
- `loadWeek` splits a week's loose items into `readings` (`secondary`) and `primaries` (`primary`); slides hang off their session.
- The two groups have no consistent names. The secondary list has no heading at all on the week page (`WeekBoard.tsx` passes `label={null}`) and no heading on the module and This week pages. The primary list is headed `Primary sources`. Elsewhere they are `Reading` and `Primary source` (import table and Edit details), `Reading` and `Source` (Go to), and the toasts say `Now a reading.` and `Now a primary source.`
- An empty list shows only while a reading is being dragged, as a place to drop it. Files dropped on `Primary sources` become primary sources; anywhere else they become readings unless their names say otherwise.
- Every reading and every slide deck has a tick box (`ReadMark`) and `Mark as read` in its menu. The reader has a read toggle in its toolbar and `Mark as read` on the end card.
- `@` in notes offers every item except slides. `Copy reference` is hidden only for slides.

---

## 2. Proposed wording for `DEBRIEF.md` and the design skill

### 2.1 Section 10 of `DEBRIEF.md` (Decisions and why)

Replace the row:

| Decision | Why |
| --- | --- |
| Typographic lists, not cards | Lists shorten cleanly. Card grids show holes. |

with:

| Decision | Why |
| --- | --- |
| Cards for modules and weeks; typographic lists for readings | Modules and weeks have a fixed shape and a visual cover (a chosen picture, a first slide, a seminar note picture, or a display-set code), so a grid lets you take in a whole degree or a 22-week module at a glance. Readings, notes and search hits vary in length and detail, so inside a week they stay flat typographic rows. Moving a reading between weeks happens on the week page, where full context is visible, rather than on the module overview. |

Part G adds two rows:

| Decision | Why |
| --- | --- |
| Three groups in a week: Primary readings, Secondary readings, Summaries | Each is something different to do with a file: read it as a source, read it as scholarship, or keep it to hand. One name for each, used everywhere it appears. |
| Progress is this week's primary and secondary readings | A count across the whole module grows too large to act on. This week's reading list is what there is to do now. Slides and summaries are kept to hand, not read through, so they are never counted. |

### 2.2 `.agents/skills/study-library-design/SKILL.md`

1. In **Components** (after **Rows**), add:
   > **Cards.** Used only for modules on the home page and weeks (or dissertation sections) on a module page. A card sits flat on `--surface` with `--r-md` (`10px`) corners, no border and no drop shadow, lifting to `--surface-hover` on pointer hover. Each card has a `16:9` top cover clipped to the top corners: a user-chosen module picture, the week's first slide, a note picture, or a calm typographic panel on `--surface-hover` with a hairline bottom rule (`--rule`) setting the module or week code in `--display`. In dark mode, picture and slide covers dim slightly (`filter: brightness(0.92)`).
2. In **Avoid**, replace:
   > - Generic card grids with identical rounded boxes and the same shadow.

   with:
   > - Bordered or shadowed cards, or cards for readings, notes or search results. Only modules on the home page and weeks on a module page use cards, always flat on `--surface` with a picture, slide or display-type cover and no drop shadow.
3. In **Writing on screen**, after "One name for each thing everywhere", add (Part G):
   > A week's groups are **Primary readings**, **Secondary readings** and **Summaries**; one item is a **primary reading**, a **secondary reading** or a **summary**. "Readings" alone means primary and secondary readings together, as in "1 of 3 read".

---

## 3. Part 1: The top bar on a laptop (done, 0.33.1)

**Status: built and live.** 0.33.0 went out first and was broken by undefined spacing tokens; 0.33.1 fixed it and is what is live. The rules below are as built. Where the build differs from what this section first proposed, it says so.

### 3.1 Rules and structure, as built

- **Phone untouched (`<= 44rem` / `704px`):** the phone top bar (`Study Library`, `SyncStatus`, the `Go to` icon button and `Jobs`) and the fixed bottom `TabBar` (`Modules`, `This week`, `Search`, `Settings`) stay exactly as they were.
- **Column alignment at every laptop width (`> 44rem`):**
  - The bar lines up with the page using percentages of the bar's own width (`100%`), never `100vw`.
  - `.topbar` sets `--bar-max: 46rem` (matching `.page`), with:
    ```css
    padding-inline: max(1.25rem, calc((100% - var(--bar-max, 46rem)) / 2 + 1.25rem));
    ```
  - On Job search, `<header className="topbar wide">` sets `--bar-max: 72rem`, matching `.page.wide`.
  - Measured in `test_topbar.py`: the brand's first letter and the last icon's drawn glyph sit within 2px of the page's text edges at 768, 1024, 1280 and 1440. Hover surfaces overhang into the margin by their own padding (`margin-left: -0.5rem` on the brand, `margin-right: -0.5rem` on the tools), as week rows' hover surfaces do.
- **One height, one row, no wrapping:**
  - `.topbar` has `height: var(--topbar-h, 3.25rem)` (`52px`), `display: flex`, `align-items: center`, `gap: 0.5rem`, `white-space: nowrap`.
  - Every interactive item has `height: 2rem`, `padding: 0 0.5rem` for word links or `width: 2rem; height: 2rem` for icon buttons, `border-radius: var(--r-sm)`, and `font-size: var(--fs-sm)`.
  - The tablet wrapping rules and the `.wide-only` / `.narrow-only` split inside `.topbar` are gone.
- **SyncStatus:** `min-width: 7.5rem` is gone. **As built:** when idle it takes no space at all but stays in the page as a live region, so a change to `Syncing`, `Offline`, `Saved on this device` or `Sign in again` is still announced. (The plan first said it would render nothing, which would have lost the announcement.)
- **Order, left to right, which is also the DOM order and the Tab order** (no CSS `order`):
  - `Study Library` (weight `600`, `--ink`), `SyncStatus`, a `1px` rule, then `ModuleLinks` (module codes; `.modules-nav` scrolls sideways with `scrollbar-width: none` rather than wrap, `gap: 0.25rem`).
  - Then, pushed right with `margin-left: auto`: `This week`, `Job search`, and the tools (`gap: 0.25rem`): `Go to` (`goto` icon, `aria-label="Go to"`, `title="Go to (Ctrl+K)"`), `Search` (`search` icon, `title="Search (/)"`), `Settings` (`settings` icon, `title="Settings"`).
  - **As built:** `This week` and `Job search` have no `title` tooltip, since it only repeated their visible words. The icon controls keep theirs.
- **One name for each page:** **This week** everywhere. `AcrossPage.tsx` titles the page and the tab `This week` for the current teaching week and `Week AT3` (that week's code) for any other.
- **One way to mark the current page:** every link in `.topbar` sets `aria-current="page"` when active (`Study Library` on home, a module code on its module, week and session pages, `This week`, `Search`, `Settings`, and `Job search` on the job search). **As built:** the brands (`Study Library` and `Job search` on its own bar) keep `aria-current` but draw no pill at any width; hover keeps its soft surface. One rule draws the pill:
  ```css
  .topbar a:not(.brand)[aria-current="page"], .topbar button[aria-current="page"] {
    background: var(--accent-soft); color: var(--accent); font-weight: 500;
  }
  ```
- **Job search bar:** the same structure, height and tokens with `--bar-max: 72rem`, keeping its own content: `Job search` and `SyncStatus` on the left, `Back to Study Library` on the right.

### 3.2 Top bar sketches at 768, 1024, 1280 and 1440 wide (light and dark)

At every width above `704px`, the bar is `52px` tall on a single line, with a `1px` bottom rule (`--rule`) and a translucent paper background (`color-mix(in srgb, var(--paper) 92%, transparent)` with a backdrop blur).

```text
768px (iPad Mini): page column is 728px wide (20px outer padding each side)
+----------------------------------------------------------------------------+
|  Study Library | HY116  HY240  HY300     This week  Job search  [>] [Q] [*] |
+----------------------------------------------------------------------------+
   ^-- left edge = 20px (matches .page)                     right edge = 748px --^

1024px: page column is 736px (46rem), centred with 144px margins
1280px: page column is 736px (46rem), centred with 272px margins
1440px study page: 736px column, 352px margins
1440px Job search: 1152px column (72rem), 144px margins, its own content:
+----------------------------------------------------------------------------------------------------------+
|        Job search                                                               Back to Study Library    |
+----------------------------------------------------------------------------------------------------------+
```

Legend: `[>]` Go to, `[Q]` Search, `[*]` Settings. The pill marks the current page on every link except the brands.

---

## 3A. Part G: Week groups, summaries and progress

Part G comes before Part 2 so that its migration ships on its own, apart from Part 2's.

### 3A.1 Three groups each week, with one name each

Each week (and each dissertation section) has three groups of loose items, in this order:

| Group heading | One item | `items.kind` | Ticked and counted | `@` and Copy reference |
| --- | --- | --- | --- | --- |
| Primary readings | primary reading | `primary` | Yes | Yes |
| Secondary readings | secondary reading | `secondary` | Yes | Yes |
| Summaries | summary | `summary` (new) | No | No |

Slides stay with their session, as now, and are neither ticked nor counted (3A.3).

The order is the one you gave: Primary readings first (decision 3 in section 8). Everything that follows the page's order follows it too: the reader's previous and next, the session page's side list, and which reading is "next".

**Rename everywhere, so each thing has one name.** "Readings" on its own keeps meaning primary and secondary readings together (as in "1 of 3 read", the home page's `Readings` tile and Search's `Readings` heading). Each place, with the old and new words:

| Where | Now | After |
| --- | --- | --- |
| `WeekBoard.tsx` group headings | (none) and `Primary sources` | `Primary readings`, `Secondary readings`, `Summaries` |
| `WeekBoard.tsx` empty-list hint | `Drop here to make it a primary source` / `a reading` | `Drop here to make it a primary reading` / `a secondary reading` / `a summary` |
| `WeekPage.tsx` drop banner and empty target | `Drop to add primary sources to AT3`, `Drop to add readings to AT3`, `Readings for AT3` | `Drop to add primary readings to AT3`, `Drop to add secondary readings to AT3`, `Drop to add summaries to AT3` |
| `ModulePage.tsx` and `AcrossPage.tsx` group headings | (none) and `Primary sources` | the three headings, shown as on the week page |
| `ImportPage.tsx` Type column | `Reading`, `Primary source`, `Slides` | `Secondary reading`, `Primary reading`, `Summary`, `Slides` |
| `ReadingRow.tsx` Edit details, Type | `Reading`, `Primary source`, `Slides` | the same four as the import table |
| `Palette.tsx` (Go to) kind column | `Reading`, `Source`, `Slides` | `Secondary reading`, `Primary reading`, `Summary`, `Slides` |
| `moves.ts` toasts | `Now a reading.`, `Now a primary source.` | `Now a secondary reading.`, `Now a primary reading.`, `Now a summary.` |
| `ReadingRow.tsx` menu, delete | `Delete reading` | `Delete reading` for primary and secondary readings, `Delete summary` for a summary, `Delete slides` for slides |
| Code comments in `WeekBoard.tsx`, `WeekPage.tsx`, `library.ts`, `moves.ts` | "primary sources", "readings" | the new names |
| `DEBRIEF.md` lines 403, 413 and the `items` row of section 12 | "Primary sources", "primary source", "reading" | the new names, plus summaries |
| Browser tests | `test_dragging.py` lines 120 to 136, `test_library.py` line 70 | the new names (3A.6) |

The labels live in one place, `app/src/lib/kinds.ts`, as `KIND_LABEL` (`primary reading`), `KIND_GROUP` (`Primary readings`) and `KIND_ORDER`, so no screen spells them itself. `test_dissertation.py` names a section "Primary sources"; that is a section you named, not a group, so it stays.

**Empty groups.** Recommended (decision 2): they stay hidden, as now, following "Show what exists, hide what doesn't" (section 10 of `DEBRIEF.md`). All three appear as places to drop while a file or a row is being dragged over the week page, outlined, with their headings. Since a phone cannot drag, two other ways in reach every group:
- **Add files** on the week page opens a choice card (`ChoiceCard.tsx`): `As in the file names` (the default, and today's behaviour), `Primary readings`, `Secondary readings`, `Summaries`. The add sheet in `DropAnywhere.tsx` gains the same choice as a third field, `Add as`, so files dropped anywhere else in the app can become summaries too.
- Each row's menu gains `Move to Primary readings`, `Move to Secondary readings` and `Move to Summaries`, hiding the one it is already in. These are offered on every screen and pointer, so the same action exists wherever the row appears (section 20 of `DEBRIEF.md`).

### 3A.2 Summaries

A summary is a file you add to a week, such as a handout.

- **Opens in the reader** like a reading, with highlights and notes, page and text layout, and the place you stopped.
- **No tick box.** `ReadMark` is not drawn. The row menu has no `Mark as read`. The reader's toolbar has no read toggle, and the end card offers `Next` and the way back, never `Mark as read`.
- **Never counted** towards progress (3A.3).
- **Not offered by `@`.** `readingSuggestions` in `NoteEditor.tsx` filters with a new `citable(item)` (primary and secondary only).
- **No Copy reference** in the row menu or the reader's menu (`citable` again), and no `Look up the details again`.
- **No citation found.** The Worker's `/files/:id/identified` already skips slides; it skips summaries too, so a handout never shows `Details found`. Edit details for a summary shows only Type and Title; the import table leaves author, year, source and pages blank for a summary.
- **Its name** comes from the file name, without the extension, as a reading's does when nothing is parsed.
- **Dropping a file on Summaries makes it a summary.** `targetOf` in `WeekPage.tsx` gains `data-drop="summary"`, and `addFiles` sets `kind: "summary"` on every plan that is not skipped.
- **Dragging between the three groups changes the kind,** as dragging between the two does now: `WeekBoard`'s `ListKey` becomes `"primary" | "secondary" | "summary"`, and `placeInWeek` receives the target list's kind. The toast says `Now a summary.` with Undo.
- **Moving to another week or Unsorted** keeps the kind, as for readings.

### 3A.3 Progress

**Rule.** A module's progress counts only the current teaching week's primary and secondary readings, never slides or summaries. It no longer adds up the whole module.

**Slides lose their tick box and `Mark as read`,** in every list (the week page's sessions, the session page and the reader). Their `read_status` stays in the data untouched; it is simply no longer drawn or counted. Nothing is migrated or cleared.

**One function.** `app/src/lib/progress.ts`:

```ts
// Only primary and secondary readings are ever ticked or counted.
export function counts(item: ItemRow): boolean;           // kind is "primary" or "secondary"
export function citable(item: ItemRow): boolean;          // the same kinds; used by @ and Copy reference

// A week's count: its live, loose (not slides) primary and secondary readings.
export function readCount(items: ItemRow[]): { read: number; total: number };

export type ModuleProgress =
  | { state: "week"; week: WeekRow; read: number; total: number }          // a teaching week is running
  | { state: "reading-week"; week: WeekRow; read: number; total: number }  // the running week is a reading week
  | { state: "upcoming"; week: WeekRow; read: number; total: number }      // before a term starts
  | { state: "none" };                                                     // no week to count

export function moduleProgress(weeks: { week: WeekRow; items: ItemRow[] }[], now: TeachingWeek | null): ModuleProgress;
```

`readCount` replaces today's `readCount(views)` in `library.ts` (callers pass `views.map((v) => v.item)`), and `ReadMark` is drawn only where `counts(item)` is true. `moduleProgress` is pure: it takes the module's weeks with their loose items and the result of `teachingWeek()` from `term.ts`, so it is tested without a browser or a clock.

**What it gives, using `teachingWeek()` as it stands:**

| When | `teachingWeek()` gives | `moduleProgress` gives | Shown as (Parts 2 and 3) |
| --- | --- | --- | --- |
| Term, a teaching week | `{ term, number, upcoming: false }` | `week`, with that week's count | `AT4: 1 of 3 read`, or `AT4: 3 readings` when none are read, or `AT4: all 3 read` |
| Term, the module's week is a reading week | the same | `reading-week`, with that week's count (usually 0 of 0) | `AT6: reading week`, with the count after it only if the week has readings |
| Term, but the module has no such week (a dissertation, or a week deleted) | the same | `none` | nothing |
| Up to five weeks before Autumn Term | `{ AT, 1, upcoming: true }` | `upcoming`, counting AT1 | `AT1 starts 28 Sep: 0 of 4 read` |
| Between Autumn and Winter Term (the Christmas vacation) | `{ WT, 1, upcoming: true }` (Winter Term starts 15 weeks after Autumn Term, so its week 1 is always within five weeks) | `upcoming`, counting WT1 | `WT1 starts 11 Jan: 1 of 3 read` |
| After WT11, until five weeks before the next Autumn Term (spring and summer) | `null` | `none` | nothing |
| A week with no primary or secondary readings | any | the state, with `total: 0` | the week and `no readings` |

The count is always of one week only. A reading already read in an earlier week never inflates it, and an unread one from last week does not linger; last week's readings stay one tap away on the module page.

**Until Part 2 ships, in 0.34.0:**
- The home page's module rows show `moduleProgress` instead of the whole-module bar. The `Next:` line takes the first unread primary or secondary reading of the counted week, in page order.
- The home page's `Readings` tile uses `readCount`, so slides and summaries no longer swell it (they do today, since `loadThisWeek` counts every linked item).
- The module page's per-week counter and This week use `readCount`.

**Parts 2 and 3 use the same function** (sections 4 and 5 are updated to say so): the home cards show `moduleProgress`; each week card's footer shows that week's `readCount`; the This week page shows each module's `readCount` beside its heading.

### 3A.4 The migration: a new kind for `items`

`items.kind` has `CHECK (kind IN ('secondary', 'primary', 'slides'))`. SQLite cannot change a `CHECK` in place, so accepting `summary` means rebuilding the table. Alternatives, with the recommendation first:

1. **Rebuild `items` with `summary` in the check (recommended).** One column says what an item is, as it does now, and the database keeps refusing anything else. `0011_dissertations.sql` rebuilt `weeks`, `sessions` and `notes` the same way and went out without trouble. No Dexie version bump is needed (`kind` is not indexed on the device) and no change to the Worker's column list (`kind` is already accepted).
2. **Keep `kind` and add a column** (`ALTER TABLE items ADD COLUMN role TEXT`, with summaries stored as `secondary` plus `role = 'summary'`, or `work_kind = 'summary'`, which has no check). No rebuild. But two columns would describe one thing, every `kind ===` test in the app would need a second condition, and a device still on 0.33.x would show summaries as secondary readings with tick boxes, counted in progress, until it updated. Not recommended.
3. **A separate `summaries` table.** Avoids touching `items`, but the reader, highlights, notes, uploads, moves, Undo and deletion all key on `item_id`, so everything would be built twice. Not recommended.
4. **Editing the check in place** with `PRAGMA writable_schema`. D1 does not allow it. Ruled out.

**What the migration does,** following `0011_dissertations.sql` and the rule in `AGENTS.md`. The file is `app/migrations/0014_item_summaries.sql` (decision 1: Part 2's migration becomes `0015`):

1. **Set aside triggers on other tables that name `items`.** `DROP TRIGGER IF EXISTS files_enqueue; DROP TRIGGER IF EXISTS week_items_priority; DROP TRIGGER IF EXISTS items_priority;` (`files_enqueue` and `week_items_priority` read `items` in their bodies; renaming a table under them fails or leaves them pointing at the wrong one. `items_priority` sits on `items` and is dropped with it, but is dropped explicitly for clarity.)
2. **Create `items_new`** with every current column, in the current order, and the new check:
   - from `0001`: `id TEXT PRIMARY KEY`, `kind TEXT NOT NULL CHECK (kind IN ('secondary', 'primary', 'slides', 'summary'))`, `author`, `title TEXT NOT NULL`, `source`, `pages`, `year INTEGER`, `doc_date`, `file_id`, `original_file_id`, `tray_module_id`, `zotero_key`, `last_page INTEGER`, `read_status TEXT NOT NULL DEFAULT 'unread'`, `modified_at TEXT NOT NULL`, `seq INTEGER NOT NULL DEFAULT 0`, `deleted INTEGER NOT NULL DEFAULT 0`;
   - from `0003`: `last_opened_at`; from `0005`: `suggested`; from `0007`: `last_spot`; from `0013`: `work_kind`, `editor`, `publisher`, `volume`, `issue`, `doi`.
3. **Copy every row,** naming every column: `INSERT INTO items_new (...) SELECT ... FROM items;`. `items_new` has no triggers yet, so `seq` and `modified_at` are kept exactly, devices pull nothing new, and the global counter does not move.
4. **Swap:** `DROP TABLE items; ALTER TABLE items_new RENAME TO items;`
5. **Indexes, as they were:** `items_file (file_id)`, `items_zotero (zotero_key)`, `items_seq (seq)`. No later migration added any other index on `items`.
6. **Triggers on `items`, as they were:** `items_seq_insert`, `items_seq_update` (from `0001`) and `items_priority` (as recreated in `0011`).
7. **Triggers on other tables, put back unchanged:** `files_enqueue` and `week_items_priority`, exactly as in `0011`.
8. **Search: nothing to rebuild.** `page_text` is keyed by `file_id` and `transcript_text` by `recording_id`; neither is filled by a trigger on `items`, and `app/worker/search.ts` does not read `items`. Titles, notes and highlights are searched on the device. Summaries appear in Search with the kind `Summary`.

**How it is tested on a populated local database,** before anything goes near the live one:

- **A backend test, `backend/tests/test_migration_0014.py`,** run by `npm run test:backend`. In its own temporary `--persist-to` folder (never the shared test database), it applies `0001` to `0013` one by one with `wrangler d1 execute DB --local --file`, so it runs on the same local D1 engine as the Worker. It then seeds, in SQL: three modules (one a dissertation), their weeks and sections, about forty items covering every kind and every column (citation fields, `suggested` and `last_spot` JSON, `doi`, `read_status = 'read'` on some slides, tray items, deleted items), week links including slides on sessions, a PDF file still `pending` so a job is queued, notes and highlights on items.
  - Before `0014` it records `SELECT * FROM items ORDER BY id`, the `seq` counter, `SELECT * FROM jobs`, and `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger')`.
  - It applies `0014` and asserts: every item row is identical, `seq` included; the counter is unchanged; the same indexes and triggers exist with the same SQL; the table's SQL now names `summary`; `PRAGMA integrity_check` is `ok`.
  - Then that everything still works: a `summary` item inserts; a `handout` kind is refused; an update takes the next `seq`; changing an item's `file_id` reprioritises its queued job (`items_priority`); a new PDF linked to an AT3 item is queued with priority 3 (`files_enqueue`); a new week link lowers a queued job's priority (`week_items_priority`).
- **The whole suite on a fresh database:** `npm run test:backend` and `npm run e2e` apply every migration from empty, so `0014` also runs there.
- **The live database is not touched** without asking. When you agree, the steps are: a read-only `wrangler d1 export DB --remote` as a backup (D1's Time Travel also keeps 30 days of restore points), then deploy, which applies `0014`.

### 3A.5 Files changed in Part G

- `app/migrations/0014_item_summaries.sql` (3A.4).
- `app/src/lib/types.ts`: `ItemKind` gains `"summary"`.
- `app/src/lib/kinds.ts` (new): labels and order (3A.1).
- `app/src/lib/progress.ts` (new): `counts`, `citable`, `readCount`, `moduleProgress` (3A.3).
- `app/src/lib/library.ts`: `WeekView` gains `summaries`; `loadWeek`, `loadReader`, `loadSession` and `loadQuestion` use the three groups in page order; `loadModules` and `loadThisWeek` count with `moduleProgress` and `readCount`; the old `readCount` goes.
- `app/src/components/WeekBoard.tsx`: three lists and headings, kind change on drop.
- `app/src/components/WeekPage.tsx`: `data-drop="summary"`, drop banner wording, Add files choice card.
- `app/src/components/ReadingRow.tsx`: `ReadMark` only where `counts`; menu: no `Mark as read` for slides and summaries, no `Copy reference` or `Look up the details again` unless `citable`, the three `Move to` items, `Delete summary` and `Delete slides`; Edit details Type with four options and Title only for a summary.
- `app/src/components/Reader.tsx`: no read toggle or `Mark as read` on the end card unless `counts`; no `Copy reference` unless `citable`.
- `app/src/components/NoteEditor.tsx`: `@` uses `citable`.
- `app/src/components/ModulePage.tsx`, `AcrossPage.tsx`, `SessionPage.tsx`, `Home.tsx`, `Palette.tsx`, `ImportPage.tsx`, `DropAnywhere.tsx`: the new names, the three groups, and the new counts.
- `app/src/lib/importing.ts`: `PlanKind` includes `summary`; a summary plan takes its title from the file name.
- `app/src/lib/moves.ts`: toasts and `placeInWeek` with three kinds.
- `app/worker/processor.ts`: `/files/:id/identified` skips summaries.
- `DEBRIEF.md`: sections 4 (Dragging, Files), 10, 12, 14, 16, 17; the design skill's wording (2.2, item 3); `app/package.json` to `0.34.0`.

---

## 4. Part 2: The home page

### 4.1 Audit and home page changes

Removing `This week`, `Recently opened`, `KeyDatesAhead` and the old progress lines from `Home.tsx` is paired with moving essential items to their proper homes:

1. **Moved to `This week` (`AcrossPage.tsx`):**
   - **Every timetabled session, even empty ones:** `AcrossPage` will display all sessions in `week.sessions` (such as `Lecture: No notes yet`), giving a direct link into `SessionPage` to start taking notes.
   - **Reading progress beside each module heading,** from `readCount` in `progress.ts` (Part G): that week's primary and secondary readings only, as `1 of 3 read`, `3 readings` or `all 3 read`.
   - **Pre-term week dates:** before term starts, `AcrossPage` displays `AT1, 28 Sep to 2 Oct` so you know when the term begins.
   - **Dissertation `Coming up` countdown:** the compact strip of upcoming dissertation deadlines sits at the top of `AcrossPage`, and also remains on each dissertation's own module page.
2. **Moved to `Go to` (`Palette.tsx`):**
   - **Recently opened readings and notes:** when the `Go to` (`Ctrl+K`) search box is empty, it lists the five most recently opened readings and session notes at the top for quick resumption.
3. **Dropped:**
   - The redundant duplicate `Recently opened` list at the bottom of the home page.

### 4.2 Home page layout and module cards

- **Page header (`.section-head`):**
  - Left: `<h1>Modules</h1>` (`--display`, `--fs-2xl`, tight tracking).
  - Right: `Arrange` (`.quiet` button, only shown when `modules.length > 1`; switches to `Done` while arranging) and `Add a module` (`.button`, opens the existing creation form).
  - **Drag and drop:** dropping files onto the home page continues to work, opening the dialog asking which module, week and group they belong to (covered in `test_dragging.py`).
- **Card grid (`.module-grid`):**
  - CSS Grid: `display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem` (`16px`) above `36rem` (`576px`), and `1fr` (single column) on phones (`<= 36rem`).
  - Inside the `46rem` (`736px`) column on tablet and laptop, 2 columns give each module card `360px` of width (`356px` at `768px`), generous for titles and a `16:9` cover (`360 x 202px`).
- **Module card anatomy (`.module-card`):**
  - `<Link className="module-card" href={/?v=module&id=...}>` on `--surface` with `border-radius: var(--r-md)` (`10px`), `overflow: hidden`, no border and no drop shadow, lifting to `--surface-hover` on pointer hover.
  - **Top cover (`.module-card-cover`, `aspect-ratio: 16 / 9`):**
    - **With a chosen picture (`module.image_key`):** `<img src={"/api/objects/" + module.image_key} alt="" loading="lazy" decoding="async" />` (`width: 100%; height: 100%; object-fit: cover`). In dark mode, `filter: brightness(0.92)`.
    - **Without a picture (typographic cover):** a calm panel on `--surface-hover` with a `1px` bottom rule (`--rule`), setting `module.code` (`HY319`, `HY300`) at the bottom-left (`padding: 1rem`) in `--display` (`Literata Display`, `font-variation-settings: "opsz" 72`, `font-weight: 560`, `font-size: clamp(1.75rem, 3vw, 2.25rem)`, `color: var(--ink)`, `letter-spacing: -0.02em`).
  - **Card body (`.module-card-body`, `padding: 0.75rem 1rem 1rem`):**
    - `.module-card-code`: `module.code` in `--sans`, `font-size: var(--fs-xs)` (`11.5px`), `font-weight: 600`, `color: var(--muted)`, `letter-spacing: 0.03em`. (For dissertation modules, `Dissertation` sits quietly on the right of this line.)
    - `.module-card-title`: `module.title` in `--serif`, `font-size: var(--fs-md)` (`15px`), `line-height: var(--lh-tight)` (`1.3`), `color: var(--ink)`, clamped to 2 lines (`-webkit-line-clamp: 2`).
    - `.module-card-progress`: `moduleProgress` from `progress.ts` (Part G), in `--fs-xs` and `--muted`: `AT4: 1 of 3 read`, `AT6: reading week`, `AT1 starts 28 Sep: 0 of 4 read`, or nothing between terms and for a dissertation.
- **Arranging (`arranging === true`):**
  - Each card shows move buttons (`Move earlier` and `Move later`) updating `modules.position` via `update("modules", id, { position })`.

### 4.3 Choosing, resizing and removing the module picture (offline-first)

- **Module settings (`app/src/components/ModuleSettings.tsx`):**
  - Add a **Picture** block with a `16:9` preview, `Choose picture` (`<input type="file" accept="image/*">`, offering Files and Photos on mobile) and `Remove picture` (`.quiet` button, shown when `image_key` is set).
  - Removing a picture sets `image_key: null`. The previously uploaded R2 object is kept, as it costs almost nothing (a few dozen kilobytes) and avoids complex garbage-collection on undo.
- **Resizing on the device (`resizeModulePicture` in `app/src/lib/uploads.ts`):**
  - Decodes the chosen file with `createImageBitmap(file)` (honouring phone EXIF orientation), scales it down to at most `960px` wide and `540px` high on an offscreen `<canvas>`, and encodes it as WebP (`image/webp`, quality `0.82`, fallback `image/jpeg`). Typical file size: `25 KB` to `65 KB`.
- **Offline support:**
  1. Hash resized blob: `const sha = await sha256(blob)`, `key = "files/" + sha + ".webp"`.
  2. Put blob straight into Service Worker `study-pictures-v1` cache via `caches.open("study-pictures-v1")`. It displays immediately offline and online.
  3. `update("modules", module.id, { image_key: key })`.
  4. Queue upload in `db.uploads` with `kind: "object"`, uploading to `PUT /api/files/${sha}` when online.

---

## 5. Part 3: The module page

### 5.1 Week and dissertation section cards

- **Cards only, no list view:**
  - The expandable `<section className="weeks">` accordion list is removed. Cards are the single view on `ModulePage.tsx`. Clicking a card navigates to `WeekPage` (`/?v=week&id=...`).
  - The week strip (`.jump`) is also removed from `ModulePage`, since the card grid already displays every week at a glance.
  - The module page opens smoothly scrolled so that `This week`'s card is in view.
  - Moving a reading between weeks now happens on `WeekPage` (via `Move to` in its menu, or dragging onto the grid of weeks on `WeekPage`), rather than on `ModulePage`.
- **Card grid (`.week-grid`):**
  - Laptop and tablet (`> 44rem`): `grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem` (`12px`). Inside the `46rem` column, each card is `237px` wide (`234px` at `768px`), fitting 22 weeks in 8 compact rows.
  - Phone (`<= 44rem`): `grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem` (`12px`) down to `340px`, and `1fr` below `340px`.
- **Thumbnail priority on each week card (`.week-card-cover`):**
  1. **First priority:** First slide of that week's slide decks.
  2. **Second priority:** First picture in its seminar notes (`session.kind === "seminar"`).
  3. **Third priority:** First picture in any other note in the week (lecture notes or section notes).
  4. **Fallback:** Typographic cover in `--display` with week code (`AT1`) or section number.
- **Card body and footer:**
  - Meta line: `week.code` (`AT1`, `WT4`, or `Section 1`) and dates (`28 Sep to 2 Oct`).
  - Title: `week.title` (or *`Reading week`* in italics).
  - Footer: that week's `readCount` from `progress.ts` (Part G), counting its primary and secondary readings only: `1 of 3 read`, `3 readings`, or `all 3 read`. Slides and summaries never count. A week with none says nothing.
  - **Week brief download:** The week brief is the zip file planned separately in the exports plan (readings, previous notes or transcript and brief document), not yet built. The card's bottom-right corner is left clean; the exports plan will add the download button there.
- **Dissertation sections:**
  - Each section card has a `•••` menu with `Rename`, `Move earlier`, `Move later` and `Delete section`.
- **How `This week` stands out:**
  - `box-shadow: inset 0 0 0 2px var(--accent)` frame.
  - `This week` badge pill on the cover.
  - Typographic fallback tints to `--accent-soft` with `--accent` display type.

### 5.2 Staying fast with 22 weeks and prefetching thumbnails

- **Bulk queries in `loadModule(moduleId)`:**
  - Instead of calling `Promise.all(weeks.map(loadWeek))` (150+ queries), `loadModule` runs 6 bulk indexed queries across the module (weeks, week items, items, sessions, slide files, note image blocks).
  - Loading 22 weeks completes in `< 5 ms` on a laptop and `< 12 ms` on a phone.
- **Prefetching thumbnails:**
  - Thumbnails are served cache-first from `study-pictures-v1` by `sw.js`.
  - When the browser is online and `navigator.connection?.saveData !== true`, a background loop prefetches any week thumbnail URLs not yet in the cache so they work offline before the user scrolls to them. When `saveData` is true, prefetching is skipped and images load on demand.

---

## 6. Storage, migration `0015`, processor changes, Cloudflare cost and purge

Part G's migration `0014_item_summaries.sql` is in section 3A.4. Part 2's migration takes the next number, `0015` (decision 1).

### 6.1 What migration `0015` holds (`app/migrations/0015_module_and_slide_images.sql`)

```sql
-- Module cover picture R2 key (files/<sha256>.webp)
ALTER TABLE modules ADD COLUMN image_key TEXT;

-- First-page WebP thumbnail R2 key for PDF/slide files (files/<sha256>.webp)
ALTER TABLE files ADD COLUMN thumb_key TEXT;
```

- Additive migration only: no table rebuilds, no trigger rebuilds.
- Tested on a populated local database first; ask the user before running on any live database.
- Dexie bumped to version `9` with cursor reset to pull `image_key` and `thumb_key` on sync.

### 6.2 Rendering slide thumbnails and backfilling

- **New slide decks:**
  - Inside `extract_text` in `backend/study/processor/jobs.py`, render page 0 at `640px` width as WebP (`quality: 80`), upload to `files/<sha256>.webp` and pass `"thumb_key"` to `/api/processor/files/:id/text`.
- **Backfilling existing slide decks:**
  - Do NOT re-run `extract_text` for existing decks, because re-running `extract_text` re-extracts all text and can queue OCR.
  - Instead, add a dedicated lightweight job (`slide_thumb`) or a flag on `extract_text` (`extract_text_thumbnail_only`) that only renders the first page to WebP, puts the object in R2 and updates `files.thumb_key`, skipping text extraction and OCR entirely.

### 6.3 Cost on Cloudflare's free plan

- **Worker CPU:** `< 1 ms` per request (rendering is done in WSL by Python or in the browser).
- **R2 Storage:** `~4 MB` for an entire degree (0.04% of 10 GB limit).
- **Purge rules in `app/worker/maintenance.ts`:**
  - A removed module picture's stored copy is kept in R2, as it costs almost nothing.
  - When a slide deck's parent `files` row is purged after 90 days, its `thumb_key` object is deleted from R2 alongside its `r2_key`.

---

## 7. The build, in order

Each step deploys on its own, with its own version and a row in section 17 of `DEBRIEF.md`.

| Order | Step | Version | Migration |
| --- | --- | --- | --- |
| 1 | Part 1: the top bar | 0.33.1 (done, live) | none |
| 2 | Stylesheet clean-up, planned separately in `docs/plans/stylesheet.md` (not yet written) | 0.33.3, a patch (0.33.2 is the recording fix) | none |
| 3 | Part G: week groups, summaries and progress | 0.34.0 | `0014_item_summaries.sql` (a rebuild of `items`) |
| 4 | Part 2: the home page and module pictures | 0.35.0 | `0015_module_and_slide_images.sql` (additive) |
| 5 | Part 3: the module page and slide thumbnails | 0.36.0 | none |

### Part 1: The top bar on a laptop (done, 0.33.1)

Built as section 3 describes, with `test_topbar.py` and the unit test for undefined CSS properties. 0.33.0 went out first and is recorded in section 17 as it shipped. The build differs from the first version of this plan in two places: the brands keep `aria-current` but draw no pill, and an idle sync status takes no space while staying a live region.

### Stylesheet clean-up (0.33.3)

Planned separately in `docs/plans/stylesheet.md`, to be written before it is built. It goes first so that Parts G, 2 and 3 add their rules to a tidy `styles.css`. A patch version, since nothing should change on screen.

### Part G: Week groups, summaries and progress (0.34.0)

- **Files changed:** section 3A.5.
- **Migration:** `0014_item_summaries.sql`, tested as section 3A.4 says. Ask before it is applied to the live database.
- **Unit tests (`npm test`, in `app/tests/run.ts`):**
  - `moduleProgress`, one case per row of the table in 3A.3: a teaching week; a reading week with and without readings; a running week the module lacks (a dissertation); five weeks before AT1 (upcoming AT1); the Christmas vacation (upcoming WT1); after WT11 (`none`); a week with no readings.
  - `readCount` leaves out slides (including slides with `read_status = 'read'`), summaries, deleted items and items linked to a session, and counts read and unread primary and secondary readings.
  - `counts` and `citable` are true for `primary` and `secondary` only.
  - `kinds.ts`: every `ItemKind` has a label, a group heading and a place in the order, and no label is used twice.
- **Backend tests (`npm run test:backend`):**
  - `test_migration_0014.py` (3A.4).
  - In `test_sync.py`: a `summary` item pushes and pulls; an unknown kind is refused and listed as a failure.
  - In the identify tests: `/files/:id/identified` leaves a summary's details alone and offers no suggestion.
- **Browser tests:**
  - **New `test_summaries.py`** (added to `app/scripts/e2e.sh` after `dragging`), with Playwright's clock fixed to a date in AT3 so progress is exact:
    - A file dropped on Summaries, and one added through Add files' choice card, each become a summary under the `Summaries` heading; the toast names the group.
    - The summary opens in the reader; it has no tick box on its row; the reader has no read toggle; the end card has `Next` and no `Mark as read`; its menu has no `Mark as read`, `Copy reference` or `Look up the details again`, and says `Delete summary`.
    - Typing `@` in a session's notes does not offer it.
    - The home page's module row reads `AT3: 1 of 2 read` with a summary, a slide deck (ticked in the data beforehand) and an AT2 reading present, proving none of them count.
    - Slides on the week page and session page have no tick box and no `Mark as read`.
    - At 390, the row menu's `Move to Summaries` moves a secondary reading into Summaries, and `Move to Primary readings` moves it on.
    - Screenshots of the week page with all three groups, in light and dark, at 1280 and 390.
  - **`test_dragging.py`:** dragging a row into the empty Primary readings list (lines 120 to 136) now expects `Now a primary reading` and the heading `Primary readings`; a new step drags it on into Summaries (`Now a summary`) and back to Secondary readings. These assertions change because the names change on purpose.
  - **`test_library.py`:** line 70 expects `Primary readings` instead of `Primary sources`, for the same reason.
  - **`test_ux.py`:** the import table's Type column offers the four new names; the home page's `Readings` tile no longer counts slides.
  - **`test_consistency.py`:** a summary's menu is the same on the week page, the module page, This week and the reader.
- **While building:** `npm test`, `npm run test:backend`, and `npm run e2e -- summaries dragging library ux consistency mobile`.
- **End of part:** `npm run test:all`, then the full `npm run e2e` once.
- **Docs:** `DEBRIEF.md` (sections 4, 10, 12, 14, 16, 17), the design skill's wording, `app/package.json` to `0.34.0`.

### Part 2: The home page and module pictures (0.35.0)

- **Files changed:**
  - `app/migrations/0015_module_and_slide_images.sql`, `app/worker/schema.ts`, `app/worker/maintenance.ts`, `app/src/lib/types.ts`, `app/src/lib/db.ts`.
  - `app/src/lib/uploads.ts`: `<canvas>` resize, cache pre-population in `study-pictures-v1`, upload queueing.
  - `app/src/components/ModuleSettings.tsx`: `Picture` picker with preview, `Choose picture` and `Remove picture`.
  - `app/src/components/Home.tsx` and `app/src/styles.css`: module card grid with 16:9 picture or `--display` typographic cover, and each card's progress line from `moduleProgress`; keep `Add a module`, `Arrange` and the home-page drop zone.
  - `app/src/components/AcrossPage.tsx`: add empty sessions, each module's `readCount` beside its heading, pre-term week dates, and the dissertation `Coming up` strip.
  - `app/src/components/Palette.tsx`: show five most recent readings and notes when search is empty.
  - `DEBRIEF.md` and `app/package.json` to `0.35.0`.
- **Tests changed:**
  - Unit tests: `schema.test.ts`, `maintenance.test.ts`; the card's progress words for each `moduleProgress` state.
  - Browser tests: `test_notes_access.py`, `test_usability.py`, `test_ux.py`, `test_dissertation.py`, and the home-page drop in `test_dragging.py`.

### Part 3: The module page and slide thumbnails (0.36.0)

- **Files changed:**
  - `backend/study/processor/jobs.py` and `app/worker/processor.ts`: render slide thumbnails and backfill job without re-extracting text.
  - `app/worker/maintenance.ts`: purge slide thumbnails with deck.
  - `app/src/lib/library.ts`: bulk 6-query `loadModule` for fast 22-week load.
  - `app/src/components/ModulePage.tsx` and `app/src/styles.css`: week card grid (slide thumbnail, then seminar note picture, then any note picture, then typographic cover), each footer from `readCount`, `This week` frame and initial scroll into view, section `•••` menus.
  - `app/src/components/WeekPage.tsx`: reading move targets.
  - Update `DEBRIEF.md` (sections 10, 12, 16, 17), `.agents/skills/study-library-design/SKILL.md`, and `app/package.json` to `0.36.0`.
- **Tests changed:**
  - Backend tests: `extract_text` thumbnail rendering and `purge`.
  - Browser tests: `test_dragging.py`, `test_ux.py`, `test_editing.py`, `test_dissertation.py`, and `audit_layout`.

---

## 8. Decisions

### 8.1 Decisions needed for Part G

Each has my recommendation first.

1. **Migration numbers.**
   - **(Recommended)** Part G's migration is `0014_item_summaries.sql`, and Part 2's becomes `0015_module_and_slide_images.sql`. Migrations apply in file-name order, and Part 2's is not written yet, so nothing has to be renamed in the repository.
   - Keep `0014` for Part 2 and give Part G `0013a`. Not advised: it sorts after `0013` and before `0014` only by accident of naming, and Wrangler would treat it as a new migration on any database that later gains `0014`.
2. **Empty groups.**
   - **(Recommended)** Hidden until something is dragged over the week page, as now; Add files gains the choice card and each row's menu gains `Move to` for the other two groups, so a phone reaches every group without dragging.
   - Always show all three headings, an empty one as a quiet line, `No summaries yet. Drop files here.`, which costs three lines on every sparse week.
3. **The order of the groups.**
   - **(Recommended)** Primary readings, Secondary readings, Summaries, as you listed them. The reader's previous and next and "next to read" follow it.
   - Secondary readings first, as the week page lists them now, then Primary readings, then Summaries.
4. **The migration's shape.**
   - **(Recommended)** Rebuild `items` with `summary` in its check (alternative 1 in 3A.4).
   - Add a column instead (alternative 2), avoiding the rebuild at the cost of two columns for one meaning and old devices counting summaries.
5. **A reading week in the progress line.**
   - **(Recommended)** Say `AT6: reading week`, adding the count only if that week has readings.
   - Show the count as for any week, which reads `AT6: no readings` most of the time.
6. **Before term and in the Christmas vacation.**
   - **(Recommended)** Count the coming week 1 (`AT1 starts 28 Sep: 0 of 4 read`), so the home page shows what to read before term.
   - Show nothing until the week starts.
7. **Applying `0014` to the live database.** Not a choice to make now: I will ask before it is applied, after a read-only export as a backup.

### 8.2 Decisions recorded for Parts 2 and 3

1. **Items removed from the home page:**
   - Moved to `This week` (`AcrossPage`): every timetabled session (even empty ones); each module's `readCount` beside its heading; the week's dates before term starts; and the dissertations' `Coming up` strip at the top (which also stays on each dissertation's own page).
   - `Recently opened`: its five most recent readings and notes show in `Go to` (`Palette.tsx`) when the search box is empty.
2. **List view and week strip on the module page:**
   - Cards only, no list view.
   - The week strip (`.jump`) goes from `ModulePage` too, since the grid shows every week. The page opens scrolled so `This week`'s card is in view.
   - Moving a reading between weeks happens on `WeekPage` (`Move to` in its menu, or dragging onto the grid of weeks there), not on `ModulePage`. This will be noted in `DEBRIEF.md`, and module-page moves updated in `test_dragging.py`.
3. **The week brief download on a week card:**
   - Left empty. The week brief is the zip planned separately in the exports plan, not yet built; the exports plan will add its download in the card's corner.
4. **Note picture fallback on a week card:**
   - First priority is the week's first slide deck; second priority is seminar notes; third priority is any other note in the week; fallback is the typographic card.
5. **Migration `0015` (was `0014`):**
   - Written and tested on a populated local database in Part 2. It will not be run against any live database without explicit confirmation.
6. **Progress on cards:** home cards use `moduleProgress`, week cards and the This week page use `readCount`, both from `progress.ts` (Part G).
