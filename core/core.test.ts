// Runnable self-check for the core. No framework: `node core/core.test.ts`.
// Asserts the timer math and the big-button state machine, since those are the
// parts that silently corrupt data if they break.

import assert from "node:assert/strict";
import type { Storage, Card, Session, Slot } from "./types.ts";
import { Device } from "./device.ts";
import * as T from "./timer.ts";

// In-memory Storage so the core is testable with zero I/O.
class MemStore implements Storage {
  cards = new Map<string, Card>();
  sessions: Session[] = [];
  slot: Slot = { cardId: null, session: null };
  async createCard(c: Card) { this.cards.set(c.id, c); }
  async getCard(id: string) { return this.cards.get(id) ?? null; }
  async listCards() { return [...this.cards.values()]; }
  async updateCard(c: Card) { this.cards.set(c.id, c); }
  async deleteCard(id: string) { this.cards.delete(id); this.sessions = this.sessions.filter(s => s.cardId !== id); }
  async getCardByNfc(uid: string) { return [...this.cards.values()].find(c => c.nfcUid === uid) ?? null; }
  async putSession(s: Session) { this.sessions.push(s); }
  async listSessions(cardId?: string) { return cardId ? this.sessions.filter(s => s.cardId === cardId) : this.sessions; }
  async getSlot() { return this.slot; }
  async setSlot(s: Slot) { this.slot = s; }
}

// A controllable clock so we can advance time deterministically.
function harness() {
  let t = 1_000_000;
  let n = 0;
  const store = new MemStore();
  const dev = new Device(store, () => t, () => `s${n++}`);
  return { store, dev, tick: (ms: number) => { t += ms; }, at: () => t };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

await test("create card slugifies and is unique", async () => {
  const { dev } = harness();
  const a = await dev.createCard("Crochet Time!");
  assert.equal(a.id, "crochet-time");
  const b = await dev.createCard("Crochet Time!");
  assert.equal(b.id, "crochet-time-2"); // collision handled
});

await test("full lifecycle: slot -> start -> pause -> resume -> stop, pause excluded", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Writing");
  await dev.slot(card.id);
  assert.equal((await dev.view()).state, "ready");

  await dev.press();                       // start (up)
  assert.equal((await dev.view()).state, "running");
  tick(10_000);                            // run 10s
  assert.equal((await dev.view()).elapsedMs, 10_000);

  await dev.press();                       // pause
  assert.equal((await dev.view()).state, "paused");
  tick(5_000);                             // paused 5s — must NOT count
  assert.equal((await dev.view()).elapsedMs, 10_000);

  await dev.press();                       // resume
  tick(3_000);                             // run 3 more
  assert.equal((await dev.view()).elapsedMs, 13_000);

  await dev.stop();                        // save to history
  assert.equal((await dev.view()).state, "ready");
  assert.equal(await dev.totalMs(card.id), 13_000); // pause excluded in history too
});

await test("countdown finishes at target and fires alarm flag", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Focus");
  await dev.slot(card.id);
  await dev.press({ mode: "down", targetMs: 25_000 });
  tick(24_999);
  let v = await dev.view();
  assert.equal(v.finished, false);
  assert.equal(v.remainingMs, 1);
  tick(1);
  v = await dev.view();
  assert.equal(v.finished, true);          // alarm moment
  assert.equal(v.state, "finished");
  assert.equal(v.remainingMs, 0);
});

await test("swapping cards saves the outgoing session to history", async () => {
  const { dev, tick } = harness();
  const a = await dev.createCard("A");
  const b = await dev.createCard("B");
  await dev.slot(a.id);
  await dev.press();
  tick(7_000);
  await dev.slot(b.id);                     // swap mid-run
  assert.equal(await dev.totalMs(a.id), 7_000); // A's time preserved
  assert.equal((await dev.view()).card?.id, "b");
  assert.equal((await dev.view()).state, "ready"); // B starts fresh
});

await test("NFC slot-by-tag works once registered", async () => {
  const { dev } = harness();
  const card = await dev.createCard("Cooking");
  await dev.registerNfc(card.id, "04:A2:B1:C3");
  const v = await dev.slotByNfc("04:A2:B1:C3");
  assert.equal(v.card?.id, "cooking");
  const unknown = await dev.slotByNfc("FF:FF");
  assert.equal(unknown.card?.id, "cooking"); // unknown tag = no change, stays slotted
});

await test("big button does nothing on empty slot", async () => {
  const { dev } = harness();
  const v = await dev.press();
  assert.equal(v.state, "empty");
});

await test("pure: bigButtonAction maps states correctly", async () => {
  assert.equal(T.bigButtonAction("ready"), "start");
  assert.equal(T.bigButtonAction("running"), "pause");
  assert.equal(T.bigButtonAction("paused"), "resume");
  assert.equal(T.bigButtonAction("empty"), "noop");
  assert.equal(T.bigButtonAction("finished"), "noop");
});

await test("press honors the card's default mode/target with no override", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Focus", { defaultMode: "down", defaultTargetMs: 25_000 });
  await dev.slot(card.id);
  const v = await dev.press();                 // no opts — should use the card default
  assert.equal(v.mode, "down");
  assert.equal(v.remainingMs, 25_000);
  tick(25_000);
  assert.equal((await dev.view()).finished, true);
});

await test("per-session override beats the card default", async () => {
  const { dev } = harness();
  const card = await dev.createCard("Focus", { defaultMode: "down", defaultTargetMs: 25_000 });
  await dev.slot(card.id);
  const v = await dev.press({ mode: "up" });    // override -> stopwatch
  assert.equal(v.mode, "up");
  assert.equal(v.remainingMs, null);
});

await test("lock ignores press and stop, but unlock restores control", async () => {
  const { dev, tick } = harness();
  const card = await dev.createCard("Writing");
  await dev.slot(card.id);
  await dev.press();                            // running
  tick(5_000);
  await dev.lock(true);
  assert.equal((await dev.view()).locked, true);
  await dev.press();                            // ignored
  assert.equal((await dev.view()).state, "running");
  tick(2_000);
  await dev.stop();                             // ignored
  assert.equal((await dev.view()).state, "running");
  await dev.lock(false);
  await dev.stop();                             // now works
  assert.equal((await dev.view()).state, "ready");
  assert.equal(await dev.totalMs(card.id), 7_000); // time kept accruing while locked
});

await test("lock clears when a different card is slotted", async () => {
  const { dev } = harness();
  const a = await dev.createCard("A");
  const b = await dev.createCard("B");
  await dev.slot(a.id);
  await dev.lock(true);
  await dev.slot(b.id);
  assert.equal((await dev.view()).locked, false); // swap resets the lock
});

await test("day-count 'until' counts down and flags passed", async () => {
  const { dev } = harness();
  const DAY = 86_400_000;
  const card = await dev.createCard("Novel");
  await dev.configureCard(card.id, { deadline: 1_000_000 + 3 * DAY, deadlineKind: "until" });
  await dev.slot(card.id);
  let v = await dev.view();
  assert.equal(v.dayCount?.days, 3);
  assert.equal(v.dayCount?.passed, false);
  // move the deadline into the past via a fresh harness clock isn't possible here;
  // instead set a past deadline and re-check.
  await dev.configureCard(card.id, { deadline: 1_000_000 - DAY });
  v = await dev.view();
  assert.equal(v.dayCount?.days, 0);
  assert.equal(v.dayCount?.passed, true);
});

await test("day-count 'since' counts a streak up from the date", async () => {
  const { dev } = harness();
  const DAY = 86_400_000;
  const card = await dev.createCard("Gym");
  await dev.configureCard(card.id, { deadline: 1_000_000 - 17 * DAY, deadlineKind: "since" });
  await dev.slot(card.id);
  assert.equal((await dev.view()).dayCount?.days, 17);
});

await test("alarmStyle resolves from the card, default chime", async () => {
  const { dev } = harness();
  const a = await dev.createCard("Loud", { alarmStyle: "blip" });
  const b = await dev.createCard("Default");
  await dev.slot(a.id);
  assert.equal((await dev.view()).alarmStyle, "blip");
  await dev.slot(b.id);
  assert.equal((await dev.view()).alarmStyle, "chime");
});

console.log(`\n${passed} core checks passed.`);
