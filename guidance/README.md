# /guidance — orientation for anyone (human or AI) working on timecards

Start with [`../CLAUDE.md`](../CLAUDE.md) — it's the one-page overview and the hard
rules. Then dive in here as needed:

- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — the layers, the three nouns (Card /
  Session / Slot), why there's a Storage interface, why timing uses timestamps.
- **[TIMER.md](./TIMER.md)** — the state machine, the big-button mapping, the
  elapsed-time formula, the invariants to keep green.
- **[INTERFACES.md](./INTERFACES.md)** — how to add a way to drive the device:
  CLI, web, Raspberry Pi, Arduino, and the **NFC** tap-to-slot flow. Includes the
  `--json` contract that hardware depends on.
- **[EXTENDING.md](./EXTENDING.md)** — adding a storage backend; the full
  **Supabase "bring your own project"** plan for when cloud sync is wanted.
- **[NODE-TS-GOTCHAS.md](./NODE-TS-GOTCHAS.md)** — what does/doesn't work when
  running `.ts` directly on Node with no compiler. Read before debugging a weird
  syntax error.

## The 30-second mental model

```
core/  = data model + timer logic + big-button rules   (shared, pure, tested)
   │ Storage interface (the seam)
   ├── SqliteStore  → cli/  (and Raspberry Pi / hardware)
   └── IdbStore     → web/  → docs/ (GitHub Pages)
```

Change behavior → edit `core/`. Change where data lives → write a new adapter.
Add a way to interact → wrap `Device`. Nothing else moves.
