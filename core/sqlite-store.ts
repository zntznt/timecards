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
import type { Storage, Card, Session, Slot } from "./types.ts";

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
      PRAGMA journal_mode = WAL;          -- safe concurrent reads (UI + Pi)
      CREATE TABLE IF NOT EXISTS cards (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        category  TEXT,
        color     TEXT,
        nfc_uid   TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        default_mode      TEXT,     -- 'up' | 'down'
        default_target_ms INTEGER,
        alarm_style       TEXT,     -- 'chime' | 'blip' | 'silent'
        deadline          INTEGER,  -- epoch ms target date, or NULL
        deadline_kind     TEXT      -- 'until' | 'since'
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id        TEXT PRIMARY KEY,
        card_id   TEXT NOT NULL,
        mode      TEXT NOT NULL,
        target_ms INTEGER,
        started_at INTEGER NOT NULL,
        ended_at  INTEGER,
        paused_ms INTEGER NOT NULL DEFAULT 0,
        paused_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_card ON sessions(card_id);
      -- Single-row table holding the one active slot. id is always 0.
      CREATE TABLE IF NOT EXISTS slot (
        id      INTEGER PRIMARY KEY CHECK (id = 0),
        card_id TEXT,
        session TEXT,                      -- JSON-encoded live Session, or NULL
        locked  INTEGER NOT NULL DEFAULT 0 -- 0/1
      );
    `);
    // Migrate BEFORE seeding the slot row — an old `slot` table is missing the
    // `locked` column until migrate() adds it, and the seed INSERT references it.
    this.migrate();
    this.db.exec(`INSERT OR IGNORE INTO slot (id, card_id, session, locked) VALUES (0, NULL, NULL, 0)`);
  }

  /** Additive migrations for DBs created before these columns existed.
   *  ALTER ... ADD COLUMN throws "duplicate column" if already present — ignore that. */
  private migrate() {
    const adds = [
      `ALTER TABLE cards ADD COLUMN default_mode TEXT`,
      `ALTER TABLE cards ADD COLUMN default_target_ms INTEGER`,
      `ALTER TABLE cards ADD COLUMN alarm_style TEXT`,
      `ALTER TABLE cards ADD COLUMN deadline INTEGER`,
      `ALTER TABLE cards ADD COLUMN deadline_kind TEXT`,
      `ALTER TABLE slot ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`,
    ];
    for (const sql of adds) {
      try { this.db.exec(sql); } catch { /* column already exists — fine */ }
    }
  }

  // ── row <-> object mapping ────────────────────────────────────
  private toCard(r: any): Card {
    return {
      id: r.id, name: r.name, category: r.category, color: r.color,
      nfcUid: r.nfc_uid, createdAt: r.created_at,
      defaultMode: r.default_mode ?? "up",
      defaultTargetMs: r.default_target_ms ?? null,
      alarmStyle: r.alarm_style ?? "chime",
      deadline: r.deadline ?? null,
      deadlineKind: r.deadline_kind ?? "until",
    };
  }
  private toSession(r: any): Session {
    return {
      id: r.id, cardId: r.card_id, mode: r.mode, targetMs: r.target_ms,
      startedAt: r.started_at, endedAt: r.ended_at, pausedMs: r.paused_ms, pausedAt: r.paused_at,
    };
  }

  // ── Cards ─────────────────────────────────────────────────────
  async createCard(c: Card) {
    this.db.prepare(`INSERT INTO cards
      (id,name,category,color,nfc_uid,created_at,default_mode,default_target_ms,alarm_style,deadline,deadline_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(c.id, c.name, c.category, c.color, c.nfcUid, c.createdAt,
           c.defaultMode ?? "up", c.defaultTargetMs ?? null, c.alarmStyle ?? "chime",
           c.deadline ?? null, c.deadlineKind ?? "until");
  }
  async getCard(id: string) {
    const r = this.db.prepare(`SELECT * FROM cards WHERE id = ?`).get(id);
    return r ? this.toCard(r) : null;
  }
  async listCards() {
    return this.db.prepare(`SELECT * FROM cards ORDER BY created_at`).all().map(r => this.toCard(r));
  }
  async updateCard(c: Card) {
    this.db.prepare(`UPDATE cards SET
      name=?,category=?,color=?,nfc_uid=?,
      default_mode=?,default_target_ms=?,alarm_style=?,deadline=?,deadline_kind=?
      WHERE id=?`)
      .run(c.name, c.category, c.color, c.nfcUid,
           c.defaultMode ?? "up", c.defaultTargetMs ?? null, c.alarmStyle ?? "chime",
           c.deadline ?? null, c.deadlineKind ?? "until", c.id);
  }
  async deleteCard(id: string) {
    this.db.prepare(`DELETE FROM sessions WHERE card_id = ?`).run(id);
    this.db.prepare(`DELETE FROM cards WHERE id = ?`).run(id);
  }
  async getCardByNfc(uid: string) {
    const r = this.db.prepare(`SELECT * FROM cards WHERE nfc_uid = ?`).get(uid);
    return r ? this.toCard(r) : null;
  }

  // ── Sessions ──────────────────────────────────────────────────
  async putSession(s: Session) {
    this.db.prepare(`INSERT OR REPLACE INTO sessions
      (id,card_id,mode,target_ms,started_at,ended_at,paused_ms,paused_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(s.id, s.cardId, s.mode, s.targetMs, s.startedAt, s.endedAt, s.pausedMs, s.pausedAt);
  }
  async listSessions(cardId?: string) {
    const rows = cardId
      ? this.db.prepare(`SELECT * FROM sessions WHERE card_id = ? ORDER BY started_at`).all(cardId)
      : this.db.prepare(`SELECT * FROM sessions ORDER BY started_at`).all();
    return rows.map(r => this.toSession(r));
  }

  // ── Slot ──────────────────────────────────────────────────────
  async getSlot(): Promise<Slot> {
    const r: any = this.db.prepare(`SELECT card_id, session, locked FROM slot WHERE id = 0`).get();
    return {
      cardId: r?.card_id ?? null,
      session: r?.session ? JSON.parse(r.session) : null,
      locked: !!r?.locked,
    };
  }
  async setSlot(slot: Slot) {
    this.db.prepare(`UPDATE slot SET card_id = ?, session = ?, locked = ? WHERE id = 0`)
      .run(slot.cardId, slot.session ? JSON.stringify(slot.session) : null, slot.locked ? 1 : 0);
  }

  close() { this.db.close(); }
}
