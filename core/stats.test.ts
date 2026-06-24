// Self-check for stats. `node core/stats.test.ts`. Focuses on streak math and
// day bucketing — the parts with off-by-one and timezone traps.

import assert from "node:assert/strict";
import type { Session, Card, Timer } from "./types.ts";
import * as S from "./stats.ts";

const DAY = 86_400_000;
// A fixed "now" at local noon so day math is unambiguous.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime(); // 2026-06-15 12:00 local

// Build a finished session that STARTED `daysAgo` days before NOW, lasting `mins`.
function sess(id: string, cardId: string, timerId: string, daysAgo: number, mins: number): Session {
  const startedAt = NOW - daysAgo * DAY;
  return { id, cardId, timerId, mode: "up", targetMs: null, startedAt,
           endedAt: startedAt + mins * 60000, pausedMs: 0, pausedAt: null };
}

const cards: Card[] = [{ id: "hobby", name: "Hobby", category: null, color: null, nfcUid: null, createdAt: 0 }];
const timers: Timer[] = [
  { id: "t1", cardId: "hobby", name: "Pomodoro", mode: "down", targetMs: 1500000, alarmStyle: "chime", liveSession: null, order: 0, createdAt: 0 },
  { id: "t2", cardId: "hobby", name: "Reading", mode: "up", targetMs: null, alarmStyle: "chime", liveSession: null, order: 1, createdAt: 0 },
];

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log(`  ok  ${name}`); }

test("totalsByCard splits by timer, sorted desc", () => {
  const sessions = [sess("a", "hobby", "t1", 0, 25), sess("b", "hobby", "t1", 1, 25), sess("c", "hobby", "t2", 0, 40)];
  const byCard = S.totalsByCard(sessions, cards, timers, NOW);
  assert.equal(byCard.length, 1);
  assert.equal(byCard[0].ms, (25 + 25 + 40) * 60000);
  assert.equal(byCard[0].sessions, 3);
  // Pomodoro = 50 min > Reading = 40 min → Pomodoro first
  assert.equal(byCard[0].timers[0].name, "Pomodoro");
  assert.equal(byCard[0].timers[0].ms, 50 * 60000);
  assert.equal(byCard[0].timers[1].ms, 40 * 60000);
});

test("byDay returns N buckets oldest→newest, last is today", () => {
  const sessions = [sess("a", "hobby", "t1", 0, 25), sess("b", "hobby", "t1", 2, 10)];
  const days = S.byDay(sessions, NOW, 7);
  assert.equal(days.length, 7);
  assert.equal(days[6].ms, 25 * 60000);          // today
  assert.equal(days[4].ms, 10 * 60000);          // 2 days ago
  assert.equal(days[5].ms, 0);                    // yesterday: empty
  assert.equal(days[6].day, S.dayKey(NOW));
});

test("streak: 3 consecutive days incl today", () => {
  const sessions = [sess("a", "hobby", "t1", 0, 5), sess("b", "hobby", "t1", 1, 5), sess("c", "hobby", "t1", 2, 5)];
  const st = S.streaks(sessions, NOW);
  assert.equal(st.current, 3);
  assert.equal(st.longest, 3);
  assert.equal(st.activeDays, 3);
});

test("streak: gap breaks current but longest remembers", () => {
  // active days ago: 0,1 (current run 2), then a gap, then 5,6,7,8 (run of 4)
  const sessions = [0, 1, 5, 6, 7, 8].map((d, i) => sess(`s${i}`, "hobby", "t1", d, 5));
  const st = S.streaks(sessions, NOW);
  assert.equal(st.current, 2);                    // today + yesterday
  assert.equal(st.longest, 4);                    // the older 4-day run
  assert.equal(st.activeDays, 6);
});

test("streak: today empty but yesterday active → grace keeps it", () => {
  const sessions = [sess("a", "hobby", "t1", 1, 5), sess("b", "hobby", "t1", 2, 5)];
  const st = S.streaks(sessions, NOW);
  assert.equal(st.current, 2);                    // counts from yesterday
});

test("streak: no activity → all zero", () => {
  const st = S.streaks([], NOW);
  assert.deepEqual(st, { current: 0, longest: 0, activeDays: 0 });
});

test("recent: newest first, annotated, limited", () => {
  const sessions = [sess("old", "hobby", "t1", 5, 5), sess("new", "hobby", "t2", 0, 5), sess("mid", "hobby", "t1", 2, 5)];
  const r = S.recent(sessions, cards, timers, NOW, 2);
  assert.equal(r.length, 2);
  assert.equal(r[0].session.id, "new");
  assert.equal(r[0].timerName, "Reading");
  assert.equal(r[1].session.id, "mid");
});

console.log(`\n${passed} stats checks passed.`);
