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

## The three nouns

- **Card** — a thing the user dedicates time to. A *category of doing*, not a
  specific task: "Writing", "Crocheting", "Work", "Exercise". Has a stable `id`
  (also what an NFC tag maps to), a name, optional category/color, optional
  `nfcUid`. Cards are the user's deck.
- **Session** — one tracked stretch of time against a card. Created when the timer
  starts, closed when stopped. Carries the timestamps that make elapsed-time exact.
- **Slot** — "the device". Holds *one* card and its current (live) session. This is
  the single-slot model: one card active at a time. Swapping saves the outgoing
  session to history.

## Why a Storage interface instead of just using SQLite everywhere

GitHub Pages is a *static* host — no server, no writable filesystem. A web build
can't use a server-side SQLite file. So the browser stores data in IndexedDB
instead. Rather than fork the logic, both back ends implement the same tiny
`Storage` interface (6 card methods, 2 session methods, 2 slot methods). The
core, the timer, the big button, and every view are then **identical** across CLI
and web. Adding a cloud/sync backend later (Supabase) is *one more adapter* — see
`EXTENDING.md`.

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
| `core/device.ts`        | `Device` — the API interfaces drive.                        |
| `core/format.ts`        | `fmtDuration(ms)` shared by CLI + web.                       |
| `core/sqlite-store.ts`  | `Storage` over `node:sqlite`. CLI + Pi.                      |
| `core/core.test.ts`     | Runnable self-check. Run after any `core/` edit.            |
| `cli/timecards.ts`      | The CLI. Big button from a terminal; `--json` for hardware.  |
| `web/idb-store.ts`      | `Storage` over IndexedDB. Browser only.                     |
| `web/app.ts`            | The web UI logic.                                           |
| `web/index.html`,`app.css` | Web shell + styling (simple now; full design later).     |
| `web/build.ts`          | Zero-dep build → `docs/` for GitHub Pages.                  |
| `docs/`                 | Built web app. Served by GitHub Pages (main /docs).         |
