// The Device: the high-level API every interface drives. Wraps a Storage adapter
// and the pure timer logic into the actions a user actually takes.
//
// "The device" = the single slot you put a card into. One card in at a time.
// Swapping a card stops the outgoing card's session (its time is saved to history).

import type { Storage, Card, Session, SlotView, TimerMode, AlarmStyle, DeadlineKind } from "./types.ts";
import * as T from "./timer.ts";

/** Drop keys whose value is undefined so a partial config only changes what's set. */
function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Make a CLI/URL-safe id from a name: "Crochet Time!" -> "crochet-time". */
export function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "card";
}

export class Device {
  // Node's strip-only TS doesn't allow constructor parameter properties, so we
  // declare fields explicitly. ponytail: boring over clever — runs with zero build.
  private store: Storage;
  private now: () => number;
  private newId: () => string;

  constructor(
    store: Storage,
    /** Injectable clock + id source — keeps Device testable. Defaults to real ones. */
    now: () => number = () => Date.now(),
    newId: () => string = () => Math.random().toString(36).slice(2, 10),
  ) {
    this.store = store;
    this.now = now;
    this.newId = newId;
  }

  // ── Cards ──────────────────────────────────────────────────────
  async createCard(name: string, opts: {
    category?: string; color?: string; id?: string;
    defaultMode?: TimerMode; defaultTargetMs?: number | null; alarmStyle?: AlarmStyle;
  } = {}): Promise<Card> {
    let id = opts.id ?? slugify(name);
    // Ensure unique id without surprising the user — append -2, -3, ... if taken.
    if (await this.store.getCard(id)) {
      let n = 2;
      while (await this.store.getCard(`${id}-${n}`)) n++;
      id = `${id}-${n}`;
    }
    const card: Card = {
      id,
      name: name.trim() || id,
      category: opts.category ?? null,
      color: opts.color ?? null,
      nfcUid: null,
      createdAt: this.now(),
      defaultMode: opts.defaultMode ?? "up",
      defaultTargetMs: opts.defaultTargetMs ?? null,
      alarmStyle: opts.alarmStyle ?? "chime",
      deadline: null,
      deadlineKind: "until",
    };
    await this.store.createCard(card);
    return card;
  }

  /** Set a card's defaults / deadline / alarm. Only provided keys change. */
  async configureCard(id: string, cfg: {
    defaultMode?: TimerMode; defaultTargetMs?: number | null;
    alarmStyle?: AlarmStyle; deadline?: number | null; deadlineKind?: DeadlineKind;
    category?: string | null; color?: string | null;
  }): Promise<Card> {
    const card = await this.requireCard(id);
    const updated: Card = { ...card, ...stripUndefined(cfg) };
    await this.store.updateCard(updated);
    return updated;
  }

  listCards(): Promise<Card[]> { return this.store.listCards(); }
  getCard(id: string): Promise<Card | null> { return this.store.getCard(id); }

  async renameCard(id: string, name: string): Promise<Card> {
    const card = await this.requireCard(id);
    const updated = { ...card, name: name.trim() || card.name };
    await this.store.updateCard(updated);
    return updated;
  }

  /** Register a physical NFC tag UID to a card (for the hardware bridge). */
  async registerNfc(id: string, nfcUid: string): Promise<Card> {
    const card = await this.requireCard(id);
    const updated = { ...card, nfcUid };
    await this.store.updateCard(updated);
    return updated;
  }

  /** Delete a card and its history. If it's slotted, eject first. */
  async deleteCard(id: string): Promise<void> {
    const slot = await this.store.getSlot();
    if (slot.cardId === id) await this.eject();
    await this.store.deleteCard(id);
  }

  // ── The slot ───────────────────────────────────────────────────

  /** Put a card into the device. Stops the previous card's running session first
   *  (its time is preserved in history). The new card starts in 'ready'. */
  async slot(cardId: string): Promise<SlotView> {
    await this.requireCard(cardId);
    const current = await this.store.getSlot();
    if (current.cardId === cardId) return this.view(); // already in, no-op
    if (current.session) await this.finalize(current.session); // save outgoing
    await this.store.setSlot({ cardId, session: null });
    return this.view();
  }

  /** Slot a card by its NFC tag. Returns null view-card if the tag is unknown. */
  async slotByNfc(nfcUid: string): Promise<SlotView> {
    const card = await this.store.getCardByNfc(nfcUid);
    if (!card) return this.view(); // unknown tag — caller can prompt to register
    return this.slot(card.id);
  }

  /** Remove the card from the device, saving any running session to history. */
  async eject(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (slot.session) await this.finalize(slot.session);
    await this.store.setSlot({ cardId: null, session: null });
    return this.view();
  }

  // ── The big button ─────────────────────────────────────────────

  /** One press. Does the right thing for the current state:
   *  ready -> start, running -> pause, paused -> resume.
   *  On start with no override, honors the card's default mode/target.
   *  Ignored while the slot is locked. */
  async press(opts: { mode?: TimerMode; targetMs?: number } = {}): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (!slot.cardId) return this.view(); // empty slot — nothing to press
    if (slot.locked) return this.view();   // locked — ignore presses
    const now = this.now();
    const action = T.bigButtonAction(T.runState(slot.session, now));
    switch (action) {
      case "start": {
        // Override wins; otherwise fall back to the card's configured default.
        const card = await this.store.getCard(slot.cardId);
        const mode = opts.mode ?? card?.defaultMode ?? "up";
        const targetMs = opts.targetMs ?? (mode === "down" ? card?.defaultTargetMs ?? null : null);
        const s = T.startSession(this.newId(), slot.cardId, now, mode, targetMs);
        await this.saveSlot(slot, s);
        break;
      }
      case "pause":
        await this.saveSlot(slot, T.pause(slot.session!, now));
        break;
      case "resume":
        await this.saveSlot(slot, T.resume(slot.session!, now));
        break;
      // noop: empty or finished — press does nothing; caller uses stop()/reset.
    }
    return this.view();
  }

  /** Stop and save the current session to history. Slot keeps the same card (ready again).
   *  Ignored while locked. */
  async stop(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (slot.locked) return this.view();
    if (slot.session) {
      await this.finalize(slot.session);
      await this.saveSlot(slot, null);
    }
    return this.view();
  }

  /** Toggle (or set) the slot lock. The lock itself is always operable. */
  async lock(on?: boolean): Promise<SlotView> {
    const slot = await this.store.getSlot();
    const locked = on ?? !slot.locked;
    await this.store.setSlot({ ...slot, locked });
    return this.view();
  }

  // ── Reading ────────────────────────────────────────────────────

  async view(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    const card = slot.cardId ? await this.store.getCard(slot.cardId) : null;
    return T.viewOf(card, slot.session, this.now(), slot.locked ?? false);
  }

  listSessions(cardId?: string): Promise<Session[]> { return this.store.listSessions(cardId); }

  /** Total tracked ms for a card across all completed sessions. */
  async totalMs(cardId: string): Promise<number> {
    const sessions = await this.store.listSessions(cardId);
    return sessions.reduce((sum, s) => sum + T.elapsed(s, this.now()), 0);
  }

  // ── internals ──────────────────────────────────────────────────

  /** Persist a new session into the current slot, preserving its lock state.
   *  Used by press/stop so locking survives within one slotted card's lifetime. */
  private saveSlot(slot: { cardId: string | null; locked?: boolean }, session: Session | null): Promise<void> {
    return this.store.setSlot({ cardId: slot.cardId, session, locked: slot.locked ?? false });
  }

  private async finalize(session: Session): Promise<void> {
    const stopped = T.stop(session, this.now());
    await this.store.putSession(stopped);
  }

  private async requireCard(id: string): Promise<Card> {
    const card = await this.store.getCard(id);
    if (!card) throw new Error(`No card with id "${id}"`);
    return card;
  }
}
