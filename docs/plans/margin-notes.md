# Notes in the margin of the text view: plan

## What is wanted

In text layout on a laptop, a reading's notes sit in the space beside the column, each pointing at the passage it belongs to, somewhat like comments in Word but quieter and easier to use. Highlighting works with them. Page layout keeps the side panel as it is.

## What exists

- **The notes already belong to passages.** A reading's notes hold a quotation for each highlight, in reading order (`src/lib/readingNotes.ts`, `reconcile`). Anything written beneath a quotation stays with it, because a new quotation always goes in before the next later one, never between a quotation and its writing.
- **The notes are edited in the side panel's Notes tab,** with the BlockNote editor (`NoteEditor.tsx`), which holds back a background refresh while it has focus or a save is pending.
- **Highlights carry a `comment` column, which nothing uses.** Every highlight is made with `comment: null`.
- **The text view** (`src/components/reader/TextView.tsx`) draws each highlight as `<mark class="hl-text" data-id>` runs. The column is at most 40rem wide and centred (`.text-view` in `styles.css`).
- **Highlights are stored as page rectangles,** so the text view and page layout show the same highlights.

## The model: a margin note is the writing beneath its quotation

The margin shows, beside each highlight, the blocks between that highlight's quotation and the next quotation in the reading's notes. Editing a card edits those same blocks. So the margin and the Notes panel are one set of notes seen two ways, nothing has to be kept in step, and the Word export later reads the same notes.

Rejected: the unused `comment` column. It would make a second place for notes, outside the notes document, the Word export and search, with no lists or formatting.

Writing at the top of the notes, before the first quotation, belongs to the reading as a whole. It stays in the panel and never appears in the margin.

## On a laptop

- **When.** In text layout, whenever the reading has a note or one is being written, and there is room: the 40rem column plus a 17rem margin and their gaps, about 62rem. With room for both margins the column stays centred. With less, it moves left of centre, so the margin fits from about a 1000-pixel window. Narrower than that, notes stay in the side panel, as now. The side panel's Notes tab still works alongside, showing the whole document.
- **Where a card sits.** Each card starts level with the first line of its passage. When passages are close, cards stack downwards with a small gap. The card being read or edited sits exactly beside its passage, and the others move to make room, as Google Docs does. Positions come from a pure function (anchors and card heights in, positions out), recalculated when the text size, the footnotes setting or the window changes.
- **How a card points.** Pointing at a card brightens its highlight and draws a faint line to the passage's first line. Pointing at a highlighted passage brightens its card. The highlight keeps its colour. A thin bar in that colour on the card's edge ties the two together.
- **A card.** It shows the note's text: paragraphs, lists and bold or italic, as in the notes. A long note shows its first four lines, with **More**. Clicking a card edits it in place. Its ••• menu offers **Delete note**, which keeps the highlight, and **Remove highlight**, both with Undo.
- **A highlight with no note** shows nothing in the margin, so it stays quiet. Pointing at the highlight offers **Add a note** in the margin beside it.
- **Adding a note.** Select text, and the selection popover offers **Note** beside the colours. It makes a highlight in the current colour, its quotation in the notes, and an empty card beside the passage, ready to type in. Clicking an existing highlight opens its card for writing.
- **The keyboard and screen readers.** Tab goes from a highlighted passage to its card. Escape leaves a card. Each highlight's `mark` is described by its note through `aria-describedby`, so a screen reader reads the note with the passage.

## In page layout

Unchanged: the notes stay in the side panel.

## On a phone

There is no margin. A highlight with a note shows a small drawn mark at its end. Tapping the highlight opens its note in a sheet from the foot of the screen, to read or edit, with **Done**, and the back gesture closes it. **Note** in the selection popover opens the same sheet, empty.

## Data and sync

- **No migration.** Margin notes are the reading's existing notes and note blocks.
- **Mapping.** A pure function takes the reading's note blocks and returns, for each highlight id, the block ids of its note. It is unit-tested against quotations that are reordered, deleted or have no writing.
- **Editing.** A card edits its blocks through the same functions as the Notes panel, so changes made in either show in the other. When both are open, the panel's rule of holding back a refresh while it has focus applies to cards too. A card with focus is never replaced by a background refresh.
- **Speed.** Positions are recalculated with a ResizeObserver on the column. A reading has tens of notes at most, so cards are not virtualised.

## The build, in four parts

1. **Reading the margin:** the mapping, the placing function, and cards shown beside their passages, read-only, on a laptop, with pointing linking a card and its highlight. Unit tests for the mapping and the placing; browser tests that a note appears beside its passage, that close passages stack without overlapping, and that the column moves left of centre at about 1000 pixels and falls back to the panel below that.
2. **Writing in the margin:** editing in a card, **Note** in the selection popover, **Add a note** on a highlight, **Delete note** and **Remove highlight** with Undo, and the background-refresh rule. Browser tests that a note written in a card appears in the panel and the reverse, that the cursor never moves while writing during a refresh, and that Undo works.
3. **The phone:** the mark at a highlight's end, the note sheet, **Note** in the popover, and back closing the sheet. Browser tests on a 390-pixel phone.
4. **Finishing:** the keyboard and screen-reader paths, dark and sepia themes, the layout audit at every width, DEBRIEF and the version.

Each part is its own session, using the tests for what it changes while working, and the full suite once at the end.

## Decisions

My recommendation comes first in each.

1. **Margin notes are the writing beneath each quotation in the reading's notes,** not the unused `comment` column.
2. **A passage can have a note without being coloured.** I'd add a "note only" highlight, shown as a dotted underline in place of a colour, for when you want to comment on a passage without marking it. The alternative is that every note needs a coloured highlight.
3. **A highlight with no note shows nothing in the margin,** so the margin holds only what you've written.
4. **The column moves left of centre to make room,** so notes show on a 1024-pixel screen too. The alternative is margin notes only on screens wide enough for both margins, about 1200 pixels.
5. **Cards edit with the same formatting as the notes** (paragraphs, lists, bold and italic), not plain text.
