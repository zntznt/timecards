-- timecards — Supabase (Postgres) schema. Mirrors the SQLite schema exactly.
-- Run this in the Supabase SQL Editor for your project, then point timecards at it
-- (see integrations/supabase/README.md). Times are epoch milliseconds (bigint).

create table if not exists cards (
  id            text primary key,
  name          text not null,
  category      text,
  color         text,
  nfc_uid       text unique,
  emblem        text,
  foil          text,
  texture       text,
  created_at    bigint not null,
  last_timer_id text,
  deadline      bigint,
  deadline_kind text
);

create table if not exists timers (
  id           text primary key,
  card_id      text not null references cards(id) on delete cascade,
  name         text not null,
  mode         text not null,            -- 'up' | 'down'
  target_ms    bigint,
  alarm_style  text not null,            -- 'chime' | 'blip' | 'silent'
  live_session jsonb,                    -- held in-progress session, or null
  ord          int not null,
  created_at   bigint not null
);
create index if not exists idx_timers_card on timers(card_id);

create table if not exists sessions (
  id         text primary key,
  card_id    text not null references cards(id) on delete cascade,
  timer_id   text,
  mode       text not null,
  target_ms  bigint,
  started_at bigint not null,
  ended_at   bigint,
  paused_ms  bigint not null default 0,
  paused_at  bigint
);
create index if not exists idx_sessions_card on sessions(card_id);

create table if not exists slot (
  id              int primary key default 0 check (id = 0),
  card_id         text,
  active_timer_id text,
  locked          boolean not null default false
);
insert into slot (id) values (0) on conflict do nothing;

-- ── Single-user "bring your own project" note ──────────────────────────────
-- The simplest setup is ONE project = ONE user's data, using the anon key. If the
-- project is private to you, that's fine. To expose it safely or go multi-user,
-- add a `user_id uuid` column to each table + Row Level Security policies keyed on
-- auth.uid(). Not needed for a personal single-user sync.

-- migration for projects created before emblem/foil existed:
--   alter table cards add column if not exists emblem text;
--   alter table cards add column if not exists foil text;
--   alter table cards add column if not exists texture text;
