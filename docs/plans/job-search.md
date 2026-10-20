# Job search redesign: plan

## 1. What is wrong now

| Where | Problem | Screenshot |
| --- | --- | --- |
| Laptop table | The stage is a full-width native select. It reads as a form field, not a chip, and opens a plain OS list with no colours or grouping. Four big amber and blue blocks dominate the table | app/tests/e2e/shots/jobs-1-table.png |
| Laptop tools | Order is a native select in OS styling, the only one like it in the app | same |
| Laptop Details | Each file slot is a row of four to six tiny text links ("Replace, Remove file, Not required, Clear"), hard to hit and to read. Details has no Close, and nothing records what happened when | app/tests/e2e/shots/jobs-2-details.png |
| Phone list | About 460 of the first 844 pixels are chrome: a two-row top bar ("Study Library" wraps under the brand), the title, the summary, the filter, the Order menu and the search. The stage is cut off ("Interview: to prepare and atte..."). Each card spends lines on the applied date and four file marks, but never says how long it has been waiting | app/tests/e2e/shots/jobs-4-phone.png |
| Phone open card | A long inline form: the employer appears twice, the stage is a native select, each file is a menu, and Delete application sits beside Done, against the design rule. Done is at the foot of a long card, out of reach until you scroll | app/tests/e2e/shots/jobs-5-phone-open.png |
| Both | A closed application still shows a past deadline (Kekst CNC, "17 Oct 2026"). A deadline typed from the keyboard is saved on every keystroke, and Escape does not put it back. Nothing is recorded when a stage changes | all |

## 2. The design

### One new piece: the choice card

A single component, ChoiceCard, replaces every dropdown in the job search.

- Laptop (table layout): a small panel on card surface with floating shadow and medium radius, anchored just below the thing being changed, flipping above it near the foot of the screen. Escape, a click outside, or its visible Cancel closes it and returns focus to the button that opened it. Tab stays inside while it is open.
- Phone (card layout, 60rem and below, as now): the same content as a sheet from the foot of the screen over the dimmed page, built on the existing sheetHost and menu backdrop, with Cancel at its foot, clear of the home indicator. The back gesture closes it first.
- Options are laid out as tiles in their category colours, at least 44 pixels tall on a phone. The current one has the one "selected" look (accent ring and a drawn tick, aria-pressed). One tap chooses and closes; a notice says what changed, with Undo.

| Dropdown that goes | Replaced by |
| --- | --- |
| StageSelect (select of 16) | The stage chip becomes a button that opens the stage card |
| Order (select) | An Order button showing the current order ("Order: Next deadline") that opens a choice card of three |
| Each file slot menu (phone) and row of small links (laptop) | A slot card, opened from the file mark in the table or from the file row in Details or on the phone |

Native date picker: it stays. It is the best picker on a phone, works offline and is accessible. What changes is when a date is saved: a date chosen in the picker is saved when the picker closes; a date typed from the keyboard is saved on Enter or on leaving the field; Escape, or a visible Cancel beside the field, puts back what was there. Clear stays for the deadline.

### The stage card

Arranged by step, with "to do" and "done" side by side, so 20 stages read as nine short rows:

```
Stage for PwC                      Now: Online test, to complete, since 20 Oct

Likely next   [ Online test: done, awaiting result ]   [ Rejected ]

                     To do                 Done
Applying             [ To apply ]          [ Applied, awaiting response ]
Online test          [ To complete ]       [ Awaiting result ]
Written assessment   [ To complete ]       [ Awaiting result ]
Video interview      [ To record ]         [ Awaiting result ]
Interview            [ To attend ]         [ Awaiting result ]
Assessment centre    [ To attend ]         [ Awaiting result ]
Final interview      [ To attend ]         [ Awaiting result ]
Offer                [ To accept or decline ]  [ Accepted ]
Closed               [ Rejected ] [ Withdrawn ] [ Offer declined ] [ No response ]

                                                           [ Cancel ]
```

Tiles show short words and their category colour (amber to do, blue waiting, green offer, grey closed). Each tile has an accessible name giving the full label, such as "Interview: to prepare and attend".

Likely next comes first, from a lookup table in jobs.ts:

| From | Likely next |
| --- | --- |
| To apply | Applied |
| Applied | Online test, Video interview, Interview (each to do); Rejected |
| Any "to do" | Its own "done" |
| Online test done | Written assessment, Video interview, Interview; Rejected |
| Written assessment done | Video interview, Interview, Assessment centre; Rejected |
| Video interview done | Interview, Assessment centre; Rejected |
| Interview done | Assessment centre, Final interview, Offer; Rejected |
| Assessment centre done | Final interview, Offer; Rejected |
| Final interview done | Offer; Rejected |
| Offer | Accepted, Offer declined |
| Accepted or closed | (none; the section is hidden) |

The same grid, in "select" mode (a tap marks a tile, Save commits), is used when adding or editing a timeline entry.

### Deadlines

Unchanged in meaning: red and bold when overdue, amber within seven days, always with words. Changes: a closed application shows no deadline at all (today it shows a stale date in plain ink); a deadline set on To apply is its closing date, under the same name, "Next deadline". A deadline is cleared when a "to do" stage is marked done, keeping the cleared deadline on the event row so Undo or changing back can restore it.

### Laptop

- Table: columns, sticky two-row header, wrapping, file marks and dropping a file on a mark all stay. The stage cell becomes a compact chip button (fully rounded, category colour, drawn caret) with "for 10 days" beneath it in small muted type, matching the deadline's words. In the default order, closed applications sit under a quiet Closed heading row.
- File marks: an attached mark still opens the file. Any other mark opens the slot card beside it, so recording "Sent, no file" or "Not required" no longer needs Details.
- New row: while a new row is unfilled it shows a visible Cancel in its last cell, which removes it. Leaving it empty still lets it go.
- Cells: employer and role save on Enter or on leaving; Escape puts back what was there. Notes keep saving as you type, as notes do everywhere in the app.
- Details (the expanded row), three columns: Notes, Timeline, Files.

### Phone

The list keeps the brand and Study Library on one row. The tools fold into two compact rows: the filter, then the search field with an Order button beside it. Add application moves to a bar fixed at the foot of the screen, in thumb reach. Each application is a flat row with no rules: employer, role, stage, next deadline with how soon, and time in stage. File marks and the applied date move inside the application sheet.

A single application opens as a tall sheet over the list, which the back gesture closes. Change stage sits in the fixed foot within thumb reach. Edit opens a short sheet with Employer, Role and Applied, with Save and Cancel.

### Timeline display

Oldest first, sorted by local time. Each entry shows: date (and time for an entry made by changing the stage), stage chip, and duration until the next entry. The current step says "so far". A line at the end gives total days since applying. Each entry can be edited or removed, with Undo. Add a past event opens the editor with a date up to today.

## 3. The stage list

Keys of existing stages are unchanged. Online test replaces OA in labels. Video interview replaces HireVue in labels. New stages are marked.

| Key | Label | Category |
| --- | --- | --- |
| to_apply (new) | To apply | To do |
| applied | Applied: awaiting response | Waiting |
| oa_todo | Online test: to complete | To do |
| oa_wait | Online test: done, awaiting result | Waiting |
| written_todo (new) | Written assessment: to complete | To do |
| written_wait (new) | Written assessment: done, awaiting result | Waiting |
| hirevue_todo | Video interview: to record | To do |
| hirevue_wait | Video interview: done, awaiting result | Waiting |
| interview_todo | Interview: to prepare and attend | To do |
| interview_wait | Interview: done, awaiting result | Waiting |
| ac_todo | Assessment centre: to prepare and attend | To do |
| ac_wait | Assessment centre: done, awaiting result | Waiting |
| final_todo | Final interview: to prepare and attend | To do |
| final_wait | Final interview: done, awaiting result | Waiting |
| offer | Offer: to accept or decline | Offer |
| accepted | Accepted | Offer |
| rejected | Rejected | Closed |
| withdrawn | Withdrawn | Closed |
| declined (new) | Offer declined | Closed |
| no_response | No response | Closed |

Search aliases: searching "oa" or "hirevue" matches the respective stages as before.

## 4. Timeline storage

A separate table, application_events, synced like note_blocks.

Migration 0012_application_events.sql:

```sql
CREATE TABLE application_events (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  from_stage TEXT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'change',
  cleared_deadline TEXT,
  modified_at TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX application_events_app ON application_events (application_id);
CREATE INDEX application_events_seq ON application_events (seq);
```

Triggers on insert and update maintain seq via the counters table, matching applications.

Starting entries: the Applied entry only (`start-applied-<id>`) for applications with an applied date, marked manual, copying deleted from the application. No starting entry for the current stage is backfilled from modified_at. The current stage shows with no "since" until added by hand.

schema.ts: table spec for application_events with json: [] and bool: ["deleted"].

Dexie version 7: stores application_events ("id, application_id"). On upgrade to version 7, reset pull cursor to 0 to pull all rows including the new table.

applications.stage remains the source of truth for the current stage.

Deleting, restoring, discarding: soft deletes cascade to application_events rows in the same transaction. Undo restores them. Restore from Recently deleted restores events deleted with or after the application. Blank application discard deletes its initial event.

Purge: maintenance purge cleans up application_events where deleted = 1 older than tombstone cutoff, and cascades orphaned application_events if their application is gone.

## 5. The mis-tap rule

A 10-minute window, measured from the entry's own time (`at`).
Say the last entry went from A to B and the user now chooses C within the window.

1. If C is A: the user returned to where they were. Remove the entry, restore any cleared deadline or previous applied date, and set the application stage back to A.
2. If C is a likely next stage from B: this is genuine progress in one sitting, not a mistake. Add a new entry from B to C at the current time. If B was a "to do" stage and C is marked done or moved forward, clear the application's deadline and store it on the new entry's cleared_deadline.
3. Otherwise (C is neither A nor likely next from B): this is a correction. Amend the existing entry to go from A to C, keeping its original time and from_stage.

If the last entry is older than 10 minutes, is manual, or has a stage that does not match A, add a new change entry.

Undo restores the previous state, reversing an add, amend, or remove.

To apply and Applied date:
- A new application starts at applied with applied = todayIso().
- If changed to to_apply, clear applied (set to null).
- If leaving to_apply, if applied is empty, set applied = todayIso().
- If changed back within the window from applied to to_apply, clear applied again.

Local time sorting:
Sort timeline entries in memory by their local time representation, so an ISO UTC stamp just after midnight sorts into the correct local calendar day alongside date-only entries.

## 6. Commits and tests

Part 1:
- Commit 1: Stages (keys, labels, categories, likely next table, search aliases, unit tests).
- Commit 2: Storage (migration 0012, schema.ts, types.ts, Dexie version 7 with cursor reset, purge cascade, migration testing on populated local database).
- Commit 3: Timeline rules (pure functions for mis-tap evaluation, duration calculation, local time sorting, undo state creation, deadline and applied date handling, unit tests).
- Commit 4: Wiring (connecting stage changes and deletions in JobsPage to the timeline rules with toast notice and Undo).

Part 2:
- Commit 5: ChoiceCard and Order card.
- Commit 6: Stage card in table.
- Commit 7: Slot card.
- Commit 8: Dates and table cell editing.
- Commit 9: Laptop Details with timeline.

Part 3:
- Commit 10: Phone list with compact tools and foot bar.
- Commit 11: Phone sheets.
- Commit 12: Finish, audit, docs, version.

## 7. Decided points

These decisions were confirmed by the user and override the plan where they differ:

1. Stages: add To apply, Written assessment (two stages: to complete and done), and Offer declined. Do not add a separate case study. Relabel HireVue as Video interview. Relabel OA as Online test across all stage labels and chips.
2. Mis-tap window: 10 minutes, measured from the entry's own time. Amends only when the change looks like a correction. If C is A, remove the entry. If C is a likely next stage from B, add a new entry. Otherwise amend from A to C, keeping the original time.
3. Deadlines: clear the deadline when a "to do" stage is marked done, saving the cleared deadline on the event row so Undo and change-back restore it.
4. To apply and Applied date: choosing To apply clears Applied. Leaving To apply sets Applied to today if empty. Changing back within the window clears it again.
5. Add application on phone: move to a bar fixed at the foot of the screen, in thumb reach (part 3).
6. File marks on phone: remove from list rows and show inside the application sheet (part 3).
7. Starting entries: the Applied entry only (`start-applied-<id>`). Do not take the current stage's date from modified_at. The current stage shows with no "since" until added by hand.
8. Cell editing on laptop: single table cells (employer, role) save on Enter or blur, with Escape to cancel, without crowded inline cancel buttons (part 2).
9. Full pull on upgrade: reset pull cursor to 0 during Dexie version 7 upgrade so existing clients fetch the new application_events table.
10. Local time sorting: sort entries in code by local time so UTC entries just after midnight sort into the correct local calendar day.
