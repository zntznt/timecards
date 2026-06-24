// IndexedDB storage adapter — the browser/GitHub Pages backend.
// Implements the SAME Storage interface as SqliteStore, so the core, timer logic,
// big button, and every view are byte-for-byte identical to the CLI. Only persistence differs.
//
// IndexedDB is verbose; we wrap it in a few promise helpers. No dependency.

import type { Storage, Card, Timer, Session, Slot } from "../core/types.ts";

const DB_NAME = "timecards";
const DB_VERSION = 2; // v2 adds the `timers` store (Card → Timers model)

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains("cards")) db.createObjectStore("cards", { keyPath: "id" });
      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("byCard", "cardId");
      }
      if (!db.objectStoreNames.contains("slot")) db.createObjectStore("slot");
      // v2: timers store, indexed by card.
      if (!db.objectStoreNames.contains("timers")) {
        const timers = db.createObjectStore("timers", { keyPath: "id" });
        timers.createIndex("byCard", "cardId");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllByIndex<T>(db: IDBDatabase, store: string, index: string, key: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).index(index).getAll(key);
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
    const timers = await this.listTimers(id);
    for (const t of timers) await tx(db, "timers", "readwrite", s => s.delete(t.id));
  }
  async getCardByNfc(uid: string) {
    return (await this.listCards()).find(c => c.nfcUid === uid) ?? null;
  }

  async putTimer(t: Timer) { await tx(await this.dbp, "timers", "readwrite", s => s.put(t)); }
  async getTimer(id: string) { return (await tx<Timer | undefined>(await this.dbp, "timers", "readonly", s => s.get(id))) ?? null; }
  async listTimers(cardId: string) {
    const all = await getAllByIndex<Timer>(await this.dbp, "timers", "byCard", cardId);
    return all.sort((a, b) => a.order - b.order);
  }
  async deleteTimer(id: string) { await tx(await this.dbp, "timers", "readwrite", s => s.delete(id)); }

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
    return slot ?? { cardId: null, activeTimerId: null };
  }
  async setSlot(slot: Slot) { await tx(await this.dbp, "slot", "readwrite", s => s.put(slot, "current")); }
}
