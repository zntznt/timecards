// Pure timer math. No I/O, no clock reads inside — `now` is always passed in.
// This is what makes the state machine deterministic and trivially testable.

                                                                                                            

/** Fallback alarm when a timer doesn't specify one. */
export const DEFAULT_ALARM             = "chime";

const DAY_MS = 86_400_000;

/** Local midnight for an epoch ms. Deadlines are STORED as local midnights (the CLI
 *  and the web date input both build them that way), so a day-count has to compare
 *  midnight-to-midnight. Comparing raw instants instead made the readout tick over
 *  at whatever time of day the deadline was set, and drift by one whole day for any
 *  span crossing a DST change (a 23- or 25-hour day breaks fixed-ms division). */
function midnight(ms        )         {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole-day count for a card's deadline. Returns null if the card has none.
 *  'until' -> days remaining (0 once the date passes, passed=true).
 *  'since' -> days elapsed from the date (a streak / "day N"). */
export function dayCountOf(card             , now        )                  {
  if (!card || card.deadline == null) return null;
  const kind = card.deadlineKind ?? "until";
  // Whole calendar days between the two midnights. Round, not ceil/floor: the
  // quotient is 0.958 or 1.042 rather than exactly 1 across a DST boundary.
  const diffDays = Math.round((midnight(card.deadline) - midnight(now)) / DAY_MS); // +ve = future
  if (kind === "until") {
    return { days: Math.max(0, diffDays), kind, passed: diffDays <= 0 };
  }
  // since: days elapsed from the date ("today" = 0, tomorrow = 1)
  return { days: Math.max(0, -diffDays), kind, passed: false };
}

/** Elapsed run time (ms), excluding paused stretches. `now` = current epoch ms.
 *  A countdown never elapses past its target: time spent ringing in the
 *  finished state (before the user presses repeat/reset) is not tracked time. */
export function elapsed(session         , now        )         {
  const end = session.endedAt ?? now;
  const pausedNow = session.pausedAt !== null ? now - session.pausedAt : 0;
  const raw = Math.max(0, end - session.startedAt - session.pausedMs - pausedNow);
  if (session.mode === "down" && session.targetMs !== null) return Math.min(raw, session.targetMs);
  return raw;
}

/** True once a countdown has reached its target. Always false for 'up' mode. */
export function isFinished(session         , now        )          {
  if (session.mode !== "down" || session.targetMs === null) return false;
  return elapsed(session, now) >= session.targetMs;
}

/** Derive the render state of a session. */
export function runState(session                , now        )           {
  if (!session) return "ready";
  if (session.endedAt !== null) return "finished";
  if (isFinished(session, now)) return "finished";
  if (session.pausedAt !== null) return "paused";
  return "running";
}

/** Build the snapshot every interface renders from.
 *  The live session comes from the active timer (timer.liveSession). */
export function viewOf(
  card             ,
  timer              ,
  timers         ,
  now        ,
  locked = false,
)           {
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
  id        ,
  cardId        ,
  timerId        ,
  now        ,
  mode            = "up",
  targetMs                = null,
)          {
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

export function pause(session         , now        )          {
  if (session.pausedAt !== null || session.endedAt !== null) return session; // already paused/stopped
  return { ...session, pausedAt: now };
}

export function resume(session         , now        )          {
  if (session.pausedAt === null) return session; // not paused
  return { ...session, pausedMs: session.pausedMs + (now - session.pausedAt), pausedAt: null };
}

export function stop(session         , now        )          {
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
export function bigButtonAction(state          )                                        {
  switch (state) {
    case "ready": return "start";
    case "running": return "pause";
    case "paused": return "resume";
    default: return "noop"; // empty or finished
  }
}
