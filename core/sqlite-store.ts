// SQLite storage adapter for the CLI and any Raspberry Pi / hardware bridge.
// Uses node:sqlite (built into Node 22+) — zero dependencies.
//
// node:sqlite is synchronous; our Storage interface is async (the browser's
// IndexedDB adapter has to be). We satisfy the contract by returning resolved
// promises. ponytail: one tiny file, same logic the core already tested.

import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { Storage, Card, Timer, Session, Slot } from "./types.ts";

export function defaultDbPath(): string {
  const dir = join(homedir(), ".timecards");
  mkdirSync(dir, { recursive: true });
  return join(dir, "data.db");
}

export class SqliteStore implements Storage {
  private db: DatabaseSync;

  constructor(path: string = defaultDbPath()) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cards (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        category  TEXT,
        color     TEXT,
        nfc_uid   TEXT UNIQUE,
        emblem    TEXT,
        foil      TEXT,
        texture   TEXT,
        created_at INTEGER NOT NULL,
        last_timer_id TEXT,
        deadline      INTEGER,
        deadline_kind TEXT
      );
      CREATE TABLE IF NOT EXISTS timers (
        id         TEXT PRIMARY KEY,
        card_id    TEXT NOT NULL,
        name       TEXT NOT NULL,
        mode       TEXT NOT NULL,
        target_ms  INTEGER,
        alarm_style TEXT NOT NULL,
        live_session TEXT,                 -- JSON Session or NULL (suspended/running)
        ord        INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timers_card ON timers(card_id);
      CREATE TABLE IF NOT EXISTS sessions (
        id        TEXT PRIMARY KEY,
        card_id   TEXT NOT NULL,
        timer_id  TEXT,
        mode      TEXT NOT NULL,
        target_ms INTEGER,
        started_at INTEGER NOT NULL,
        ended_at  INTEGER,
        paused_ms INTEGER NOT NULL DEFAULT 0,
        paused_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_card ON sessions(card_id);
      CREATE TABLE IF NOT EXISTS slot (
        id      INTEGER PRIMARY KEY CHECK (id = 0),
        card_id TEXT,
        active_timer_id TEXT,
        locked  INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.migrate();
    this.db.exec(`INSERT OR IGNORE INTO slot (id, card_id, active_timer_id, locked) VALUES (0, NULL, NULL, 0)`);
  }

  /** Additive migrations + a one-time data migration from the pre-timers schema:
   *  cards that carried mode/alarm get a seeded timer so old data keeps working. */
  private migrate() {
    const tryExec = (sql: string) => { try { this.db.exec(sql); } catch { /* exists */ } };
    // Add any columns introduced over time (no-op if present).
    for (const sql of [
      `ALTER TABLE cards ADD COLUMN last_timer_id TEXT`,
      `ALTER TABLE cards ADD COLUMN deadline INTEGER`,
      `ALTER TABLE cards ADD COLUMN deadline_kind TEXT`,
      `ALTER TABLE sessions ADD COLUMN timer_id TEXT`,
      `ALTER TABLE slot ADD COLUMN active_timer_id TEXT`,
      `ALTER TABLE slot ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`,
    ]) tryExec(sql);

    // One-time: if cards still have the OLD default_mode column, seed a timer per
    // card from it and migrate the old slot.session into that timer's live_session.
    const hasOldCols = this.columnExists("cards", "default_mode");
    if (!hasOldCols) return;

    const cards: any[] = this.db.prepare(`SELECT * FROM cards`).all();
    const oldSlot: any = this.tableHasColumn("slot", "session")
      ? this.db.prepare(`SELECT card_id, session FROM slot WHERE id = 0`).get()
      : null;
    let seeded = 0;
    for (const c of cards) {
      // Skip if this card already has timers (migration already ran).
      const existing: any = this.db.prepare(`SELECT COUNT(*) n FROM timers WHERE card_id = ?`).get(c.id);
      if (existing.n > 0) continue;
      const mode = c.default_mode ?? "up";
      const targetMs = c.default_target_ms ?? null;
      const tid = `t_${c.id}`;
      const liveSession = oldSlot && oldSlot.card_id === c.id && oldSlot.session
        ? this.reTagSession(oldSlot.session, c.id, tid) : null;
      this.db.prepare(`INSERT INTO timers (id,card_id,name,mode,target_ms,alarm_style,live_session,ord,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(tid, c.id, mode === "down" ? `${Math.round((targetMs ?? 0) / 60000)} min` : "Stopwatch",
             mode, mode === "down" ? targetMs : null, c.alarm_style ?? "chime", liveSession,
             0, c.created_at ?? Date.now());
      this.db.prepare(`UPDATE cards SET last_timer_id = ? WHERE id = ?`).run(tid, c.id);
      seeded++;
    }
    // Point the slot's active timer at the migrated card's seeded timer.
    if (oldSlot && oldSlot.card_id) {
      this.db.prepare(`UPDATE slot SET active_timer_id = ? WHERE id = 0`).run(`t_${oldSlot.card_id}`);
    }
    if (seeded) console.error(`timecards: migrated ${seeded} card(s) to the timers model`);
  }

  /** Re-tag a JSON session blob with a timerId (old sessions had none). */
  private reTagSession(json: string, cardId: string, timerId: string): string {
    try { const s = JSON.parse(json); s.cardId = cardId; s.timerId = timerId; return JSON.stringify(s); }
    catch { return json; }
  }
  private columnExists(table: string, col: string): boolean { return this.tableHasColumn(table, col); }
  private tableHasColumn(table: string, col: string): boolean {
    const rows: any[] = this.db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some(r => r.name === col);
  }

  // ── mapping ───────────────────────────────────────────────────
  private toCard(r: any): Card {
    return {
      id: r.id, name: r.name, category: r.category, color: r.color, nfcUid: r.nfc_uid,
      emblem: r.emblem ?? null, foil: r.foil ?? null, texture: r.texture ?? null,
      createdAt: r.created_at, lastTimerId: r.last_timer_id ?? null,
      deadline: r.deadline ?? null, deadlineKind: r.deadline_kind ?? "until",
    };
  }
  private toTimer(r: any): Timer {
    return {
      id: r.id, cardId: r.card_id, name: r.name, mode: r.mode, targetMs: r.target_ms,
      alarmStyle: r.alarm_style, liveSession: r.live_session ? JSON.parse(r.live_session) : null,
      order: r.ord, createdAt: r.created_at,
    };
  }
  private toSession(r: any): Session {
    return {
      id: r.id, cardId: r.card_id, timerId: r.timer_id, mode: r.mode, targetMs: r.target_ms,
      startedAt: r.started_at, endedAt: r.ended_at, pausedMs: r.paused_ms, pausedAt: r.paused_at,
    };
  }

  /** Additive migrations for DBs created before a column existed. */
  private migrate() {
    for (const col of ["emblem TEXT", "foil TEXT", "texture TEXT"]) {
      try { this.db.exec(`ALTER TABLE cards ADD COLUMN ${col}`); } catch { /* already there */ }
    }
  }

  // ── Cards ─────────────────────────────────────────────────────
  async createCard(c: Card) {
    this.db.prepare(`INSERT INTO cards (id,name,category,color,nfc_uid,emblem,foil,texture,created_at,last_timer_id,deadline,deadline_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(c.id, c.name, c.category, c.color, c.nfcUid, c.emblem ?? null, c.foil ?? null, c.texture ?? null, c.createdAt,
           c.lastTimerId ?? null, c.deadline ?? null, c.deadlineKind ?? "until");
  }
  async getCard(id: string) { const r = this.db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id); return r ? this.toCard(r) : null; }
  async listCards() { return this.db.prepare(`SELECT * FROM cards ORDER BY created_at`).all().map(r => this.toCard(r)); }
  async updateCard(c: Card) {
    this.db.prepare(`UPDATE cards SET name=?,category=?,color=?,nfc_uid=?,emblem=?,foil=?,texture=?,last_timer_id=?,deadline=?,deadline_kind=? WHERE id=?`)
      .run(c.name, c.category, c.color, c.nfcUid, c.emblem ?? null, c.foil ?? null, c.texture ?? null, c.lastTimerId ?? null, c.deadline ?? null, c.deadlineKind ?? "until", c.id);
  }
  async deleteCard(id: string) {
    this.db.prepare(`DELETE FROM sessions WHERE card_id = ?`).run(id);
    this.db.prepare(`DELETE FROM timers WHERE card_id = ?`).run(id);
    this.db.prepare(`DELETE FROM cards WHERE id = ?`).run(id);
  }
  async getCardByNfc(uid: string) { const r = this.db.prepare(`SELECT * FROM cards WHERE nfc_uid = ?`).get(uid); return r ? this.toCard(r) : null; }

  // ── Timers ────────────────────────────────────────────────────
  async putTimer(t: Timer) {
    this.db.prepare(`INSERT OR REPLACE INTO timers (id,card_id,name,mode,target_ms,alarm_style,live_session,ord,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(t.id, t.cardId, t.name, t.mode, t.targetMs, t.alarmStyle,
           t.liveSession ? JSON.stringify(t.liveSession) : null, t.order, t.createdAt);
  }
  async getTimer(id: string) { const r = this.db.prepare(`SELECT * FROM timers WHERE id = ?`).get(id); return r ? this.toTimer(r) : null; }
  async listTimers(cardId: string) { return this.db.prepare(`SELECT * FROM timers WHERE card_id = ? ORDER BY ord`).all(cardId).map(r => this.toTimer(r)); }
  async deleteTimer(id: string) { this.db.prepare(`DELETE FROM timers WHERE id = ?`).run(id); }

  // ── Sessions ──────────────────────────────────────────────────
  async putSession(s: Session) {
    this.db.prepare(`INSERT OR REPLACE INTO sessions (id,card_id,timer_id,mode,target_ms,started_at,ended_at,paused_ms,paused_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(s.id, s.cardId, s.timerId, s.mode, s.targetMs, s.startedAt, s.endedAt, s.pausedMs, s.pausedAt);
  }
  async listSessions(cardId?: string) {
    const rows = cardId
      ? this.db.prepare(`SELECT * FROM sessions WHERE card_id = ? ORDER BY started_at`).all(cardId)
      : this.db.prepare(`SELECT * FROM sessions ORDER BY started_at`).all();
    return rows.map(r => this.toSession(r));
  }

  // ── Slot ──────────────────────────────────────────────────────
  async getSlot(): Promise<Slot> {
    const r: any = this.db.prepare(`SELECT card_id, active_timer_id, locked FROM slot WHERE id = 0`).get();
    return { cardId: r?.card_id ?? null, activeTimerId: r?.active_timer_id ?? null, locked: !!r?.locked };
  }
  async setSlot(slot: Slot) {
    this.db.prepare(`UPDATE slot SET card_id = ?, active_timer_id = ?, locked = ? WHERE id = 0`)
      .run(slot.cardId, slot.activeTimerId, slot.locked ? 1 : 0);
  }

  close() { this.db.close(); }
}
