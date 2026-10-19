# Study Library

A personal, single-user web app that replaces Zotero for an LSE History degree. It holds every reading, note, lecture recording and seminar question in one place, organised by module and by week of term (or, for a dissertation, by sections the user names). It works on a laptop and a phone, offline, and syncs between them. It also has a job applications tracker.

## Read first

`DEBRIEF.md` is the full reference: what the app does, how it works, every decision and why, the code map, data model, API, tests and version history. Read it before changing anything. The sections that matter most:

- 4 (How it works), 10 (Decisions and why), 11 (Code map), 12 (Data model)
- 14 (Tests), 15 (Design rules), 16 (Known limits and next steps)
- 17 (Version history): the current version is 0.31.2

## Layout

- `app/`: the React app (Vite, Dexie for the local database) and the Cloudflare Worker (Hono, D1, R2), in `app/src` and `app/worker`. Migrations are in `app/migrations`.
- `backend/`: the Python processor that runs in WSL on the user's laptop: OCR, file conversion, transcription, citation finding.
- `app/wrangler.jsonc` and `backend/.env` hold the user's own settings and secrets. They are not in Git. Never print, commit or overwrite them.

## What the user wants from the app

- **Readings:** PDFs, Word, PowerPoint and phone photos, sorted into weeks or sections from their file names. A Zotero-like reader with a text layout for phones, an exact remembered place, and smooth highlights that are easy to make with a finger.
- **Scans:** every scan readable and searchable, including JSTOR-style OCR layers, French and German, crooked pages and two-page spreads.
- **Sessions:** notes for each lecture and seminar, slides added from anywhere, recordings with transcripts, and seminar answers written beneath their questions.
- **The phone:** it should feel like a real app, with a tab bar, finger-sized controls, sheets instead of small menus, and no dragging by finger.
- **The whole app:** professional, clean, modern and intuitive, inspired by Notion, Zotero and Word. Consistent: the same actions wherever a thing appears, one obvious way to each place, labels that match what they open.

## Rules

- **Language:** British English everywhere, in the interface, comments and docs. No em dashes or en dashes.
- **Design:** follow section 15 of `DEBRIEF.md`. That means quiet chrome, soft surfaces, one accent colour, sentence case, no capitals for labels and no middle dots.
- **Consistency:** when adding an action to something, offer it everywhere that thing appears (see section 20).
- **Tests:** every change comes with a test, and existing tests must pass. A browser test that fails because the design changed on purpose is updated; one that fails for any other reason is a bug to fix.
- **Migrations:** never edit an existing one; add a new one. A table rebuild must drop and recreate any trigger on another table that names it (see `0011_dissertations.sql`). Test a migration on a populated local database before calling it done.
- **Sync:** edits send only the columns that changed, and the server writes only the columns a device sends, so an older device keeps working after a new column is added. Keep it that way.
- **Limits:** the Worker runs on Cloudflare's free plan, with 10 ms of CPU per request. Do heavy work on the device or in the processor.
- **Docs:** update `DEBRIEF.md` and the version in `app/package.json` with each release, including any deployment steps.

## Commands

Unit tests and typecheck, in `app/`:

```
npm test
npm run typecheck
```

Backend integration tests, in WSL in `backend/`:

```
pip install -r requirements-dev.txt
pytest
```

Browser tests, in `app/`. Start the local Worker first:

```
npm run build
npx wrangler d1 migrations apply DB --local
npx wrangler dev --port 8790 --ip 127.0.0.1
python tests/e2e/make_pdfs.py
python tests/e2e/test_library.py http://127.0.0.1:8790
```

Then run the other `tests/e2e/test_*.py` files the same way. `library`, `sessions`, `features`, `usability` and `themes` build on each other's data, so run them in that order. The local development proxy sometimes drops an upload; if a test fails while waiting for one, rerun it before treating it as a bug.

Deploy, in `app/`. This applies any new migrations and publishes the Worker:

```
npm run deploy
```

- Backend tests run in WSL from a copy at `~/study-library`, refreshed by `npm run test:backend`. Never run `npm install` for Linux in the Windows folder.

## Ask the user first

- Before deploying.
- Before writing or applying a migration to the live database.
- Before anything that deletes or rewrites the user's data, including starting a rescan.
- Before changing sign-in, Cloudflare Access or secrets.

## Skills and tools

- Design rules in section 15 of `DEBRIEF.md` take precedence over the frontend-design skill. Use the skill for new screens, not to restyle settled ones.
- Use the web-design-guidelines skill when asked to review the interface or its accessibility.
- Use Context7 for current documentation of BlockNote, pdf.js, Dexie, Hono and Wrangler before relying on memory.
- At the end of a session, update section 16 (Known limits and next steps) of `DEBRIEF.md` with what was done and what is left.
- For any change to the interface, use the study-library-design skill. It takes precedence over frontend-design.