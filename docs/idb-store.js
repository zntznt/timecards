// IndexedDB storage adapter — the browser/GitHub Pages backend.
// Implements the SAME Storage interface as SqliteStore, so the core, timer logic,
// big button, and every view are byte-for-byte identical to the CLI. Only persistence differs.
//
// IndexedDB is verbose; we wrap it in a few promise helpers. No dependency.

                                                                            

const DB_NAME = "timecards";
const DB_VERSION = 2; // v2 adds the `timers` store (Card → Timers model)

function openDb()                       {
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

function getAllByIndex   (db             , store        , index        , key        )               {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readonly").objectStore(store).index(index).getAll(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx   (db             , store        , mode                    , fn                                      )             {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IdbStore                    {
          dbp = openDb();

  async createCard(c      ) { await tx(await this.dbp, "cards", "readwrite", s => s.add(c)); }
  async getCard(id        ) { return (await tx                  (await this.dbp, "cards", "readonly", s => s.get(id))) ?? null; }
  async listCards() {
    const all = await tx        (await this.dbp, "cards", "readonly", s => s.getAll());
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async updateCard(c      ) { await tx(await this.dbp, "cards", "readwrite", s => s.put(c)); }
  async deleteCard(id        ) {
    const db = await this.dbp;
    await tx(db, "cards", "readwrite", s => s.delete(id));
    const sessions = await this.listSessions(id);
    for (const sess of sessions) await tx(db, "sessions", "readwrite", s => s.delete(sess.id));
    const timers = await this.listTimers(id);
    for (const t of timers) await tx(db, "timers", "readwrite", s => s.delete(t.id));
  }
  async getCardByNfc(uid        ) {
    return (await this.listCards()).find(c => c.nfcUid === uid) ?? null;
  }

  async putTimer(t       ) { await tx(await this.dbp, "timers", "readwrite", s => s.put(t)); }
  async getTimer(id        ) { return (await tx                   (await this.dbp, "timers", "readonly", s => s.get(id))) ?? null; }
  async listTimers(cardId        ) {
    const all = await getAllByIndex       (await this.dbp, "timers", "byCard", cardId);
    return all.sort((a, b) => a.order - b.order);
  }
  async deleteTimer(id        ) { await tx(await this.dbp, "timers", "readwrite", s => s.delete(id)); }

  async putSession(sess         ) { await tx(await this.dbp, "sessions", "readwrite", s => s.put(sess)); }
  async listSessions(cardId         ) {
    const db = await this.dbp;
    if (!cardId) {
      const all = await tx           (db, "sessions", "readonly", s => s.getAll());
      return all.sort((a, b) => a.startedAt - b.startedAt);
    }
    const byCard = await new Promise           ((resolve, reject) => {
      const req = db.transaction("sessions", "readonly").objectStore("sessions").index("byCard").getAll(cardId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return byCard.sort((a, b) => a.startedAt - b.startedAt);
  }

  async getSlot()                {
    const slot = await tx                  (await this.dbp, "slot", "readonly", s => s.get("current"));
    return slot ?? { cardId: null, activeTimerId: null };
  }
  async setSlot(slot      ) { await tx(await this.dbp, "slot", "readwrite", s => s.put(slot, "current")); }
}
