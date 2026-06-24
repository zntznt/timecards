# timecards — guidance for AI assistants

> Time tracking, in card form. The user makes **cards** (a hobby, a task, a
> category — "Writing", "Cooking", "Studying", "Work"), slots **one** card into
> a "device", and a big button starts / pauses / resumes its timer. Each card
> keeps its own separate history. Swap the card → its data swaps in.
>
> Each card can default to a **stopwatch** or a **countdown** (with an **alarm**
> at zero), carry a **deadline / streak** day-count, and the slot can be
> **locked** to prevent accidental presses. See `guidance/TIMER.md` for the rules.

**Read this file first.** Deeper docs live in [`/guidance`](./guidance).

## The one idea that explains everything

There is **one shared core** (the data model + timer logic + the big-button
state machine). Every way of interacting with timecards — CLI, web UI, and any
future Raspberry Pi / Arduino / NFC bridge — is a **thin wrapper over that core**.
Interfaces never re-implement timing or card rules. They call the core.

```
            ┌──────────────── core/ ────────────────┐
            │  types.ts   data model + Storage iface │
            │  timer.ts   pure timer math + big btn  │
            │  device.ts  Device: the public API     │
            │  format.ts  ms -> "HH:MM:SS"           │
            └───────────────────┬────────────────────┘
                  Storage interface (the seam)
        ┌─────────────────┬─────┴──────────────────┐
   SqliteStore         IdbStore            (future) SupabaseStore
   core/sqlite-store    web/idb-store       — see guidance/EXTENDING.md
   (CLI, Pi, hardware)  (browser / Pages)
        │                    │
   cli/timecards.ts     web/app.ts  →  build → docs/  (GitHub Pages)
```

**If you change timing or card behavior, change it in `core/`.** If you only
change *where data is stored*, write a new `Storage` adapter and touch nothing else.

## Run it

```bash
node core/core.test.ts          # core self-checks (always run after editing core/)
node cli/timecards.ts help      # the CLI
node web/build.ts               # build the web app into docs/ for GitHub Pages
```

Open the web app locally: `node web/build.ts && cd docs && python3 -m http.server 8000`
then visit http://localhost:8000.

## Hard rules (learned the hard way — don't relearn them)

1. **No build step for core/CLI.** Node 22+ runs `.ts` directly (type-stripping)
   and ships `node:sqlite`. Keep it dependency-free. The *only* build is the web
   bundle (`web/build.ts`), and even that has zero deps.
2. **Node's strip-only TS has limits.** No `enum`, no `namespace`, and **no
   constructor parameter properties** (`constructor(private x: T)`). Declare
   fields explicitly. See `core/device.ts` for the pattern.
3. **Times are integer epoch-ms; durations are integer ms. Never floats.**
   A session stores `startedAt`, `pausedMs`, `pausedAt` — elapsed is *derived*,
   not a running counter. This is why a timer survives the app closing/reopening.
4. **One card in the slot at a time.** Slotting a new card stops the old one and
   saves its session to history. Don't add multi-slot without re-reading the spec.
5. **`--json` on every CLI command.** It's the integration surface for hardware.
   Don't break the JSON shape; it's a contract (see `guidance/INTERFACES.md`).
6. **Never describe this product as based on any specific physical timer device.**
   It's "a study/focus timer in card form." That's the whole framing.

## Where to look

| You want to…                          | Go to                              |
|---------------------------------------|------------------------------------|
| Understand the architecture           | `guidance/ARCHITECTURE.md`         |
| Add a storage backend (e.g. Supabase) | `guidance/EXTENDING.md`            |
| Add an interface (Pi, Arduino, NFC)   | `guidance/INTERFACES.md`           |
| Understand the timer state machine    | `guidance/TIMER.md`                |
| Know the data shapes                  | `core/types.ts` (it's the spec)    |
