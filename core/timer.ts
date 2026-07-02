// Pure timer math. No I/O, no clock reads inside — `now` is always passed in.
// This is what makes the state machine deterministic and trivially testable.

import type { Session, SlotView, Card, Timer, RunState, TimerMode, DayCount, AlarmStyle } from "./types.ts";

/** Fallback alarm when a timer doesn't specify one. */
export const DEFAULT_ALARM: AlarmStyle = "chime";

const DAY_MS = 86_400_000;

/** Whole-day count for a card's deadline. Returns null if the card has none.
 *  'until' -> days remaining (0 once the date passes, passed=true).
 *  'since' -> days elapsed from the date (a streak / "day N"). */
export function dayCountOf(card: Card | null, now: number): DayCount | null {
  if (!card || card.deadline == null) return null;
  const kind = card.deadlineKind ?? "until";
  const diffDays = Math.ceil((card.deadline - now) / DAY_MS); // +ve = future
  if (kind === "until") {
    return { days: Math.max(0, diffDays), kind, passed: diffDays <= 0 };
  }
  // since: days elapsed from the date (floor so "today" = 0, tomorrow = 1)
  const elapsedDays = Math.max(0, Math.floor((now - card.deadline) / DAY_MS));
  return { days: elapsedDays, kind, passed: false };
}

/** Elapsed run time (ms), excluding paused stretches. `now` = current epoch ms.
 *  A countdown never elapses past its target: time spent ringing in the
 *  finished state (before the user presses repeat/reset) is not tracked time. */
export function elapsed(session: Session, now: number): number {
  const end = session.endedAt ?? now;
  const pausedNow = session.pausedAt !== null ? now - session.pausedAt : 0;
  const raw = Math.max(0, end - session.startedAt - session.pausedMs - pausedNow);
  if (session.mode === "down" && session.targetMs !== null) return Math.min(raw, session.targetMs);
  return raw;
}

/** True once a countdown has reached its target. Always false for 'up' mode. */
export function isFinished(session: Session, now: number): boolean {
  if (session.mode !== "down" || session.targetMs === null) return false;
  return elapsed(session, now) >= session.targetMs;
}

/** Derive the render state of a session. */
export function runState(session: Session | null, now: number): RunState {
  if (!session) return "ready";
  if (session.endedAt !== null) return "finished";
  if (isFinished(session, now)) return "finished";
  if (session.pausedAt !== null) return "paused";
  return "running";
}

/** Build the snapshot every interface renders from.
 *  The live session comes from the active timer (timer.liveSession). */
export function viewOf(
  card: Card | null,
  timer: Timer | null,
  timers: Timer[],
  now: number,
  locked = false,
): SlotView {
  const alarmStyle = timer?.alarmStyle ?? DEFAULT_ALARM;
  const dayCount = dayCountOf(card, now);
  const session = timer?.liveSession ?? null;
  const base = { card, timer, timers, alarmStyle, locked, dayCount };
  if (!card) {
    return { ...base, state: "empty", elapsedMs: 0, remainingMs: null, mode: null, finished: false };
  }
  if (!timer || !session) {
    // Card slotted but the active timer has no running session → ready (or, if the
    // card has no timers at all, still "ready" but interfaces show "add a timer").
    return { ...base, state: "ready", elapsedMs: 0, remainingMs: null, mode: timer?.mode ?? null, finished: false };
  }
  const e = elapsed(session, now);
  const finished = isFinished(session, now);
  const remaining =
    session.mode === "down" && session.targetMs !== null
      ? Math.max(0, session.targetMs - e)
      : null;
  return {
    ...base,
    state: runState(session, now),
    elapsedMs: e,
    remainingMs: remaining,
    mode: session.mode,
    finished,
  };
}

// ── Session transitions ─────────────────────────────────────────────
// Each returns a NEW session object (immutable-style) so callers persist the result.
// They never read the clock themselves — `now` and `id` come from the caller.

export function startSession(
  id: string,
  cardId: string,
  timerId: string,
  now: number,
  mode: TimerMode = "up",
  targetMs: number | null = null,
): Session {
  return {
    id,
    cardId,
    timerId,
    mode,
    targetMs: mode === "down" ? targetMs : null,
    startedAt: now,
    endedAt: null,
    pausedMs: 0,
    pausedAt: null,
  };
}

export function pause(session: Session, now: number): Session {
  if (session.pausedAt !== null || session.endedAt !== null) return session; // already paused/stopped
  return { ...session, pausedAt: now };
}

export function resume(session: Session, now: number): Session {
  if (session.pausedAt === null) return session; // not paused
  return { ...session, pausedMs: session.pausedMs + (now - session.pausedAt), pausedAt: null };
}

export function stop(session: Session, now: number): Session {
  if (session.endedAt !== null) return session;
  // Fold any open pause into pausedMs, then close.
  const settled = session.pausedAt !== null ? resume(session, now) : session;
  return { ...settled, endedAt: now };
}

/** The big button: one action that does the right thing for the current state.
 *  empty/finished -> caller handles (can't toggle an empty slot / restart).
 *  ready  -> start
 *  running-> pause
 *  paused -> resume
 *  Returns the action the caller should perform. Pure decision, no mutation. */
export function bigButtonAction(state: RunState): "start" | "pause" | "resume" | "noop" {
  switch (state) {
    case "ready": return "start";
    case "running": return "pause";
    case "paused": return "resume";
    default: return "noop"; // empty or finished
  }
}
