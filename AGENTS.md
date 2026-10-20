# Study Library

A personal, single-user web app that replaces Zotero for an LSE History degree. It holds every reading, note, lecture recording and seminar question in one place, organised by module and by week of term (or, for a dissertation, by sections the user names). It works on a laptop and a phone, offline, and syncs between them. It also has a job applications tracker.

## Read first

`DEBRIEF.md` is the full reference: what the app does, how it works, every decision and why, the code map, data model, API, tests and version history. Read it before changing anything, in large sections rather than many small pieces. The sections that matter most:

- 4 (How it works), 10 (Decisions and why), 11 (Code map), 12 (Data model)
- 14 (Tests), 15 (Design rules), 16 (Known limits and next steps)
- 17 (Version history): the current version is 0.31.3

## Layout

- `app/`: the React app (Vite, Dexie for the local database) and the Cloudflare Worker (Hono, D1, R2), in `app/src` and `app/worker`. Migrations are in `app/migrations`.
- `backend/`: the Python processor that runs in WSL on the user's laptop: OCR, file conversion, transcription, citation finding.
- `app/wrangler.jsonc` and `backend/.env` hold the user's own settings and secrets. They are not in Git. Never print, commit or overwrite them.

## What the user wants from the app

- **Readings:** PDFs, Word, PowerPoint and phone photos, sorted into weeks or sections from their file names. A Zotero-like reader with a text layout for phones, an exact remembered place, and smooth highlights that are easy to make with a finger.
- **Scans:** every scan readable and searchable, including JSTOR-style OCR layers, French and German, crooked pages and two-page spreads.
- **Sessions:** notes for each lecture and seminar, slides added from anywhere, recordings with transcripts, and seminar answers written beneath their questions.
- **The phone:** it should feel like a real app, with a tab bar, finger-sized controls, sheets instead of small menus, and no dragging by finger.
- **The whole app:** professional, clean, modern and intuitive, inspired by Notion, Zotero and Word. Consistent: the same actions wherever a thing appears, one obvious way to each place, labels that match what they open, and a visible Cancel on everything that opens or edits.

## Rules

- **Language:** British English everywhere, in the interface, comments and docs. No em dashes or en dashes.
- **Design:** for any change to the interface, use the study-library-design skill. It covers the tokens, components, behaviour rules and a checklist, and takes precedence over the frontend-design skill.
- **Consistency:** when adding an action to something, offer it everywhere that thing appears (see section 20 of `DEBRIEF.md`).
- **Tests:** every change comes with a test, and existing tests must pass. A browser test that fails because the design changed on purpose is updated; one that fails for any other reason is a bug to fix.
- **Migrations:** never edit an existing one; add a new one. A table rebuild must drop and recreate any trigger on another table that names it (see `0011_dissertations.sql`). Test a migration on a populated local database before calling it done.
- **Sync:** edits send only the columns that changed, and the server writes only the columns a device sends, so an older device keeps working after a new column is added. Keep it that way.
- **Limits:** the Worker runs on Cloudflare's free plan, with 10 ms of CPU per request. Do heavy work on the device or in the processor.
- **Docs:** update `DEBRIEF.md` and the version in `app/package.json` with each release, including any deployment steps.

## Commands

All of these run from `app/`. Use them rather than working out how to run things another way.

| What | Command |
| --- | --- |
| Typecheck, unit tests and backend tests together | `npm run test:all` |
| Typecheck only | `npm run typecheck` |
| Unit tests only | `npm test` |
| Backend tests only | `npm run test:backend` |
| Every browser test, in the order they depend on | `npm run e2e` |
| Named browser tests | `npm run e2e -- jobs ux` (for `test_jobs.py` and `test_ux.py`) |
| The layout audit | `npm run e2e -- audit_layout` |
| Build | `npm run build` |
| Deploy (ask the user first) | `npm run deploy` |

How they work, so there is no need to investigate:

- `npm run test:backend` and `npm run e2e` run in WSL, from a copy of the project at `~/study-library` that they refresh each time. `npm run e2e` builds the app there, starts and stops the local Worker itself, and waits until every test has finished, printing PASS or FAIL for each. Never start the Worker or run browser tests any other way.
- Python for tests is `~/.venvs/study/bin/python` in WSL. Don't look for Python on Windows.
- Never run `npm install` for Linux in the Windows folder.
- Screenshots from browser tests are copied back to `app/tests/e2e/shots/`.
- The local development proxy sometimes drops an upload. If a browser test fails while waiting for one, rerun that test before treating it as a bug.

## Working efficiently

- Run commands in the foreground and wait for them to finish. Don't start a command in the background and check on it repeatedly.
- When writing a script or test, get it working on the smallest case first (one page, one width), then run the full version once.
- Read a file once, in full or in large sections.
- Plan larger changes before building: say what you will change and wait for the user to agree.

## Ask the user first

- Before deploying.
- Before writing or applying a migration to the live database.
- Before anything that deletes or rewrites the user's data, including starting a rescan.
- Before changing sign-in, Cloudflare Access or secrets.

## Skills and tools

- **study-library-design:** for any change to the interface (see Rules).
- **web-design-guidelines:** when asked to review the interface or its accessibility.
- **frontend-design:** for new screens only, never to restyle settled ones, and always below study-library-design.
- **Context7:** for current documentation of BlockNote, pdf.js, Dexie, Hono and Wrangler before relying on memory.

## End of each session

Update section 16 (Known limits and next steps) of `DEBRIEF.md` with what was done and what is left, and section 17 for anything user-visible. Run `npm run test:all`, then commit with a clear message.