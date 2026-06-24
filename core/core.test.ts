// Runnable self-check for the core. No framework: `node core/core.test.ts`.
// Covers the timer math, the big-button state machine, and the Card→Timers model
// with suspend/resume — the parts that silently corrupt data if they break.

import assert from "node:assert/strict";
import type { Storage, Card, Timer, Session, Slot } from "./types.ts";
import { MAX_TIMERS } from "./types.ts";
import { Device } from "./device.ts";
import * as T from "./timer.ts";

// In-memory Storage so the core is testable with zero I/O.
class MemStore implements Storage {
  cards = new Map<string, Card>();
  timers = new Map<string, Timer>();
  sessions: Session[] = [];
  slot: Slot = { cardId: null, activeTimerId: null };
  async createCard(c: Card) { this.cards.set(c.id, c); }
  async getCard(id: string) { return this.cards.get(id) ?? null; }
  async listCards() { return [...this.cards.values()]; }
  async updateCard(c: Card) { this.cards.set(c.id, c); }
  async deleteCard(id: string) { this.cards.delete(id); this.sessions = this.sessions.filter(s => s.cardId !== id); }
  async getCardByNfc(uid: string) { return [...this.cards.values()].find(c => c.nfcUid === uid) ?? null; }
  async putTimer(t: Timer) { this.timers.set(t.id, t); }
  async getTimer(id: string) { return this.timers.get(id) ?? null; }
  async listTimers(cardId: string) { return [...this.timers.values()].filter(t => t.cardId === cardId).sort((a, b) => a.order - b.order); }
  async deleteTimer(id: string) { this.timers.delete(id); }
  async putSession(s: Session) { this.sessions.push(s); }
  async listSessions(cardId?: string) { return cardId ? this.sessions.filter(s => s.cardId === cardId) : this.sessions; }
  async getSlot() { return this.slot; }
  async setSlot(s: Slot) { this.slot = s; }
}

// A controllable clock + deterministic ids.
function harness() {
  let t = 1_000_000;
  let n = 0;
  const store = new MemStore();
  const dev = new Device(store, () => t, () => `id${n++}`);
  return { store, dev, tick: (ms: number) => { t += ms; }, at: () => t };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await test("create card seeds a first timer; slug unique", async () => {
  const { dev } = harness();
  const a = await dev.createCard("Crochet Time!");
  assert.equal(a.id, "crochet-time");
  const timers = await dev.listTimers(a.id);
  assert.equal(timers.length, 1);                 // a usable timer exists immediately
  assert.equal(a.lastTimerId, timers[0].id);      // and is the default-loaded one
  const b = await dev.createCard("Crochet Time!");
  assert.equal(b.id, "crochet-time-2");
});

await test("full lifecycle on a timer: start/pause/resume/stop, pause excluded", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Writing");
  await dev.slot(card.id);
  assert.equal((await dev.view()).state, "ready");
  await dev.press();                       // start (the seeded stopwatch)
  tick(10_000);
  assert.equal((await dev.view()).elapsedMs, 10_000);
  await dev.press(); tick(5_000);          // pause 5s — must not count
  assert.equal((await dev.view()).elapsedMs, 10_000);
  await dev.press(); tick(3_000);          // resume
  assert.equal((await dev.view()).elapsedMs, 13_000);
  await dev.stop();
  assert.equal((await dev.view()).state, "ready");
  assert.equal(await dev.totalMs(card.id), 13_000);
});

await test("a card holds multiple timers up to the cap", async () => {
  const { dev } = harness();
  const card = await dev.createCard("Hobby");       // seeds 1
  await dev.addTimer(card.id, { name: "Deep work", mode: "down", targetMs: 50 * 60000 });
  await dev.addTimer(card.id, { name: "Sprint", mode: "down", targetMs: 15 * 60000 });
  assert.equal((await dev.listTimers(card.id)).length, 3);
  // fill to the cap
  while ((await dev.listTimers(card.id)).length < MAX_TIMERS) await dev.addTimer(card.id, {});
  assert.equal((await dev.listTimers(card.id)).length, MAX_TIMERS);
  await assert.rejects(() => dev.addTimer(card.id, {}), /maximum/);  // 11th rejected
});

await test("switching timers SUSPENDS one and RESUMES the other where it left off", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Hobby");
  const reading = (await dev.listTimers(card.id))[0];          // seeded stopwatch
  const pomo = await dev.addTimer(card.id, { name: "Pomodoro", mode: "down", targetMs: 25 * 60000 });
  await dev.slot(card.id);                                     // loads reading (lastTimerId)
  await dev.press(); tick(12_000);                            // reading runs 12s
  assert.equal((await dev.view()).elapsedMs, 12_000);

  await dev.switchTimer(pomo.id);                              // suspend reading, activate pomo
  assert.equal((await dev.view()).timer!.id, pomo.id);
  await dev.press(); tick(60_000);                            // pomo countdown runs 1 min
  assert.equal((await dev.view()).remainingMs, 24 * 60000);

  tick(99_999);                                                // time passes while reading is suspended
  await dev.switchTimer(reading.id);                           // back to reading
  assert.equal((await dev.view()).state, "paused");           // it was suspended (paused), not lost
  assert.equal((await dev.view()).elapsedMs, 12_000);         // exactly where we left it
  await dev.press(); tick(3_000);                            // resume
  assert.equal((await dev.view()).elapsedMs, 15_000);
});

await test("swapping cards suspends the active timer; coming back resumes it", async () => {
  const { dev, tick } = harness();
  const a = await dev.createCard("A");
  const b = await dev.createCard("B");
  await dev.slot(a.id);
  await dev.press(); tick(7_000);                              // A's timer runs 7s
  await dev.slot(b.id);                                        // swap — A suspended
  tick(50_000);
  await dev.slot(a.id);                                        // back to A
  assert.equal((await dev.view()).state, "paused");           // held, not stopped
  assert.equal((await dev.view()).elapsedMs, 7_000);
  assert.equal(await dev.totalMs(a.id), 0);                    // nothing saved to history yet
});

await test("slot loads the card's last-used timer", async () => {
  const { dev } = harness();
  const card = await dev.createCard("Hobby");
  const t2 = await dev.addTimer(card.id, { name: "Second" });
  await dev.slot(card.id);
  await dev.switchTimer(t2.id);                                // now t2 is last-used
  await dev.eject();
  await dev.slot(card.id);                                     // re-slot
  assert.equal((await dev.view()).timer!.id, t2.id);          // remembered
});

await test("delete timers down to zero, then create works", async () => {
  const { dev } = harness();
  const card = await dev.createCard("Hobby");
  const t1 = (await dev.listTimers(card.id))[0];
  const t2 = await dev.addTimer(card.id, {});
  await dev.slot(card.id);
  await dev.deleteTimer(t1.id);
  assert.equal((await dev.listTimers(card.id)).length, 1);
  await dev.deleteTimer(t2.id);
  assert.equal((await dev.listTimers(card.id)).length, 0);    // none remain
  assert.equal((await dev.view()).timer, null);
  const fresh = await dev.addTimer(card.id, { name: "New" }); // create when none
  assert.equal((await dev.listTimers(card.id)).length, 1);
  assert.equal(fresh.name, "New");
});

await test("deleting a running timer saves its time to history", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Hobby");
  const t = (await dev.listTimers(card.id))[0];
  await dev.slot(card.id);
  await dev.press(); tick(8_000);
  await dev.deleteTimer(t.id);
  assert.equal(await dev.totalMs(card.id), 8_000);            // not lost
});

await test("countdown finishes at target and flips the alarm flag", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Focus", { defaultMode: "down", defaultTargetMs: 25_000 });
  await dev.slot(card.id);
  await dev.press();
  tick(24_999); assert.equal((await dev.view()).finished, false);
  tick(1);      assert.equal((await dev.view()).finished, true);
  assert.equal((await dev.view()).state, "finished");
});

await test("repeat: finished countdown re-runs at the same duration, saving the round", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Focus", { defaultMode: "down", defaultTargetMs: 25_000 });
  await dev.slot(card.id);
  await dev.press();                         // start round 1
  tick(25_000);
  assert.equal((await dev.view()).state, "finished");

  await dev.repeat();                         // round 2
  const v = await dev.view();
  assert.equal(v.state, "running");           // fresh session running
  assert.equal(v.remainingMs, 25_000);        // same target
  assert.equal(await dev.totalMs(card.id), 25_000); // round 1 saved to history
  assert.equal((await dev.listSessions(card.id)).length, 1);
});

await test("repeat via the big button when finished", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Focus", { defaultMode: "down", defaultTargetMs: 10_000 });
  await dev.slot(card.id);
  await dev.press();                          // start
  tick(10_000);                               // finishes
  await dev.press();                          // press while finished -> repeat
  assert.equal((await dev.view()).state, "running");
  assert.equal((await dev.view()).remainingMs, 10_000);
  assert.equal(await dev.totalMs(card.id), 10_000);
});

await test("repeat preserves an overridden duration, not the timer default", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Focus", { defaultMode: "down", defaultTargetMs: 25_000 });
  await dev.slot(card.id);
  await dev.press({ mode: "down", targetMs: 5_000 });  // override: 5s round, not the 25s default
  tick(5_000);
  await dev.repeat();
  assert.equal((await dev.view()).remainingMs, 5_000);  // repeats the 5s round, not 25s
});

await test("per-timer alarmStyle resolves into the view", async () => {
  const { dev } = harness();
  const card = await dev.createCard("Hobby");
  const loud = await dev.addTimer(card.id, { name: "Loud", mode: "down", targetMs: 1000, alarmStyle: "blip" });
  await dev.slot(card.id);
  await dev.switchTimer(loud.id);
  assert.equal((await dev.view()).alarmStyle, "blip");
});

await test("lock ignores press/stop; swap clears it", async () => {
  const { dev, tick } = harness();
  const a = await dev.createCard("A");
  const b = await dev.createCard("B");
  await dev.slot(a.id);
  await dev.press(); tick(5_000);
  await dev.lock(true);
  await dev.press();  assert.equal((await dev.view()).state, "running");  // ignored
  await dev.stop();   assert.equal((await dev.view()).state, "running");  // ignored
  await dev.slot(b.id);
  assert.equal((await dev.view()).locked, false);                          // swap cleared lock
});

await test("NFC slot-by-tag works once registered", async () => {
  const { dev } = harness();
  const card = await dev.createCard("Cooking");
  await dev.registerNfc(card.id, "04:A2:B1:C3");
  assert.equal((await dev.slotByNfc("04:A2:B1:C3")).card?.id, "cooking");
});

await test("timerTotalMs splits history by timer", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Hobby");
  const t1 = (await dev.listTimers(card.id))[0];
  const t2 = await dev.addTimer(card.id, { name: "Other" });
  await dev.slot(card.id);
  await dev.press(); tick(4_000); await dev.stop();          // 4s on t1
  await dev.switchTimer(t2.id);
  await dev.press(); tick(9_000); await dev.stop();          // 9s on t2
  assert.equal(await dev.timerTotalMs(t1.id), 4_000);
  assert.equal(await dev.timerTotalMs(t2.id), 9_000);
  assert.equal(await dev.totalMs(card.id), 13_000);
});

await test("pure: bigButtonAction maps states correctly", async () => {
  assert.equal(T.bigButtonAction("ready"), "start");
  assert.equal(T.bigButtonAction("running"), "pause");
  assert.equal(T.bigButtonAction("paused"), "resume");
  assert.equal(T.bigButtonAction("empty"), "noop");
  assert.equal(T.bigButtonAction("finished"), "noop");
});

await test("export → import round-trips the whole dataset into a fresh store", async () => {
  const { dev, store, tick } = harness();
  const card = await dev.createCard("Hobby");
  const t2 = await dev.addTimer(card.id, { name: "Pomodoro", mode: "down", targetMs: 25 * 60000 });
  await dev.slot(card.id);
  await dev.press(); tick(5_000); await dev.stop();      // a history session
  await dev.switchTimer(t2.id); await dev.press();       // a live (suspended-able) session
  const dump = await dev.exportAll();
  assert.equal(dump.cards.length, 1);
  assert.equal(dump.timers.length, 2);
  assert.equal(dump.sessions.length, 1);

  // Import into a brand-new device/store and verify it matches.
  const fresh = new Device(new (store.constructor as any)(), () => 2_000_000, () => "x");
  const counts = await fresh.importAll(dump);
  assert.deepEqual(counts, { cards: 1, timers: 2, sessions: 1 });
  assert.equal((await fresh.listCards()).length, 1);
  assert.equal((await fresh.listTimers(card.id)).length, 2);
  assert.equal(await fresh.totalMs(card.id), 5_000);     // history preserved
  assert.equal((await fresh.view()).card?.id, "hobby");  // slot preserved
});

await test("import merges (upsert) into an existing store without dupes", async () => {
  const { dev } = harness();
  const card = await dev.createCard("A");
  const dump = await dev.exportAll();
  await dev.importAll(dump);                               // re-import same data
  assert.equal((await dev.listCards()).length, 1);         // no duplicate card
});

console.log(`\n${passed} core checks passed.`);
