// Stats: pure functions over session history. No I/O, no clock reads inside —
// `now` is passed in, so every result is deterministic and testable. Shared by
// the web stats view and the `timecards stats` CLI.

                                                       
import { elapsed } from "./timer.js";

const DAY_MS = 86_400_000;

/** Local YYYY-MM-DD for an epoch ms (uses the host's timezone — "a day" is a
 *  calendar day where the user lives, which is what a habit tracker wants). */
export function dayKey(ms        )         {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Step `n` CALENDAR days from an epoch ms, in local time. Integer ms in, integer
 *  ms out. Never step by ±DAY_MS to walk days: a DST day is 23 or 25 hours long, so
 *  fixed-millisecond arithmetic skips or repeats a calendar day right at the
 *  boundary — spring-forward day disappeared from the 14-day chart entirely, and
 *  streaks broke across it. Date normalizes day overflow (day 0 = last month's
 *  last day), so this is safe across month and year ends. */
export function addDays(ms        , n        )         {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12, 0, 0, 0).getTime();
}

/** Total tracked ms across the given sessions. */
export function totalMs(sessions           , now        )         {
  return sessions.reduce((sum, s) => sum + elapsed(s, now), 0);
}

                                                                                            
                                                                                                                

/** Per-card totals, each broken down by timer. Sorted by time desc. */
export function totalsByCard(sessions           , cards        , timers         , now        )              {
  const cardName = new Map(cards.map(c => [c.id, c.name]));
  const timerName = new Map(timers.map(t => [t.id, t.name]));
  const byCard = new Map                   ();
  for (const s of sessions) {
    const ms = elapsed(s, now);
    let c = byCard.get(s.cardId);
    if (!c) { c = { cardId: s.cardId, name: cardName.get(s.cardId) ?? s.cardId, ms: 0, sessions: 0, timers: [] }; byCard.set(s.cardId, c); }
    c.ms += ms; c.sessions++;
    let t = c.timers.find(x => x.timerId === s.timerId);
    if (!t) { t = { timerId: s.timerId, name: timerName.get(s.timerId) ?? "(deleted timer)", ms: 0, sessions: 0 }; c.timers.push(t); }
    t.ms += ms; t.sessions++;
  }
  const out = [...byCard.values()];
  for (const c of out) c.timers.sort((a, b) => b.ms - a.ms);
  return out.sort((a, b) => b.ms - a.ms);
}

                                                       

/** Time tracked per calendar day for the last `days` days (oldest → newest),
 *  including zero days so a chart shows gaps. A session counts toward the day it
 *  STARTED (simple + matches "when did I sit down to do it"). */
export function byDay(sessions           , now        , days = 14)              {
  const totals = new Map                ();
  for (const s of sessions) {
    const k = dayKey(s.startedAt);
    totals.set(k, (totals.get(k) ?? 0) + elapsed(s, now));
  }
  const out              = [];
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(addDays(now, -i));
    out.push({ day: k, ms: totals.get(k) ?? 0 });
  }
  return out;
}

                                                                                  

/** Streak stats over days that have ANY tracked time.
 *  current  — consecutive days up to today (or yesterday) with activity.
 *  longest  — longest such run ever.
 *  activeDays — distinct days with any tracked time. */
export function streaks(sessions           , now        )          {
  const active = new Set(sessions.filter(s => elapsed(s, now) > 0).map(s => dayKey(s.startedAt)));
  if (active.size === 0) return { current: 0, longest: 0, activeDays: 0 };

  // longest run of consecutive calendar days
  const sorted = [...active].sort();
  let longest = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (consecutive(sorted[i - 1], sorted[i])) { run++; longest = Math.max(longest, run); }
    else run = 1;
  }

  // current: count back from today; if today is empty but yesterday active, start there.
  let cursor = dayKey(now);
  if (!active.has(cursor)) cursor = dayKey(addDays(now, -1)); // grace: yesterday still counts
  let current = 0;
  while (active.has(cursor)) { current++; cursor = dayKey(addDays(parseDay(cursor), -1)); }

  return { current, longest, activeDays: active.size };
}

/** Most recent finished sessions, newest first. Each annotated with card/timer name. */
                                                                                                     
export function recent(sessions           , cards        , timers         , now        , limit = 20)                  {
  const cardName = new Map(cards.map(c => [c.id, c.name]));
  const timerName = new Map(timers.map(t => [t.id, t.name]));
  return [...sessions]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
    .map(s => ({ session: s, cardName: cardName.get(s.cardId) ?? s.cardId, timerName: timerName.get(s.timerId) ?? "(deleted)", ms: elapsed(s, now) }));
}

// ── day helpers ─────────────────────────────────────────────────
function parseDay(key        )         {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}
function consecutive(a        , b        )          {
  return Math.round((parseDay(b) - parseDay(a)) / DAY_MS) === 1;
}
