# timecards on Arduino

An Arduino can't run Node or open the SQLite file, so it works as the **sensor** and
a **host computer** (any machine running Node) runs the bridge. The Arduino reports
button/NFC events over USB serial; the host maps them to the timecards CLI and pushes
state back to drive the Arduino's LED.

```
  [Arduino: button + LED + NFC] ──USB serial──► [host: bridge.js] ──► timecards CLI
                                                                          │
                                  LED:<state> ◄── status --json ◄─────────┘
```

Like the Pi driver, the bridge is **pure glue** — it never reimplements timer logic,
so it can't disagree with the app. The host and CLI share `~/.timecards/data.db`.

## Serial protocol

| Direction | Line | Meaning |
|-----------|------|---------|
| Arduino → host | `PRESS`    | tap → `timecards press` |
| Arduino → host | `HOLD`     | hold 1.5s → `timecards stop` |
| Arduino → host | `NFC:04a2b1c3` | tag tapped → `timecards slot --nfc 04:A2:B1:C3` |
| Arduino → host | `READY` / `ERR:*` | startup / error (host ignores) |
| host → Arduino | `LED:running\|paused\|finished\|ready\|empty` | drive the status LED |

LED: **solid** = running, **slow blink** = paused/ready, **fast blink** = finished
(alarm), **off** = empty.

## 1. Flash the Arduino

In the Arduino IDE:
1. **Library Manager** → install **Adafruit PN532** (pulls in **Adafruit BusIO**).
   Skip if you're not using NFC — the sketch runs button-only if no reader is found.
2. Open `integrations/arduino/timecards/timecards.ino`, select your board + port, Upload.

### Wiring

**Button** — between **pin 7** and **GND** (sketch uses `INPUT_PULLUP`, no resistor).
**LED** — **pin 13** → LED → **220–330 Ω** resistor → **GND**.
**PN532 (optional), I2C** — set the board to I2C mode, then:

| PN532 | Arduino (Uno) |
|-------|---------------|
| VCC   | 5V (check your board; many are 3.3 V) |
| GND   | GND |
| SDA   | A4 (SDA) |
| SCL   | A5 (SCL) |

Pins are at the top of the `.ino` (`BTN_PIN`, `LED_PIN`, `PN532_IRQ/RESET`).

## 2. Run the host bridge

On the host (laptop, Pi, any always-on machine with the repo + Node 22+):

```bash
cd ~/timecards
npm i serialport                 # the one native dep, needed for USB serial
node integrations/arduino/host/bridge.js
```

It auto-detects the Arduino's serial port (by USB vendor id / name; falls back to the
first port). Hard-code `path` in `bridge.js` if detection picks the wrong one.

## 3. Register NFC tags (optional)

Tap a tag while the bridge runs — it logs `NFC:… -> timecards slot --nfc …`. Register
that UID to a card once:

```bash
node ~/timecards/cli/timecards.ts nfc <card-id> 04:A2:B1:C3
```

Now tapping that tag slots the card.

## Test the bridge logic (no hardware)

```bash
node integrations/arduino/host/bridge.test.js
```

The pure mapping functions (serial event → CLI command, NFC formatting, state → LED)
are unit-tested without a serial port — the hardware loop only runs when the script is
invoked directly.

## Note: the web app is a separate dataset

The host + CLI share `~/.timecards/data.db`. The web app (GitHub Pages) uses the
browser's IndexedDB and does not see this data until you add sync — see the Supabase
integration (`integrations/supabase/`) and `guidance/EXTENDING.md`.
