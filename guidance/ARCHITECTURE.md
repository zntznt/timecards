# Architecture

## Layers, top to bottom

```
INTERFACES   cli/timecards.ts   web/app.ts   (future: pi/, arduino bridge)
                    │                │
                    └──── call ──────┘
                          ▼
CORE API     core/device.ts  ── the Device class: createCard, slot, press, stop, eject, view…
                          ▼
CORE LOGIC   core/timer.ts   ── pure functions: elapsed, pause, resume, stop, bigButtonAction
CORE TYPES   core/types.ts   ── Card, Session, Slot, SlotView, Storage (the contract)
                          ▼
STORAGE      core/sqlite-store.ts (CLI/Pi)   web/idb-store.ts (browser)   future: SupabaseStore
                          ▼
PERSISTENCE  ~/.timecards/data.db            browser IndexedDB            Postgres
```

**Dependencies point downward only.** `core/timer.ts` imports nothing but types.
`core/device.ts` imports timer + types. Storage adapters import only types.
Interfaces import `device` + one adapter. Nothing in `core/` imports an interface
or a concrete adapter — that's what keeps it portable.

## The four nouns

- **Card** — a thing the user dedicates time to. A *category of doing*, not a
  specific task: "Writing", "Crocheting", "Work", "Exercise". Has a stable `id`
  (also what an NFC tag maps to), a name, optional category/color, `nfcUid`, an
  optional `deadline` (day-count), and `lastTimerId` (which timer loads on slot).
  A card OWNS a list of timers. Cards are the user's deck.
- **Timer** — a reusable timer config *inside* a card: name + mode (stopwatch/
  countdown) + duration + alarm. A card holds up to `MAX_TIMERS` (10) of them
  (e.g. 5 countdowns + 2 stopwatches). Each timer carries its OWN in-progress
  session (`liveSession`) — this is what makes switching timers suspend/resume.
- **Session** — one tracked stretch of time against a *specific timer* on a card.
  Created when started, closed when stopped (→ history). Carries the timestamps
  that make elapsed-time exact, plus `timerId` so history splits per timer.
- **Slot** — "the device". Holds *one* card and one *active timer* (`activeTimerId`).
  The live session lives on the timer, not the slot — so switching timers only
  changes which timer is active; the outgoing one's session is paused and held.

## Why a Storage interface instead of just using SQLite everywhere

GitHub Pages is a *static* host — no server, no writable filesystem. A web build
can't use a server-side SQLite file. So the browser stores data in IndexedDB
instead. Rather than fork the logic, both back ends implement the same `Storage`
interface (cards, timers, sessions, slot). The core, the timer, the big button,
and every view are then **identical** across CLI and web. Adding a cloud/sync
backend later (Supabase) is *one more adapter* — see `EXTENDING.md`.

This seam is the single most important design decision in the project. Preserve it.

## Why timestamps, not a running clock

A naive timer keeps a counter ticking in memory. Close the app and it's lost; the
displayed time and the truth diverge. timecards instead stores three numbers per
session — `startedAt`, `pausedMs` (total paused), `pausedAt` (current pause start
or null) — and *derives* elapsed time on demand: `elapsed = (end ?? now) -
startedAt - pausedMs - currentPause`. Consequences:

- A running timer **survives the process dying / browser closing**. Reopen → it's
  still running, showing the right time. (Verified by the SQLite reopen smoke test.)
- The UI's ticking readout is purely cosmetic; it just re-reads the derived value
  4×/sec. The data layer is authoritative.
- All time math is pure and takes `now` as an argument → deterministic tests with a
  fake clock (see `core/core.test.ts`).

## File map

| File                    | Role                                                        |
|-------------------------|-------------------------------------------------------------|
| `core/types.ts`         | Data model + the `Storage` contract. The source of truth.   |
| `core/timer.ts`         | Pure timer math + `bigButtonAction`. No I/O.                 |
| `core/device.ts`        | `Device` — the API interfaces drive. `statsData()` feeds stats.|
| `core/format.ts`        | `fmtDuration(ms)` shared by CLI + web.                       |
| `core/stats.ts`         | Pure stats over sessions (totals, by-day, streaks, recent). |
| `core/sqlite-store.ts`  | `Storage` over `node:sqlite`. CLI + Pi.                      |
| `core/*.test.ts`        | Runnable self-checks (`npm test`). Run after any `core/` edit.|
| `cli/timecards.ts`      | The CLI. Big button from a terminal; `--json` for hardware.  |
| `web/idb-store.ts`      | `Storage` over IndexedDB. Browser only.                     |
| `web/app.ts`            | The web UI logic.                                           |
| `web/index.html`,`app.css` | Web shell + styling (simple now; full design later).     |
| `web/build.ts`          | Zero-dep build → `docs/` for GitHub Pages.                  |
| `docs/`                 | Built web app. Served by GitHub Pages (main /docs).         |
