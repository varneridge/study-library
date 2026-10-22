# Plan: Laptop top bar, home module grid, and module week grid

This plan covers three connected changes to Study Library:

1. **The top bar above the phone layout (`> 44rem` / `704px`):** one height, one row at every width from `768px` to `1440px`, lined up with the page's content column using percentages of the bar's own width (not `100vw`, so the scrollbar does not offset it), using the tab bar's icons where a symbol is commonly known and words where a symbol would need explaining, one name for every page, one way to mark the current page everywhere, and the job search top bar built on the same structure and spacing while keeping its own content.
2. **The home page:** a grid of module cards in your chosen order, keeping `Add a module` and `Arrange`, with a picture chosen in module settings (resized on the device and working offline) or a typographic cover in `--display`, replacing `This week`, `Recently opened` and the dissertation countdown on the home page.
3. **The module page:** a grid of week cards (or dissertation section cards) on both laptop and phone, each showing its code, title, dates, reading progress and a 16:9 thumbnail (first slide of that week's slides, seminar note picture, any note picture in the week, or a typographic cover), with `This week` standing out, working offline and staying fast across 22 weeks.

Each part deploys on its own, so each bumps the minor version with a row in section 17 of `DEBRIEF.md`.

---

## 1. What you see now

Screenshots from `npm run e2e -- audit_layout` are in `app/tests/e2e/shots/` and `app/tests/e2e/shots/audit/`.

### 1.1 The laptop and tablet top bar

Relevant screenshots:
- `app/tests/e2e/shots/audit/w768-ipad-mini_light_01-home_fault_67.png` (tablet `768px`, light)
- `app/tests/e2e/shots/audit/w768-ipad-mini_dark_01-home_fault_72.png` (tablet `768px`, dark)
- `app/tests/e2e/shots/audit/w1024-laptop_light_01-home_fault_85.png` (`1024px`, light)
- `app/tests/e2e/shots/audit/w1280-desktop_light_01-home_fault_94.png` (`1280px`, light)
- `app/tests/e2e/shots/audit/w1280-desktop_dark_08-settings_fault_101.png` (`1280px`, dark, Settings open)
- `app/tests/e2e/shots/ux-2-module.png` (`1440px`, module page with module links in the top bar)
- `app/tests/e2e/shots/jobs-1-table.png` (`1440px`, Job search top bar)

What happens today in `app/src/App.tsx` and `app/src/styles.css`:
- **Out of alignment with the page column:** `.topbar` uses `padding: 0.7rem max(1.25rem, calc((100vw - 72rem) / 2 + 1.25rem))`, which lines up with `.page.wide` (`72rem`, used only by `JobsPage`), while every study page uses `.page` (`max-width: 46rem`). At `1024px`, `1280px` and `1440px` (`ux-3-home.png`, `ux-2-module.png`, `w1280-desktop_dark_08-settings_fault_101.png`), `Study Library` on the left and the navigation links on the right float far outside the `46rem` column below them. Furthermore, using `100vw` ignores the Windows scrollbar (about 16px wide), shifting the bar about 8px to the right of the page content.
- **Wrapping at tablet widths (`768px` to `896px`):** `@media (max-width: 56rem)` sets `.topbar { flex-wrap: wrap }` and hides `.wide-only`, while individual links lack `white-space: nowrap`. In `w768-ipad-mini_light_01-home_fault_67.png`, `Study Library`, `Go to` and `Week across modules` each wrap onto two lines inside the bar, making the bar `74px` tall and uneven.
- **Reserved empty gap in `SyncStatus`:** `.sync-status` has `min-width: 7.5rem` even when idle and empty, pushing `ModuleLinks` and `<nav>` rightwards and cramping narrower screens.
- **Words where icons are standard:** the laptop bar spells out `Go to`, `Search` and `Settings` as text links, whereas the phone's top bar and `TabBar` already use crisp `20x20` stroke icons (`goto`, `search`, `settings` in `app/src/components/icons.tsx`).
- **Two names for the same page:** the laptop bar says `Week across modules` (or `Across` below `56rem`), the phone tab bar says `This week`, and `AcrossPage.tsx` switches its `<h1>` between `This week across modules` and `Week across modules`.
- **Three ways to mark the current page:** `.topbar nav a[aria-current="page"]` has a soft accent pill at line 1634 of `styles.css`, but earlier rules at lines 530 and 1036 still apply `border-bottom: 2px solid var(--accent)` and `box-shadow: inset 0 -2px 0 var(--accent)` on `.modules-nav a[aria-current="page"]` (`w1280-desktop_dark_08-settings_fault_101.png` shows both the pill and the bottom line under `Settings`), while `Study Library` and `Job search` sit outside `<nav>` and never set `aria-current`.
- **Inconsistent bar structure for Job search:** when `route.view === "jobs"` (`jobs-1-table.png`), `App.tsx` renders `<header className="topbar jobs-bar">` with different spacing rules, rather than sharing the unified height, alignment and item sizing with the study side.

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

### 2.2 `.agents/skills/study-library-design/SKILL.md`

1. In **Components** (after **Rows and lists**), add:
   > **Cards.** Used only for modules on the home page and weeks (or dissertation sections) on a module page. A card sits flat on `--surface` with `--r-md` (`10px`) corners, no border and no drop shadow, lifting to `--surface-hover` on pointer hover. Each card has a `16:9` top cover clipped to the top corners: a user-chosen module picture, the week's first slide, a note picture, or a calm typographic panel on `--surface-hover` with a hairline bottom rule (`--rule`) setting the module or week code in `--display`. In dark mode, picture and slide covers dim slightly (`filter: brightness(0.92)`).
2. In **Avoid**, replace:
   > - Generic card grids with identical rounded boxes and the same shadow.

   with:
   > - Bordered or shadowed cards, or cards for readings, notes or search results. Only modules on the home page and weeks on a module page use cards, always flat on `--surface` with a picture, slide or display-type cover and no drop shadow.

---

## 3. Part 1: The top bar on a laptop

### 3.1 Rules and structure

- **Phone untouched (`<= 44rem` / `704px`):** the phone top bar (`Study Library`, `SyncStatus` and the `Go to` icon button) and the fixed bottom `TabBar` (`Modules`, `This week`, `Search`, `Settings`) stay exactly as they are.
- **Column alignment at every laptop width (`> 44rem`):**
  - Line up the bar with the page using percentages of the bar's own width (`100%`), never `100vw`. On Windows, the browser scrollbar takes about 16 pixels from the document width but not from `100vw`, which would throw the bar about 8 pixels off the page column.
  - `.topbar` uses `--bar-max: 46rem` (matching `.page`'s `max-width: 46rem`), with padding:
    ```css
    padding-inline: max(var(--s-5), calc((100% - var(--bar-max, 46rem)) / 2 + var(--s-5)));
    ```
  - When `route.view === "jobs"`, `<header className="topbar wide">` sets `--bar-max: 72rem`, so the bar lines up flush with `.page.wide` (`72rem`) on Job search and with `.page` (`46rem`) on every study screen.
- **One height, one row, no wrapping:**
  - `.topbar` has `height: 3.25rem` (`52px`), `display: flex`, `align-items: center`, `gap: var(--s-2)` (`8px`), `flex-wrap: nowrap`, `white-space: nowrap`.
  - Every interactive item inside `.topbar` has `height: 2rem` (`32px`), `padding: 0 var(--s-2)` (`8px`) for word links or `width: 2rem; height: 2rem` for icon buttons, `border-radius: var(--r-sm)` (`6px`), and `font-size: var(--fs-sm)` (`13px`).
  - Tablet wrapping rules (`@media (max-width: 56rem)`) and the `.wide-only` / `.narrow-only` split inside `.topbar` are removed.
  - `SyncStatus` drops `min-width: 7.5rem`. When idle (empty text), it renders nothing and takes `0px`. When active (`Syncing`, `Offline`, `Saved on this device`, or `Sign in again`), it sits immediately to the right of `Study Library` with `font-size: var(--fs-xs)` (`11.5px`) and `color: var(--muted)`.
- **Symbols where commonly known; words where a symbol would need explaining:**
  - **Left side:**
    - `Study Library` (word link to `/`, weight `600`, `--ink`).
    - `SyncStatus` (inline pill when non-empty).
    - `ModuleLinks` (`HY116`, `HY240`, `HY300`, etc.): compact module code links separated from the brand by a `1px` vertical rule (`height: 1rem; background: var(--rule)`). If a user has many modules, `.modules-nav` has `overflow-x: auto; scrollbar-width: none; min-width: 0; flex-shrink: 1` so the bar never wraps.
  - **Right side (`margin-left: auto`, `display: flex`, `align-items: center`, `gap: var(--s-1)`):**
    - **Word links** (where a symbol would need explaining):
      - `This week` (`href="/?v=across"`, tooltip `title="This week"`).
      - `Job search` (`href="/?v=jobs"`, tooltip `title="Job search"`).
    - **Icon controls** (using the same `20x20` stroke icons from `app/src/components/icons.tsx` as the phone tab bar, rendered at `size={18}` inside `2rem x 2rem` buttons/links):
      - **Go to:** `goto` icon (`aria-label="Go to"`, `title="Go to (Ctrl+K)"`, button opening the command palette).
      - **Search:** `search` icon (`aria-label="Search"`, `title="Search (/)"`, link to `/?v=search`).
      - **Settings:** `settings` icon (`aria-label="Settings"`, `title="Settings"`, link to `/?v=settings`).
- **One name for each page everywhere:**
  - The cross-module week view is named **`This week`** everywhere: in the laptop top bar, in the phone tab bar, in `Palette.tsx` (`Go to`), and in `AcrossPage.tsx` (`<h1>This week</h1>` when viewing the current teaching week, or `<h1>Week {code}</h1>` when inspecting another week, with the subtitle naming the term and week dates).
- **One way to mark the current page everywhere:**
  - Every link in `.topbar` sets `aria-current="page"` when active:
    - `Study Library`: active when `route.view === "home"`.
    - Each module code in `ModuleLinks`: active when `route.view === "module" | "week" | "session"` and that module is the current module.
    - `This week`: active when `route.view === "across"`.
    - `Search` icon link: active when `route.view === "search"`.
    - `Settings` icon link: active when `route.view === "settings"`.
  - All legacy bottom-border and inset-shadow active rules in `styles.css` (lines 529-530 and 1036-1037) are removed. A single rule styles every active link in the bar:
    ```css
    .topbar a[aria-current="page"] {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 500;
    }
    ```
- **Job search bar structure and content:**
  - The job search's bar takes the same structure, height (`3.25rem`), tokens and alignment (`--bar-max: 72rem`) as the study bar, but keeps its own content:
    - Left: `Job search` (`weight: 600`, `--ink`) and `SyncStatus`.
    - Right: `Back to Study Library` (`.nav-link`, returning to `/`).
  - It keeps its own content rather than the study side's links because the job search is deliberately set apart.

### 3.2 Top bar sketches at 768, 1024, 1280 and 1440 wide (light and dark)

At every width above `704px`, the bar is `52px` (`3.25rem`) tall on a single line, with a `1px` bottom rule (`--rule`) and translucent paper background (`color-mix(in srgb, var(--paper) 88%, transparent)` with `backdrop-filter: blur(10px)`):

- **Light tokens:** background `rgba(250, 250, 248, 0.88)`, rule `#E6E5E1`, text `#181816`, muted `#65645F`, active pill `#DCE6EC` with `#2E5266` text/icon.
- **Dark tokens:** background `rgba(21, 23, 25, 0.88)`, rule `#282C31`, text `#ECEBE6`, muted `#92969C`, active pill `#1F3340` with `#7AA6BF` text/icon.

```text
768px (iPad Mini, light & dark): page column is 728px wide (20px outer padding each side)
+----------------------------------------------------------------------------+
|  [Study Library] | HY116  HY240  HY300     This week  Job search  [>] [Q] [*] |
+----------------------------------------------------------------------------+
   ^-- left edge = 20px (matches .page)                     right edge = 748px --^

1024px (Laptop, light & dark): page column is 736px (46rem), centred with 144px margins
+----------------------------------------------------------------------------------------+
|              [Study Library] | HY116  HY240  HY300     This week  Job search  [>] [Q] [*]              |
+----------------------------------------------------------------------------------------+
               ^-- left edge = 144px (matches .page)                   right edge = 880px --^

1280px (Desktop, light & dark): page column is 736px (46rem), centred with 272px margins
+----------------------------------------------------------------------------------------------------+
|                    [Study Library] | HY116  HY240  HY300     This week  Job search  [>] [Q] [*]                    |
+----------------------------------------------------------------------------------------------------+
                     ^-- left edge = 272px (matches .page)                   right edge = 1008px --^

1440px (Wide laptop, Study page vs Job search page):
Study page (--bar-max: 46rem / 736px, margins 352px):
+----------------------------------------------------------------------------------------------------------+
|                       [Study Library] | HY116  HY240  HY300     This week  Job search  [>] [Q] [*]                       |
+----------------------------------------------------------------------------------------------------------+

Job search page (--bar-max: 72rem / 1152px, margins 144px, keeping its own content):
+----------------------------------------------------------------------------------------------------------+
|        Job search                                                               Back to Study Library    |
+----------------------------------------------------------------------------------------------------------+
```

Legend for icon controls on the right:
- `[>]` = `goto` icon (`aria-label="Go to"`, `title="Go to (Ctrl+K)"`)
- `[Q]` = `search` icon (`aria-label="Search"`, `title="Search (/)"`)
- `[*]` = `settings` icon (`aria-label="Settings"`, `title="Settings"`)
- `[...]` around a label shows the `--accent-soft` / `--accent` `aria-current="page"` pill.

---

## 4. Part 2: The home page

### 4.1 Audit and home page changes

Removing `This week`, `Recently opened`, `KeyDatesAhead` and the old progress lines from `Home.tsx` is paired with moving essential items to their proper homes:

1. **Moved to `This week` (`AcrossPage.tsx`):**
   - **Every timetabled session, even empty ones:** `AcrossPage` will display all sessions in `week.sessions` (such as `Lecture: No notes yet`), giving a direct link into `SessionPage` to start taking notes.
   - **`1 of 3 read` reading progress:** displayed directly beside each module heading on `AcrossPage`.
   - **Pre-term week dates:** before term starts, `AcrossPage` displays `AT1 · 28 Sep to 2 Oct` so you know when the term begins.
   - **Dissertation `Coming up` countdown:** the compact strip of upcoming dissertation deadlines sits at the top of `AcrossPage`, and also remains on each dissertation's own module page.
2. **Moved to `Go to` (`Palette.tsx`):**
   - **Recently opened readings and notes:** when the `Go to` (`Ctrl+K`) search box is empty, it lists the five most recently opened readings and session notes at the top for quick resumption.
3. **Dropped:**
   - The redundant duplicate `Recently opened` list at the bottom of the home page.

### 4.2 Home page layout and module cards

- **Page header (`.section-head`):**
  - Left: `<h1>Modules</h1>` (`--display`, `--fs-2xl`, tight tracking).
  - Right: `Arrange` (`.quiet` button, only shown when `modules.length > 1`; switches to `Done` while arranging) and `Add a module` (`.button`, opens the existing creation form).
  - **Drag and drop:** dropping files onto the home page continues to work, opening the dialog asking which module and week they belong to (covered in `test_dragging.py`).
- **Card grid (`.module-grid`):**
  - CSS Grid: `display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4)` (`16px`) above `36rem` (`576px`), and `1fr` (single column) on phones (`<= 36rem`).
  - Inside the `46rem` (`736px`) column on tablet and laptop, 2 columns give each module card `360px` of width (`356px` at `768px`), generous for titles and a `16:9` cover (`360 x 202px`).
- **Module card anatomy (`.module-card`):**
  - `<Link className="module-card" href={/?v=module&id=...}>` on `--surface` with `border-radius: var(--r-md)` (`10px`), `overflow: hidden`, no border and no drop shadow, lifting to `--surface-hover` on pointer hover.
  - **Top cover (`.module-card-cover`, `aspect-ratio: 16 / 9`):**
    - **With a chosen picture (`module.image_key`):** `<img src={"/api/objects/" + module.image_key} alt="" loading="lazy" decoding="async" />` (`width: 100%; height: 100%; object-fit: cover`). In dark mode, `filter: brightness(0.92)`.
    - **Without a picture (typographic cover):** a calm panel on `--surface-hover` with a `1px` bottom rule (`--rule`), setting `module.code` (`HY319`, `HY300`) at the bottom-left (`padding: var(--s-4)`) in `--display` (`Literata Display`, `font-variation-settings: "opsz" 72`, `font-weight: 560`, `font-size: clamp(1.75rem, 3vw, 2.25rem)`, `color: var(--ink)`, `letter-spacing: -0.02em`).
  - **Card body (`.module-card-body`, `padding: var(--s-3) var(--s-4) var(--s-4)`):**
    - `.module-card-code`: `module.code` in `--sans`, `font-size: var(--fs-xs)` (`11.5px`), `font-weight: 600`, `color: var(--muted)`, `letter-spacing: 0.03em`. (For dissertation modules, `Dissertation` sits quietly on the right of this line.)
    - `.module-card-title`: `module.title` in `--serif`, `font-size: var(--fs-md)` (`15px`), `line-height: var(--lh-tight)` (`1.3`), `color: var(--ink)`, clamped to 2 lines (`-webkit-line-clamp: 2`).
- **Arranging (`arranging === true`):**
  - Each card shows move buttons (`Move earlier` and `Move later`) updating `modules.position` via `update("modules", id, { position })`.

### 4.3 Choosing, resizing and removing the module picture (offline-first)

- **Module settings (`app/src/components/ModuleSettings.tsx`):**
  - Add a **Picture** block with a `16:9` preview, `Choose picture` (`<input type="file" accept="image/*">`, offering Files and Photos on mobile) and `Remove picture` (`.quiet` button, shown when `image_key` is set).
  - Removing a picture sets `image_key: null`. As noted in `DEBRIEF.md`, the previously uploaded R2 object is kept in R2 storage, as it costs almost nothing (a few dozen kilobytes) and avoids complex garbage-collection on undo.
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
  - Laptop & tablet (`> 44rem`): `grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-3)` (`12px`). Inside the `46rem` column, each card is `237px` wide (`234px` at `768px`), fitting 22 weeks in 8 compact rows.
  - Phone (`<= 44rem`): `grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-3)` (`12px`) down to `340px`, and `1fr` below `340px`.
- **Thumbnail priority on each week card (`.week-card-cover`):**
  1. **First priority:** First slide of that week's slide decks.
  2. **Second priority:** First picture in its seminar notes (`session.kind === "seminar"`).
  3. **Third priority:** First picture in any other note in the week (lecture notes or section notes).
  4. **Fallback:** Typographic cover in `--display` with week code (`AT1`) or section number.
- **Card body & footer:**
  - Meta line: `week.code` (`AT1`, `WT4`, or `Section 1`) and dates (`28 Sep to 2 Oct`).
  - Title: `week.title` (or *`Reading week`* in italics).
  - Footer: reading progress (`1 of 3 read`, `3 readings`, or `All 3 read`).
  - **Week brief download:** The week brief is the zip file planned separately in the exports plan (readings, previous notes/transcript and brief document), not yet built. The card's bottom-right corner is left clean; the exports plan will add the download button there.
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

## 6. Storage, migration `0014`, processor changes, Cloudflare cost and purge

### 6.1 What migration `0014` holds (`app/migrations/0014_module_and_slide_images.sql`)

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

## 7. The build in three parts

Each part deploys on its own and bumps the minor version, with a row in Section 17 of `DEBRIEF.md`.

### Part 1: The top bar on a laptop (version 0.33.0)

- **Files changed:**
  - `app/src/App.tsx`:
    - Align `.topbar` with `--bar-max: 46rem` (or `72rem` when on `jobs`) using `padding-inline: max(var(--s-5), calc((100% - var(--bar-max, 46rem)) / 2 + var(--s-5)))`.
    - Change `Week across modules` / `Across` to `This week`.
    - Use `Icon` (`goto`, `search`, `settings`) for `Go to`, `Search` and `Settings` with `aria-label` and shortcut `title`.
    - Set `aria-current="page"` consistently on `Study Library`, `ModuleLinks`, `This week`, `Search` and `Settings`.
    - Make `SyncStatus` render nothing when empty (no reserved gap).
    - Give Job search the same bar structure and tokens, keeping `Job search` on the left and `Back to Study Library` on the right.
  - `app/src/components/AcrossPage.tsx` and `app/src/components/Palette.tsx`: use `This week` as the single page name.
  - `app/src/styles.css`: unified `.topbar` styling, height `3.25rem`, remove `@media (max-width: 56rem)` wrapping, remove `.sync-status` `min-width: 7.5rem`, remove legacy active line styles.
  - `DEBRIEF.md`: update where it describes the top bar, and add `0.33.0` to Section 17.
  - `app/package.json`: bump version to `0.33.0`.
- **Tests to run during build:**
  - `npm run e2e -- ux jobs back audit_layout`
- **End-of-part verification:**
  - `npm run test:all`
  - Full `npm run e2e` once.
  - Visual check via screenshots at `390`, `768`, `1024`, `1280` and `1440` in light and dark.

### Part 2: The home page and module pictures (version 0.34.0)

- **Files changed:**
  - `app/migrations/0014_module_and_slide_images.sql`, `app/worker/schema.ts`, `app/worker/maintenance.ts`, `app/src/lib/types.ts`, `app/src/lib/db.ts`.
  - `app/src/lib/uploads.ts`: `<canvas>` resize, cache pre-population in `study-pictures-v1`, upload queueing.
  - `app/src/components/ModuleSettings.tsx`: `Picture` picker with preview, `Choose picture` and `Remove picture`.
  - `app/src/components/Home.tsx` and `app/src/styles.css`: module card grid with 16:9 picture or `--display` typographic cover; keep `Add a module`, `Arrange` and home-page drop zone.
  - `app/src/components/AcrossPage.tsx`: add empty sessions, `1 of 3 read` per module, pre-term week dates, and dissertation `Coming up` strip.
  - `app/src/components/Palette.tsx`: show five most recent readings/notes when search is empty.
  - `DEBRIEF.md` and `app/package.json` bump to `0.34.0`.
- **Tests changed:**
  - Unit tests: `schema.test.ts`, `maintenance.test.ts`.
  - Browser tests: `test_notes_access.py`, `test_usability.py`, `test_ux.py`, `test_dissertation.py`, and the home-page drop in `test_dragging.py`.

### Part 3: The module page and slide thumbnails (version 0.35.0)

- **Files changed:**
  - `backend/study/processor/jobs.py` and `app/worker/processor.ts`: render slide thumbnails and backfill job without re-extracting text.
  - `app/worker/maintenance.ts`: purge slide thumbnails with deck.
  - `app/src/lib/library.ts`: bulk 6-query `loadModule` for fast 22-week load.
  - `app/src/components/ModulePage.tsx` and `app/src/styles.css`: week card grid (slide thumbnail -> seminar note picture -> any note picture -> typographic cover), `This week` frame and initial scroll into view, section `•••` menus.
  - `app/src/components/WeekPage.tsx`: reading move targets.
  - Update `DEBRIEF.md` (sections 10, 12, 16, 17), `.agents/skills/study-library-design/SKILL.md`, and `app/package.json` bump to `0.35.0`.
- **Tests changed:**
  - Backend tests: `extract_text` thumbnail rendering and `purge`.
  - Browser tests: `test_dragging.py`, `test_ux.py`, `test_editing.py`, `test_dissertation.py`, and `audit_layout`.

---

## 8. Decisions recorded

1. **Items removed from the home page:**
   - Moved to `This week` (`AcrossPage`): every timetabled session (even empty ones); "1 of 3 read" beside each module heading; the week's dates before term starts; and the dissertations' `Coming up` strip at the top (which also stays on each dissertation's own page).
   - `Recently opened`: its five most recent readings and notes show in `Go to` (`Palette.tsx`) when the search box is empty.
2. **List view and week strip on the module page:**
   - Cards only, no list view.
   - The week strip (`.jump`) goes from `ModulePage` too, since the grid shows every week. The page opens scrolled so `This week`'s card is in view.
   - Moving a reading between weeks happens on `WeekPage` (`Move to` in its menu, or dragging onto the grid of weeks there), not on `ModulePage`. This will be noted in `DEBRIEF.md`, and module-page moves updated in `test_dragging.py`.
3. **The week brief download on a week card:**
   - Left empty. The week brief is the zip planned separately in the exports plan, not yet built; the exports plan will add its download in the card's corner.
4. **Note picture fallback on a week card:**
   - First priority is the week's first slide deck; second priority is seminar notes; third priority is any other note in the week; fallback is the typographic card.
5. **Migration `0014`:**
   - Migration `0014_module_and_slide_images.sql` will be written and tested on a populated local database in Part 2. It will not be run against any live database without explicit confirmation.
