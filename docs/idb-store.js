// IndexedDB storage adapter — the browser/GitHub Pages backend.
// Implements the SAME Storage interface as SqliteStore, so the core, timer logic,
// big button, and every view are byte-for-byte identical to the CLI. Only persistence differs.
//
// IndexedDB is verbose; we wrap it in a few promise helpers. No dependency.

                                                                     

const DB_NAME = "timecards";
const DB_VERSION = 1;

function openDb()                       {
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
  }
  async getCardByNfc(uid        ) {
    return (await this.listCards()).find(c => c.nfcUid === uid) ?? null;
  }

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
    return slot ?? { cardId: null, session: null };
  }
  async setSlot(slot      ) { await tx(await this.dbp, "slot", "readwrite", s => s.put(slot, "current")); }
}
