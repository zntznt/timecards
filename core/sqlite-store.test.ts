// Self-check for the SQLite adapter's MIGRATION path. `node core/sqlite-store.test.ts`.
//
// Why this file exists: the schema in the constructor uses CREATE TABLE IF NOT
// EXISTS, so a database created by an older version keeps its OLD columns forever.
// Everything that keeps such a database openable lives in migrate() — and migrate()
// is exactly the kind of code that is never exercised by normal use, so it rotted
// (a second `private migrate()` shadowed it and the whole data migration went dead,
// leaving pre-timers databases throwing on the very first command). These checks
// build a genuine legacy database on disk and open it with the real adapter.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "./sqlite-store.ts";

let passed = 0;
async function test(name: string, fn: (dbPath: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "timecards-test-"));
  try {
    await fn(join(dir, "data.db"));
    passed++;
    console.log(`  ok  ${name}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write the PRE-TIMERS schema by hand: one card carrying its own mode/alarm, a
 *  slot holding the live session as JSON, and a session row with no timer_id.
 *  This is what a database from before the Card→Timers model actually looks like. */
function writeLegacyDb(path: string, opts: { withLiveSession: boolean }) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE cards (
      id        TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      category  TEXT,
      color     TEXT,
      nfc_uid   TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      default_mode TEXT,
      default_target_ms INTEGER,
      alarm_style TEXT
    );
    CREATE TABLE sessions (
      id        TEXT PRIMARY KEY,
      card_id   TEXT NOT NULL,
      mode      TEXT NOT NULL,
      target_ms INTEGER,
      started_at INTEGER NOT NULL,
      ended_at  INTEGER,
      paused_ms INTEGER NOT NULL DEFAULT 0,
      paused_at INTEGER
    );
    CREATE TABLE slot (
      id      INTEGER PRIMARY KEY CHECK (id = 0),
      card_id TEXT,
      session TEXT
    );
  `);
  db.prepare(`INSERT INTO cards (id,name,category,color,nfc_uid,created_at,default_mode,default_target_ms,alarm_style)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run("writing", "Writing", "hobby", "#e8a", null, 1_700_000_000_000, "down", 1_500_000, "blip");
  db.prepare(`INSERT INTO sessions (id,card_id,mode,target_ms,started_at,ended_at,paused_ms,paused_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run("s1", "writing", "down", 1_500_000, 1_700_000_100_000, 1_700_001_600_000, 0, null);
  const live = opts.withLiveSession
    ? JSON.stringify({ id: "s2", cardId: "writing", mode: "down", targetMs: 1_500_000,
                       startedAt: 1_700_002_000_000, endedAt: null, pausedMs: 0, pausedAt: 1_700_002_060_000 })
    : null;
  db.prepare(`INSERT INTO slot (id, card_id, session) VALUES (0, ?, ?)`).run("writing", live);
  db.close();
}

await test("a pre-timers database opens, and each card gains a seeded timer", async (path) => {
  writeLegacyDb(path, { withLiveSession: false });
  const store = new SqliteStore(path);   // must not throw
  try {
    const timers = await store.listTimers("writing");
    assert.equal(timers.length, 1, "the card's old mode/target should become one timer");
    assert.equal(timers[0].id, "t_writing");
    assert.equal(timers[0].mode, "down");
    assert.equal(timers[0].targetMs, 1_500_000);
    assert.equal(timers[0].alarmStyle, "blip", "the card's old alarm carries onto the timer");
    assert.equal(timers[0].name, "25 min");
    const card = await store.getCard("writing");
    assert.equal(card?.lastTimerId, "t_writing", "the card loads its seeded timer when slotted");
    assert.equal(card?.name, "Writing");
  } finally { store.close(); }
});

await test("the columns added since the old schema are backfilled, not missing", async (path) => {
  writeLegacyDb(path, { withLiveSession: false });
  const store = new SqliteStore(path);
  try {
    // These all read columns the old schema never had; before migrate() ran they
    // threw "no such column" from the very first CLI command.
    const card = await store.getCard("writing");
    assert.equal(card?.deadline, null);
    assert.equal(card?.deadlineKind, "until");
    assert.equal(card?.emblem, null);
    assert.equal(card?.foil, null);
    assert.equal(card?.texture, null);
    const slot = await store.getSlot();
    assert.equal(slot.locked, false);
    await store.setSlot({ cardId: "writing", activeTimerId: "t_writing", locked: true });
    assert.equal((await store.getSlot()).locked, true);
  } finally { store.close(); }
});

await test("an in-progress run in the old slot is re-tagged onto the seeded timer", async (path) => {
  writeLegacyDb(path, { withLiveSession: true });
  const store = new SqliteStore(path);
  try {
    const slot = await store.getSlot();
    assert.equal(slot.cardId, "writing");
    assert.equal(slot.activeTimerId, "t_writing", "the slot points at the migrated timer");
    const timer = await store.getTimer("t_writing");
    assert.ok(timer?.liveSession, "the held run moved from the slot onto the timer");
    assert.equal(timer!.liveSession!.id, "s2");
    assert.equal(timer!.liveSession!.timerId, "t_writing", "the session is re-tagged with its new timer");
    assert.equal(timer!.liveSession!.cardId, "writing");
    assert.equal(timer!.liveSession!.pausedAt, 1_700_002_060_000, "and it stays paused where it was");
  } finally { store.close(); }
});

await test("migration is idempotent — reopening seeds nothing twice", async (path) => {
  writeLegacyDb(path, { withLiveSession: true });
  new SqliteStore(path).close();
  const store = new SqliteStore(path);   // second open, same file
  try {
    assert.equal((await store.listTimers("writing")).length, 1, "no duplicate timer on reopen");
    assert.equal((await store.listSessions("writing")).length, 1, "history untouched");
  } finally { store.close(); }
});

await test("a fresh database needs no migration and round-trips a card", async (path) => {
  const store = new SqliteStore(path);
  try {
    await store.createCard({ id: "a", name: "A", category: null, color: null, emblem: "★",
      foil: "gold", texture: "waves", nfcUid: null, createdAt: 1, lastTimerId: null,
      deadline: 2, deadlineKind: "since" });
    const got = await store.getCard("a");
    assert.equal(got?.emblem, "★");
    assert.equal(got?.foil, "gold");
    assert.equal(got?.texture, "waves");
    assert.equal(got?.deadlineKind, "since");
  } finally { store.close(); }
});

console.log(`\n${passed} sqlite-store checks passed.`);
