# The timer state machine

All of this lives in `core/timer.ts` as pure functions. `core/device.ts` calls
them and persists the results. Understand this before touching timing.

## Timers within a card (the big idea)

A **card owns up to `MAX_TIMERS` (10) timers**. Each `Timer` is a saved config
(name, mode, duration, alarm) AND holds its own in-progress session in
`timer.liveSession`. The slot tracks which timer is `activeTimerId`. The big
button drives the **active timer's** session.

**Switching timers = suspend & resume.** `device.switchTimer(id)`:
1. If the outgoing timer is running, it's **paused** (the paused session stays on
   that timer in storage — nothing is finalized, nothing lost).
2. The target timer becomes active. Its held session (if any) is whatever state it
   was left in — a paused session resumes on the next press; a never-started one is
   `ready`.

Swapping the whole **card** (or ejecting) does the same suspend to the active timer.
So a half-done 25-min countdown on "Writing" survives you doing an hour on "Cooking"
and switching back. This works because suspend is just `pause()` (see below) and the
held session is three timestamps in storage, not a live in-memory clock.

`device.addTimer` enforces the 10 cap (throws past it). `device.deleteTimer` saves
any in-progress session to history first, then removes the timer; deleting down to
zero is allowed (the card then shows "add a timer").
Per-timer history totals: `device.timerTotalMs(id)`; whole-card: `device.totalMs(id)`.

## Three ways to end a run — keep / discard / commit

These are distinct on purpose (a common point of confusion):

| method            | what it does                                         | history? |
|-------------------|------------------------------------------------------|----------|
| `stop()`          | **freeze & keep** — pauses and holds the run (readout stays put); resume later | no |
| `reset()`         | **discard** — clears the run, back to full duration / zero | no |
| `finish()`        | **commit** — banks the run to history, timer goes idle | yes |

Time is banked to history ONLY when a run ends for real: a natural countdown finish,
`repeat()` (saves the round then restarts), `deleteTimer()`, or an explicit
`finish()`. A `stop()`-frozen or switch-suspended session is "in progress," not done,
so it isn't in history until it actually ends. (Earlier `stop()` finalized — that
made the countdown jump back to full and silently banked partial time; split into
stop/reset/finish so each intent is explicit.)

## States (`RunState`)

```
 empty ──slot card──▶ ready ──press──▶ running ⇄ paused
                        ▲                  │
                        │                  ├─(countdown hits target)─▶ finished ──press──▶ repeat
                        └──── stop ────────┴──────────────────────────┘    (same round again)
                                  (session saved to history)
```

- **empty** — no card in the slot. The big button does nothing.
- **ready** — card slotted, no session running. Press → start.
- **running** — a session is counting. Press → pause.
- **paused** — session frozen; paused time won't count. Press → resume.
- **finished** — a *countdown* reached its target (alarm moment). Press → **repeat**
  (`device.repeat()`): the finished round is saved to history and a fresh session
  starts at the SAME mode/duration. Or **stop** to just save and go idle. Count-up
  never auto-finishes.

## Repeat (`device.repeat()`)

Re-runs the active timer's just-finished round in one action — the device's "repeat"
function. It restarts at the duration of the session that *just ran* (`prev.mode` /
`prev.targetMs`), not the timer's current config — so it faithfully repeats "the
thing I just did," including a one-off `press` override. The big button calls it
automatically when the state is `finished`; the CLI has `repeat`.

## The big button (`bigButtonAction`)

One function maps the current state to the single action a press performs:

| state    | press does |
|----------|-----------|
| ready    | **start** |
| running  | **pause** |
| paused   | **resume**|
| finished | **repeat** (via `device.press` → `repeat`) |
| empty    | nothing   |
| finished | nothing (use stop) |

Every interface — CLI `press`, the web button, a physical Arduino button — calls
this. Behavior stays identical everywhere because none of them re-decide it.

## Two modes

- **up** (default) — open-ended stopwatch. Tracks time spent. `targetMs` is null.
  The readout shows hundredths of a second.
- **down** — countdown from `targetMs`. `remainingMs` counts toward 0; at 0 the
  session is `finished` and `SlotView.finished` flips true (interfaces fire their
  "alarm" / visual pulse on that edge).

### Where mode comes from (precedence)

When you press start, the mode/target is resolved in this order:
1. An explicit **per-session override** — `press({mode, targetMs})` (CLI `--down`/`--up`,
   web mode chips).
2. The **card's default** — `card.defaultMode` + `card.defaultTargetMs`.
3. Fallback **`up`**.

So a card can default to a 25-min countdown, but you can still run it as a plain
stopwatch for one session without changing the card.

## Alarm (`alarmStyle`)

When a countdown finishes, interfaces play the card's alarm:
- **chime** — three rising tones (default).
- **blip** — one short tone.
- **silent** — no sound; the visual pulse still happens.

`SlotView.alarmStyle` carries the resolved style (card's, or the `DEFAULT_ALARM`
fallback). The web app synthesizes tones with WebAudio — no audio files to host.
Fire the alarm **once** per finished session (track the last-alarmed session id).

## Lock

`Slot.locked` freezes the big button and stop — `press()`/`stop()` no-op while
locked, so you can't fat-finger a running session. The lock toggle itself (`lock()`)
always works. **Slotting a different card or ejecting clears the lock** (deliberate
swap = clear intent to move on). Lock is preserved across press/pause/resume/stop of
the *same* slotted card.

## Day-count (`dayCount`)

A card may carry a `deadline` (epoch ms) + `deadlineKind`:
- **until** — whole days remaining to the date; `passed:true` once the date arrives
  (a "42 days left" countdown to a goal/deadline).
- **since** — whole days elapsed from the date (a streak / "day 17").

`dayCountOf(card, now)` computes it; `SlotView.dayCount` carries the result (or null).
This is independent of the running timer — it's about the card, not the session.

## The elapsed formula (the important bit)

```
elapsed = max(0, (endedAt ?? now) - startedAt - pausedMs - currentPause)
where currentPause = (pausedAt !== null) ? now - pausedAt : 0
```

- Pausing sets `pausedAt = now`.
- Resuming does `pausedMs += now - pausedAt; pausedAt = null`.
- Stopping folds any open pause into `pausedMs`, then sets `endedAt = now`.

This makes pause/resume idempotent-safe and exact across any number of
pause cycles, and across the app being closed mid-session. **Don't replace it with
a setInterval counter** — you'd reintroduce drift and lose crash-survival.

## Invariants to preserve

- A session's elapsed time never decreases except a countdown's `remainingMs`.
- `pausedAt !== null` ⟺ state is `paused` (while not ended).
- Stopping always produces `endedAt !== null` and no open pause.
- These are asserted in `core/core.test.ts`. Keep them green.
