# Adding an interface (CLI, web, Raspberry Pi, Arduino, NFC)

An "interface" is any way a human or machine drives the device. They all do the
same thing: construct a `Device` with a `Storage` adapter, then call its methods.

```ts
import { Device } from "../core/device.ts";
import { SqliteStore } from "../core/sqlite-store.ts"; // or IdbStore in a browser
const dev = new Device(new SqliteStore());
await dev.slot("writing");
await dev.press();      // start / pause / resume — the big button
console.log(await dev.view());
```

`Device` is the entire surface: `createCard, listCards, getCard, renameCard,
registerNfc, deleteCard, slot, slotByNfc, eject, press, stop, view, listSessions,
totalMs`. That's it.

## The machine bridge: the CLI is the API

You do **not** need a server or a daemon to integrate hardware. The CLI already
speaks JSON. Any device that can run a shell command and parse one line of JSON
can drive timecards:

```bash
timecards press  --json     # {"state":"running","elapsedMs":12000,...}
timecards status --json
timecards slot --nfc 04:A2:B1:C3 --json
```

### Raspberry Pi (recommended hardware host)

A Pi runs Node, so it runs timecards directly. Wire a physical button to a GPIO
pin; on press, shell out:

```python
# pseudo — on button-down
subprocess.run(["node", "/opt/timecards/cli/timecards.ts", "press", "--json"])
```

Read `status --json` on a loop to drive an LED (green=running, amber=paused) or a
small display. The `~/.timecards/data.db` file is the shared truth — the web UI on
the same Pi (served from `docs/`) sees the same data **if** they share a backend.
(Browser IndexedDB and the Pi's SQLite are separate stores; bridge them via
export/import or a shared SupabaseStore — see `EXTENDING.md`.)

### Arduino (needs a host)

An Arduino can't run Node. Put a Pi (or any computer) in the middle: Arduino reads
the button / NFC and sends a line over USB serial; a tiny host script maps serial
messages to `timecards` commands. The Arduino is the sensor; the host is the bridge.

## NFC — slotting a card by tapping a tag (amiibo-style)

The data model is **already NFC-ready**: every `Card` has an `nfcUid` field, and
`Storage` has `getCardByNfc`. The flow when hardware arrives:

1. **Register** a tag to a card once: `timecards nfc <card-id> <tag-uid>`
   (or `dev.registerNfc(id, uid)`).
2. **Reader loop** (PN532 over I2C/SPI, or a USB reader like ACR122U) reads the
   tag UID on tap and calls `timecards slot --nfc <uid>` (or `dev.slotByNfc(uid)`).
3. The matching card swaps into the slot; its data is now active. Unknown tag →
   `view` is unchanged; prompt the user to register it.

No core changes are needed to add NFC — only a reader process that calls the
existing `slotByNfc`. That's the payoff of reserving `nfcUid` from day one.

## The JSON contract (don't break it)

`SlotView` is what `status`/`press`/`slot`/`stop` emit with `--json`:

```jsonc
{
  "state": "empty|ready|running|paused|finished",
  "card": {
    "id": "...", "name": "...", "category": null, "color": null,
    "nfcUid": null, "createdAt": 1700000000000,
    "defaultMode": "up",        // 'up' | 'down' — what start does by default
    "defaultTargetMs": null,    // countdown length when defaultMode is 'down'
    "alarmStyle": "chime",      // 'chime' | 'blip' | 'silent'
    "deadline": null,           // epoch ms target date, or null
    "deadlineKind": "until"     // 'until' (countdown) | 'since' (streak)
  } | null,
  "elapsedMs": 0,            // run time, pauses excluded
  "remainingMs": null,       // countdown only, else null
  "mode": "up|down" | null,
  "finished": false,         // true the instant a countdown hits 0 (alarm edge)
  "alarmStyle": "chime",     // which alarm to play on finish (resolved from card)
  "locked": false,           // slot locked → presses ignored
  "dayCount": null           // { days, kind:'until'|'since', passed } if card has a deadline
}
```

A hardware bridge reads `finished` + `alarmStyle` to decide whether/how to sound an
alarm, `locked` to show a lock LED, and `dayCount` for a "N days left" display.

`cards --json` → `{ "active": "<id|null>", "cards": [Card & {totalMs}] }`.
`report --json` → `{ "report": [{ "id", "name", "totalMs" }] }`.

The fields above are **additive** — older consumers that ignore the new keys keep
working. Keep field names and meanings stable; downstream firmware depends on them.

New CLI verbs hardware can drive: `config` (set a card's default mode / countdown /
alarm / deadline), `lock` / `unlock` (freeze the big button), and `press --down <dur>`
/ `press --up` to override the card default for one session.
