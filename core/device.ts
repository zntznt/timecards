// The Device: the high-level API every interface drives. Wraps a Storage adapter
// and the pure timer logic into the actions a user actually takes.
//
// Model: a Card owns up to MAX_TIMERS Timers. The slot holds one card + one active
// timer. Each timer carries its OWN in-progress session (timer.liveSession), so
// switching timers SUSPENDS the current one and RESUMES the target — nothing is
// lost. Finishing (or a natural countdown end / repeat / timer delete) banks the
// active session into history; stop = freeze & keep, reset = discard.

import type { Storage, Card, Timer, Session, SlotView, TimerMode, AlarmStyle, DeadlineKind, TimecardsExport } from "./types.ts";
import { MAX_TIMERS } from "./types.ts";
import * as T from "./timer.ts";

/** Drop keys whose value is undefined so a partial config only changes what's set. */
function stripUndefined<O extends object>(o: O): Partial<O> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<O>;
}

/** Make a CLI/URL-safe id from a name: "Crochet Time!" -> "crochet-time". */
export function slugify(name: string): string {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "card";
}

/** A sensible auto-name for a new timer from its config. */
export function defaultTimerName(mode: TimerMode, targetMs: number | null): string {
  if (mode === "up") return "Stopwatch";
  const min = targetMs ? Math.round(targetMs / 60000) : 0;
  return min ? `${min} min` : "Countdown";
}

export class Device {
  private store: Storage;
  private now: () => number;
  private newId: () => string;

  constructor(
    store: Storage,
    now: () => number = () => Date.now(),
    newId: () => string = () => Math.random().toString(36).slice(2, 10),
  ) {
    this.store = store;
    this.now = now;
    this.newId = newId;
  }

  // ── Cards ──────────────────────────────────────────────────────
  async createCard(name: string, opts: {
    category?: string; color?: string; id?: string; emblem?: string; foil?: string; texture?: string;
    // Optional: seed a first timer with this config (else the card starts empty).
    defaultMode?: TimerMode; defaultTargetMs?: number | null; alarmStyle?: AlarmStyle;
  } = {}): Promise<Card> {
    let id = opts.id ?? slugify(name);
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
      emblem: opts.emblem ?? null,
      foil: opts.foil ?? null,
      texture: opts.texture ?? null,
      nfcUid: null,
      createdAt: this.now(),
      lastTimerId: null,
      deadline: null,
      deadlineKind: "until",
    };
    await this.store.createCard(card);
    // Seed a first timer so a fresh card is immediately usable.
    const mode = opts.defaultMode ?? "up";
    const targetMs = mode === "down" ? opts.defaultTargetMs ?? null : null;
    await this.addTimer(id, { mode, targetMs, alarmStyle: opts.alarmStyle ?? "chime" });
    return (await this.store.getCard(id))!;
  }

  /** Set card-level config (deadline / category / color). Only provided keys change. */
  async configureCard(id: string, cfg: {
    deadline?: number | null; deadlineKind?: DeadlineKind;
    category?: string | null; color?: string | null;
    emblem?: string | null; foil?: string | null; texture?: string | null;
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

  async registerNfc(id: string, nfcUid: string): Promise<Card> {
    const card = await this.requireCard(id);
    const updated = { ...card, nfcUid };
    await this.store.updateCard(updated);
    return updated;
  }

  /** Delete a card, its timers, and its history. Ejects first if slotted. */
  async deleteCard(id: string): Promise<void> {
    const slot = await this.store.getSlot();
    if (slot.cardId === id) await this.eject();
    for (const t of await this.store.listTimers(id)) await this.store.deleteTimer(t.id);
    await this.store.deleteCard(id);
  }

  // ── Timers (within a card) ─────────────────────────────────────

  listTimers(cardId: string): Promise<Timer[]> { return this.store.listTimers(cardId); }

  /** Add a timer to a card. Throws if the card already has MAX_TIMERS.
   *  Returns the created timer. The card's lastTimerId points at it if it was the first. */
  async addTimer(cardId: string, cfg: {
    name?: string; mode?: TimerMode; targetMs?: number | null; alarmStyle?: AlarmStyle;
  } = {}): Promise<Timer> {
    const card = await this.requireCard(cardId);
    const existing = await this.store.listTimers(cardId);
    if (existing.length >= MAX_TIMERS) {
      throw new Error(`Card "${cardId}" already has the maximum of ${MAX_TIMERS} timers`);
    }
    const mode = cfg.mode ?? "up";
    const targetMs = mode === "down" ? cfg.targetMs ?? null : null;
    const timer: Timer = {
      id: this.newId(),
      cardId,
      name: (cfg.name ?? "").trim() || defaultTimerName(mode, targetMs),
      mode,
      targetMs,
      alarmStyle: cfg.alarmStyle ?? "chime",
      liveSession: null,
      order: existing.length,
      createdAt: this.now(),
    };
    await this.store.putTimer(timer);
    // First timer on the card becomes its default-loaded one.
    if (!card.lastTimerId) await this.store.updateCard({ ...card, lastTimerId: timer.id });
    return timer;
  }

  /** Edit a timer's config. Changing mode/target only affects future sessions;
   *  a running session is left alone (stop it first to apply a new countdown). */
  async configureTimer(timerId: string, cfg: {
    name?: string; mode?: TimerMode; targetMs?: number | null; alarmStyle?: AlarmStyle;
  }): Promise<Timer> {
    const timer = await this.requireTimer(timerId);
    const next: Timer = { ...timer, ...stripUndefined(cfg) };
    if (next.mode === "up") next.targetMs = null;
    await this.store.putTimer(next);
    return next;
  }

  /** Delete a timer. Its in-progress session (if any) is saved to history first.
   *  If it was the active/last timer, the card falls back to another (or none). */
  async deleteTimer(timerId: string): Promise<SlotView> {
    const timer = await this.requireTimer(timerId);
    if (timer.liveSession) await this.finalize(timer.liveSession);
    await this.store.deleteTimer(timerId);

    const card = await this.store.getCard(timer.cardId);
    if (card) {
      const remaining = await this.store.listTimers(timer.cardId);
      if (card.lastTimerId === timerId) {
        await this.store.updateCard({ ...card, lastTimerId: remaining[0]?.id ?? null });
      }
      // If the deleted timer was active in the slot, repoint the slot.
      const slot = await this.store.getSlot();
      if (slot.cardId === card.id && slot.activeTimerId === timerId) {
        await this.store.setSlot({ ...slot, activeTimerId: remaining[0]?.id ?? null });
      }
    }
    return this.view();
  }

  /** Switch the active timer on the slotted card. SUSPENDS the current timer
   *  (pauses its session, kept on the timer) and activates the target (its held
   *  session resumes when pressed; a paused held session stays paused until press). */
  async switchTimer(timerId: string): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (!slot.cardId || slot.locked) return this.view();
    const target = await this.store.getTimer(timerId);
    if (!target || target.cardId !== slot.cardId) return this.view(); // not this card's timer
    if (slot.activeTimerId === timerId) return this.view();           // already active

    // Suspend the outgoing timer: if it's running, pause it (held on the timer).
    if (slot.activeTimerId) {
      const current = await this.store.getTimer(slot.activeTimerId);
      if (current?.liveSession && current.liveSession.pausedAt === null && current.liveSession.endedAt === null) {
        await this.store.putTimer({ ...current, liveSession: T.pause(current.liveSession, this.now()) });
      }
    }
    await this.store.setSlot({ ...slot, activeTimerId: timerId });
    // Remember this as the card's last-used timer.
    const card = await this.store.getCard(slot.cardId);
    if (card) await this.store.updateCard({ ...card, lastTimerId: timerId });
    return this.view();
  }

  // ── The slot ───────────────────────────────────────────────────

  /** Put a card into the device. Suspends the previous card's active timer (held),
   *  loads this card's last-used timer. Ignored while locked: the lock holds the
   *  card in the slot — unlock first. */
  async slot(cardId: string): Promise<SlotView> {
    await this.requireCard(cardId);
    const current = await this.store.getSlot();
    if (current.locked) return this.view();
    if (current.cardId === cardId) return this.view();
    // Suspend the outgoing card's active timer (pause if running — kept on timer).
    await this.suspendActive(current);
    const card = await this.store.getCard(cardId);
    const timers = await this.store.listTimers(cardId);
    const activeTimerId = card?.lastTimerId && timers.some(t => t.id === card.lastTimerId)
      ? card.lastTimerId
      : timers[0]?.id ?? null;
    await this.store.setSlot({ cardId, activeTimerId, locked: false });
    return this.view();
  }

  async slotByNfc(nfcUid: string): Promise<SlotView> {
    const card = await this.store.getCardByNfc(nfcUid);
    if (!card) return this.view();
    return this.slot(card.id);
  }

  /** Remove the card from the device. Its active timer is suspended (held, not lost).
   *  Ignored while locked. */
  async eject(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (slot.locked) return this.view();
    await this.suspendActive(slot);
    await this.store.setSlot({ cardId: null, activeTimerId: null, locked: false });
    return this.view();
  }

  // ── The big button ─────────────────────────────────────────────

  /** One press, on the ACTIVE timer:
   *  ready -> start (using the timer's mode/target), running -> pause, paused -> resume,
   *  finished -> repeat (save the round, restart it at the same duration).
   *  No-op only when there's no active timer.
   *  The big button stays LIVE while locked: the lock freezes the card and its
   *  configuration (eject/slot/switch/stop/reset/finish), but you can still
   *  start/pause/resume/repeat the running session. `press` alone ignores the lock. */
  async press(opts: { mode?: TimerMode; targetMs?: number } = {}): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (!slot.cardId || !slot.activeTimerId) return this.view();
    const timer = await this.store.getTimer(slot.activeTimerId);
    if (!timer) return this.view();
    const now = this.now();
    const action = T.bigButtonAction(T.runState(timer.liveSession, now));
    switch (action) {
      case "start": {
        const mode = opts.mode ?? timer.mode;
        const targetMs = opts.targetMs ?? (mode === "down" ? timer.targetMs : null);
        const s = T.startSession(this.newId(), timer.cardId, timer.id, now, mode, targetMs);
        await this.store.putTimer({ ...timer, liveSession: s });
        break;
      }
      case "pause":
        await this.store.putTimer({ ...timer, liveSession: T.pause(timer.liveSession!, now) });
        break;
      case "resume":
        await this.store.putTimer({ ...timer, liveSession: T.resume(timer.liveSession!, now) });
        break;
      case "noop":
        // finished — pressing again repeats the round (device's repeat function).
        if (timer.liveSession && T.runState(timer.liveSession, now) === "finished") return this.repeat();
        break;
    }
    return this.view();
  }

  /** Repeat: save the active timer's finished (or in-progress) session to history,
   *  then start a fresh session at the SAME mode/duration as the one that just ran.
   *  This is the device's "repeat" — one action begins the next identical round. */
  async repeat(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (slot.locked || !slot.activeTimerId) return this.view();
    const timer = await this.store.getTimer(slot.activeTimerId);
    if (!timer || !timer.liveSession) return this.view(); // nothing to repeat
    const prev = timer.liveSession;
    await this.finalize(prev);                              // save the round
    const now = this.now();
    const next = T.startSession(this.newId(), timer.cardId, timer.id, now, prev.mode, prev.targetMs);
    await this.store.putTimer({ ...timer, liveSession: next });
    return this.view();
  }

  /** Stop = freeze & keep. Pauses the active timer's run and HOLDS it (no history
   *  write, readout stays where it is). Resume with the big button later. The run is
   *  only banked to history when it finishes naturally, is repeated, the timer is
   *  deleted, or you call finish(). Ignored while locked. */
  async stop(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (slot.locked || !slot.activeTimerId) return this.view();
    const timer = await this.store.getTimer(slot.activeTimerId);
    if (timer?.liveSession && timer.liveSession.pausedAt === null && timer.liveSession.endedAt === null) {
      await this.store.putTimer({ ...timer, liveSession: T.pause(timer.liveSession, this.now()) });
    }
    return this.view();
  }

  /** Reset = discard the current run. Clears the active timer's session WITHOUT
   *  writing it to history, so a countdown returns to its full duration / a
   *  stopwatch to zero. Exception: a FINISHED countdown banks its round first —
   *  that time fully elapsed, and earned time can't be discarded. Ignored while
   *  locked. */
  async reset(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (slot.locked || !slot.activeTimerId) return this.view();
    const timer = await this.store.getTimer(slot.activeTimerId);
    if (timer?.liveSession) {
      if (T.runState(timer.liveSession, this.now()) === "finished") await this.finalize(timer.liveSession);
      await this.store.putTimer({ ...timer, liveSession: null });
    }
    return this.view();
  }

  /** Finish = bank the current run to history and clear it (the timer goes idle,
   *  ready for a fresh start). The explicit "this run is done, save it" action. */
  async finish(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    if (slot.locked || !slot.activeTimerId) return this.view();
    const timer = await this.store.getTimer(slot.activeTimerId);
    if (timer?.liveSession) {
      await this.finalize(timer.liveSession);
      await this.store.putTimer({ ...timer, liveSession: null });
    }
    return this.view();
  }

  async lock(on?: boolean): Promise<SlotView> {
    const slot = await this.store.getSlot();
    await this.store.setSlot({ ...slot, locked: on ?? !slot.locked });
    return this.view();
  }

  // ── Reading ────────────────────────────────────────────────────

  async view(): Promise<SlotView> {
    const slot = await this.store.getSlot();
    const card = slot.cardId ? await this.store.getCard(slot.cardId) : null;
    const timers = card ? await this.store.listTimers(card.id) : [];
    const timer = slot.activeTimerId ? timers.find(t => t.id === slot.activeTimerId) ?? null : null;
    return T.viewOf(card, timer, timers, this.now(), slot.locked ?? false);
  }

  listSessions(cardId?: string): Promise<Session[]> { return this.store.listSessions(cardId); }

  /** Total tracked ms for a card across all completed sessions (all its timers). */
  async totalMs(cardId: string): Promise<number> {
    const sessions = await this.store.listSessions(cardId);
    return sessions.reduce((sum, s) => sum + T.elapsed(s, this.now()), 0);
  }

  /** Total tracked ms for a single timer across its completed sessions. */
  async timerTotalMs(timerId: string): Promise<number> {
    const timer = await this.store.getTimer(timerId);
    if (!timer) return 0;
    const sessions = await this.store.listSessions(timer.cardId);
    return sessions.filter(s => s.timerId === timerId).reduce((sum, s) => sum + T.elapsed(s, this.now()), 0);
  }

  /** Gather everything the stats functions need: all sessions + all cards + all
   *  timers. The caller runs core/stats.ts functions over the result. */
  async statsData(): Promise<{ sessions: Session[]; cards: Card[]; timers: Timer[]; now: number }> {
    const cards = await this.store.listCards();
    const sessions = await this.store.listSessions();
    const timers = (await Promise.all(cards.map(c => this.store.listTimers(c.id)))).flat();
    return { sessions, cards, timers, now: this.now() };
  }

  // ── Portability: export / import the whole dataset ──────────────
  // Used for backups and for moving between storage backends (local ↔ Supabase).

  /** Snapshot the entire dataset as a plain JSON-able object. */
  async exportAll(): Promise<TimecardsExport> {
    const cards = await this.store.listCards();
    const timers = (await Promise.all(cards.map(c => this.store.listTimers(c.id)))).flat();
    const sessions = await this.store.listSessions();
    const slot = await this.store.getSlot();
    return { version: 1, exportedAt: this.now(), cards, timers, sessions, slot };
  }

  /** Write an exported dataset into the current store. Merge (upsert) by id so it's
   *  safe to import into an existing store; existing rows with the same id are
   *  overwritten. Returns counts of what was written. */
  async importAll(data: TimecardsExport): Promise<{ cards: number; timers: number; sessions: number }> {
    for (const c of data.cards ?? []) {
      // upsert: create if absent, else update.
      if (await this.store.getCard(c.id)) await this.store.updateCard(c);
      else await this.store.createCard(c);
    }
    for (const t of data.timers ?? []) await this.store.putTimer(t);
    for (const s of data.sessions ?? []) await this.store.putSession(s);
    if (data.slot) await this.store.setSlot(data.slot);
    return { cards: data.cards?.length ?? 0, timers: data.timers?.length ?? 0, sessions: data.sessions?.length ?? 0 };
  }

  // ── internals ──────────────────────────────────────────────────

  /** Pause (suspend) the slot's active timer if it's running — keeps it on the timer. */
  private async suspendActive(slot: { cardId: string | null; activeTimerId: string | null }): Promise<void> {
    if (!slot.activeTimerId) return;
    const timer = await this.store.getTimer(slot.activeTimerId);
    if (timer?.liveSession && timer.liveSession.pausedAt === null && timer.liveSession.endedAt === null) {
      await this.store.putTimer({ ...timer, liveSession: T.pause(timer.liveSession, this.now()) });
    }
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

  private async requireTimer(id: string): Promise<Timer> {
    const timer = await this.store.getTimer(id);
    if (!timer) throw new Error(`No timer with id "${id}"`);
    return timer;
  }
}
