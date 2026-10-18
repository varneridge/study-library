# Browser tests

These drive the real app in headless Chromium against the Worker running locally.

- `test_library.py` covers module creation, folder import, upload, the reader, highlights and sync to a second device.
- `test_editing.py` covers editing, deleting, undo and restore, at desktop and phone widths.
- `test_features.py` covers find, search, recently opened, page colours, contents, recordings, the notes menus and the phone reader. It uses the data `test_sessions.py` leaves, so run it after that.
- `test_usability.py` covers home progress, question links, recent searches and first steps. Run it after `test_sessions.py`.
- `test_themes.py` checks each theme across the app. Run it after `test_sessions.py`.
- `test_recording_bar.py` checks a recording carrying on round the app.
- `test_notes_access.py` checks the quick routes to lecture and seminar notes.
- `test_paragraphs.py` checks no paragraph in text layout breaks mid-sentence.
- `test_reading_place.py` checks the exact place is kept and the text holds still.
- `test_reading_notes.py` checks highlights joining a reading's notes in reading order.
- `test_textview.py` checks a reading set as text on a phone.
- `test_citations.py` checks readings naming themselves from JSTOR cover pages.
- `test_transcripts.py` imports the Moodle transcript in `fixtures` and checks how it reads.
- `test_dragging.py` covers dragging readings, dropping files, undoing moves and Go to.
- `test_mobile.py` covers the phone: the tab bar, touch targets, sheets, swiping, finger highlighting and the installable app.
- `test_photos.py` covers photos added together becoming one reading, and OCR reading them.
- `test_answers.py` covers answers written beneath seminar questions.
- `test_ux.py` covers the 0.24 pass: this week marked, week dates, highlight counts, the Readings tile, the import table, Go to's Esc and Jobs on a phone.
- `test_jobs.py` covers the job search, and checks the study side is unchanged.
- `test_slides_and_modules.py` covers dragging slides between sessions, moving a reading to another module, the processor's status and a stale device saving its place.
- `test_sessions.py` covers seminar questions, filing highlights, notes, a live recording with a fake microphone, transcripts and search.

To run them:

```
pip install playwright pymupdf pillow requests
python -m playwright install chromium
python make_pdfs.py

cd ../..                      # the app folder
cp .dev.vars.example .dev.vars
npm run build
npx wrangler d1 migrations apply DB --local
npx wrangler dev --port 8790  # leave running

python tests/e2e/test_library.py http://127.0.0.1:8790
python tests/e2e/test_sessions.py http://127.0.0.1:8790
python tests/e2e/test_features.py http://127.0.0.1:8790
python tests/e2e/test_usability.py http://127.0.0.1:8790
python tests/e2e/test_themes.py http://127.0.0.1:8790
python tests/e2e/test_editing.py http://127.0.0.1:8790
python tests/e2e/test_dragging.py http://127.0.0.1:8790
python tests/e2e/test_transcripts.py http://127.0.0.1:8790
python tests/e2e/test_citations.py http://127.0.0.1:8790
python tests/e2e/test_textview.py http://127.0.0.1:8790
python tests/e2e/test_reading_notes.py http://127.0.0.1:8790
python tests/e2e/test_recording_bar.py http://127.0.0.1:8790
python tests/e2e/test_reading_place.py http://127.0.0.1:8790
python tests/e2e/test_paragraphs.py http://127.0.0.1:8790
python tests/e2e/test_notes_access.py http://127.0.0.1:8790
python tests/e2e/test_slides_and_modules.py http://127.0.0.1:8790
python tests/e2e/test_jobs.py http://127.0.0.1:8790
python tests/e2e/test_ux.py http://127.0.0.1:8790
python tests/e2e/test_answers.py http://127.0.0.1:8790
python tests/e2e/test_mobile.py http://127.0.0.1:8790
python tests/e2e/test_photos.py http://127.0.0.1:8790
```

Both tests wipe the local database first. They never touch your live data.
`test_sessions.py` runs the processor with fake transcription, so it needs ffmpeg and the backend's Python dependencies.
