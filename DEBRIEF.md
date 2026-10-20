# Study Library: debrief

A complete record of what was built, how your installation is set up, how it works, and how to run it. Written on 7 October 2026 and updated for version 0.31 on 15 October 2026. Section 17 lists what each version changed.

## Contents

1. What Study Library is
2. Your installation at a glance
3. Where every secret lives
4. How it works
5. What you can do with it
6. Everyday tasks
7. Running and maintaining it
8. Troubleshooting
9. Costs
10. Decisions and why
11. Code map
12. Data model
13. API reference
14. Tests
15. Design rules
16. Known limits and next steps
17. Version history
18. The job search
19. On a phone
20. The same actions wherever a thing appears
21. Dissertation modules

---

## 1. What Study Library is

Study Library is a personal course library that replaces Zotero for your course work. It holds every reading for your modules, organised by week. It lets you read and highlight PDFs, take lecture and class notes, record sessions, and collect evidence for seminar questions.

It runs on Cloudflare, so every device sees the same library. It also works offline. Edits wait on the device and sync when it reconnects.

It is built for one person. There are no accounts inside the app. Cloudflare Access decides who can reach it.

---

## 2. Your installation at a glance

| Part | What it is | Where it lives |
| --- | --- | --- |
| App and API | One Cloudflare Worker called `study-library` | https://study-library.samuel-leigh147.workers.dev |
| Database | Cloudflare D1 database `study-library` | Your Cloudflare account |
| Files | Cloudflare R2 bucket `study-library` | Your Cloudflare account |
| Sign-in | Cloudflare Access, with two policies | Zero Trust, attached to the Worker |
| Processor | Python, running in WSL on your laptop | `D:\Downloads\study-library\backend` |
| Processor's Python | A virtual environment on the Linux disk | `~/.venvs/study` inside WSL |
| Processor start-up | A Task Scheduler task at sign-in | "Study Library processor" |
| Processor log | Plain text file | `D:\Downloads\study-library\backend\processor.log` |
| Project code | This folder | `D:\Downloads\study-library` |

**Access policies**

| Policy | Action | Who it lets in |
| --- | --- | --- |
| Cloudflare account | Allow | Members of your Cloudflare account, which is only you |
| Service Auth | Service Auth | Anything holding the `study-library` service token |

The scope is **All traffic**. Sessions last **7 days**, so each device asks for an emailed code once a week. Preview URLs are switched off.

**Processor**

The processor runs in WSL, in Ubuntu 24.04, rather than Docker. Docker Desktop restarted the laptop whenever it opened. The Task Scheduler task starts it hidden at each sign-in. It pauses while the laptop sleeps and carries on when it wakes. Jobs created while the laptop is off wait in the queue until it next runs.

---

## 3. Where every secret lives

Keep a copy of each of these in a password manager.

| Secret | Purpose | Stored in |
| --- | --- | --- |
| `PROCESSOR_KEY` | Lets only your processor claim jobs and save results | Worker secret, and `backend/.env` |
| Service token Client ID | Gets the processor and importer past Access | Zero Trust, and `backend/.env` |
| Service token Client Secret | The other half of the token | Zero Trust (shown once), and `backend/.env` |
| `OPENAI_API_KEY` | Transcription | `backend/.env` only |

These settings are not secret, but you need them to redeploy:

| Setting | Where |
| --- | --- |
| D1 `database_id` | `app/wrangler.jsonc` |
| `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` | `app/wrangler.jsonc` |

Your own `app/wrangler.jsonc` is never included in the zip. The zip has `app/wrangler.example.jsonc` instead, so unzipping an update cannot overwrite your settings. Keep a copy of your real `wrangler.jsonc` somewhere safe.

---

## 4. How it works

### The parts

```
  Laptop, phone          Cloudflare                          Your laptop (WSL)
 +---------------+      +------------------------------+     +------------------+
 | Study Library |----->| Access   checks who you are  |     | Processor        |
 | app (PWA)     |      | Worker   app and API         |<----| OCR, conversion, |
 | IndexedDB     |      | D1       data and job queue  |     | audio, speech    |
 | copy of data  |      | R2       PDFs, slides, audio |     +------------------+
 +---------------+      | Cron     maintenance         |        |         |
                        +------------------------------+        v         v
                                                            OpenAI     Crossref
                                                            speech     citations
```

### Sync

Every edit is saved to the device first, in IndexedDB, and added to an outbox. The outbox is sent to the Worker, which keeps the newest version of each row. This is called last-write-wins. Each row carries the time it was edited, and the later edit wins.

Every write on the server takes the next number from a global counter, called `seq`. Devices remember the highest number they have seen and ask for everything above it. Devices check for changes every 30 seconds while the app is open, and straight away when you return to it.

Notes are stored one block per row. Editing a paragraph on your phone and a different paragraph on your laptop keeps both edits.

A row with an unsent local edit keeps the local version until that edit has been pushed. Rows the server rejects are listed under **Settings**, so nothing disappears silently.

**An edit sends only what it changed.** When you change one field of a row that already exists, such as the place you stopped in a reading, the device sends just that field. The server writes just that field. So a device holding an old copy of a reading cannot put back an old title or wipe out a citation the processor found. A new row is still sent whole.

**A turned-down edit comes back.** If the server already holds a later edit to a row, it keeps its own version and sends that row back with its answer. The device takes it at once, so it never goes on showing an edit the server did not keep.

### Files

Each file is stored in R2 under the SHA-256 hash of its contents. Uploading the same file twice stores it once. Because a key never points at different contents, devices can cache files for good.

Files over 50 MB, such as lecture videos, upload in 50 MB parts. Each part finished is remembered, so a dropped connection only repeats the part in progress. Files waiting to upload are kept on the device, so uploads survive closing the app.

### The job queue

Jobs live in a `jobs` table in D1. Database triggers create them:

- Adding a PDF queues `extract_text`.
- Adding a .pptx or .docx queues `convert`.
- A recording reaching "uploaded" queues `prepare_audio`.

Jobs run in week order, AT1 first and WT11 last. Opening a reading that hasn't been processed moves its job to the front. Recordings go ahead of readings, because notes link to them straight away.

A failed job is retried after 2, 4, 8 and 16 minutes. After five attempts it is marked failed, and the app shows a **Retry** link.

A running job reports in every five minutes from a second thread. The 15-minute maintenance run puts a job back in the queue only after an hour without word, so a long transcription is never taken for a stuck one. This matters if a laptop and a server both run processors.

**Whether the processor is running.** Each time the processor asks for work, the Worker notes the time. **Settings** has a **Processor** section saying when it last asked and how much is waiting. When work is waiting and the processor has been quiet for 15 minutes, readings say "Waiting to convert" or "Waiting to add text", and recordings say "Waiting for the processor, last seen 3 hours ago". A laptop that is off no longer looks like a slow one.

### Processor jobs

| Job | What it does |
| --- | --- |
| `extract_text` | Reads each page's text for search. If more than 20 per cent of pages have no text, it queues OCR. |
| `identify` | Works out the citation from the first pages, by DOI, JSTOR cover, the title on the first page or the PDF's own fields. |
| `ocr` | Adds a text layer to scans with OCRmyPDF, in English, French and German. Pages it reads are turned upright and straightened, and two-page book spreads are split into single pages first. A text layer of scanner rubbish is read again. The original scan is then deleted. Section 19 has the detail. |
| `convert` | Turns .pptx and .docx files into PDFs with LibreOffice. The original is kept for download. |
| `prepare_audio` | Joins live recording chunks, or extracts audio from an uploaded video, into mono Opus audio. An uploaded video is then deleted. |
| `transcribe` | Splits audio into pieces of about ten minutes, each cut in a pause, and sends them to OpenAI's `gpt-transcribe` with the recording's context. The text is joined and kept on the recording. |

### Recordings

A live recording is captured in 20-second chunks. Each chunk is saved on the device before it uploads, so a crash loses seconds at most.

**The microphone is watched.** After 30 seconds of complete silence, the recording bar and the session page say "No sound for 30 seconds", which usually means the microphone is muted, unplugged or the wrong one is chosen. The warning clears as soon as sound returns. If the microphone goes away altogether, as when a headset runs out of charge, the recording stops cleanly. What was captured is kept and uploaded, and a notice offers **Record again**.

### Transcription

Recordings are transcribed with `gpt-transcribe`, the model OpenAI recommends for recorded speech and its most accurate. It costs about 27 cents an hour of audio.

- **Context.** Each recording is sent with a short description, such as "A university lecture for HY319, Napoleon and Europe, on the Concordat", and a list of words to expect: the surnames of the week's authors and the titles of its readings. Names and terms come out right more often.
- **Pieces.** A recording is split into pieces of about ten minutes, each cut in the nearest pause, so no sentence is cut in two. Each piece is told how the last one ended.
- **A retry carries on.** Each finished piece is kept in R2 until the whole transcript is saved. If piece nine of twelve fails, the retry sends only pieces nine to twelve, so nothing is paid for twice. The kept pieces are deleted once the transcript is saved.
- **Line breaks are kept.** Where the model breaks its text into lines, each line starts a new paragraph. Leaving out ums and repeats tidies each line on its own, so the breaks survive.
- **The result** is plain text, set as Moodle transcripts are: paragraphs, find, download, and leaving out ums and repeats. Search finds words in it and opens it at the passage.

The model gives no times, so features that matched words to moments have gone: time stamps beside notes, the transcript following playback, grouping by slide and marking slide changes. The audio player stays, with its speed and skip controls. Transcripts made before this version were turned into the same plain form.

`TRANSCRIBE_MODEL` in `backend/.env` chooses the model. `TRANSCRIBE_BACKEND=local` transcribes on the laptop instead, free but slower.

After you stop, the status moves through these stages:

| Status | Meaning |
| --- | --- |
| Uploading recording | Chunks are still going up from the device |
| Waiting to process | All chunks are up and the job is queued |
| Preparing audio | The processor is building the audio file |
| Transcribing | Speech to text is running |
| (nothing shown) | Done |

### Search

Search runs in two places at once. Notes, highlights and titles are searched on the device, so they work offline. Page text and transcripts are searched in D1 with full-text indexes when you're online.

Both halves read a query the same way. Every word must match at the start of a word, so "war" does not find "towards". Text in "quote marks" must match as written. Accents are ignored on the device. On the server, matching also accepts other endings of a word.

Your own highlights and notes are listed first. Page hits are grouped by reading, and each result names its module and week. Opening a page hit takes the search words into the reader and marks them.

### Finish and resilience

- **One set of rules for shared parts.** Buttons come in three kinds with one height: bordered for actions, filled for the main action on a screen, quiet for the rest. Each has the same hover, pressed and keyboard focus states. Fields, menus, popovers, dialogs and notices share one card tone, one hairline and one shadow, in every theme.
- **Feedback under the pointer.** The reading row under the pointer takes a soft wash, so it is clear what a click or drag will act on. The top bar underlines the page you are on.
- **Nothing looks empty while loading.** A notes editor that is still opening shows quiet placeholder bars, not a blank space that looks broken.
- **A failed page says so.** If a page hits an error, it says so plainly, with Reload, and reassures you that notes are saved on the device. It no longer leaves a screen that looks fine but does nothing.
- **Updates are picked up.** After a deploy, a tab opened earlier can ask for parts of the app that no longer exist, which used to stop notes from opening until a reload. The app now reloads itself once when that happens.
- **Slides beside notes.** On a session page the week's readings come first and the slides last. The slides stay in view while you write, sized so that a portrait handout fits on screen, and are redrawn when the column changes width. Nothing can pass under them.

### Recording while you use the rest of the app

A recording carries on wherever you go in the app. Leave the session page and the recording shrinks to a small bar at the foot of the screen, as a call or a voice memo does on a phone. It stays there on every page, the reader included.

- **What it shows.** The module, week and session being recorded, the time, and a small level meter that moves with the sound, so you can see the microphone is hearing the room.
- **Back to the notes.** Tap the session's name to return to its notes, where the full controls are. On its own session page the bar steps aside.
- **Pause and resume.** Pausing stops the clock and the audio together. Time spent paused is left out of the recording's length.
- **Stop asks once more.** The first tap on Stop turns it into "Tap again to stop" for three seconds, so a stray tap cannot end a lecture's recording.
- **Closing the tab asks first.** The browser asks before closing or reloading the tab mid-recording, because that would end it.

Notices and the drag grid sit above the bar, not behind it.

### Notes and highlights in one place

The reader's sidebar opens on **Notes**: the notes on that reading, which you type into like any other note. Highlights are part of them. Each highlight joins the notes as a quotation, with its colour down the side and its page number beneath.

- **Reading order.** Quotations sit in the order they come in the reading, whatever order you made them in. Page first, then down the page.
- **Your writing stays put.** A new quotation goes in before the next later quotation, never between a quotation and what you wrote beneath it. Write under a quotation, and your writing stays with it.
- **Write a note about this.** Click a highlight on the page, then this button. The notes open with the cursor on the line beneath its quotation.
- **One highlight, one quotation.** Recolour a highlight on the page and its quotation changes colour. Delete it on the page and its quotation leaves the notes, but anything you wrote beneath stays. Delete a quotation in the notes and its highlight leaves the page, with Undo in the notice.
- **The page number moves the reader.** Click "p. 12" under a quotation to go to that passage, with the highlight selected.
- **Named colours show.** A colour named in Settings, such as Evidence, appears beside its quotations.

Highlights made before this version, and those brought in from Zotero, join the notes the first time the reading opens. A comment on a highlight moves into the notes once, as a line beneath its quotation.

This is kept in step from the data, not from the screen, so a highlight made on your phone appears in the notes on your laptop too.

### Getting to your notes

**The home page opens on this week.** Each module shows a **Readings** box first: how many of this week's readings you have read, and the next one to read, which it opens in one tap. Then a box for each of its sessions this week. Tap one and you are in its notes. Each box shows how much you have written, how many questions it has and whether it was recorded. A reading week says so. Under the modules, **Recently opened** lists the readings and the notes you opened last, newest first, in one list.

The week comes from LSE's term dates. For 2026/27, Autumn Term week 1 starts on Monday 28 September 2026 and Winter Term week 1 on Monday 11 January 2027. Later years follow LSE's usual pattern: Autumn Term on the first Monday from 25 September, Winter Term fifteen weeks later. **Term dates** in Settings corrects either one, and the change syncs.

**Every week on a module page links to its notes.** Each week's row has small links for its sessions, in blue where you have written something.

**This week, everywhere.** On a module page, this week is in the accent colour in the grid of weeks and carries a **This week** tag in the list. Reading weeks are in italics, so they no longer look selected. A week page says when it runs, such as "12 to 16 Oct", beside its place in the module.

**A reading's row says how far you are.** Beside each reading: the page you reached, such as "p. 4 of 24", until it is read, and how many highlights you made, which stays after it is read.

**Go to (Ctrl K) finds notes.** Typing "319 at4 sem" and pressing Enter opens the HY319 AT4 seminar notes. Every word typed only has to appear somewhere, so short forms work.

### Seminar questions

Questions are typed straight into the list on the seminar page or the week page, as notes are. There are no menus or edit modes.

**Each answer is written beneath its question,** in the same editor as the session's notes, with headings, lists, pictures and @ citations. It is always there to type in: no label, no click through. The same answer shows on the week page, the seminar page and the question's own page, and editing it in one place changes it in all three. A quiet rule on the left ties each answer to its question and turns blue while you type in it.

- **Enter** starts the next question, splitting the current one at the cursor.
- **Backspace** on an empty question removes it. A question with an answer comes back with Undo.
- **Alt and an arrow** moves a question up or down. Up from the start of a question goes to the one before; down from the end goes into its answer.
- **Fast typing is safe.** Keys typed straight after Enter wait for the new question and go into it. Moving a question just after rewording its neighbour keeps the new wording. Both used to go wrong when typing quickly.
- **Pasting a list** is cleaned of any numbering: "1.", "2)", "(3)", "a)", bullets, "Q3:" and "Question 4:". A year at the start, as in "1949 was the turning point?", stays.

A question left empty is not kept.

### Slides beside notes

The slide fills its space, with nothing around it. Faint arrows appear on its left and right edges, with the slide number in the corner, whenever the pointer moves over it or it is tapped, and fade away again after a moment of stillness. On a touch screen, a swipe across the slide turns it too. The arrow keys work as before.

### Keeping your place

The reader keeps the exact place you stopped, not just the page.

- **What is kept.** The page, how far down it, and in text layout the character at the top of the screen. In page layout the words at the top of the screen are kept too, so text layout can open on the same line.
- **When it is saved.** A second after you stop scrolling, and at once when you switch to another app or close the reading. A phone can end a tab in the background without warning, so that save is sent straight away, in a way the browser finishes even as the tab closes.
- **Across devices and layouts.** The place syncs, so a reading left on your laptop opens on the same line on your phone. Between page and text layout it lands on the same line or the one next to it, because a line half in view at the top can count either way.
- **The text holds still.** When anything changes the length of the text, such as the font arriving, a larger text size, footnotes shown or the phone turned, the line at the top of the screen stays exactly where it is. In page layout, zooming, fitting to a new width or trimming margins keeps the same line at the top. The browser's own scroll adjustment is switched off in the reader, so only one thing ever moves the text.

Before this version, saving the page also moved text layout back to the top of that page, which was the jump you saw while reading on a phone.

### Reading as text

A PDF's pages are sized for paper, so on a phone they are either too small to read or too wide to fit. **Text** layout sets the reading as an article instead, the way a newspaper's app sets a story: one column sized to the screen, serif type with generous spacing, headings, and notes in smaller type beneath the passage they belong to. Phones open readings as text. Laptops open them as pages. Either can be changed under Aa, and on a phone with the button beside it. The choice is remembered on each device.

The text is worked out on the device, from the text the PDF already carries:

- Pieces of text are gathered into lines, and two-column pages are read left column then right.
- Running heads, page numbers and JSTOR's download notices are dropped. A JSTOR cover page is skipped.
- Lines are joined into paragraphs. The firm rule is that a paragraph never breaks in the middle of a sentence: a line that does not end a sentence always runs on into the next, across a page turn, a column break, footnotes, extra space between lines, or a word set larger than the rest.
- Where a sentence has ended, a new paragraph starts only on a clear sign: an indented first line, a wider gap, or a short last line. In ragged-right text, where short lines are everywhere, only an indent or a gap counts.
- A large first letter, a drop capital, joins the start of its paragraph.
- A line's size is the size most of its letters are set in, so one larger word does not turn a line into a heading.
- Pieces of text separated by a wide gutter are read as two columns, never as one line.
- A word split with a hyphen at the end of a line is joined again.
- Larger type becomes a heading. Smaller type becomes a footnote.
- Anything else in the top or bottom margin, such as a journal's name, a footer or a publisher's line, is left out.
- Raised footnote numbers in the text are left out, so a sentence reads straight through.

**Footnotes are hidden.** On a phone they break up the text, so text layout leaves them out. **Show footnotes** under Aa brings them back, beneath the passage they belong to.

**Scans with an OCR layer, as JSTOR provides.** A JSTOR download is a picture of each page with an invisible layer of OCR text laid over it, one word at a time. Each word has its own slightly different baseline and a guessed size and width. Text layout recognises such a page and reads it differently:

- **Lines are built a row at a time,** from words that overlap in height, whatever the gaps between them. The OCR layer's widths are guesses, so a gap between two words can look as wide as a gutter.
- **A row is split only at a real gutter.** That is either a point in the middle of the page that almost no row covers, which marks two columns, or a point where a box beside the text starts four or more rows running, as an article's Keywords beside its abstract. Each side of a gutter is read on its own.
- **A box beside the text** is read whole, as a paragraph of its own, after the text narrowed to sit beside it.
- **Words broken across lines** are rejoined where the OCR layer dropped the hyphen. That happens when the whole word appears elsewhere in the reading, or when one half is plainly not a word, such as "mis" and "taken", "histori" and "ans", "complica" and "tions".
- **Note numbers stuck to the text,** as in "1914'1" or "men'.2", are recognised as note numbers and left out, as raised ones are.
- **What a database or publisher adds** is left out: JSTOR's cover page and its download line on every page, and Taylor & Francis's contact line and copyright.
- **Type sizes are trusted less,** since the OCR layer guesses them, so only a clear difference makes a heading or a footnote.

Ordinary PDFs are read exactly as before.

**Page numbers stay.** A small "p. 12" marks where each printed page begins, so a quotation can still be cited exactly.

**Highlights work in both layouts.** Every word keeps its place on the printed page. A highlight made in text shows on the page, and one made on the page shows in the text. A highlight stops at the end of a page, as it does in page layout.

**The rest carries over.** Find, the theme, the place you stopped and the end-of-reading card all work in text. Aa offers the text size in place of zoom.

**The whole screen for reading.** On a phone, scrolling down slides the toolbar away and the text runs to the top of the screen, with no band left behind. A thin blue line across the top shows how far through the reading you are. Scrolling up brings the toolbar back.

**When text is not possible.** A scan with no text layer yet, or a document that is mostly pictures, shows as pages with a note saying why. Figures, tables and images appear only in page layout.

### Finding in a reading

The reader draws only the pages near the screen, so the browser's own find misses most of a long PDF. **Find**, Ctrl+F or `/` searches the text of every page instead. A phrase is looked for as written. If several words without quote marks don't appear together, each word is looked for separately, and the counter says so.

### Pages in each theme

In sepia, each page is laid onto the theme's warm paper: white becomes paper and ink stays dark. In dark, the page is inverted, then photographs, maps and figures are put back in their own colours. A picture covering most of a page is treated as a scan and stays darkened, because a bright scan is hard to read at night. Thumbnails and lecture slides follow the theme the same way.

### The reader's layout

The reader follows Zotero's arrangement. A toolbar of icons runs along the top: back and the sidebar on the left, then zoom, page arrows and a page box you can type into. The highlight tool and its colour sit in the middle. Appearance, find, read and the notes pane sit on the right. Hovering over any icon shows its name and shortcut.

The sidebar on the left has three tabs. **Notes** holds your notes on the reading, with its highlights in them as quotations. **Pages** shows thumbnails. **Contents** shows the PDF's own contents list when it has one. The notes button on the right of the toolbar opens the Notes tab.

With the highlight tool on, by pressing it or `H`, selecting text highlights it straight away in the chosen colour. With it off, selecting text offers the colours as before.

**Appearance**, the Aa button, holds the theme, the layout, the size and the option to trim white margins. Trimming is on by default on a phone and off on a laptop.

### Deleting and restoring

Nothing is deleted outright. A delete marks rows as deleted, and the 03:00 maintenance run removes them after 90 days.

A delete takes the thing and everything inside it in one go. Deleting a module takes its weeks, sessions, readings, highlights, notes and recordings. Deleting a session takes its slides, questions, notes and recordings, but leaves the week's readings alone. The parent is written first, so everything inside it carries a later edit time.

That ordering is what makes restoring safe. Restoring brings back the parent and anything related that was deleted at or after it. Something you deleted on its own beforehand stays deleted.

Every delete shows a notice at the foot of the screen with an **Undo** button for eight seconds. After that, **Settings** lists the last 90 days under **Recently deleted**. A reading deleted as part of a module is listed under the module, not separately. Empty sessions are not listed at all.

Files in R2 are kept. Restoring a reading therefore restores its file too.

### Themes

There are three themes, and one choice colours everything: every screen, the reader's toolbar and panes, menus, dialogs, the pages of a reading and the text layout.

- **Light** is paper white with near-black ink. It is the default.
- **Sepia** is the warm paper of the Financial Times, with brown-black ink. Panels sit a shade deeper, so they still read as separate.
- **Dark** is near-black, with pages inverted and pictures kept in their own colours.
- **Match this device** follows the device's light or dark setting, and changes when the device does.

Choose in **Settings**, or from **Aa** in the reader, which changes the same setting. The choice syncs to every device. A copy on each device applies it before the page first draws, so there is no flash of the wrong colours. On a phone, the browser's own bar takes the theme's colour too.

Every colour comes from one set of tokens at the top of `styles.css`, and each theme redefines the same set. A new screen built from the tokens follows all three themes without further work. All three pass the 4.5:1 contrast threshold for text.

### Readings name themselves

When a PDF's text is ready, the processor works out its citation from the first pages. It tries four ways, most trustworthy first:

1. A DOI printed in the PDF, looked up with Crossref.
2. A JSTOR cover page, which states the citation in fixed lines.
3. The title set largest on the first page, with the names beneath it. If Crossref has a work with that title, its full record is used. If not, the title and names are offered as they are.
4. The PDF's own title and author fields, when they look real and not like "Microsoft Word - essay.docx". These are also checked against Crossref.

No language model is used. Crossref's records are free and public, and need no key.

Everything found is put in one standard form. Authors are "Surname, I.", with two joined by "and" and more by commas and a final "and". Page ranges are shortened as reading lists write them, so 433-458 becomes 433-58. Short titles use "Chen", "Chen and Westad", or "Chen et al." for three or more.

A reading with no author or year, such as one named scan_0034.pdf, takes the details straight away when they come from a DOI, a JSTOR cover or a Crossref record. Any other keeps what you gave it, and the row shows **Details found**. Click it to see the two side by side, then **Use these details**, **Edit them first** or **Keep mine**. A dismissed suggestion is not raised again. Details read from the page layout or the PDF's own fields alone are only ever offered, because they are good guesses, not records.

The module page gathers every pending suggestion behind one button, **Details found for N readings**, for a single check with a tick box each. On a phone the row's button says just **Details**, to leave the title room.

**Edit details** says where filled-in details came from, with **Put back the old details** beside it. **Look up the details again** in a reading's menu sends it back to the processor.

On the first deploy of this version, every PDF already in the library is looked at once, after all other work.

### Transcripts from Moodle

Moodle offers a transcript with each recording. Download it, then on the session choose **Add a Moodle transcript**, or drop the file on the session. Dropping it on a week page also works: it goes to the session you drop it on, or to the week's first lecture.

The text download gives a line saying who speaks, then what they said, block after block. Study Library joins blocks from one speaker, so a turn only ends when someone else starts talking. Caption files (.vtt and .srt) are read too, with their times kept and named voices used as speaker names.

The transcript is shown turn by turn. Each speaker keeps one colour, used only for their name and the rule beside their words. Long turns are broken into paragraphs at the end of a sentence, roughly every 120 words. The short exchanges before a lecture begins are folded away, with one click to show them.

- **Speaker names.** Click "Speaker 1" to give it a name. Names are saved for that transcript and sync to every device.
- **Ums and repeats.** A tick box leaves out um, uh and er, and words said twice. It changes only what you see. The transcript keeps every word.
- **Find in transcript** marks every match. Enter steps to the next one.
- **Download** saves a plain text copy with your speaker names.
- **Search** finds words in imported transcripts, labels each hit with who was speaking, and opens the transcript at that turn.

An imported transcript is stored with the session as a recording with no audio. Its turns are kept on the recording's row and synced, so it reads offline. The server indexes each turn for search.

Transcripts of your own recordings read the same way, as plain text without speakers.

### Dragging and dropping

**Readings.** On a week page, pick a reading up and drop it where you want it. A mouse, trackpad or pen picks up after a small movement, so a plain click still opens the reading. A finger never drags: on a touch screen a finger on a list scrolls it, and each reading's ••• menu has **Move up**, **Move down** and **Move to another week or module** instead. The keyboard works too: focus a row, press Space, move it with the arrow keys, and press Space again. The rows you pass slide out of the way, so you see where it will land before you let go.

Dropping a reading in the other list changes what it is: into Primary sources makes it a primary source, and back again makes it a reading. While you drag, a grid of the module's weeks appears at the foot of the screen, with Unsorted beside it. Drop on any week to move the reading there.

On the module page, readings can be dropped on any week's row, open or closed. A floating Unsorted target appears while you drag, so the page never shifts under your pointer.

**Slides.** A session's slides on the week page move the same way. Pick slides up to reorder them, or drop them on another session to make them its slides. A session with no slides shows a place to drop while you drag. The grid of weeks appears too, so slides can go to another week, where they join that week's lecture, or to Unsorted.

**Another module.** A reading's ••• menu has **Move to another week or module**. Choose the module, then a week or its Unsorted list. The reading's highlights and notes go with it, because they belong to the reading.

Every move can be undone from the notice it leaves. A plain reorder leaves no notice, because the list already shows the result.

**Files.** Files from your computer land where you drop them. On a week page, a session makes them its slides, Primary sources makes them primary sources, and anywhere else makes them readings. A banner says what will happen before you let go, and the place is outlined. On the module page, a week's row takes them for that week.

On a session page, recordings become the session's recording and documents become its slides. Anywhere else, a short sheet asks which module and week they belong to. It starts with its best guess: the reading or session you are on, or the weeks in the file names.

### Small things that save steps

- **Home** shows how far through each module you are, and the next unread reading. "Next" starts from the week you last opened, so it follows where you are.
- **An empty module** says how to begin, and Import readings becomes its main button.
- **Question pages** link to the previous and next question, and list the week's readings. The answer is written in a box, so an empty answer still looks like a place to write.
- **Notes** say on an empty line that / opens the block menu and @ cites a reading.
- **Search** remembers recent searches, shown when the box is empty.
- **Light** is the default theme. Sepia, dark, or following the device, are choices in Settings.
- **The drag grip** takes no room. It appears in the margin when you point at a row that can be moved.
- **The keyboard section** of Settings is hidden on touch screens.

### Go to

Ctrl K, or **Go to** in the top bar, opens a box for jumping to any module, week, reading or question. Type a few letters, choose with the arrow keys and press Enter. The last line always offers to search everything for what you typed.

### Uploads

While files upload, the top bar's **Uploading** notice opens a list of them with their progress. A failed upload can be retried from there.

### Maintenance

A Cron Trigger runs every 15 minutes. It puts back any job left "running" for over an hour without reporting in. In the 03:00 UTC run, it also removes deleted rows older than 90 days and completed jobs older than 30 days, and clears search text for files and recordings that no longer exist.

**Files nothing uses.** Deleting a reading or a recording leaves its file in place, so restoring brings it back. Once nothing has pointed at a file for 30 days, not even a deleted row waiting to be purged, the 03:00 run marks the file deleted. It and its stored copy go 90 days after that. Pictures in notes are never touched, because they have no file row.

---

## 5. What you can do with it

**Organisation**

- Modules with 22 weeks each, AT1 to AT11 and WT1 to WT11, created in one step.
- Each week holds readings and its timetabled sessions: lecture, seminar, or one combined session.
- Reading weeks hold readings but no sessions.
- Each module opens at the week you last looked at, on every device.
- **Week across modules** shows one week for all modules together.

**Reading**

- A smooth PDF reader that only draws the pages near the screen.
- Find within the reading, with every match marked.
- Click the page counter to type a page number. A Contents panel appears when the PDF has its own contents list.
- At the end of a reading, one button marks it read and opens the next one in the week.
- On a phone, white margins are trimmed so text is larger, and the toolbar slides away as you read.
- Highlight colours can be given names in **Settings**, such as Argument or Evidence.
- Zoom with buttons, pinch, or ctrl and the scroll wheel. Sepia and dark themes.
- Highlights in five colours, each quoted in the reading's notes, with room to write beneath.
- Notes on each reading, in a side panel.
- Each reading reopens at the page you stopped on, and its row shows "p. 12 of 30" until you mark it read.
- **Recently opened** on the home page lists the last readings you opened on any device.
- Offline, readings not saved on that device say so.

**Notes and seminars**

- A block editor with headings, lists, tables, pictures and quoted highlights. Type `/` for the block menu and `@` to cite a reading as a link.
- Paste, drop or choose a picture to put it in a note. Drag the handles at its sides to resize it, and drag the dots in the margin to move it, as with any block. Pictures are PNG, JPEG, GIF or WebP, up to 20 MB, and need a connection to add. Once seen, they show offline.
- On a laptop, notes start at the left edge of their column. The block handles sit in the page margin.
- Seminar questions pasted straight from Moodle.
- Answered questions are marked as answered.

**Sessions**

- Session mode puts your notes beside the slides, with a record button.
- Moodle recordings can be added as files, including large videos.
- Transcripts as plain text, set in paragraphs, with find and download.
- Playback at up to twice the speed, and 15-second skips.
- The session page lists the week's readings beside your notes.

**Editing**

- Modules can be renamed, given a description, reordered on the home page and deleted. Reading weeks can be changed at any time.
- Marking a reading week clears its empty sessions and keeps any that hold notes, slides or recordings. Unmarking it gives the week the module's usual sessions.
- Sessions can be renamed, changed between lecture, seminar and combined, reordered, added and deleted.
- Readings can be downloaded, given a new file, moved, sent to Unsorted or deleted. Moving slides keeps them in a session.
- Seminar questions can be reworded, reordered and deleted. So can recordings and highlights.
- Every delete can be undone, and restored from **Settings** for 90 days.

**Getting around**

- Module codes sit in the top bar on every page.
- The module page keeps its week grid in view, and each week says in words what its sessions hold.
- **Week across modules** shows sessions, questions and recordings as well as readings. Opened from the top bar or the phone's **This week** tab, it shows this week while term runs, and says so in its heading; in the vacations it opens at the week you last chose.
- `/` opens search, or find when you're reading. On a week, `[` and `]` go to the previous and next week, and links at the foot of the page do the same.
- Each browser tab is titled with the page it shows.

**Import**

- Folder import, which reads your `(AT3) P1 Author, 'Title', date` naming convention.
- A Zotero importer that brings across files, highlights and notes.

---

## 6. Everyday tasks

### In a lecture

1. On your laptop, open the week, then the lecture, by its name.
2. Press **Record**. Allow the microphone the first time.
3. Type notes as normal. If the slides are open beside your notes, turn them with the arrow keys, the faint arrows on the slide, or a swipe.
4. You can leave the page to open readings or other notes. A bar at the foot of the screen keeps the recording in view, with pause and stop.
5. Press **Stop recording** at the end. Keep the tab open until the status reads "Waiting to process".

Check LSE's rules on recording teaching, and ask before recording seminars where classmates speak.

### A lecture you missed

1. Download the recording from Moodle.
2. Open the session and choose **Add a recording file**.
3. Take notes on the session while you watch. The recording is transcribed like a live one.

### Adding readings

- **One or two files**: drop them onto the week page, or use **Add files**.
- **A whole module**: on the module page, choose **Import readings**, then **Choose a folder**. Check the review table, then import. Each file's name is cut to two lines, in full on hover, because the columns beside it already say what it is. The **Import** button stays at the foot of the screen, however long the list. A name ending ", pp. 1-24" with no source gives pages 1 to 24; before 0.24 it put "pp. 1-24" in the source field, which showed the same but was wrong underneath.
- **Slides**: use **Add slides** on the session.

### Importing from Zotero

The importer works one Zotero collection at a time. Create the module in Study Library first. Close Zotero, then in WSL:

```
cd /mnt/c/Users/samue/Documents/Antigravity/study-library/backend
. ~/.venvs/study/bin/activate
set -a; . ./.env; set +a
python -m study.zotero --zotero-dir "/mnt/c/Users/samue/Zotero" --collection HY335 --module HY335
```

That is a dry run. Check the list, then run the same command with `--apply` added. Running it again only adds what's new and never overwrites your edits.

### Preparing for a seminar

1. On the week page or the seminar's own page, type or paste the questions straight into the list, one per line.
2. Write the answer beneath the question, on the week page or the seminar page.

### Tidying up

- **A reading in the wrong week or module**: its ••• menu has **Move to another week or module**.
- **Slides on the wrong session**: drag them to the right session on the week page.
- **A reading you don't want in any week**: **Remove from this week** sends it to Unsorted on the module page.
- **A better scan**: **Replace file** keeps the reading's details, notes and highlights. Highlights only line up if the pages match.
- **Something deleted by mistake**: press **Undo** straight away, or find it in **Settings** under **Recently deleted**.

### Tracking job applications

1. Choose **Job search** at the right of the top bar (**Jobs** on a phone).
2. Press **Add application**, or N. Type the employer and the role. It starts dated today, awaiting a response.
3. As it moves on, change its stage and set the next deadline. The page orders itself by what is due.
4. Open its Details to attach the CV and cover letter you sent, or drop a file on its slot.
5. **Back to Study Library** returns you to your modules. Section 18 has the detail.

### Reading offline

Opening a week saves its files, and the next week's, to that device. To keep every reading on your laptop, go to **Settings** and tick **Keep every reading available offline**.

---

## 7. Running and maintaining it

### Which window for which command

| Commands | Where to run them |
| --- | --- |
| `npx`, `npm`, `wrangler` | PowerShell, in `D:\Downloads\study-library\app` |
| `python`, the processor, the importer | WSL, in `/mnt/c/Users/samue/Documents/Antigravity/study-library/backend` |

### The processor

| To | Do this |
| --- | --- |
| Start it now | Task Scheduler, right-click the task, **Run** |
| Stop it until next sign-in | Task Scheduler, right-click the task, **End** |
| Stop it starting at all | Task Scheduler, right-click the task, **Disable** |
| Watch what it's doing | In WSL: `tail -f /mnt/c/Users/samue/Documents/Antigravity/study-library/backend/processor.log` |
| Run it in a window instead | In WSL: `bash /mnt/c/Users/samue/Documents/Antigravity/study-library/backend/run-processor.sh`, or run it by hand as below |

To run it by hand, with the output on screen:

```
cd /mnt/c/Users/samue/Documents/Antigravity/study-library/backend
. ~/.venvs/study/bin/activate
set -a; . ./.env; set +a
python -m study.processor
```

Add `--once` to the last line to work through the queue and stop.

`processor.log` is set aside as `processor.log.1` each time the processor starts once it passes 5 MB, so it never grows without end. One old copy is kept.

### Signing in less often

Each device asks for an emailed code when its Access session ends, seven days by default. Access allows up to a month. To change it, in the Cloudflare dashboard go to **Zero Trust**, then **Access controls**, then **Applications** (older dashboards call it **Access**, then **Applications**). Open the `study-library` application, and on its **Overview** tab choose a **Session Duration** of 1 month. A policy can set its own session duration, which wins over the application's, so open the **Cloudflare account** policy and check it is left at the application's value. A longer session means a lost or stolen device stays signed in for longer. If that happens, revoke its session under **Zero Trust**, then **My Team**, then **Users**.

### Updating the code

When you receive new code:

1. Unzip it over `D:\Downloads\study-library`. Your `wrangler.jsonc` and `.env` aren't in the zip, so they stay as they are.
2. In PowerShell, in `app`:

```
npm install
npm run deploy
```

This builds the app, applies any new database migrations and deploys the Worker.

3. In WSL, refresh the processor's dependencies:

```
cd /mnt/c/Users/samue/Documents/Antigravity/study-library/backend
. ~/.venvs/study/bin/activate
pip install -r requirements.txt
```

4. In Task Scheduler, **End** the task, then **Run** it.

**Version 0.31 has a migration, 0011.** `npm run deploy` applies it. It rebuilds three tables (weeks, sessions and notes) so they accept sections, supervision meetings and section notes, copying every row with its data unchanged; modules gain a kind and key dates. Existing modules stay taught. A device still on an older version keeps working: the server now writes only the columns a device sends, so a column a device does not know about takes its default.

**Version 0.30 needs no migration, and removes one file.** Delete `app\src\components\QuestionPage.tsx` before deploying, then restart the processor's task, as its OCR changed. To read your existing scans again with the new OCR, choose **Read every scan again** under **Processor** in Settings (section 19 explains).

**Version 0.29 needs no migration.** It changes only how the app looks.

**Version 0.28 needs no migration.** It changes only the app.

**Version 0.27 needs no migration, but the laptop needs two language packs.** For OCR in French and German, and for cleaner reading of scans, run this once in WSL:

```bash
sudo apt install -y tesseract-ocr-fra tesseract-ocr-deu unpaper
```

Then restart the processor's task. Without the packs, OCR carries on in English. To choose the languages yourself, set `OCR_LANGUAGES` in `backend/.env`, such as `eng+fra+deu+ita` (each needs its `tesseract-ocr-` pack). `SPLIT_SPREADS=false` turns off the splitting of two-page spreads.

**Version 0.26 needs no migration.** It changes only the app.

**Version 0.25 needs no migration either.** Answers are stored as they always were, so existing answers appear beneath their questions straight away.

**Version 0.24 needs no migration.** It changes only the app. Deploy as usual.

**Unzipping over the folder never deletes anything.** If a version removes a file, delete it by hand before deploying, or the build can fail on the old copy. Version 0.22 removed `app/src/lib/transcripts.ts`. Version 0.23 removes nothing.

**Version 0.23 adds the job search.** Its migration, `0010_job_search.sql`, only adds a table and your two starting applications, so nothing existing changes. The processor needs no restart for it.

**Version 0.22 removes four columns.** Its migration, `0009_drop_time_stamps.sql`, drops `summary` and `slide_marks` from recordings and the old recording times from note blocks. Nothing has used them since 0.20, but any summaries written before 0.11 go with them. D1 keeps 30 days of history, so the time-travel restore under **Backups** can bring them back if you ever need to. Restart the processor after this update too, because its routes for summaries and old transcripts are gone.

You only need to deploy after a code update or a change to `wrangler.jsonc`. Setting a secret with `wrangler secret put` takes effect without a deploy.

### Rebuilding the processor from scratch

If WSL is reset, the code and `.env` on D: survive. Only the Python environment needs rebuilding. In WSL:

```
cd /mnt/c/Users/samue/Documents/Antigravity/study-library/backend
bash setup-wsl.sh
```

### Backups

- **Database**: D1 keeps a full history for 30 days. To restore to a moment, run this in PowerShell, in `app`, using a time in UTC:

```
npx wrangler d1 time-travel restore study-library --timestamp=2026-10-07T12:00:00Z
```

- **Files**: R2 objects are never overwritten, because each is stored under its hash.

### Rotating secrets

| Secret | How to replace it |
| --- | --- |
| `PROCESSOR_KEY` | Generate one in WSL with `python3 -c "import secrets; print(secrets.token_hex(32))"`. Set it with `npx wrangler secret put PROCESSOR_KEY` in PowerShell, put it in `.env`, then restart the task. |
| Service token | In Zero Trust, generate a new secret for `study-library`, or create a new token and update the Service Auth policy. Put both values in `.env`, then restart the task. |
| API key | Create a new one in the OpenAI console, put it in `.env`, then restart the task. |

Service tokens expire after the period chosen when they were made. If the processor's log suddenly shows a 403 or "redirected" months from now, renew the token.

### Moving the processor to a server

To process recordings while the laptop is off, run the processor on a small Linux server with 2 CPUs and 4 GB of memory. On the server:

```
curl -fsSL https://get.docker.com | sh
```

Copy the `backend` folder and `.env` across, then run `docker compose up -d --build` in that folder. Then disable the Task Scheduler task on the laptop. Two processors at once is safe, but pointless.

---

## 8. Troubleshooting

Every problem met during setup, and its fix.

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Bindings must have unique names" | Wrangler named both bindings `study_library` when adding them | Set the D1 binding to `DB` and the R2 binding to `BUCKET` in `wrangler.jsonc` |
| "Invalid uuid", code 7400 | The placeholder text was used as the database ID | Get the real ID from `npx wrangler d1 list` |
| `wrangler secret put` creates an oddly named secret | The value was typed where the name goes | Run `npx wrangler secret put PROCESSOR_KEY`, then paste the value when asked |
| "Assertion failed ... async.c" after a Wrangler error | A known Node crash on Windows as Wrangler exits | Harmless. Fix the error above it |
| Laptop restarts when Docker Desktop opens | A virtualisation fault on this laptop | Don't use Docker here. Run the processor in WSL |
| WSL closes with "Failed to attach disk ... ERROR_PATH_NOT_FOUND" | A Linux install was registered but its disk file had gone | `wsl --unregister` the broken one, then `wsl --install -d Ubuntu-24.04` |
| `ensurepip` fails, then "externally-managed-environment" | The Python environment was built on the Windows drive | Build it at `~/.venvs/study` instead |
| "./.env: No such file or directory", then `KeyError: 'STUDY_URL'` | The settings file didn't exist yet | `cp .env.example .env`, then fill it in with `nano .env` |
| Keys fail although they look right | `.env` was edited in Windows Notepad, which adds hidden line endings | `sed -i 's/\r$//' .env` |
| Processor log shows 403 and a Cloudflare Access page | Access rejected the service token | Attach the Service Auth policy to the Worker, check the token values |
| Processor log shows 401 "Processor key missing or wrong" | `.env` and the Worker secret don't match | Set a fresh key in both places |
| `cd D:\...` fails in WSL | A Windows path typed into Linux | Use `/mnt/d/...` in WSL, or run the command in PowerShell |
| `chmod` refused on the start script | Files on D: don't support Linux permissions | Skip it. Run the script with `bash` |
| "Sync problem" in the app | Usually the Access values in `wrangler.jsonc` are wrong, or weren't deployed | Check `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`, then `npm run deploy` |
| "Your Cloudflare Access session has ended" | The 7-day session ran out | Press **Reload** and enter the emailed code. Unsent edits are kept |
| Readings stay at "Adding text" or "Converting" | The processor isn't running | Check the task, and `processor.log` |
| "Waiting for the processor, last seen ..." | The processor has not asked for work for 15 minutes or more | Start the task, or open the laptop. **Settings**, under **Processor**, shows how much is waiting |
| "No sound for 30 seconds" while recording | The microphone is muted, unplugged or not the one chosen | Check the system's input and the browser's microphone choice. The warning clears when sound returns |
| A recording ends at "Processing failed" | Usually no OpenAI key, or no credit | Add the key or credit, restart the task, then press **Retry** |

---

## 9. Costs

All estimates. Check current pricing.

| Item | Cost |
| --- | --- |
| Cloudflare Workers, D1, Access and Cron | Free tier. The processor's polling uses about 8,600 of the 100,000 free daily requests. An open app adds one status check a minute |
| Cloudflare R2 | Free up to 10 GB. A year of readings and audio fits within that |
| Transcription | About 27 cents (roughly 21p) per hour of audio with `gpt-transcribe` |
| Naming readings | Free. Crossref's public records need no account |
| Processor | Free on your laptop. A server would be around £4 to £5 a month |

---

## 10. Decisions and why

| Decision | Reason |
| --- | --- |
| Last-write-wins sync | One person rarely edits the same thing on two devices at once. It is simple and predictable. |
| Notes stored one block per row | A conflict only affects one paragraph. Moving a block rewrites one row. |
| Everything is read as a PDF | One viewer to build. Slides and Word files get highlighting for free. |
| The week is the unit of organisation | It matches how the course is taught and replaces the `(AT1)` title prefixes. |
| Weeks contain sessions | Handles modules with a separate lecture and seminar, and modules with one combined session. |
| Show what exists, hide what doesn't | Sparse weeks look finished rather than broken. |
| Typographic lists, not cards | Lists shorten cleanly. Card grids show holes. |
| Every page knows the week, none jumps to it | Since 0.21 the home page opens on this teaching week, from LSE's term dates. Since 0.24 the module page marks it and each week page gives its dates. Module and week pages still open where you were. |
| Edits sent as patches of the columns they changed | A full row from a device with an old copy would undo changes it never saw. A patch only carries what you did. |
| No hash check on uploads in the Worker | The Workers Free plan allows 10 ms of CPU a request, and hashing a 50 MB part takes far longer. The app computes each hash itself. |
| The reader loads on demand | pdf.js is the largest part of the app. Loading it with the first reading made the home page open faster on a phone. |
| A fresh service worker cache for each build | Each deploy gets its own cache, filled with every script at install, so the whole app works offline straight after an update. Old caches are deleted, keeping only the one before for a tab still open on it. |
| Cloudflare instead of Supabase and Vercel | One provider and one deployment, mostly on free tiers. |
| D1 with a global sequence counter | Pulling becomes "everything above this number", with nothing missed. |
| No foreign keys in D1 | Rows arrive from several devices in any order. A missing parent just means the row isn't shown. |
| Vite and React instead of Next.js | The app is one client-side page, so it can run offline. Next.js would need an adapter on Cloudflare. |
| No sign-in screen, Cloudflare Access instead | Private without an account system. Each device signs in once a week. |
| The Worker checks the Access token itself | The API stays closed even if Access is switched off by mistake. |
| Files keyed by content hash | Duplicates cost nothing, and caching is always safe. |
| Large uploads in 50 MB parts | A Worker request is limited to 100 MB. Parts also resume after a dropped connection. |
| Processor talks only to the Worker's API | It needs no database or storage credentials. It can run anywhere. |
| Processor in WSL instead of Docker | Docker Desktop crashed this laptop. |
| The laptop records, not the phone | Web apps on phones can be stopped when the screen locks. |
| Recordings captured in chunks saved locally | A crash or bad wifi loses seconds, not a lecture. |
| A second Zotero import never overwrites | Edits made in Study Library are always kept. |
| OCR deletes the original scan | The OCR output keeps the original images, so nothing is lost. |

---

## 11. Code map

```
study-library/
  DEBRIEF.md                   this document
  README.md                    short setup guide
  docs/original-plan.html      the first plan, before the move to Cloudflare
  shared/title-fixtures.json   test cases shared by both title parsers

  app/                         the app and the Worker
    wrangler.example.jsonc     copy to wrangler.jsonc and fill in
    migrations/                D1 schema, applied in order by npm run deploy
    worker/                    the Cloudflare Worker
      index.ts                 routes
      auth.ts                  Access token and processor key checks
      sync.ts                  push and pull
      schema.ts                which columns each table accepts
      files.ts                 uploads, downloads and range requests
      recordings.ts            recording chunks, transcripts and retries
      search.ts                full-text search
      processor.ts             endpoints for the processor
      maintenance.ts           the Cron Trigger's work
    src/                       the React app
      App.tsx                  routes, the top bar and shortcuts
      components/              each screen
        reader/pages.tsx       drawing pages, page colours, trimmed margins, find marks
        reader/Sidebar.tsx     the reading's notes, page thumbnails, contents
        reader/TextView.tsx    a reading set as an article
        icons.tsx              the toolbar's line icons
        Menu.tsx               the ••• menu used on every row
        WeekBoard.tsx          dragging readings on a week page
        DropAnywhere.tsx       files dropped outside a week or module page
        Palette.tsx            Go to, on Ctrl K
        RecorderPill.tsx       the recording bar shown on every page
        QuestionList.tsx       seminar questions typed in place
        SlideBoard.tsx         dragging slides between a week's sessions
        JobsPage.tsx           the job search: the table, the cards and Details
        ErrorBoundary.tsx      the page shown when something fails, and the notes loading state
        TranscriptView.tsx     an imported transcript, turn by turn
        Overlays.tsx           the undo notice and confirmation dialog
        ModuleSettings.tsx     editing and deleting a module
      lib/
        db.ts                  the IndexedDB store
        edits.ts               deleting, restoring and reordering
        ui.ts                  notices, dialogs, tab titles
        appearance.ts          light, dark or the device's setting
        transcriptImport.ts    reading Moodle transcripts and caption files into turns
        reflow.ts              turning PDF pages into headings, paragraphs and notes
        term.ts                which teaching week it is, from LSE's term dates
        readingNotes.ts        keeping a reading's highlights in its notes, in reading order
        citations.ts           using, keeping or undoing citations found in PDFs
        moves.ts               moving and reordering readings, with undo
        settings.ts            synced settings, such as highlight colour names
        status.ts              whether the processor is running
        jobs.ts                the job search's stages, deadlines, order and files
        sync.ts                outbox, push and pull
        library.ts             data for each screen
        importing.ts           turning files into readings
        uploads.ts             the upload queue
        recorder.ts            live recording
        notes.ts               saving notes block by block
        parse.ts               the (AT1) title parser
        search.ts              local and server search
    public/sw.js               service worker for offline use
    tests/run.ts               unit tests
    tests/e2e/                 browser tests

  backend/                     the processor and the Zotero importer
    run-processor.sh           starts the processor in WSL
    setup-wsl.sh               one-time WSL setup
    .env.example               the processor's settings
    Dockerfile                 for running on a server
    study/
      api.py                   client for the Worker's API
      parser.py                the (AT1) title parser, in Python
      blocks.py                Zotero note HTML to editor blocks
      keys.py                  position keys that match the app's
      processor/jobs.py        the six job types
      processor/speech.py      transcription
      processor/identify.py    finding a reading's citation in its first pages
      zotero/                  the Zotero importer
    tests/                     integration tests against a local Worker
```

---

## 12. Data model

Every synced table has `id`, `modified_at`, `seq` and `deleted`.

| Table | Holds |
| --- | --- |
| `modules` | Code, title, session pattern, description, the week last opened |
| `weeks` | Term, number, title, whether it is a reading week |
| `sessions` | Lecture, seminar or combined, for one week |
| `files` | Hash, storage key, type, size, processing status |
| `items` | A reading, primary source or slide deck, with its citation details, last page, when it was last opened, and any citation found in its PDF |
| `week_items` | Places an item in a week, and in a session for slides |
| `questions` | Seminar questions for a session |
| `highlights` | Page, rectangles in PDF points, colour and comment. A column for filing under a question remains from earlier versions, unused |
| `recordings` | Source, audio file, duration, status, and the transcript as turns: plain text for your own recordings, speakers and text for one from Moodle |
| `notes` | Attached to exactly one session, reading or question |
| `note_blocks` | One editor block each, and the highlight it quotes if it is a quotation |
| `settings` | Settings that follow you across devices, such as highlight colour names |
| `applications` | The job search: employer, role, date applied, stage, next deadline, notes, and the four file slots, one JSON column each |

Server-only tables: `page_text` and `transcript_text` for search, `jobs` for the queue, `counters` for `seq`.

---

## 13. API reference

Every route sits behind Cloudflare Access. Processor routes also need the `X-Processor-Key` header.

**App routes**

| Route | Purpose |
| --- | --- |
| `GET /api/ping` | Checks the API is reachable |
| `GET /api/status` | When the processor last asked for work, and how many jobs are waiting, running or failed |
| `POST /api/sync/push` | Sends edits, each a whole row or a patch with `cols`. Returns rows that were rejected, and under `current` the server's own version of rows where it held a later edit |
| `GET /api/sync/pull?since=N` | Returns rows written after `seq` N |
| `PUT /api/files/:sha` | Uploads a file of up to 50 MB |
| `POST /api/uploads` | Starts a multipart upload |
| `PUT /api/uploads/:id/:part` | Uploads one part |
| `POST /api/uploads/:id/complete` | Finishes a multipart upload |
| `GET /api/objects/*` | Downloads a file. Supports range requests. Pictures in notes are served from here too. With `?name=`, the browser shows and saves it under that name, as the job search's files are |
| `POST /api/files/:id/bump` | Moves a file's jobs to the front |
| `POST /api/files/:id/retry` | Retries a failed file |
| `POST /api/files/:id/identify` | Looks at a PDF's first pages again for its citation |
| `PUT /api/recordings/:id/chunks/:n` | Uploads a live recording chunk |
| `POST /api/recordings/:id/retry` | Retries a recording from where it stopped |
| `GET /api/search?q=&limit=` | Searches page text and transcripts. Returns `more` when there are further results |

**Processor routes**, under `/api/processor`

| Route | Purpose |
| --- | --- |
| `POST /claim` | Takes the next job |
| `POST /jobs/:id/complete` and `/fail` | Reports a job's result |
| `POST /jobs/:id/heartbeat` | Says a long job is still running |
| `GET /files/:id` | Reads a file's details |
| `GET`, `PUT`, `DELETE /objects/*` | Reads, stores and removes stored files |
| `POST /files/:id/text`, `/needs-ocr`, `/replaced`, `/converted`, `/failed` | Saves file processing results |
| `GET /recordings/:id` | Reads a recording, its file and its chunks |
| `POST /recordings/:id/status`, `/audio`, `/transcript` | Saves recording processing results |

---

## 14. Tests

| Suite | Covers | How to run |
| --- | --- | --- |
| App unit tests | Title parsing, display titles, position keys, question splitting, which columns an edit sends, transcript paragraphs and tidying | In `app`: `npm test` |
| Backend integration tests (70) | Sync rules and patches, job order, OCR, conversion, recordings, transcription that resumes, heartbeats, the storage sweep, multipart uploads, range requests, search, the Zotero importer | In `backend`: `pip install -r requirements-dev.txt`, then `pytest` |
| Phone browser test | The tab bar and its sections, the slim top bar, the tab bar stepping aside while typing, 16px fields, the Evidence link without hover, menus as sheets, swiping between weeks, the reader's toolbar at 44 points, highlighting by finger with Whole sentence, a low selection kept in view, and the installable app | `python tests/e2e/test_mobile.py http://127.0.0.1:8790` |
| Photos browser test | Two pictures added together become one two-page PDF reading on the device, and OCR reads both, one taken sideways | `python tests/e2e/test_photos.py http://127.0.0.1:8790` |
| Job search browser test | Getting there and back, the default order, stage colours and deadline words, adding and editing in the table, an empty new application let go, attaching, linking and dropping files, filter, find and order, delete with Undo and restore, the phone cards with 44-pixel targets, and the study side unchanged | `python tests/e2e/test_jobs.py http://127.0.0.1:8790` |
| Slides and modules browser test | Slides reordered and dragged between sessions with Undo, a reading moved to another module, the processor's status in Settings, a stale device saving its place without undoing a name found on the server | `python tests/e2e/test_slides_and_modules.py http://127.0.0.1:8790` |
| Browser tests | The whole app in Chromium, including a live recording with a fake microphone | See `app/tests/e2e/README.md` |
| Features browser test | Find, search, recently opened, page colours, contents, recordings, the notes menus, colour names and the phone reader. Run after the sessions test | `python tests/e2e/test_features.py http://127.0.0.1:8790` |
| Themes browser test | Light, sepia and dark checked on Settings, a week, the reader's toolbar, sidebar and pages, and text layout; Aa changing the whole app | `python tests/e2e/test_themes.py http://127.0.0.1:8790` |
| Recording bar browser test | Recording on, moving round the app and into the reader, the level, pause, the close-tab guard, stopping from the bar, the phone | `python tests/e2e/test_recording_bar.py http://127.0.0.1:8790` |
| Answers browser test | Answers typed beneath both questions and saved, down from a question into its answer, rewording a question leaving its answer alone, the same answers on the seminar and question pages, and the phone layout | `python tests/e2e/test_answers.py http://127.0.0.1:8790` |
| Dissertation browser test | Creating a dissertation, sections renamed, added and moved, section readings and notes, a supervision meeting, key dates counting down on the home page, a file named for a section, search on section notes, deleting a section, changing a taught module, and the phone | `python tests/e2e/test_dissertation.py http://127.0.0.1:8790` |
| Consistency browser test | Slides added on a lecture's own page and listed with their menu, the session menu, renaming a session by its name, going on to the next session, Back from slides to their session, Edit details from the reader, and reading menus on the module page and Week across modules | `python tests/e2e/test_consistency.py http://127.0.0.1:8790` |
| UX browser test | The import table and its bar, page ranges read as pages, this week marked on the module and week pages, week dates, highlight counts, the home page's Readings tile, Go to closing with one Esc, and Jobs on a phone's first row | `python tests/e2e/test_ux.py http://127.0.0.1:8790` |
| Notes access browser test | This week on the home page, session links on the module page, notes in Go to, term dates, the fading slide arrows and typed questions | `python tests/e2e/test_notes_access.py http://127.0.0.1:8790` |
| Paragraphs browser test | An article with every printed hazard: a drop capital, extra line space mid-sentence, a larger word, a paragraph over a page turn with footnotes between, a sentence across two columns, ragged-right text | `python tests/e2e/test_paragraphs.py http://127.0.0.1:8790` |
| Reading place browser test | The exact line kept on reload, through zooming and larger text, carried from laptop pages to phone text, steady while saving, and saved when the app goes to the background | `python tests/e2e/test_reading_place.py http://127.0.0.1:8790` |
| Reading notes browser test | Quotations in reading order, writing under a highlight, colour and deletion in step both ways, undo, old comments moving in, the phone | `python tests/e2e/test_reading_notes.py http://127.0.0.1:8790` |
| Text view browser test | A phone opening a reading as text: paragraphs, headings, notes, page numbers, joined hyphens, highlights in both layouts, text size and the place kept | `python tests/e2e/test_textview.py http://127.0.0.1:8790` |
| Citations browser test | A scan named scan_0034.pdf naming itself, a suggestion offered, checked on the module page, and put back | `python tests/e2e/test_citations.py http://127.0.0.1:8790` |
| Transcripts browser test | Importing the Moodle transcript in `fixtures`, turns, paragraphs, speaker names, find, tidying and search | `python tests/e2e/test_transcripts.py http://127.0.0.1:8790` |
| Usability browser test | Home progress and next reading, question links, the notes placeholder, recent searches, an empty module, light by default. Run after the sessions test | `python tests/e2e/test_usability.py http://127.0.0.1:8790` |
| Dragging browser test | Reordering, changing list, moving weeks, undo, the module page, file drops on weeks, sessions and the home page, Go to | `python tests/e2e/test_dragging.py http://127.0.0.1:8790` |
| Editing browser test | Editing, deleting, undo and restore for modules, weeks, sessions, readings and questions, at desktop and phone widths | `python tests/e2e/test_editing.py http://127.0.0.1:8790` |

The integration and browser tests start the Worker locally with its own empty database. They never touch your live data. OCR and conversion tests run only when OCRmyPDF and LibreOffice are installed.

---

## 15. Design rules

From version 0.29 the app follows the tools it stands in for: Zotero's library, Notion's notes and Word's page.

- **Quiet chrome, type leads.** The interface recedes. Sections are set apart by their headings and by space, not by ruled lines.
- **One bold element: page titles.** Titles are set in Literata's display cut ("Literata Display", its optical-size design at large sizes), finer and higher in contrast, as a book sets a chapter opening. Reading text stays in Literata's reading cut, and the interface in IBM Plex Sans.
- **Soft surfaces, shaped by hierarchy.** Controls are lightly rounded (6 pixels), surfaces such as tiles, session panels and menus a little more (10), sheets and dialogs most (14). Resting surfaces have no shadow; only what floats above the page (menus, dialogs, notices) casts one.
- **Buttons.** The page's main action is filled with the accent. Other buttons are soft grey surfaces, not outlines. Minor actions are plain text that lifts on hover.
- **One look for "selected".** A soft accent fill with accent text: the current module or page in the top bar, this week in the week grids, the week chosen in Week across modules. A segmented control shows its choice as a raised white button.
- **One accent.** The blue marks links, the current choice, focus and primary buttons. Red marks deleting and problems only. The job search's stage chips are the one exception, a set of status colours confined to that part of the app (section 18).
- **Sentence case, and no middle dots.** No labels in capitals. Details are joined by commas or set apart by space.
- **Rows lift on hover.** Lists of readings, modules and recent items are flat; the row under the pointer takes a soft surface.
- **Titles in typographic quotes,** one date style, drawn icons only, and native controls that follow the theme, as before.
- **Square corners are gone.** Earlier versions used them throughout; they read as a newspaper rather than a desk.

## 16. Known limits and next steps

**Limits**

- Recording is meant for the laptop. On a phone, Android may stop a web app recording when the screen locks.
- Processing only happens while your laptop is on.
- The Zotero importer needs each module's items in a Zotero collection.
- Changes from another device appear within 30 seconds, not instantly.
- Seminar answers and session notes can't yet be exported to Word.
- Moodle's speaker detection sometimes splits a sentence across two speakers, or gives one person two numbers. The import keeps what Moodle wrote.
- Leaving out repeats also joins words that were meant twice, such as "had had". Untick the box to read every word.
- Text layout works from the PDF's own text. Unusual layouts, such as three columns, sidebars or text set in boxes, may come out in an odd order. Page layout always shows the original.
- Settings may show "Nothing deleted" for a moment on a new device, until the first sync finishes.
- Find can't mark a match that is split across two runs of text in the PDF. It still counts and jumps to it.
- Trimmed margins use the text on the first six pages. A reading whose layout changes later may lose a little at the edges. Zooming turns trimming off.
- Last-write-wins still decides between two edits to the same row. If a phone left offline for a day sends an edit older than one made since on the laptop, the phone's edit is turned down even if it changed a different field. The phone then shows the laptop's version.
- The microphone warning only notices complete silence. A microphone that works but is pointed the wrong way still records a quiet room without warning.
- The processor's status is how long since it last asked for work. It cannot tell a processor that is running but failing every job; those jobs show **Retry** as before.
- The browser tests drive a real mouse and keyboard, so a few steps are sensitive to timing. In the 0.22 runs, `editing` passed eight times in nine on its own, the miss being a week shortcut pressed straight after a menu closed. `dragging` sometimes fails in the full suite and passes alone. The new slides test passed five times in six; the miss was waiting for a notice after a mouse drag.

**Possible next steps**

- Move the processor to a small server, so recordings are processed while the laptop is off.
- A native Android build, if recording on the phone becomes necessary.
- Export of notes and answers to Word, for essays and revision.
- An audit of the empty states once a full term of real data is in.
- Accessibility and touch improvements from the October 2026 review:
  - Make editable titles (week and session headings) and reading highlights focusable and operable from the keyboard.
  - Turn the highlight popover into a sheet on mobile with dialog semantics, focus management and Escape dismissal.
  - Pass the screen-reader label to the note editor DOM and label the session rename input.
  - Correct the heading order on the home page so the h1 heading precedes subordinate sections.
  - Add arrow navigation to menus and sidebar tabs, give slide canvases an image role, and replace the middle dot in transcript meta.

**Layout and behaviour audit fixes (October 2026)**

- Fixed top bar wrapping and sideways scrolling on tablet viewports by condensing navigation labels and wrapping controls.
- Added visible Cancel and Close controls to module creation and the Go to palette.
- Added one-tap clear buttons to search inputs on the Search page and in the Go to palette.
- Prevented duplicate records on Save and Add buttons by disabling buttons immediately on the first tap, and verified phone application cards in regression checks.
- Unified overlay back handling into a single `useCloseOnBack` hook across all menus, dialogs, sheets and panels, preventing duplicate `history.back()` calls and closing overlays cleanly before leaving the page.
- Coordinated overlay transitions so opening an editor, picker or dialog directly from a menu hands over the overlay history entry without collision.
- Ensured navigation from open overlays replaces the top overlay entry, leaving no spare entries in session history.
- Restored focus to opening triggers when closing dialogs, sheets and menus without interrupting edit triggers.
- Guaranteed full text availability via title attributes on truncated text elements.
- Enlarged all interactive controls on touch screens to meet the 44-point minimum hit target, replacing input pseudo-elements with enlarged label wrappers for Safari compatibility.
- Cleaned duplicated opacity rules for quotation action buttons and updated backend WSL paths.
- Established automated layout audit regression tests across 320, 390, 768 and 1280 viewports, added virtualenv binaries to the test runner PATH, and added `test_back.py` and `audit_layout` to the default e2e suite.

## 17. Version history

| Version | What changed |
| --- | --- |
| 0.1 and 0.2 | The library, the reader, notes, recordings and sync |
| 0.3 | Editing, deleting and restoring |
| 0.4 | The reader and search reworked |
| 0.5 | A reader layout modelled on Zotero's |
| 0.6 | Pictures in notes and a light mode setting |
| 0.7 | Dragging and dropping everywhere |
| 0.8 | A usability pass across the rest of the app |
| 0.9 | Transcripts imported from Moodle |
| 0.10 | Readings name themselves |
| 0.11 | Every use of the Claude API removed |
| 0.12 | Readings set as text to fit a phone |
| 0.13 | One theme for the whole app |
| 0.14 | A reading's notes hold its highlights |
| 0.15 | A recording carries on while you use the rest of the app |
| 0.16 | A finishing pass on the interface and its resilience |
| 0.17 | Footnotes and page furniture cleared out of text layout |
| 0.18 | The exact place you stopped kept, and the text held still |
| 0.19 | A paragraph in text layout never breaks mid-sentence |
| 0.20 | Transcription with OpenAI's most accurate model |
| 0.21 | Lecture and seminar notes one tap from the home page |
| 0.22 | Edits sent as patches; two seminar question bugs fixed; slides dragged between sessions; readings moved between modules; the processor's status shown; the microphone watched; transcription that resumes; unused files cleared; the reader loaded on demand; a fresh cache for each build; the columns from the time-stamp era removed |
| 0.23 | The job search, a separate part of the app for applications |
| 0.24 | A pass as a user: this week marked everywhere, readings on the home page, highlight counts, a compact import table, page ranges parsed properly, Go to closing with one Esc, and Jobs always reachable on a phone |
| 0.25 | Seminar answers written beneath their questions, in the notes editor |
| 0.26 | A polish pass: dark-mode controls fixed, curly quotation marks, one date style, one selected style, drawn icons, one recent list, pasted questions cleaned of every numbering, accessibility fixes, dead code removed |
| 0.27 | The phone: a tab bar, touch targets, sheets, finger highlighting, no touch dragging, photos as readings, the job search on phones, OCR that turns, straightens, splits spreads and reads French and German, and text layout that reads JSTOR's OCR-layered scans properly |
| 0.28 | Consistency: a session's page does what its row does, a reading's menu is the same everywhere and in the reader, Back from slides goes to their session, one link into each session, and Week across modules opens on this week |
| 0.29 | A redesign: display titles, soft surfaces, one look for selection, soft buttons, sentence case, and the reader holding its place through late fonts |
| 0.30 | Every scan read again on request, smooth highlights with no gaps, and evidence removed from questions |
| 0.31 | Dissertation modules: sections you name, section notes, supervision meetings, key dates counting down on the home page, and Change to a dissertation |
| 0.31.1 | An accessible h1 heading for the reader in page layout, a relative path for the processor script, and enforced LF line endings for shell scripts |
| 0.31.2 | Quotation deletion and note editing fixes in the reader: restoring highlights on editor undo (Ctrl+Z), protecting drafted text from background sync replacement, quiet hover-revealed quotation action buttons on laptops with 44-point touch targets on phones, and interactive-widget=resizes-content for virtual keyboards |
| 0.31.3 | Layout, behaviour and back-gesture fixes: single useCloseOnBack hook closing menus, dialogs, sheets and panels without duplicate history back calls, navigation from open overlays replacing entries with no spare history, 44-point touch targets for breadcrumbs, week nav and inputs, Safari checkbox label tap enlargement, duplicate item prevention on rapid double tap, and focused layout audit regression tests |

## 18. The job search

A separate part of the app for managing job applications. It shares the app's sign-in, sync, storage and look, and nothing else. The study side does not read it, search it or process its files.

### Getting there and back

**Job search** sits at the right of the study top bar, set apart by a thin rule. On a phone it is **Jobs**, on the first row opposite the brand, so it is never pushed out of sight by the row of other links. Inside the job search, the top bar shows only **Job search** and **Back to Study Library**, so it is always clear which part you are in. Its address is `/?v=jobs`, so it can be bookmarked or added to a phone's home screen on its own.

### What an application holds

| Field | Notes |
| --- | --- |
| Employer and Role | Required. A new application left with neither is let go when you leave it |
| Applied | The date you submitted. A new one starts today |
| Stage | One of 16 stages, each in one of four categories |
| Next deadline | Optional. Whatever is due next: an online test, a HireVue, an interview |
| Notes | Contacts, interview times, what they asked. Not in the spreadsheet; added because there was nowhere else for it |
| Files | Four slots: CV, cover letter, role description, and answers to questions |

Dates are stored as YYYY-MM-DD and shown as "26 Feb 2026". Deadlines compare dates, not times, so one due today never turns overdue in the afternoon.

### Stages

Stages are stored by key, such as `oa_todo`, with the wording in `src/lib/jobs.ts`. A stage can be reworded there without touching any data.

| Category | Colour | Stages |
| --- | --- | --- |
| To do | Amber | OA: to complete; HireVue: to record; Interview, Assessment centre and Final interview: to prepare and attend |
| Waiting | Blue | Applied: awaiting response; each "done, awaiting result" |
| Offer | Green | Offer: to accept or decline; Accepted |
| Closed | Grey | Rejected; Withdrawn; No response |

### Deadlines

A deadline before today is overdue, in red with bold type. One from today to seven days ahead is due soon, in amber. Each also says so in words, such as "overdue by a day", "today" or "in 3 days", so the colour never carries the meaning alone. A closed application never shows its deadline as due, so a rejection cannot sit there in red.

### Order, filter and find

The page opens in this order: open applications by next deadline, soonest first; then open ones with no deadline, newest first; then closed ones, newest first. **Order** also offers date applied and employer. **All**, **Open** and **Closed** filter the list, each with its count. The search box finds an employer, role, stage or anything in the notes; press / to reach it and Esc to clear it. A line under the heading counts what is open, overdue, due within a week, offered and closed.

### On a wide screen and on a phone

On a screen wider than 60rem, the job search is a table you edit in place. Its two-row header, with **Files** over CV, CL, RD and Qs, stays in view under the top bar as you scroll, as the frozen panes did in the spreadsheet. Employer and role wrap rather than being cut off. A date opens the browser's own picker when clicked, or can be typed from the keyboard. The stage is a menu of all 16.

On a phone, each application is a card showing the employer, stage, role, date applied, deadline and the four file marks. Tapping a card opens it to edit everything; the summary lines step aside so nothing shows twice. Each file slot is one line with its state and a single menu, which rises as a sheet. **Done**, at the foot of the card beside **Delete application**, closes it. In the card layout, and on any touch screen, every control is at least 44 pixels tall.

### Files

Each slot is one of:

| Mark | Means |
| --- | --- |
| A faint dot | Not recorded yet |
| ✓ in blue | Sent, with the file or a link attached. Clicking it opens what you sent |
| ✓ | Sent, with nothing attached, as a tick in the spreadsheet meant |
| N/A | Not required |

Clicking any other mark, or the arrow at the end of the row, opens Details. There each slot can take an attached file, a link, "Sent, no file", or "Not required", and can be cleared. A file dropped on a mark in the table is attached to that slot. PDFs, Word documents, plain text and pictures are accepted, up to 50 MB each. Attaching needs a connection; everything else works offline.

Files are stored the way pictures in notes are: in R2 by their contents, with no file row. So the processor never converts or reads them, study search never sees them, and the storage sweep leaves them alone. The nightly purge also checks the applications before deleting any stored copy, so a PDF that was once a reading and is also a role description is kept. A file opens under its own name, not the hash it is stored under.

### Deleting and restoring

**Delete application** is at the foot of its Details. The notice offers **Undo**. Deleted applications are listed under **Recently deleted** at the foot of the job search for 90 days, each with **Restore**. They are not mixed into the study side's list in **Settings**.

### Privacy

The whole app is behind Cloudflare Access, so the job search and its files are reachable only after you sign in. Your CV and cover letters, with your address and phone number, are never public.

### Starting data

Migration `0010_job_search.sql` adds the two applications from the spreadsheet: Kekst CNC, rejected, with its CV, cover letter and role description ticked; and Dragonfly Intelligence, no response, with its cover letter ticked. The ticks are "sent, no file", ready for the files to be attached if you want them here.

### Keys

| Key | Does |
| --- | --- |
| N | Adds an application |
| / | Finds an application |
| Esc | Clears the search |
| Enter | In an employer or role, finishes it |

### Design

The job search uses the same type, rules, spacing and theme tokens as the rest of the app. Its one departure is colour: stage chips and deadlines use the spreadsheet's status colours, as small square chips rather than filled cells, so the table still reads as a page. Each colour is set as a token in all three themes (`--todo-bg`, `--waiting-ink` and so on), with darker versions for dark mode. Every pair passes the 4.5:1 contrast threshold in every theme; the weakest is the spreadsheet's own amber, at 4.6.

### Code

`src/lib/jobs.ts` holds the stages, the date and deadline rules, the order, and attaching files. `src/components/JobsPage.tsx` is the screen. It loads only when the job search is first opened, as its own small file, so the study side never loads it. On the Worker, the only changes are the `applications` table in `worker/schema.ts`, plain text added to the accepted file types, `?name=` on downloads, and the purge's check.

## 19. On a phone

Version 0.27 rebuilt the app for fingers rather than a mouse and keyboard, following Apple's Human Interface Guidelines and the wider research on mobile use.

### Getting around

- **A tab bar** at the foot of the screen, below 44rem wide, with four places: **Home**, **This week**, **Search** and **Settings**. Each is an icon with a label. A tab stays lit for every page within its section, so a module, week or session keeps Home lit. As Apple advises, the tabs only go places; Go to, which is an action, is a button in the top bar.
- **The top bar** slims to the brand, **Go to** and **Jobs**. The module links live on the home page.
- **While you type,** the tab bar steps aside, so it never floats over the keyboard, and it is back as soon as you finish. It sits clear of the home indicator on every iPhone.
- **Swipe** left on a week for the next week, and right for the one before. The links at the foot of the week still do the same. A mostly vertical movement is always a scroll.

### Touch

- **Every control is at least 44 points,** Apple's minimum. Where a control should look small, its tappable area is larger than what you see.
- **A pressed state** shows on every tap, since nothing on a phone can be hovered over. Nothing in the app now depends on hover: the Evidence link and the slide arrows always show on a touch screen.
- **No zooming into fields.** Every field is at least 16 pixels on a touch screen, below which iOS zooms in when you tap it.
- **The right keyboard.** Module codes type in capitals with no autocorrect, search fields have a Search key, links get a keyboard with / and .com, the page box takes numbers, and seminar questions have a Next key.
- **Menus and confirmations are sheets** that rise from the foot of the screen, with large rows and **Cancel**, where a thumb already is. Tapping the dimmed page closes them.
- **No dragging by finger.** On a touch screen a finger on a list scrolls, and a held finger selects text, so dragging would fight both. Readings offer **Move up**, **Move down** and **Move to another week or module** in their menu instead. A mouse, trackpad or pen still drags, so a tablet with a pen keeps it.

### Highlighting with a finger

- **The colours dock at the foot of the screen** when you select text, each with its name, clear of the phone's own selection handles and its Copy menu.
- **Whole sentence** and **Whole paragraph** turn a rough selection into a clean one, so you never need to drag a handle precisely. Whole paragraph is offered in text layout, where paragraphs are known.
- **Nothing is highlighted while your finger is still down,** so "Highlight as I select" waits until you have finished.
- **A selection low on the screen** scrolls up just enough to stay in view above the bar.

### Photos as readings

Pictures can be added wherever readings are: on a week, by dropping them, on the import page, or as a replacement file. Pictures added together become **one** PDF reading, a page each, in the order chosen, so six photos of a chapter are one reading. This happens on the device, so it works offline. One picture keeps its own name; several are named for the day and the number of pages, such as "Photos 14 Oct 2026 (6 pages)", and can be renamed like any reading. On a phone, the file picker offers the camera and the photo library.

### OCR

The processor now reads far more kinds of scan.

| What | How |
| --- | --- |
| Languages | English, French and German by default, each used if its Tesseract pack is installed. Set `OCR_LANGUAGES` to change them |
| Pages photographed sideways or upside down | Turned upright |
| Crooked scans | Straightened |
| Two-page book spreads | Split into single pages before reading: a wide page with text on both sides of an empty gutter |
| Dirty or uneven scans | Cleaned for reading, if `unpaper` is installed; the page you see is unchanged |
| A text layer of scanner rubbish | Spotted (fewer than 45 per cent real words over at least 200) and read again |
| A page that will not read | Given up after five minutes, so it cannot hold up the reading |

**Why highlights are safe.** Turning, straightening and splitting only touch pages that had no text. A page with no text cannot carry a highlight, so nothing you have marked can move. Pages that already have text are left exactly as they were. Reading a rubbish layer again never moves a page either.

### The app on the home screen

Added to an iPhone's home screen, the app opens on its own, named **Library**, with a 180-pixel icon and a status bar that follows the theme. A long press on its icon offers **This week**, **Search** and **Job search** where the phone supports shortcuts.

## 20. The same actions wherever a thing appears

From version 0.28, anything you can do to a session or a reading is offered wherever it is shown, so you never have to go somewhere else to do it.

**A session.** Its own page does everything its row on the week page does: **Add slides** (a PDF, a PowerPoint, or photos of the slides), rename it by clicking its name, change it to a lecture, seminar or combined session, or delete it, which takes you back to the week. The foot of the page goes on to the session before or after in the module, as a week page goes to the next week. On a phone, the quieter actions sit in the session's menu beside **Record**.

**A session's way in.** On a week page a session's name is its one link, marked with an arrow. Its notes, slides and recordings are behind it. The recording line beside it still opens the session at that recording.

**A reading.** Its ••• menu is the same on the week page, the module page, Week across modules, a question's page and a session's page, including its slides. In the reader, **More reading actions** has the reading's own actions too: **Edit details** and **Move to another week or module** open in a dialog (a sheet on a phone), with **Download file**, **Replace file** and **Delete reading**, which takes you back.

**Back from slides** goes to the session they belong to, by its name ("Back to the lecture", or "Back to The Consulate" for a named one), not to the week.

**One link to each place on a screen.** The home page no longer repeats Week across modules, which the top bar and the phone's tab already offer.

### Reading every scan again

Scans OCR'd before 0.27 can be read again with the current OCR. Under **Processor** in Settings, **Read every scan again** asks first, then queues every PDF reading. On the laptop the same is `python -m study.processor --rescan`. The processor checks each one:

- **A scan it OCR'd before** is rebuilt from its page images: spreads split, pages turned upright and straightened, every language read. The original scans were deleted after the first OCR, so the page images in the OCR'd file are what it works from. A highlight on a rebuilt page may sit a little out of place afterwards.
- **A file whose text layer is rubbish,** such as a poor scanner OCR, is rebuilt the same way.
- **A PDF with good text,** such as a journal article downloaded as text, is left alone.

New work always goes first, and every reading stays open to read while the processor works through the rest. Asking again while some are still waiting queues only the ones not already waiting.

### Smooth highlights

A highlight is drawn as one smooth shape. On the page, the words on each line join into one band, however wide the gaps an OCR layer leaves between them, and neighbouring lines meet halfway across the space between them. In text layout, a highlight fills the height of each line and runs through the spaces between lines. The highlight you are working on shows stronger, rather than outlined line by line. All of this happens as highlights are drawn, so every highlight made before benefits too.

### Questions without evidence

Questions no longer have pages of their own or evidence filed under them. A question's answer is written beneath it, on the week page or the session page. A question in Week across modules, Go to or search opens its session, and so does a link to a question page saved before 0.30.

## 21. Dissertation modules

A module is either **taught**, organised by weeks of term, or a **dissertation**, organised by sections you name and order yourself: a chapter, a set of sources, supervision, whatever you work by. Choose when you add a module; a dissertation starts with one section, ready to name.

**Sections.** On the module page each section has a menu: **Rename**, **Move up**, **Move down** and **Delete section**. **Add a section** is at the foot of the list. A section's name is used everywhere a week's code would be: breadcrumbs, Go to, search, moving a reading, the recording bar. Deleting a section never deletes a reading: its readings move to Unsorted, and its notes and meetings go with it, which Undo brings back.

**A section's page** is laid out as a week's: its readings, then its own **Notes**, written straight on the page and found by search, then its meetings. **Add a meeting** creates a supervision meeting named for the day, such as "Supervision, 15 Oct". A meeting has notes, recording and Moodle transcripts, as a lecture has.

**Key dates.** A dissertation's page lists its key dates: the proposal, chapter drafts, the submission. **Coming up**, at the top of the home page, counts down the next four across your dissertations, as job deadlines do: blue, amber within a week, red on the day and after. A date a fortnight past drops off. This week leaves dissertations out, as they have no weeks.

**Importing.** A file named with a section's name in brackets, such as "(Chapter 2) Kirby, W. C. (1997) 'The Internationalization of China'", goes to that section, with its citation read as usual. Anything else waits in Unsorted.

**Changing a taught module.** In **Edit module**, **Change to a dissertation** turns its weeks into sections. Each week with readings, notes, questions or recordings becomes a section named after it, such as "AT3", to rename or merge; empty weeks and sessions go. Nothing written or added is lost.
