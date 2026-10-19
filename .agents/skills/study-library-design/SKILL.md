---
name: study-library-design
description: Study Library's design system and taste. Use for any change to how the app looks or behaves on screen: new screens, components, layouts, styling, the phone layout, or a design or usability review. Not needed for sync, processor, OCR or data work.
---

# Study Library design

Read this before changing anything the user sees. Where another design skill disagrees with this one, this one wins: the app's look is settled, and new work should match it, not restyle it.

## The idea

A study desk: Zotero's library, Notion's notes and Word's page, in one calm place. The interface stays quiet so the reading and writing can be loud. Space and type do the work, not lines and boxes. It should feel made by one hand: the same thing always looks and behaves the same, wherever it appears.

The one bold element is the page titles, set in Literata's display cut, like a book's chapter openings. Everything else is plain.

## What to learn from, and what exactly to take

| From | Take | Leave |
| --- | --- | --- |
| Notion | Calm pages, generous space, rows that lift onto a soft surface on hover, quiet chrome | Its emoji and coloured callouts |
| Zotero 7 | The reader's shape: sidebar, page, notes pane; highlights that stay part of the reading | Its dense dialogs and settings |
| Microsoft Word | The page as an object, set on a slightly darker desk with a soft shadow | Ribbons and toolbars |
| Apple (iOS) | Tab bars, sheets from the foot of the screen, 44-point targets, safe areas, nothing that needs hover | Native visual details that look odd on the web |
| Linear | One look for "selected": a soft accent fill with accent text | Its dark-first look |
| Things 3 | Restraint: few controls on screen, each one obvious | |

References, to open when you need detail rather than to copy: Apple's Human Interface Guidelines at https://developer.apple.com/design/human-interface-guidelines (tab bars, sheets, layout, accessibility), and the WCAG 2.2 quick reference at https://www.w3.org/WAI/WCAG22/quickref/.

The finished look is shown in `docs/design/`: the home, module, week, session and reader pages on a laptop; the home and week pages on a phone; and the week page in dark mode. Match them.

## Tokens

Always use these variables; never write a colour, radius or size directly. They are defined at the end of `app/src/styles.css`, in the block that begins "Design, from 0.29", with sepia and dark versions.

**Colour (light)**

| Token | Value | Use |
| --- | --- | --- |
| `--paper` | #FCFCFB | The page |
| `--ink` | #1D2024 | Text |
| `--muted` | #60656D | Secondary text, minor actions |
| `--faint` | #8F959C | Placeholders, dates beside titles |
| `--rule` | #E5E6E3 | The few hairlines that remain |
| `--rule-strong` | #D5D7D3 | Field borders |
| `--surface` | #F4F4F1 | Tiles, panels, secondary buttons, hover |
| `--surface-hover` | #ECEDE9 | Hover on a surface |
| `--card` | #FFFFFF | Fields, menus, dialogs |
| `--accent` | #185FA5 | Links, the current choice, focus, primary buttons |
| `--accent-soft` | #E6EFF8 | The fill behind a current choice or a chip |
| `--danger` | #A33A2A | Deleting and problems only |

**Type**

- `--display`: Literata Display, for page titles (`h1`, `h2`) and the brand. Weight about 560.
- `--serif`: Literata, for reading text, reading titles and notes.
- `--sans`: IBM Plex Sans, for the interface: buttons, labels, menus, metadata.
- Sizes: `--fs-2xl` (1.875rem) page titles, `--fs-xl` (1.3rem) section titles, `--fs-lg`, `--fs-md` (body), `--fs-sm` (secondary), `--fs-xs` (metadata).

**Shape**

- `--r-xs` (4px): small marks, focus outlines.
- `--r-sm` (6px): buttons, fields, rows, menu items.
- `--r-md` (10px): tiles, session panels, menus.
- `--r-lg` (14px): dialogs and sheets.
- `--shadow-float`: only for things that float above the page (menus, dialogs, notices). Resting surfaces have no shadow.

## Components

- **Buttons.** The page's main action is filled with the accent (`.button.primary`), at most one per page, at the top right beside the title. Other actions are soft grey surfaces (`.button`), never outlines. Minor actions are plain text that lifts on hover (`.quiet`).
- **Rows.** Lists of readings, modules and recent items are flat, with no dividing lines. The row under the pointer takes `--surface`. A row's whole width is its target.
- **Panels.** A group that belongs together, such as a session on a week page, sits on `--surface` with `--r-md` corners, not between rules.
- **Chips and tags.** Sentence case, a soft fill (`--accent-soft` with accent text), fully rounded, never outlined. Small chips keep a larger invisible tap area.
- **Selected and current.** One look everywhere: an `--accent-soft` fill with accent text. A segmented control shows its choice as a raised white button.
- **Menus.** Every "more" menu is the drawn ••• icon (`Menu` in `Menu.tsx`). On a phone it becomes a sheet from the foot of the screen, with Cancel.
- **Icons.** Only the drawn set in `icons.tsx`, at the stroke weight of its other icons. Never a typed character (•••, ▸, ⋮⋮) or an emoji.
- **Dates.** "12 Oct", "12 Oct 2026", "12 to 16 Oct", using `shortDate` in `lib/dates.ts`.
- **Titles of readings.** In curly quotation marks, from `lib/titles.ts`.

## Writing on screen

- British English. No em dashes or en dashes.
- Sentence case for every label, button and heading. No capitals for labels.
- No middle dots between details: use a comma, or space.
- One name for each thing everywhere. A tab, a link and the page it opens use the same words.
- Buttons say what they do ("Add a section", "Delete reading"), not "OK" or "Submit".
- Empty states say what is missing and how to add it, in one or two short sentences.

## Behaviour

- **Consistency.** Anything you can do to a thing is offered wherever it appears (section 20 of `DEBRIEF.md`).
- **One way in.** Each place has one obvious link on any screen, not three.
- **Undo, not "Are you sure?".** Ask first only when something hard to replace would be lost.
- **A way out, always.** Every sheet, panel, dialog, menu, form and editing state has a visible Cancel (or Close) button, as well as Escape on a laptop and a tap outside where it makes sense. Cancel leaves everything as it was.
- **Back closes, then leaves.** On a phone, the back gesture or button closes an open sheet, panel or dialog first, and only then leaves the page.
- **Focus goes where you'd expect.** Opening a form puts the cursor in its first field. Closing a sheet or dialog returns focus to the button that opened it. While a dialog is open, Tab stays inside it.
- **No accidental doubles.** A button that saves or creates something is disabled from the first tap until it finishes.
- **Say what happened.** After any action that changes data, a short notice says what changed, with Undo where possible.
- **Errors say what to do,** in plain words, never a code.
- **Nothing lost by leaving.** Typing is saved as you go, or leaving a form with unsaved changes asks first.
- **Lists remember their place** when you come back to them.
- **The keyboard never covers what you're typing** on a phone.
- **Search and filters can be cleared in one tap.**
- **Dangerous actions look and sit apart.** Delete is red, never the main button, and never beside Save or Done.
- **Offline is visible,** and changes queue to sync later.

## Phone (below 44rem wide)

- The tab bar (Home, This week, Search, Settings) navigates; it never performs actions.
- Every control is at least 44 points. Fields are at least 16px, so iOS never zooms.
- Nothing depends on hover. No dragging by finger: offer Move up, Move down and Move to in menus instead.
- Menus and confirmations are sheets from the foot of the screen.
- Keep content clear of the home indicator and the keyboard.

## Avoid

- Lines between every row or section, or a heavy rule under a heading.
- Outlined buttons, or more than one filled button on a page.
- Capitals for labels, and middle dots between details.
- The same thing styled differently in two places.
- New colours, fonts, shadows or radii outside the tokens.
- Generic card grids with identical rounded boxes and the same shadow.
- Cream backgrounds, purple gradients, and default fonts like Inter.

## Before finishing any change to the interface

1. Look at it on a laptop and on a phone (390px wide), in light and in dark.
2. Compare it with the matching screenshot in `docs/design/`.
3. Check every control is at least 44 points on a phone, focus is visible, and nothing needs hover.
4. Check the words: British English, sentence case, the same names as elsewhere.
5. Check the same thing behaves the same everywhere it appears.
6. Run `npm run test:all` and the browser tests the change touches.
7. Check every sheet, panel, dialog, form and editing state has a visible Cancel.
8. Check the phone's back gesture closes anything open before leaving the page.
9. Check a double tap on Save or Add makes only one of anything.
10. Check the keyboard never covers the field being typed in on a phone.
