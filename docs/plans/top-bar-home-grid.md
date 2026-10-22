# Plan: Laptop top bar, home module grid, and module week grid

This plan covers three connected changes to Study Library:

1. **The top bar above the phone layout (`> 44rem` / `704px`):** one height, one row at every width from `768px` to `1440px`, lined up with the page's content column, using the tab bar's icons where a symbol is commonly known and words where a symbol would need explaining, one name for every page, one way to mark the current page everywhere, and the job search top bar built on the same structure.
2. **The home page:** a grid of module cards in your chosen order, keeping `Add a module` and `Arrange`, with a picture chosen in module settings (resized on the device and working offline) or a typographic cover in `--display`, replacing `This week`, `Recently opened` and the dissertation countdown on the home page.
3. **The module page:** a grid of week cards (or dissertation section cards) on both laptop and phone, each showing its code, title, dates, reading progress and a 16:9 thumbnail (first slide of that week's slides, first picture in its seminar notes, or a typographic cover), with `This week` standing out, working offline and staying fast across 22 weeks.

No code or database schema has been changed yet.

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
- **Out of alignment with the page column:** `.topbar` uses `padding: 0.7rem max(1.25rem, calc((100vw - 72rem) / 2 + 1.25rem))`, which lines up with `.page.wide` (`72rem`, used only by `JobsPage`), while every study page uses `.page` (`max-width: 46rem`). At `1024px`, `1280px` and `1440px` (`ux-3-home.png`, `ux-2-module.png`, `w1280-desktop_dark_08-settings_fault_101.png`), `Study Library` on the left and the navigation links on the right float far outside the `46rem` column below them.
- **Wrapping at tablet widths (`768px` to `896px`):** `@media (max-width: 56rem)` sets `.topbar { flex-wrap: wrap }` and hides `.wide-only`, while individual links lack `white-space: nowrap`. In `w768-ipad-mini_light_01-home_fault_67.png`, `Study Library`, `Go to` and `Week across modules` each wrap onto two lines inside the bar, making the bar `74px` tall and uneven.
- **Reserved empty gap in `SyncStatus`:** `.sync-status` has `min-width: 7.5rem` even when idle and empty, pushing `ModuleLinks` and `<nav>` rightwards and cramping narrower screens.
- **Words where icons are standard:** the laptop bar spells out `Go to`, `Search` and `Settings` as text links, whereas the phone's top bar and `TabBar` already use crisp `20x20` stroke icons (`goto`, `search`, `settings` in `app/src/components/icons.tsx`).
- **Two names for the same page:** the laptop bar says `Week across modules` (or `Across` below `56rem`), the phone tab bar says `This week`, and `AcrossPage.tsx` switches its `<h1>` between `This week across modules` and `Week across modules`.
- **Three ways to mark the current page:** `.topbar nav a[aria-current="page"]` has a soft accent pill at line 1634 of `styles.css`, but earlier rules at lines 530 and 1036 still apply `border-bottom: 2px solid var(--accent)` and `box-shadow: inset 0 -2px 0 var(--accent)` on `.modules-nav a[aria-current="page"]` (`w1280-desktop_dark_08-settings_fault_101.png` shows both the pill and the bottom line under `Settings`), while `Study Library` and `Job search` sit outside `<nav>` and never set `aria-current`.
- **Separate structure for Job search:** when `route.view === "jobs"` (`jobs-1-table.png`), `App.tsx` renders a separate `<header className="topbar jobs-bar">` where `Job search` replaces `Study Library` on the left and `<nav>` holds only `Back to Study Library`.

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
| Cards for modules and weeks; typographic lists for readings | Modules and weeks have a fixed shape and a visual cover (a chosen picture, a first slide, a seminar note picture, or a display-set code), so a grid lets you take in a whole degree or a 22-week module at a glance. Readings, notes and search hits vary in length and detail, so inside a week they stay flat typographic rows. |

### 2.2 `.agents/skills/study-library-design/SKILL.md`

1. In **Components** (after **Rows and lists**), add:
   > **Cards.** Used only for modules on the home page and weeks (or dissertation sections) on a module page. A card sits flat on `--surface` with `--r-md` (`10px`) corners, no border and no drop shadow, lifting to `--surface-hover` on pointer hover. Each card has a `16:9` top cover clipped to the top corners: a user-chosen module picture, the week's first slide, the first picture in its seminar notes, or a calm typographic panel on `--surface-hover` with a hairline bottom rule (`--rule`) setting the module or week code in `--display`. In dark mode, picture and slide covers dim slightly (`filter: brightness(0.92)`).
2. In **Avoid**, replace:
   > - Generic card grids with identical rounded boxes and the same shadow.

   with:
   > - Bordered or shadowed cards, or cards for readings, notes or search results. Only modules on the home page and weeks on a module page use cards, always flat on `--surface` with a picture, slide or display-type cover and no drop shadow.

---

## 3. Part 1: The top bar on a laptop

### 3.1 Rules and structure

- **Phone untouched (`<= 44rem` / `704px`):** the phone top bar (`Study Library`, `SyncStatus` and the `Go to` icon button) and the fixed bottom `TabBar` (`Modules`, `This week`, `Search`, `Settings`) stay exactly as they are.
- **Column alignment at every laptop width (`> 44rem`):**
  - `.topbar` uses a CSS custom property `--bar-max: 46rem` (matching `.page`'s `max-width: 46rem`, with `padding-inline: max(var(--s-5), calc((100vw - var(--bar-max)) / 2 + var(--s-5)))`).
  - When `route.view === "jobs"`, `<header className="topbar wide">` sets `--bar-max: 72rem` so the bar lines up with `.page.wide` (`72rem`) on Job search and with `.page` (`46rem`) on every study screen.
  - Because the inner left edge of the bar and the inner left edge of `.page` share the exact same formula, `Study Library` on the left and the last icon button on the right sit flush with the content column at `768px`, `1024px`, `1280px` and `1440px`.
- **One height, one row, no wrapping:**
  - `.topbar` has `height: 3.25rem` (`52px`), `display: flex`, `align-items: center`, `gap: var(--s-2)` (`8px`), `flex-wrap: nowrap`, `white-space: nowrap`.
  - Every interactive item inside `.topbar` (the brand link, module links, word links, and icon buttons) has `height: 2rem` (`32px`), `padding: 0 var(--s-2)` (`8px`) for word links or `width: 2rem; height: 2rem` for icon buttons, `border-radius: var(--r-sm)` (`6px`), and `font-size: var(--fs-sm)` (`13px`).
  - The tablet `@media (max-width: 56rem)` wrapping rules and `.wide-only` / `.narrow-only` split inside `.topbar` are removed.
  - `SyncStatus` drops `min-width: 7.5rem`. When idle (empty text), it renders nothing and takes `0px`. When active (`Syncing`, `Offline`, `Saved on this device`, or `Sign in again`), it sits immediately to the right of `Study Library` with `font-size: var(--fs-xs)` (`11.5px`) and `color: var(--muted)`.
- **Symbols where commonly known; words where a symbol would need explaining:**
  - **Left side:**
    - `Study Library` (word link to `/`, weight `600`, `--ink`).
    - `SyncStatus` (inline pill when non-empty).
    - `ModuleLinks` (`HY116`, `HY240`, `HY300`, etc.): compact module code links separated from the brand by a `1px` vertical rule (`height: 1rem; background: var(--rule)`). If a user ever has many modules at `768px`, `.modules-nav` has `overflow-x: auto; scrollbar-width: none; min-width: 0; flex-shrink: 1` so the bar still never wraps onto a second line.
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
    - `Job search`: active when `route.view === "jobs"`.
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
- **Job search bar on the same structure:**
  - `App.tsx` no longer swaps in a different `<header className="topbar jobs-bar">` with `Back to Study Library`. Instead, `JobsPage` uses the exact same `<header className="topbar wide">`: `Study Library` on the left returns to your modules in one click, `SyncStatus` sits beside it, and on the right sit `This week`, `Job search` (highlighted with `aria-current="page"`), `Go to`, `Search` and `Settings`.

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

Job search page (--bar-max: 72rem / 1152px, margins 144px, "Job search" has aria-current="page"):
+----------------------------------------------------------------------------------------------------------+
|        Study Library  |  HY116  HY240  HY300                       This week  [Job search]  [>] [Q] [*]        |
+----------------------------------------------------------------------------------------------------------+
```

Legend for icon controls on the right:
- `[>]` = `goto` icon (`aria-label="Go to"`, `title="Go to (Ctrl+K)"`)
- `[Q]` = `search` icon (`aria-label="Search"`, `title="Search (/)"`)
- `[*]` = `settings` icon (`aria-label="Settings"`, `title="Settings"`)
- `[...]` around a label shows the `--accent-soft` / `--accent` `aria-current="page"` pill.

---

## 4. Part 2: The home page

### 4.1 Audit: what `This week`, `Recently opened`, `KeyDatesAhead` and the old module rows did that `AcrossPage` (`This week`) does not

Removing `This week`, `Recently opened`, `KeyDatesAhead` and the progress/next-reading lines from `Home.tsx` drops six pieces of information from the home page. Here is every item that `AcrossPage.tsx` does not currently show, so you can decide which (if any) to bring onto `AcrossPage`:

| What was on the home page | Where it came from | Does `AcrossPage` (`This week`) do this now? | Recommendation |
| --- | --- | --- | --- |
| **1. Empty sessions for this week** (e.g. `Lecture: No notes yet`, tapping straight into `SessionPage` to start writing lecture notes) | `ThisWeek` in `Home.tsx` listed every session in `week.sessions` even when it had 0 notes, 0 slides and 0 recordings. | **No.** `AcrossPage.tsx` line 49 filters out empty sessions (`s.notes.length \|\| s.slides.length \|\| s.recordings.length \|\| s.questions.length`), so a lecture or seminar with no notes yet is invisible on `AcrossPage`. | **Move to `AcrossPage`.** Show all timetabled sessions for each module's current week on `AcrossPage` so you can open a lecture or seminar in one tap to start taking notes. |
| **2. Next unread reading & week reading counter** (`1 of 3 read` / `All 3 read` and `Next: Short Title`) | `ReadingsTile` in `Home.tsx` and `loadModules()` in `library.ts`. | **Partly.** `AcrossPage` renders the full `ReadingRow` list for each module's current week (so you can see and open every reading directly), plus a `X of Y readings done` summary in the page subtitle, but does not highlight a single `Next:` reading or show a per-module `1 of 3 read` badge in the module heading. | **Show `1 of 3 read` beside each module heading on `AcrossPage`**; no separate `Next:` link is needed there because the actual reading rows sit immediately below the heading. |
| **3. Session word counts and question counts** (`420 words`, `3 questions`, `recorded`) | `SessionTile` in `Home.tsx`. | **Partly.** `AcrossPage` shows note links, slide counts, recording counts and unanswered seminar questions inline, which is richer than the tile summary, though it does not print the word count of a note. | **Keep `AcrossPage` as is** (no word count needed on `AcrossPage`). |
| **4. Pre-term start date notice** (`Coming up: AT1`, `Starts 28 Sep`) | `loadThisWeek()` sets `upcoming: true` when today is before `AT1`'s Monday. | **No.** Before term starts, `AcrossPage` falls back to `AT1` without saying when `AT1` starts. | **Move to `AcrossPage`.** Show the week's dates (`28 Sep to 2 Oct`) in `AcrossPage`'s subtitle or module header. |
| **5. Dissertation key-date countdown** (`KeyDatesAhead`: next 4 upcoming deadlines across dissertations, e.g. `Proposal due · In 12 days · 15 Nov`) | `KeyDatesAhead` in `Home.tsx`. (Each dissertation's own `ModulePage` also shows its full `KeyDates` table.) | **No.** `AcrossPage` only iterates taught modules with dated weeks (`if (mod.kind === "dissertation") continue`). | **Decision 1 below:** either move the compact `Coming up` dissertation deadline strip to the top of `AcrossPage`, or keep key dates only on the dissertation's own module page. |
| **6. Recently opened readings and session notes** (up to 8 recent readings with `p. 4 of 22` and session notes) | `loadRecent(6)` and `loadRecentSessions(4)` in `Home.tsx`. | **No** (though `Go to` / `Ctrl+K` searches all modules, weeks, readings and notes). | **Drop without moving**, or show the 5 most recently opened readings/notes at the top of `Go to` (`Palette.tsx`) when the search box is empty. |

### 4.2 Home page layout and module cards

- **Page header (`.section-head`):**
  - Left: `<h1>Modules</h1>` (`--display`, `--fs-2xl`, tight tracking).
  - Right: `Arrange` (`.quiet` button, only shown when `modules.length > 1`; switches to `Done` while arranging) and `Add a module` (`.button`, opens the existing creation form).
- **Card grid (`.module-grid`):**
  - CSS Grid: `display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4)` (`16px`) above `36rem` (`576px`), and `1fr` (single column) on phones (`<= 36rem`).
  - Within the `46rem` (`736px`) column on tablet and laptop, 2 columns give each module card `360px` of width (`356px` at `768px`), which is generous for module titles of 40 to 70 characters and a `16:9` cover (`360 x 202px`).
- **Module card anatomy (`.module-card`):**
  - Entire card is a `<Link className="module-card" href={/?v=module&id=...}>` on `--surface` with `border-radius: var(--r-md)` (`10px`), `overflow: hidden`, no border and no drop shadow, lifting to `--surface-hover` on pointer hover.
  - **Top cover (`.module-card-cover`, `aspect-ratio: 16 / 9`):**
    - **With a chosen picture (`module.image_key`):** `<img src={"/api/objects/" + module.image_key} alt="" loading="lazy" decoding="async" />` (`width: 100%; height: 100%; object-fit: cover`). In dark mode, `filter: brightness(0.92)`.
    - **Without a picture (typographic cover):** a calm panel on `--surface-hover` with a `1px` bottom rule (`--rule`), setting `module.code` (`HY319`, `HY300`) at the bottom-left (`padding: var(--s-4)`) in `--display` (`Literata Display`, `font-variation-settings: "opsz" 72`, `font-weight: 560`, `font-size: clamp(1.75rem, 3vw, 2.25rem)`, `color: var(--ink)`, `letter-spacing: -0.02em`).
  - **Card body (`.module-card-body`, `padding: var(--s-3) var(--s-4) var(--s-4)`):**
    - `.module-card-code`: `module.code` in `--sans`, `font-size: var(--fs-xs)` (`11.5px`), `font-weight: 600`, `color: var(--muted)`, `letter-spacing: 0.03em`. (Shown on every card so cards with pictures and cards without pictures have the exact same text block at the foot; for dissertation modules, `Dissertation` sits quietly on the right of this meta line.)
    - `.module-card-title`: `module.title` in `--serif`, `font-size: var(--fs-md)` (`15px`), `line-height: var(--lh-tight)` (`1.3`), `color: var(--ink)`, clamped to 2 lines (`-webkit-line-clamp: 2`).
- **Arranging (`arranging === true`):**
  - Each card shows an overlay bar in its top-right corner with `Move earlier` (up/left arrow icon) and `Move later` (down/right arrow icon) buttons (`44x44px` on touch, `32x32px` on pointer), updating `modules.position` via `update("modules", id, { position })` just as `move()` in `Home.tsx` does today.

### 4.3 Choosing, resizing and removing the module picture (offline-first)

- **Where you choose it (`app/src/components/ModuleSettings.tsx`):**
  - Inside `ModuleSettings` (which opens from the `Settings` button on `ModulePage`), add a **Picture** block above the danger zone:
    - Shows a small `16:9` preview (`9rem` wide) of the current picture or the typographic cover.
    - `Choose picture` button triggering `<input type="file" accept="image/*" hidden />` (on a phone, iOS and Android offer both the photo library and Files; on a laptop, it opens the file picker).
    - `Remove picture` (`.quiet` button, shown whenever `module.image_key` is set), which calls `update("modules", module.id, { image_key: null })`.
- **Resizing on the device (`resizeModulePicture(file)` in `app/src/lib/uploads.ts`):**
  - Decodes the chosen image on the device with `createImageBitmap(file)` (which honours phone EXIF orientation automatically, matching `app/src/lib/photos.ts`), draws it onto an offscreen `<canvas>` scaled down so its width is at most `960px` and height at most `540px` (preserving aspect ratio, or cropping/fitting cleanly), and encodes it as WebP (`canvas.toBlob(..., "image/webp", 0.82)`, falling back to `"image/jpeg"` if a browser ever lacks WebP encode).
  - A `960px` WebP is typically `25 KB` to `65 KB`.
- **Working offline when choosing and viewing (`saveModulePicture(file)` in `app/src/lib/uploads.ts`):**
  1. Hash the resized blob on the device: `const sha = await sha256(blob)` and `const key = "files/" + sha + ".webp"`. Because the R2 key is derived from the SHA-256 content hash, the URL `/api/objects/${key}` is known immediately before any network call.
  2. Write the blob straight into the Service Worker's `study-pictures-v1` Cache Storage (`caches.open("study-pictures-v1")` -> `cache.put("/api/objects/" + key, new Response(blob, { headers: { "content-type": blob.type } }))`). Because `app/public/sw.js` line 55 already serves `/^\/api\/objects\/files\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/` cache-first from `study-pictures-v1`, the picture appears on `ModulePage` and `Home` immediately, even in flight mode.
  3. Update the module locally and queue the sync change: `await update("modules", module.id, { image_key: key })`.
  4. Queue the binary upload in `db.uploads` (extending `PendingUpload` in `uploads.ts` so a row with `kind: "object"` uploads to `PUT /api/files/${sha}` when online and then deletes the `db.uploads` entry without needing an `items` row). If online, `pump()` uploads it right away; if offline, `pump()` uploads it automatically when connectivity returns.
  5. On your other device, when `modules.image_key` arrives via `/api/sync`, the `<img src="/api/objects/files/<sha>.webp">` request is intercepted by `sw.js` and cached in `study-pictures-v1` on first view, so it works offline there too.

### 4.4 Home page sketches across widths

```text
Phone 390px (1 column, bottom tab bar stays):
+---------------------------------------+
| Study Library                     [>] |
+---------------------------------------+
| Modules         Arrange  Add a module |
|                                       |
| +-----------------------------------+ |
| |                                   | |
| |   [Chosen picture 16:9]           | |
| |                                   | |
| +-----------------------------------+ |
| | HY116                             | |
| | International Politics since 1914 | |
| +-----------------------------------+ |
|                                       |
| +-----------------------------------+ |
| |                                   | |
| |   HY300  (set in Literata Display)| |
| +-----------------------------------+ |
| | HY300 · Dissertation              | |
| | British Mandates in the Middle... | |
| +-----------------------------------+ |
+---------------------------------------+
|  Modules   This week  Search Settings |
+---------------------------------------+

Tablet 768px & Laptop 1024px / 1280px / 1440px (2 columns inside the 46rem / 736px page column):
+------------------------------------------------------------------------------+
| [Study Library] | HY116  HY240  HY300       This week  Job search  [>] [Q] [*]|
+------------------------------------------------------------------------------+
|                                                                              |
| Modules                                            Arrange   [Add a module]  |
|                                                                              |
| +-----------------------------------+  +-----------------------------------+ |
| |                                   |  |                                   | |
| |     [Chosen picture 16:9]         |  |   HY240  (in Literata Display)    | |
| |                                   |  |                                   | |
| +-----------------------------------+  +-----------------------------------+ |
| | HY116                             |  | HY240                             | |
| | International Politics since 1914 |  | From Empire to Independence       | |
| +-----------------------------------+  +-----------------------------------+ |
|                                                                              |
| +-----------------------------------+                                        |
| |                                   |                                        |
| |   HY300  (in Literata Display)    |                                        |
| |                                   |                                        |
| +-----------------------------------+                                        |
| | HY300 · Dissertation              |                                        |
| | British Mandates in the Middle... |                                        |
| +-----------------------------------+                                        |
+------------------------------------------------------------------------------+
```

---

## 5. Part 3: The module page

### 5.1 Week and dissertation section cards

- **Card grid (`.week-grid`):**
  - Replaces the expandable `<section className="weeks">` accordion list on `ModulePage.tsx`.
  - CSS Grid:
    - Laptop & tablet (`> 44rem` / `704px`): `grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-3)` (`12px`). Inside the `46rem` (`736px`) column, each card is `237px` wide (`234px` at `768px`), fitting 22 weeks in just 8 compact rows.
    - Phone (`<= 44rem`): `grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-3)` (`12px`) down to `340px` wide (`169px` per card at `390px`), and `1fr` below `340px`. Two columns on a phone let you scan 22 weeks in 11 short rows without endless scrolling.
- **What each card shows (`.week-card`):**
  - **16:9 top thumbnail (`.week-card-cover`):**
    1. **First priority (week's slides):** the first page thumbnail (`/api/objects/${slideThumbKey}`) of the first slide deck in that week (ordered by session position, then item position).
    2. **Second priority (seminar note picture):** the first image block (`block.type === "image"` with `block.props?.url`) inside that week's seminar notes (or, if a module has no seminar or the picture is in a lecture/section note, the first note image in that week; see Decision 4). Because note images are already stored at `/api/objects/files/<sha256>.<ext>` and cached in `study-pictures-v1`, no extra file or conversion is needed.
    3. **Fallback (typographic cover):** a calm panel on `--surface-hover` with a `1px` bottom rule (`--rule`), setting the week code (`AT1`, `WT6`, or `S1` / section number for a dissertation) in `--display` (`Literata Display`, weight `560`, `--fs-xl`). For reading weeks (`week.is_reading_week === 1`), the cover uses `--paper` with a dashed `--rule` bottom line and muted text so reading weeks look visibly lighter.
  - **Card body (`.week-card-body`):**
    - **Top meta line (`.week-card-meta`):**
      - Left: `week.code` (`AT1`, `WT4`) in `--sans`, `font-weight: 600`, `font-size: var(--fs-xs)`, `color: var(--muted)` (for dissertation sections, `Section 1`, `Section 2`, etc.).
      - Right: `weekDatesText(module, week)` (`28 Sep to 2 Oct`) in `font-size: var(--fs-xs)`, `color: var(--subtle)` for taught weeks.
    - **Title (`.week-card-title`):** `week.title` in `--serif`, `font-size: var(--fs-md)` (`15px`), `line-height: var(--lh-tight)`, `color: var(--ink)`, clamped to 2 lines (or *`Reading week`* in italics when `is_reading_week` and untitled, or *`Untitled week`* in `--muted` when blank).
    - **Footer line (`.week-card-foot`):**
      - Left: reading progress in `font-size: var(--fs-xs)`, `color: var(--muted)`:
        - `0` readings: empty (`Reading week` if reading week)
        - `readCount === 0`: `{total} readings` (or `1 reading`)
        - `0 < readCount < total`: `{readCount} of {total} read`
        - `readCount === total`: `All {total} read` (in `color: var(--accent); font-weight: 500`)
      - Right: optional week brief / slides download button or section `•••` menu (see 5.4 and 5.5 below).
- **How `This week` stands out:**
  - When `isThisWeek(week, now)` is true, `.week-card.is-this-week` gets:
    - `box-shadow: inset 0 0 0 2px var(--accent)` (a crisp `2px` accent frame that does not shift layout).
    - A `This week` pill (`background: var(--accent-soft); color: var(--accent); font-weight: 600; font-size: var(--fs-xs); border-radius: var(--r-sm); padding: 0.1rem 0.45rem`) at the top-left of the card cover (or in the meta line).
    - If the card uses the typographic cover, the cover background tints to `--accent-soft` with `--accent` display type.

### 5.2 Does a list view stay?

- **Recommendation: No separate list/grid toggle.**
- Why: the design skill specifies *Restraint: few controls on screen, each one obvious* and *The same thing always looks and behaves the same*. Having a view-mode toggle adds another control and state to maintain, whereas the 3-column grid on laptop (2-column on phone) already shows every week's code, title, dates and reading count clearly, and clicking any week card opens `WeekPage` (`/?v=week&id=...`) where all readings, seminar questions, slides and notes live in full typographic lists.

### 5.3 How the week strip (`.jump`) and dragging work in a grid

- **The week strip (`.jump`):**
  - Stays above the grid for taught modules, without the old `Open every week` / `Close every week` toggle button (since cards open `WeekPage` rather than expanding inline).
  - Each cell (`AT1` to `WT11`) still marks `.read` (all readings read), `.current` (`This week`), `.reading` (reading week) and `.empty`.
  - Clicking a cell in `.jump` smoothly scrolls the grid to `#week-AT4` (`document.getElementById("week-" + w.code)?.scrollIntoView({ behavior: "smooth", block: "center" })`) and briefly pulses its focus ring, or on double-click opens `WeekPage` directly.
- **Dragging in a grid:**
  - **Dragging unsorted readings from `Unsorted` (`TraySection`):** `DndContext` in `ModulePage.tsx` wraps `TraySection` and `.week-grid`. Every `.week-card` registers `useDroppable({ id: "week:" + week.id })`. Dragging an unsorted item over any card in the grid highlights that card with `.week-card.drag-over` (`box-shadow: inset 0 0 0 2px var(--accent); background: var(--accent-soft)`) and dropping moves the reading into that week.
  - **Dragging files from your laptop desktop onto a week card:** every `.week-card` keeps `onDragOver`, `onDragLeave` and `onDrop`, calling `addFilesTo(module, week, e.dataTransfer.files)` so you can drop a PDF, Word file or slide deck straight onto `AT5`'s card in the grid to file it into `AT5`.
  - **Reordering dissertation sections:** in a dissertation module, each section card has a `•••` button in its footer (`e.stopPropagation()`), opening a menu on laptop or action sheet on phone with `Rename section`, `Move earlier` (up), `Move later` (down) and `Delete section`. No finger dragging is used on a phone.

### 5.4 Where the week brief's download sits on a card

- When a week has a downloadable brief or handout (or its first slide deck / primary week document; see Decision 3 to confirm which item you want this button to download), a quiet `28x28px` (`44x44px` hit target on touch) download icon button (`Icon name="download"`, `aria-label="Download week brief"`, `title="Download week brief"`) sits at the bottom-right corner of `.week-card-foot`, opposite the `1 of 3 read` count.
- Clicking it calls `e.preventDefault(); e.stopPropagation(); downloadFile(fileId, filename)` so it downloads the file immediately without navigating into `WeekPage`. Weeks without that file show nothing in that corner.

### 5.5 Staying fast with 22 weeks and working offline

- **Lightening `loadModule(moduleId)` in `app/src/lib/library.ts`:**
  - Today, `loadModule` calls `Promise.all(weeks.map(loadWeek))`, issuing ~7 IndexedDB queries per week (`22 x 7 = ~154` queries) plus per-question highlight queries and per-reading Cache Storage lookups.
  - Because `ModulePage` now renders week cards instead of inline `WeekBlock`s, `loadModule` only needs 6 bulk IndexedDB queries across the entire module:
    1. `db.weeks.where("module_id").equals(moduleId)` (22 rows)
    2. `db.week_items.where("week_id").anyOf(weekIds)`
    3. `db.items.where("id").anyOf(itemIds)` (gives `read_status`, `kind`, `file_id`, `source_file_id` for every reading and slide deck in the module)
    4. `db.sessions.where("week_id").anyOf(weekIds)`
    5. `db.files.where("id").anyOf(slideFileIds)` (gives `thumb_key` for each week's first slide deck)
    6. `db.notes.where("week_id").anyOf(weekIds)` + `db.note_blocks.where("note_id").anyOf(noteIds).and(b => b.type === "image")` (only queried for weeks that do not already have a slide thumbnail)
  - This cuts `loadModule` from ~150+ queries to 6 indexed bulk reads (`< 5 ms` on a laptop, `< 12 ms` on a phone), while `loadWeek(weekId)` remains unchanged for `WeekPage`.
- **Offline caching for all 22 thumbnails:**
  - Every slide thumbnail (`files/<sha256>.webp`) and note image (`files/<sha256>.<ext>`) matches the existing `/^\/api\/objects\/files\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/` route in `app/public/sw.js` and is served cache-first from `study-pictures-v1`.
  - Card images use `<img loading="lazy" decoding="async" />` for instant initial paint, and when `ModulePage` loads online, a quiet background loop prefetches any thumbnail URLs not yet in `study-pictures-v1` so all 22 cards have their thumbnails cached before you go offline.

### 5.6 Module page sketches across widths

```text
Phone 390px (2-column card grid, bottom tab bar):
+---------------------------------------+
| Study Library                     [>] |
+---------------------------------------+
| <- Modules                   Settings |
| HY116                                 |
| International Politics since 1914     |
| 10 of 42 readings read · Add files    |
|                                       |
| [AT1][AT2][*AT3*][AT4][AT5][AT6] ...  |
|                                       |
| +-----------------+ +---------------+ |
| | [Slide 1 thumb] | | [Note picture]| |
| |                 | |               | |
| +-----------------+ +---------------+ |
| | AT1 · 28 Sep    | | AT2 · 5 Oct   | |
| | The July Crisis | | Peacemaking   | |
| | All 3 read  [v] | | 1 of 3 read   | |
| +-----------------+ +---------------+ |
|                                       |
| +=================+ +---------------+ |
| | [This week]     | |   AT4         | |
| |   AT3 (Display) | |   (Display)   | |
| +=================+ +---------------+ |
| | AT3 · 12 Oct    | | AT4 · 19 Oct  | |
| | Manchuria 1931  | | Abyssinia     | |
| | 0 of 4 read [v] | | 2 readings    | |
| +=================+ +---------------+ |
+---------------------------------------+
|  Modules   This week  Search Settings |
+---------------------------------------+

Laptop 1024px / 1280px / 1440px (3-column card grid inside the 46rem / 736px column):
+------------------------------------------------------------------------------+
| [Study Library] | [HY116]  HY240  HY300     This week  Job search  [>] [Q] [*]|
+------------------------------------------------------------------------------+
| <- Modules                                                          Settings |
| HY116                                                                        |
| International Politics since 1914                                            |
| Autumn Term 28 Sep 2026, Winter Term 11 Jan 2027                             |
| 10 of 42 readings read · Add files · Find references                         |
|                                                                              |
| [AT1][AT2][*AT3*][AT4][AT5][AT6][AT7][AT8][AT9][AT10][AT11]                  |
| [WT1][WT2][WT3][WT4][WT5][WT6][WT7][WT8][WT9][WT10][WT11]                    |
|                                                                              |
| +-----------------------+ +-----------------------+ +======================+ |
| |                       | |                       | | [This week]          | |
| |   [Slide 1 16:9]      | |  [Seminar note img]   | |    AT3 (Display)     | |
| |                       | |                       | |                      | |
| +-----------------------+ +-----------------------+ +======================+ |
| | AT1 · 28 Sep to 2 Oct | | AT2 · 5 to 9 Oct      | | AT3 · 12 to 16 Oct   | |
| | The July Crisis       | | Versailles & After    | | The Manchurian Crisis| |
| | All 3 read        [v] | | 1 of 3 read           | | 0 of 4 read      [v] | |
| +-----------------------+ +-----------------------+ +======================+ |
|                                                                              |
| +-----------------------+ +-----------------------+ +----------------------+ |
| |                       | |                       | |                      | |
| |    AT4 (Display)      | |    AT5 (Display)      | |    AT6 (Display)     | |
| |                       | |                       | |                      | |
| +-----------------------+ +-----------------------+ +----------------------+ |
| | AT4 · 19 to 23 Oct    | | AT5 · 26 to 30 Oct    | | AT6 · 2 to 6 Nov     | |
| | Abyssinia 1935        | | Appeasement           | | *Reading week*       | |
| | 2 readings            | | 3 readings            | | Reading week         | |
| +-----------------------+ +-----------------------+ +----------------------+ |
+------------------------------------------------------------------------------+
```
(`+===+` denotes the `2px` `--accent` border on `This week`; `[v]` is the optional download icon button on weeks that have a brief/slides.)

---

## 6. Storage, migration `0014`, processor changes, Cloudflare cost and purge

### 6.1 What migration `0014` holds (`app/migrations/0014_module_and_slide_images.sql`)

Combining both new columns into a single additive migration `0014` avoids rebuilding any tables or touching any triggers:

```sql
-- Module cover picture R2 key (files/<sha256>.webp)
ALTER TABLE modules ADD COLUMN image_key TEXT;

-- First-page WebP thumbnail R2 key for PDF/slide files (files/<sha256>.webp)
ALTER TABLE files ADD COLUMN thumb_key TEXT;
```

- **Why `files.thumb_key` is worth including in `0014`:**
  - Since `0014` is already needed for `modules.image_key`, adding `ALTER TABLE files ADD COLUMN thumb_key TEXT` in the same migration has zero extra migration overhead.
  - Storing `thumb_key` as `files/<sha256>.webp` means:
    1. The client knows for certain whether a slide deck has a rendered thumbnail (`Boolean(file.thumb_key)`) instead of guessing a URL and getting `404`s on older files.
    2. `app/public/sw.js` caches it offline in `study-pictures-v1` with no change to its `/^\/api\/objects\/files\/[0-9a-f]{64}\.(png|jpg|gif|webp)$/` matcher.
    3. Identical slide decks share one thumbnail object by content hash.
- **Sync compatibility:**
  - In `app/worker/schema.ts`, add `"image_key"` to `TABLES.modules` and `"thumb_key"` to `TABLES.files`.
  - Because `applyChanges` in `app/worker/sync.ts` writes only the columns a device sends, an older tab or device continues syncing cleanly.
  - In `app/src/lib/db.ts`, bump Dexie to version `9` and clear `"cursor"` from `meta` on upgrade so existing devices pull `image_key` and `thumb_key` on their next sync.

### 6.2 How the processor renders a slide deck's first page (`backend/study/processor/jobs.py`)

- Every slide deck ends up as a PDF row in `files` that runs the `extract_text` job:
  - A PDF slide deck uploaded directly queues `extract_text` immediately (`app/worker/files.ts`).
  - A PowerPoint (`.pptx`) or Word (`.docx`) slide deck runs `convert`, which converts it to PDF via LibreOffice and calls `/api/processor/files/:id/converted`, which creates the `:pdf` row in `files` and queues `extract_text` (`app/worker/processor.ts` lines 163-173).
- Inside `extract_text(ctx, job)` in `backend/study/processor/jobs.py`:
  1. `extract_text` already downloads the PDF to a temp file and opens it with `pymupdf.open(path)`.
  2. When `len(doc) > 0`, render page `0` at `640px` width using PyMuPDF and Pillow (both already installed in `~/.venvs/study`):
     ```python
     page0 = doc[0]
     scale = 640.0 / max(page0.rect.width, 1.0)
     pix = page0.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
     img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
     buf = io.BytesIO()
     img.save(buf, format="WEBP", quality=80, method=4)
     thumb_bytes = buf.getvalue()
     thumb_sha = hashlib.sha256(thumb_bytes).hexdigest()
     thumb_key = f"files/{thumb_sha}.webp"
     ctx.api.put_object(thumb_key, thumb_bytes, "image/webp")
     ```
  3. Pass `"thumb_key": thumb_key` in the existing `POST /api/processor/files/:id/text` JSON body, and update `app/worker/processor.ts` line 127 to set `thumb_key = COALESCE(?3, thumb_key)` in the existing `UPDATE files` statement.

### 6.3 How existing slides get thumbnails

- In `app/worker/processor.ts`, extend `POST /api/processor/rescan` (or add a lightweight startup check called once when the processor starts up in `backend/study/processor/loop.py`) with an idempotent query that queues `extract_text` for any live PDF file attached to a `slides` item whose `thumb_key IS NULL`:
  ```sql
  INSERT INTO processor_jobs (id, kind, target_id, status, payload, created_at, updated_at)
  SELECT 'thumb:' || f.id, 'extract_text', f.id, 'pending',
         json_object('r2_key', f.r2_key, 'mime', f.mime), ?1, ?1
  FROM files f
  JOIN items i ON i.file_id = f.id AND i.deleted = 0
  WHERE f.deleted = 0 AND f.mime = 'application/pdf' AND f.thumb_key IS NULL
    AND i.kind = 'slides'
    AND NOT EXISTS (
      SELECT 1 FROM processor_jobs j
      WHERE j.target_id = f.id AND j.kind = 'extract_text' AND j.status IN ('pending', 'running')
    )
  ```
- Rendering page 0 with PyMuPDF takes ~15 ms per deck, so 30 existing slide decks finish in under 2 seconds on your laptop.

### 6.4 Cost on Cloudflare's free plan

| Resource | Free tier limit | Cost of module pictures + slide thumbnails |
| --- | --- | --- |
| **Worker CPU** | `10 ms` per request | **`< 1 ms` per request.** Module pictures are resized in the browser (`<canvas>`); slide thumbnails are rendered in WSL by Python. The Worker only streams bytes into and out of R2 and binds one extra string (`thumb_key`) to an existing D1 `UPDATE`. |
| **R2 storage** | `10 GB` / month | **`~4 MB` across a whole degree.** 12 module pictures (`~45 KB` each) + 150 slide thumbnails (`~25 KB` each) = `~4.3 MB` (`0.04%` of the free allowance). |
| **R2 Class A writes** | `1,000,000` / month | **`1 PUT` per picture or slide deck** when created. |
| **R2 Class B reads** | `10,000,000` / month | **`1 GET` per device per thumbnail**, then cached permanently in `study-pictures-v1` because `/api/objects/*` returns `Cache-Control: private, max-age=31536000, immutable`. |
| **D1 reads / writes** | `5M` reads, `100k` writes / day | **`0` extra D1 queries** for slide thumbnails (`thumb_key` piggybacks on `/files/:id/text` and `/api/sync`). |

### 6.5 How the nightly purge keeps module pictures and removes slide thumbnails with their deck

In `app/worker/maintenance.ts`:

1. **Keeping module pictures:**
   - Module pictures are stored at `files/<sha256>.webp` and referenced by `modules.image_key` (without a row in `files`), so `releaseUnusedFiles()` never marks them as unused `files` rows.
   - In `purge(env)`, add `AND NOT EXISTS (SELECT 1 FROM modules m WHERE m.image_key = f.r2_key)` alongside the existing `applications` guard so that even if a user picks an image file that also existed in `files`, the nightly purge never deletes an R2 object referenced by any module.
2. **Removing a slide thumbnail when its deck is purged:**
   - In `purge(env)`, select `f.id, f.r2_key, f.thumb_key` for expired deleted files (`WHERE f.deleted = 1 AND f.modified_at < cutoff ...`).
   - When deleting `row.r2_key` from `env.BUCKET`, if `row.thumb_key` is set and no other non-purged `files` row or `modules.image_key` references `row.thumb_key`, call `await env.BUCKET.delete(row.thumb_key)` in the same loop before `DELETE FROM files WHERE id = ?`.

---

## 7. The build in three parts

Each part will be committed separately on `main` after its tests pass.

### Part 1: The top bar on a laptop

- **Files changed:**
  - `app/src/App.tsx`: unify `.topbar` structure across study pages and `JobsPage` (`--bar-max: 72rem` when on `jobs`, `46rem` otherwise); replace `Week across modules` / `Across` with `This week`; use `Icon` (`goto`, `search`, `settings`) for `Go to`, `Search` and `Settings` with `aria-label` and shortcut `title`; set `aria-current="page"` consistently on `Study Library`, `ModuleLinks`, `This week`, `Job search`, `Search` and `Settings`; make `SyncStatus` render nothing when empty.
  - `app/src/components/AcrossPage.tsx` and `app/src/components/Palette.tsx`: use `This week` as the single page name.
  - `app/src/styles.css`: align `.topbar` with `--bar-max`, fix height to `3.25rem`, remove `@media (max-width: 56rem)` wrapping and `.wide-only` / `.narrow-only` top bar rules, remove `.sync-status` `min-width: 7.5rem`, and unify `.topbar a[aria-current="page"]`.
- **Tests:**
  - Update and run `npm run e2e -- ux jobs back audit_layout` to verify:
    - Single-row `52px` top bar at `768`, `1024`, `1280` and `1440` in light and dark with zero wrapping or overflow faults.
    - Left edge of `Study Library` and right edge of `Settings` icon align with `.page` (`46rem`) on study pages and `.page.wide` (`72rem`) on Job search.
    - `aria-current="page"` marks the active item identically on every route, and tooltips/labels match shortcuts.
    - Phone top bar and bottom `TabBar` at `390px` and `412px` remain unchanged.

### Part 2: The home page and module pictures

- **Files changed:**
  - `app/migrations/0014_module_and_slide_images.sql` (ask you before applying to any live database), `app/worker/schema.ts`, `app/worker/maintenance.ts`, `app/src/lib/types.ts`, `app/src/lib/db.ts`.
  - `app/src/lib/uploads.ts`: add client-side `<canvas>` resize (`resizeModulePicture`), Cache Storage pre-population in `study-pictures-v1`, and offline-capable object queueing in `db.uploads`.
  - `app/src/components/ModuleSettings.tsx`: add `Picture` picker (`Choose picture`, `Remove picture`, preview).
  - `app/src/components/Home.tsx` and `app/src/styles.css`: replace `KeyDatesAhead`, `ThisWeek`, `.module-row` list and `Recently opened` with `.module-grid` and `.module-card` (16:9 picture or `--display` typographic cover), keeping `Add a module` and `Arrange`.
  - `app/src/components/AcrossPage.tsx`: include any items you choose to move from the old home page (see Decision 1).
- **Tests:**
  - Unit tests (`npm test`): migration `0014` schema test, `maintenance.ts` purge test verifying `modules.image_key` is kept.
  - Browser tests (`npm run e2e -- ux editing dissertation offline`):
    - Choosing a module picture in `ModuleSettings` resizes it on the device, shows it on `Home` immediately (including while offline), and `Remove picture` restores the typographic `--display` card.
    - `Arrange` reorders module cards and persists the order.

### Part 3: The module page and slide thumbnails

- **Files changed:**
  - `backend/study/processor/jobs.py` and `app/worker/processor.ts`: render page 0 WebP thumbnail during `extract_text`, store `files.thumb_key`, and queue backfill for existing slide decks without `thumb_key`.
  - `app/worker/maintenance.ts`: delete `thumb_key` from R2 when its parent `files` row is purged.
  - `app/src/lib/library.ts`: replace `Promise.all(weeks.map(loadWeek))` in `loadModule` with 6 bulk IndexedDB queries returning card data (`code`, `title`, `dates`, `readCount`, `totalReadings`, `thumbUrl`, `briefFile`).
  - `app/src/components/ModulePage.tsx` and `app/src/styles.css`: render `.week-grid` and `.week-card` (slide thumbnail -> seminar note picture -> `--display` typographic cover), highlight `This week`, wire `.jump` smooth-scroll, preserve drag-and-drop from `Unsorted` and desktop files onto cards, and add the card download button / dissertation section menu.
  - Update `DEBRIEF.md` (sections 10, 12, 16, 17), `.agents/skills/study-library-design/SKILL.md`, and `app/package.json` version.
- **Tests:**
  - Backend tests (`npm run test:backend`): test `extract_text` generates and uploads a `640px` WebP thumbnail and sends `thumb_key`; test `purge` deletes `thumb_key` with its deck.
  - Browser tests (`npm run e2e`): update `ux`, `workflow`, `editing`, `dissertation` and `audit_layout` for the week card grid, verifying slide thumbnails, seminar note image fallback, typographic fallback, `This week` highlight, dropping unsorted readings onto a week card, and 22-week load speed.

---

## 8. Decisions needed from you

Each question lists my recommendation first:

1. **Items removed from the home page (`This week`, `Recently opened`, dissertation `Coming up`):**
   - **Recommendation:** Move **(a) empty timetabled sessions** (so you can tap into an empty lecture or seminar to start taking notes), **(b) the per-module `X of Y read` count**, **(c) pre-term start dates**, and **(d) the `Coming up` dissertation key-dates strip** onto `AcrossPage` (`This week`), and drop `Recently opened` (since `Go to` / `Ctrl+K` is available from every screen).
   - Would you like all four moved to `This week` (`AcrossPage`), or should dissertation key dates stay only on the dissertation's own module page?
2. **List view on the module page:**
   - **Recommendation:** Use the card grid as the single view on `ModulePage` (with no list/grid toggle), and open `WeekPage` when a card is clicked.
   - Are you happy with cards only on the module page, or do you want a `Cards / List` toggle?
3. **The week brief download on a week card:**
   - **Recommendation:** Show a quiet download icon button in the bottom-right corner of a week card when that week has a slide deck (or, if you designate a reading/handout as the week's brief, that file), downloading its PDF in one click with `stopPropagation()`.
   - Which file in a week should that download button fetch: the week's first slide deck, a week handout/brief item, or should the card have no download button so everything lives inside `WeekPage`?
4. **Note picture fallback on a week card:**
   - **Recommendation:** Check seminar notes first (`session.kind === "seminar"`), and if there is no picture in seminar notes, fall back to any lecture or week note picture before falling back to the typographic card (so dissertation sections and lecture-only weeks can also show a note picture).
   - Should it check seminar notes then any note in that week, or strictly seminar notes only?
5. **Migration `0014` (`modules.image_key` and `files.thumb_key`):**
   - **Recommendation:** Put both `ALTER TABLE modules ADD COLUMN image_key TEXT` and `ALTER TABLE files ADD COLUMN thumb_key TEXT` in `app/migrations/0014_module_and_slide_images.sql` and test locally first (without applying to the live D1 database until you ask to deploy).
   - Are you happy for me to create `0014_module_and_slide_images.sql` for local testing when we start Part 2?
