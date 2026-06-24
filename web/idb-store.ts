// IndexedDB storage adapter — the browser/GitHub Pages backend.
// Implements the SAME Storage interface as SqliteStore, so the core, timer logic,
// big button, and every view are byte-for-byte identical to the CLI. Only persistence differs.
//
// IndexedDB is verbose; we wrap it in a few promise helpers. No dependency.

import type { Storage, Card, Session, Slot } from "../core/types.ts";

const DB_NAME = "timecards";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("cards", { keyPath: "id" });
      const sessions = db.createObjectStore("sessions", { keyPath: "id" });
      sessions.createIndex("byCard", "cardId");
      db.createObjectStore("slot"); // single key "current" -> Slot
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore implements Storage {
  private dbp = openDb();

  async createCard(c: Card) { await tx(await this.dbp, "cards", "readwrite", s => s.add(c)); }
  async getCard(id: string) { return (await tx<Card | undefined>(await this.dbp, "cards", "readonly", s => s.get(id))) ?? null; }
  async listCards() {
    const all = await tx<Card[]>(await this.dbp, "cards", "readonly", s => s.getAll());
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async updateCard(c: Card) { await tx(await this.dbp, "cards", "readwrite", s => s.put(c)); }
  async deleteCard(id: string) {
    const db = await this.dbp;
    await tx(db, "cards", "readwrite", s => s.delete(id));
    const sessions = await this.listSessions(id);
    for (const sess of sessions) await tx(db, "sessions", "readwrite", s => s.delete(sess.id));
  }
  async getCardByNfc(uid: string) {
    return (await this.listCards()).find(c => c.nfcUid === uid) ?? null;
  }

  async putSession(sess: Session) { await tx(await this.dbp, "sessions", "readwrite", s => s.put(sess)); }
  async listSessions(cardId?: string) {
    const db = await this.dbp;
    if (!cardId) {
      const all = await tx<Session[]>(db, "sessions", "readonly", s => s.getAll());
      return all.sort((a, b) => a.startedAt - b.startedAt);
    }
    const byCard = await new Promise<Session[]>((resolve, reject) => {
      const req = db.transaction("sessions", "readonly").objectStore("sessions").index("byCard").getAll(cardId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return byCard.sort((a, b) => a.startedAt - b.startedAt);
  }

  async getSlot(): Promise<Slot> {
    const slot = await tx<Slot | undefined>(await this.dbp, "slot", "readonly", s => s.get("current"));
    return slot ?? { cardId: null, session: null };
  }
  async setSlot(slot: Slot) { await tx(await this.dbp, "slot", "readwrite", s => s.put(slot, "current")); }
}
