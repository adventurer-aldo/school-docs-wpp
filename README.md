# School Docs — Cloudflare edition

Two pieces:

- **`worker/`** — deployed to Cloudflare Workers. This is the whole web app: dashboard, search,
  settings, QR display, D1 database. This is what you actually visit and use day to day.
- **`runner/`** — a small Node.js process that holds the real WhatsApp connection (via Baileys),
  uploads files straight to Backblaze B2, and reports metadata to the Worker. It has to run
  continuously somewhere, because Cloudflare Workers cannot host a persistent WhatsApp session
  itself (see "why two pieces?" below).

They talk over a small HTTP API, authenticated with a shared secret token you set once.

## Why two pieces, not just a Worker?

Cloudflare Workers run in a V8 sandbox with no persistent sockets, no Node crypto internals, and
no support for the WebSocket + Signal-protocol crypto stack Baileys needs to actually talk to
WhatsApp. There's no way around that — it's a platform limitation, not a design choice. So the
WhatsApp connection needs a real, always-on Node.js process somewhere. Good free/cheap options:

- A Raspberry Pi or old laptop that's usually on at home.
- Oracle Cloud's Always Free tier (a small ARM VM, genuinely free forever).
- Fly.io's free allowance (a tiny always-on VM).
- Any $5/month VPS (Hetzner, DigitalOcean, etc.).

The runner is deliberately tiny and dumb — it doesn't store anything itself and doesn't need much
CPU/RAM, so almost anything works.

---

## 1. Set up Backblaze B2

1. Create a bucket (private is fine — the Worker mints short-lived signed links when you click
   "Open").
2. In **App Keys**, create a new Application Key scoped to that bucket. Note the `keyID` and
   `applicationKey`.
3. Note your bucket's **S3-compatible endpoint** (shown on the bucket page), e.g.
   `s3.us-west-004.backblazeb2.com`, and the region part of it (`us-west-004`).

## 2. Deploy the Worker

```
cd worker
npm install
npx wrangler login
npx wrangler d1 create school-docs
```

Copy the `database_id` it prints into `wrangler.toml` (`REPLACE_WITH_YOUR_D1_DATABASE_ID`), then:

```
npm run db:init
npx wrangler secret put RUNNER_TOKEN        # make up any long random string — used below too
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APPLICATION_KEY
npx wrangler secret put B2_BUCKET
npx wrangler secret put B2_ENDPOINT
npx wrangler secret put B2_REGION
npm run deploy
```

Wrangler will print your Worker's URL, e.g. `https://school-docs-manager.yourname.workers.dev`.
Open it — you'll see the "Link WhatsApp" screen (no QR yet, since the runner isn't running).

## 3. Run the runner

On whatever machine you're using as the always-on host:

```
cd runner
npm install
cp .env.example .env
```

Fill in `.env`:
- `WORKER_URL` — the URL from step 2
- `RUNNER_TOKEN` — the exact same string you set with `wrangler secret put RUNNER_TOKEN`
- The same B2 credentials as above

```
npm start
```

Refresh the Worker's web page — the QR code should appear. Scan it from your phone
(WhatsApp → Settings → Linked Devices → Link a Device). Once connected, the dashboard replaces
the QR screen automatically.

Keep the runner running with a process manager so it survives reboots/crashes, e.g.:

```
npm install -g pm2
pm2 start index.js --name school-docs-runner
pm2 save
pm2 startup   # follow the printed instructions to survive reboots
```

---

## Using it

- **Dashboard** — folders on the left (one per WhatsApp group, or per "catcher" if you've grouped
  several groups together). Each document shows its latest version up front, with older versions
  tucked under "N earlier versions" so an out-of-date file never gets mistaken for the current one.
- **Search** — global search box on the dashboard home searches every folder; each folder view also
  has its own local search. Sort by date sent or name.
- **Settings**
  - Toggle whether documents / images / videos get downloaded at all (documents on by default).
  - **Catcher folders**: create one (e.g. "Physiology I"), then assign multiple WhatsApp groups to
    it from the Groups list — their files all land in that one folder instead of splintering across
    near-duplicate group folders.
  - **Groups**: per group, toggle whether it's visible on the dashboard ("hidden" groups are excluded
    from search by default too, unless you switch the search filter to "include" or "only hidden"),
    and whether the bot should download from it at all.
  - **De-sync**: set a private phrase *before* scanning the QR code. After that, either click
    "De-sync now" on this page, or simply send that exact phrase in any WhatsApp chat from the
    linked account — the runner logs out and clears its local session automatically. Scan a fresh
    QR code afterwards to link a different account.

## Notes & limits

- Baileys talks to WhatsApp's unofficial web protocol. It works well, but isn't officially
  supported — keep usage reasonable (a personal archive like this is exactly the kind of low-volume
  use case it handles fine).
- "Same document, newer version" grouping is based on the sent filename (ignoring the extension).
  If people rename files when re-sending an update (`timetable_v2.pdf` vs `timetable.pdf`), they
  won't be grouped — happy to make that matching fuzzier if it becomes an issue in practice.
- Search uses simple substring matching (fast enough for a personal archive of this size). If it
  ever grows into the tens of thousands of files, switching to SQLite FTS5 inside D1 would keep it
  snappy — not needed yet.
- All file bytes live only in your Backblaze bucket; D1 just stores metadata and short-lived signed
  links are generated on click, so nothing sensitive is ever cached in the Worker itself.
