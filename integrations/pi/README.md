# timecards on a Raspberry Pi

Turn a Pi into the physical "device": one button is the big button, an LED shows
state, and an optional NFC reader slots a card when you tap a tag.

This is **glue, not a fork** — `timecards_pi.py` shells out to the timecards CLI and
reads its `--json` output. The CLI + `~/.timecards/data.db` stay the single source of
truth, so the Pi can never disagree with the app about what's running.

```
 Button (tap)        → timecards press     (start / pause / resume / repeat)
 Button (hold 1.5s)  → timecards stop      (save the session)
 NFC tag tapped      → timecards slot --nfc <uid>
 Timer button (tap)  → timecards timer switch <next timer>   (optional)
 LED                 ← timecards status --json
 Buzzer              ← `finished` + `alarmStyle`             (optional)
```

LED: **solid** = running, **slow blink** = paused, **fast blink** = finished (alarm),
**brief heartbeat** = a card is in but idle, **off** = empty slot.

**Everything except the button and LED is optional.** No NFC reader, no second
button, no buzzer → the script says so at startup and runs with what's there. Build
the minimal version first; add parts later without touching the code.

## Parts

| Part | ~Cost | Needed? |
|------|-------|---------|
| Raspberry Pi (any model with GPIO — a Zero 2 W is plenty) | $15–35 | yes |
| Momentary push button (the big button) | ~$1 | yes |
| LED + 220–330 Ω resistor | ~$1 | yes |
| PN532 NFC module (I2C) + MIFARE tags | $10–15 | for card-swapping |
| Passive buzzer | ~$2 | for an audible alarm |
| Second momentary push button | ~$1 | to cycle timers |

A **passive** buzzer (not active) is required — the driver generates the pitch via
PWM, which an active buzzer ignores.

## 1. Install timecards on the Pi

```bash
# Node 22+ (runs the .ts files directly — no build step)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
git clone https://github.com/zntznt/timecards.git ~/timecards
node ~/timecards/cli/timecards.ts help          # sanity check
```

`timecards_pi.py` expects the repo at `~/timecards`. Editing a different path? Change
`TIMECARDS_REPO` at the top of the script.

## 2. Wiring

**Button** — between **GPIO17** and **GND**. No resistor needed (the script enables
the Pi's internal pull-up).

```
  GPIO17 ──┤ button ├── GND
```

**LED** — **GPIO27** → LED anode (long leg); LED cathode (short leg) → a **220–330 Ω
resistor** → **GND**.

```
  GPIO27 ── 330Ω ──►|── GND
                    LED
```

**PN532 NFC reader (optional), over I2C** — 4 wires. Set the PN532's DIP switches to
I2C mode.

| PN532 | Pi pin        |
|-------|---------------|
| VCC   | 3V3 (pin 1)   |
| GND   | GND (pin 6)   |
| SDA   | GPIO2 / SDA (pin 3) |
| SCL   | GPIO3 / SCL (pin 5) |

**Passive buzzer (optional)** — **GPIO18** → buzzer **+**; buzzer **−** → **GND**.
GPIO18 is a hardware-PWM pin, which keeps the tone clean.

```
  GPIO18 ──┤ buzzer ├── GND
```

**Second button, "next timer" (optional)** — between **GPIO22** and **GND**, same as
the big button (internal pull-up, no resistor).

```
  GPIO22 ──┤ button ├── GND
```

Pins are configurable at the top of `timecards_pi.py` (`BUTTON_PIN`, `LED_PIN`,
`BUZZER_PIN`, `TIMER_BUTTON_PIN`). **Set `BUZZER_PIN` or `TIMER_BUTTON_PIN` to
`None` if you haven't wired that part** — or just leave them; an unwired pin is
harmless, the button simply never fires.

### The alarm

When a countdown hits zero, `status --json` reports `finished: true` and the card's
`alarmStyle`. The driver beeps a pattern per style — `chime`, `blip`, `digital`,
`bell`, `melody`, and `silent` (LED-only). It fires on the **rising edge** of
`finished`, so it sounds once per finish, not every poll.

### The timer button

A card holds up to 4 timers. Tapping the second button switches to the next one,
wrapping at the end. Switching **suspends** the current timer and resumes the target
where it left off — that's core behavior, not something the driver implements. With
0 or 1 timer on the card the tap is a no-op. When the slot is **locked** the core
refuses the switch, which is why the driver doesn't check `locked` itself.

## 3. Python dependencies

```bash
sudo apt-get install -y python3-gpiozero python3-pip

# NFC only (skip if you're not using a reader — the script runs button-only):
sudo raspi-config            # Interface Options → I2C → enable, then reboot
pip3 install adafruit-circuitpython-pn532
```

The script **degrades gracefully**: no reader or no NFC libs → it just runs the
button + LED and prints "no NFC reader".

## 4. Register a tag to a card (one-time, for NFC)

Find a tag's UID by tapping it while the script runs (it prints `tag XX:XX… -> slot`),
or read it any way you like, then:

```bash
node ~/timecards/cli/timecards.ts nfc <card-id> <tag-uid>
# e.g.  timecards nfc study 04:A2:B1:C3
```

Now tapping that tag slots the "study" card.

## 5. Run it

```bash
python3 ~/timecards/integrations/pi/timecards_pi.py
```

### Run on boot (systemd)

```ini
# /etc/systemd/system/timecards.service
[Unit]
Description=timecards Pi driver
After=multi-user.target

[Service]
ExecStart=/usr/bin/python3 /home/pi/timecards/integrations/pi/timecards_pi.py
User=pi
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now timecards
journalctl -u timecards -f      # watch its logs
```

## Test the glue (no hardware needed)

```bash
python3 ~/timecards/integrations/pi/test_timecards_pi.py
```

Runs off-Pi too — GPIO/NFC imports live inside `main()`, so the JSON-parsing and
LED-policy logic is testable on any machine.

## Note: the web app is a separate dataset

The Pi and the CLI share `~/.timecards/data.db`. The **web app** (GitHub Pages) keeps
its data in the browser's IndexedDB and does **not** see the Pi's timers, and vice
versa, until you add sync — see `guidance/EXTENDING.md` (the Supabase adapter plan).
