# Study Library

A personal course library for readings, notes and lecture recordings. One Cloudflare Worker serves the app and its API. D1 holds the data, R2 holds the files, and Cloudflare Access keeps it private. A processor adds text to scanned PDFs, converts slides, turns recordings into transcripts, and works out each reading's citation.

**Read `DEBRIEF.md` for the full picture**: how it works, how your installation is set up, everyday tasks, maintenance and troubleshooting.

## Folders

| Folder | Contents |
| --- | --- |
| `app/` | The React app, the Worker (`worker/`) and the D1 schema (`migrations/`) |
| `backend/` | The processor and the Zotero importer, in Python |
| `shared/` | Title parser test cases shared by both languages |
| `docs/` | The original plan, kept for reference |

## Fresh install

### Cloudflare

You need Node 20 or later and a Cloudflare account.

1. In `app/`, copy `wrangler.example.jsonc` to `wrangler.jsonc`.
2. Run `npm install`, then `npx wrangler login`.
3. Create the database with `npx wrangler d1 create study-library`. Put its ID in `wrangler.jsonc`. If Wrangler offers to add the binding for you, decline, and keep the binding names `DB` and `BUCKET`.
4. Create the bucket with `npx wrangler r2 bucket create study-library`.
5. Set the processor key with `npx wrangler secret put PROCESSOR_KEY`, pasting a long random value when asked.
6. Deploy with `npm run deploy`.

### Cloudflare Access

1. In the Worker's **Domains** settings, choose **Enable Access** on the production `workers.dev` row. Switch the preview row off.
2. Use the **Cloudflare account** policy, scope **All traffic**, and a 7-day session.
3. In Zero Trust, create a service token. Add a policy with the **Service Auth** action that includes that token, and attach it to the Worker.
4. Put your team domain and the application's AUD tag in `wrangler.jsonc`, then deploy again.

### The processor, in WSL

```
cd /mnt/c/Users/samue/Documents/Antigravity/study-library/backend
bash setup-wsl.sh
nano .env
bash run-processor.sh
```

To start it at every sign-in, add a Task Scheduler task as described in `DEBRIEF.md`, section 7. On a Linux server, use Docker instead: `docker compose up -d --build` in `backend/`.

## Updating

1. Unzip over your copy. `wrangler.jsonc` and `.env` aren't in the zip, so yours are kept.
2. In `app/`: `npm install`, then `npm run deploy`.
3. In WSL: `. ~/.venvs/study/bin/activate`, then `pip install -r requirements.txt` in `backend/`.
4. Restart the processor's Task Scheduler task.

## Local development

```
cd app
cp wrangler.example.jsonc wrangler.jsonc
cp .dev.vars.example .dev.vars
npm run db:local
npm run dev:api    # the Worker on port 8787
npm run dev        # the app, in a second terminal
```

## Tests

- `cd app && npm test` for unit tests.
- `cd backend && pip install -r requirements-dev.txt && pytest` for integration tests against a local Worker.
- `app/tests/e2e/README.md` for browser tests.
