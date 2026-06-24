# timecards cloud sync (Supabase)

By default, the **CLI/Pi** store data in `~/.timecards/data.db` and the **web app**
stores it in your browser — two separate islands. Point both at one **Supabase**
project and they share a single live dataset: start a timer on the web, see it on the
Pi, review it in the CLI.

It's **bring-your-own-project**: you supply your own Supabase URL + anon key, so you
own your data and nobody else operates or pays for it. Fully opt-in — leave it unset
and everything stays local exactly as before.

## 1. Create the project + tables

1. Make a free project at [supabase.com](https://supabase.com).
2. In the project's **SQL Editor**, paste and run [`schema.sql`](./schema.sql).
3. Grab your **Project URL** and **anon public key** from Project Settings → API.

> Single-user note: one project = your data, using the anon key. To share it or go
> multi-user, add `user_id` + Row Level Security (see the note in `schema.sql`).

## 2. Point the CLI / Raspberry Pi at it

Set two env vars; when both are present, timecards uses Supabase instead of SQLite:

```bash
export TIMECARDS_SUPABASE_URL="https://xxxx.supabase.co"
export TIMECARDS_SUPABASE_KEY="eyJ…anon-key…"
npm install @supabase/supabase-js          # one-time, only needed for sync

node ~/timecards/cli/timecards.ts cards    # now reads/writes Supabase
```

Unset the vars to go back to the local SQLite file. (Add the exports to `~/.bashrc`
or the systemd unit's `Environment=` to make it permanent on a Pi.)

## 3. Point the web app at it

Open the web app → **⚙ settings** → paste your **URL** and **anon key** → *save &
reload*. The browser then syncs to Supabase (it loads the client from the esm.sh CDN;
no build step). Click **use local only** to switch back to in-browser storage.

## 4. Move existing local data up (one-time)

Your existing local data doesn't copy itself — export it and import it once Supabase
is active:

```bash
# with Supabase env UNSET (reads local SQLite):
node ~/timecards/cli/timecards.ts export --out ~/timecards-backup.json

# then with Supabase env SET (writes to the cloud):
node ~/timecards/cli/timecards.ts import ~/timecards-backup.json
```

`export`/`import` also work as plain backups, independent of Supabase.

## How it works

`core/supabase-store.ts` is a `SupabaseStore` implementing the same `Storage`
interface as the SQLite and IndexedDB adapters — so the core, timer logic, and every
view are identical; only persistence moves to Postgres. The query code is the same in
Node and the browser; only the `createClient` import differs (npm package vs esm.sh
CDN). See `guidance/EXTENDING.md`.

**Conflict handling is last-writer-wins** (upsert by id). For a single user across
their own devices that's fine. True multi-device-simultaneous-edit conflict
resolution isn't implemented — it's not needed for personal sync.
