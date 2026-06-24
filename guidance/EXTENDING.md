# Extending storage (and adding cloud sync)

Every storage backend implements the `Storage` interface in `core/types.ts`.
That interface is deliberately tiny — 10 methods — so a new backend is one file
and nothing else changes.

```ts
export interface Storage {
  createCard(c): Promise<void>;  getCard(id): Promise<Card|null>;
  listCards(): Promise<Card[]>;  updateCard(c): Promise<void>;
  deleteCard(id): Promise<void>; getCardByNfc(uid): Promise<Card|null>;
  putSession(s): Promise<void>;  listSessions(cardId?): Promise<Session[]>;
  getSlot(): Promise<Slot>;      setSlot(slot): Promise<void>;
}
```

Existing implementations to copy from:
- `core/sqlite-store.ts` — synchronous DB wrapped in promises. Cleanest template.
- `web/idb-store.ts` — async IndexedDB. Template for anything browser-side.

## Do you need a hosted database?

**No — not for the current product.** Local SQLite (CLI/Pi) + IndexedDB (web) cover
single-user, single-or-few-device use fully, for free, offline. A hosted DB only
earns its place when you need one of:

- **Sync** — the same live dataset across web + Pi + laptop.
- **Multi-user** — separate accounts/decks.
- **Remote access** — reach your data without your own machine running.

Until one of those is real, **don't build it** (YAGNI). The interface guarantees it
stays a small, scoped job whenever you do.

## BUILT: the "bring your own Supabase" adapter

Cloud sync is now implemented in **`core/supabase-store.ts`** (`SupabaseStore`), with
schema + setup in **`integrations/supabase/`**. It's opt-in: CLI/Pi use it when
`TIMECARDS_SUPABASE_URL`/`_KEY` env vars are set, the web app when you paste creds in
⚙ settings (stored in localStorage). Local stays the default. `timecards export` /
`import` move data between backends. The notes below describe how it's built.

Supabase is hosted Postgres + a JS client. The user supplies **their own project URL
+ anon key**, so no one operates or pays for a shared server, and each user owns their
data. It's a *third* opt-in backend, not a requirement.

Key implementation facts (verified against supabase-js v2):
- Calls never reject — they resolve to `{ data, error }`. `SupabaseStore.check()`
  throws on `error` so failures surface loudly.
- `.maybeSingle()` returns `data:null` for no-row (used for getCard/getTimer/getSlot);
  `.upsert()` is insert-or-replace by PK (putTimer/putSession/setSlot).
- Same query code runs in Node and the browser. The ONLY difference is the
  `createClient` import: Node uses the `@supabase/supabase-js` npm package (via
  `makeSupabaseStoreNode`); the browser imports from `https://esm.sh/@supabase/supabase-js@2`
  (no bundler). The build's `.ts→.js` rewrite leaves that CDN URL untouched.

### 1. Tables (mirror the SQLite schema exactly)

```sql
create table cards (
  id         text primary key,
  name       text not null,
  category   text,
  color      text,
  nfc_uid    text unique,
  created_at bigint not null,          -- epoch ms (matches the model)
  last_timer_id text,
  deadline      bigint,
  deadline_kind text
);
create table timers (                  -- a card owns up to 10 of these
  id          text primary key,
  card_id     text not null references cards(id) on delete cascade,
  name        text not null,
  mode        text not null,           -- 'up' | 'down'
  target_ms   bigint,
  alarm_style text not null,           -- 'chime' | 'blip' | 'silent'
  live_session jsonb,                  -- held in-progress session, or null
  ord         int not null,
  created_at  bigint not null
);
create table sessions (
  id         text primary key,
  card_id    text not null references cards(id) on delete cascade,
  timer_id   text,                     -- which timer this history belongs to
  mode       text not null,
  target_ms  bigint,
  started_at bigint not null,
  ended_at   bigint,
  paused_ms  bigint not null default 0,
  paused_at  bigint
);
create table slot (                    -- single row, id always 0
  id      int primary key default 0 check (id = 0),
  card_id text,
  active_timer_id text,
  locked  boolean not null default false
);
insert into slot (id) values (0) on conflict do nothing;
```

`SupabaseStore` implements the same 12 `Storage` methods (cards, timers, sessions,
slot) — each one query. Same row↔model mapping as `core/sqlite-store.ts`.

For multi-user later: add a `user_id` column to each table + Row Level Security
policies keyed on `auth.uid()`. Single-user BYO-project needs none of that.

### 2. The adapter (~80 lines, one file: `core/supabase-store.ts`)

```ts
import { createClient } from "@supabase/supabase-js"; // the only new dependency
import type { Storage, Card, Session, Slot } from "./types.ts";

export class SupabaseStore implements Storage {
  private sb;
  constructor(url: string, anonKey: string) { this.sb = createClient(url, anonKey); }
  // map snake_case rows <-> camelCase model (same mapping as sqlite-store.ts)
  // each method = one supabase query; e.g.:
  async getCard(id: string) {
    const { data } = await this.sb.from("cards").select("*").eq("id", id).maybeSingle();
    return data ? toCard(data) : null;
  }
  // …the other 9, all one-liners over .from(...).select/insert/update/delete
}
```

### 3. Wiring it up

- **CLI**: read `TIMECARDS_SUPABASE_URL` / `TIMECARDS_SUPABASE_KEY` env vars; if both
  set, use `SupabaseStore`, else fall back to `SqliteStore`. One `if`.
- **Web**: a small settings panel where the user pastes URL + anon key (store in
  `localStorage`); if present, use `SupabaseStore`, else `IdbStore`.

### 4. Migrating existing data

Add `timecards export --json` (dump all cards + sessions) and `import`. Switching
backends becomes export-from-old → import-into-new. Cheap, and useful even without
Supabase (backups, moving between machines).

Nothing above touches `core/timer.ts`, `core/device.ts`, the CLI commands, or the
web UI logic. That's the interface doing its job.
