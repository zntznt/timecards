#!/usr/bin/env python3
"""timecards — Raspberry Pi driver.

Turns a Pi into the physical "device": one button is the big button, an LED
shows state, and (optionally) a PN532 NFC reader slots a card when you tap a tag.

This script is pure GLUE. It never reimplements timer logic — it shells out to
the timecards CLI and reads one line of JSON back. The CLI + ~/.timecards/data.db
remain the single source of truth, so the Pi can never disagree with the app.

  Button (tap)      -> timecards press     (start / pause / resume / repeat)
  Button (hold 1.5s)-> timecards stop      (save the session)
  NFC tag tapped    -> timecards slot --nfc <uid>
  LED               <- timecards status --json   (running=on, paused=blink slow,
                                                  finished=blink fast, else off)

Optional extras — each degrades to "absent" if you haven't wired it:
  Timer button (tap)-> timecards timer switch <next timer on the card>
  Buzzer            <- beeps when `finished` goes true, patterned by alarmStyle

Setup, wiring, and autostart: see README.md in this folder.
"""

import json
import subprocess
import sys
import time
from pathlib import Path

# ── Config (edit these) ─────────────────────────────────────────────
# How to invoke the CLI. Node 22+ runs the .ts directly. Point this at your clone.
TIMECARDS_REPO = Path.home() / "timecards"
CLI = ["node", str(TIMECARDS_REPO / "cli" / "timecards.ts")]

BUTTON_PIN = 17          # BCM pin for the big button (to GND, internal pull-up)
LED_PIN = 27             # BCM pin for the status LED (through a resistor to GND)
HOLD_SECONDS = 1.5       # button hold time that means "stop"
POLL_SECONDS = 0.25      # how often to refresh the LED from CLI state
NFC_POLL_SECONDS = 0.3   # how often to scan for an NFC tag

# Optional extras. Set either to None if you haven't wired that part.
TIMER_BUTTON_PIN = 22    # BCM pin for the "next timer" button, or None
BUZZER_PIN = 18          # BCM pin for a passive buzzer, or None

# ── CLI bridge ──────────────────────────────────────────────────────
def cli(*args, want_json=False):
    """Run a timecards command. Returns parsed JSON (if want_json) or None.
    Never raises on a non-zero exit — hardware loops must not crash on a hiccup."""
    cmd = CLI + list(args)
    if want_json:
        cmd.append("--json")
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except Exception as e:                       # pragma: no cover - hardware path
        print(f"[timecards] CLI error: {e}", file=sys.stderr)
        return None
    if want_json:
        # The CLI prints one JSON line on stdout; ignore the zoxide-style shell noise.
        for line in reversed(out.stdout.splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except json.JSONDecodeError:
                    continue
        return None
    return None


def status():
    """Current SlotView dict, or {} if unavailable."""
    return cli("status", want_json=True) or {}


# ── LED policy: map device state -> LED behavior ────────────────────
# Returns (on_fraction_of_cycle, cycle_seconds). Steady on = (1, x); off = (0, x).
def led_pattern(state: str):
    return {
        "running":  (1.0, 1.0),   # solid on
        "paused":   (0.5, 1.2),   # slow blink
        "finished": (0.5, 0.3),   # fast blink (alarm)
        "ready":    (0.08, 2.0),  # brief heartbeat — card in, idle
    }.get(state, (0.0, 1.0))      # empty/unknown -> off


# ── Timer cycling: which timer does the second button select? ───────
def next_timer_id(view):
    """Given a SlotView, return the id of the timer AFTER the active one
    (wrapping), or None if there's nothing to switch to.

    The core owns what switching *means* (it suspends the current timer and
    resumes the target). We only pick the target — hence pure, hence testable."""
    timers = (view or {}).get("timers") or []
    if len(timers) < 2:
        return None                       # 0 or 1 timer — nothing to cycle to
    active = (view or {}).get("timer") or {}
    active_id = active.get("id")
    ids = [t.get("id") for t in timers]
    if active_id not in ids:
        return ids[0]                     # no/unknown active timer -> first
    return ids[(ids.index(active_id) + 1) % len(ids)]


# ── Buzzer: alarmStyle -> a sequence of (frequency_hz, seconds) ─────
# frequency 0 means "rest". Styles come from AlarmStyle in core/types.ts;
# an unknown style falls back to "chime" so a new style is never silent by accident.
ALARM_PATTERNS = {
    "chime":   [(880, 0.18), (0, 0.06), (659, 0.32)],
    "blip":    [(1200, 0.08)],
    "digital": [(1046, 0.09), (0, 0.05)] * 3,
    "bell":    [(784, 0.12), (0, 0.04)] * 4,
    "melody":  [(659, 0.14), (784, 0.14), (988, 0.14), (1319, 0.28)],
    "silent":  [],
}


def alarm_pattern(style: str):
    """Beep sequence for an alarmStyle. 'silent' -> [] (no sound, LED still blinks)."""
    if style == "silent":
        return []
    return ALARM_PATTERNS.get(style, ALARM_PATTERNS["chime"])


# ── Main loop ───────────────────────────────────────────────────────
def main():
    # GPIO is imported here so the module can be unit-tested off-Pi.
    from gpiozero import Button, LED

    button = Button(BUTTON_PIN, pull_up=True, hold_time=HOLD_SECONDS)
    led = LED(LED_PIN)

    # Button: tap = press, hold = stop. gpiozero fires when_held during the press,
    # so we suppress the release-tap that would otherwise also fire.
    held = {"flag": False}

    def on_held():
        held["flag"] = True
        print("[timecards] hold -> stop")
        cli("stop")

    def on_released():
        if held["flag"]:
            held["flag"] = False             # this release ends a hold; not a tap
            return
        print("[timecards] tap -> press")
        cli("press")

    button.when_held = on_held
    button.when_released = on_released

    # Optional second button: cycle to the next timer on the slotted card.
    # The core refuses the switch when the slot is locked — we don't re-check that here.
    # NOTE: `timer_button` must stay referenced for the life of the loop; gpiozero
    # collects Button objects that go out of scope and the button silently dies.
    timer_button = None
    if TIMER_BUTTON_PIN is not None:
        def on_timer_button():
            nxt = next_timer_id(status())
            if nxt is None:
                print("[timecards] timer button -> no other timer on this card")
                return
            print(f"[timecards] timer button -> switch {nxt}")
            cli("timer", "switch", nxt)

        try:
            timer_button = Button(TIMER_BUTTON_PIN, pull_up=True)
            timer_button.when_pressed = on_timer_button
            print(f"[timecards] timer button on GPIO{TIMER_BUTTON_PIN}")
        except Exception as e:                    # pragma: no cover - hardware path
            print(f"[timecards] timer button init failed ({e}); continuing without it",
                  file=sys.stderr)

    buzzer = try_init_buzzer()
    if buzzer:
        print(f"[timecards] buzzer on GPIO{BUZZER_PIN}")

    nfc = try_init_nfc()
    if nfc:
        print("[timecards] NFC reader ready — tap a tag to slot its card")
    else:
        print("[timecards] no NFC reader — button + LED only")

    print(f"[timecards] driving CLI: {' '.join(CLI)}")
    print("[timecards] running. Ctrl-C to quit.")

    last_uid = None
    last_nfc_scan = 0.0
    blink_phase = 0.0
    was_finished = False
    try:
        while True:
            view = status()
            st = view.get("state", "empty")

            # Alarm on the RISING edge of `finished` only — the flag stays true
            # while the finished state is held, and we must not re-beep every poll.
            finished = bool(view.get("finished"))
            if finished and not was_finished:
                play_alarm(buzzer, alarm_pattern(view.get("alarmStyle", "chime")))
            was_finished = finished

            # LED reflects current state.
            on_frac, cycle = led_pattern(st)
            # software PWM-ish blink without extra threads
            blink_phase = (blink_phase + POLL_SECONDS) % cycle if cycle else 0
            led.value = 1 if (cycle and blink_phase < on_frac * cycle) else 0

            # NFC scan (rate-limited; ignore repeats of the same tag held on the reader).
            now = time.monotonic()
            if nfc and now - last_nfc_scan >= NFC_POLL_SECONDS:
                last_nfc_scan = now
                uid = read_nfc_uid(nfc)
                if uid and uid != last_uid:
                    last_uid = uid
                    print(f"[timecards] tag {uid} -> slot")
                    cli("slot", "--nfc", uid)
                elif not uid:
                    last_uid = None              # tag lifted; allow re-tap

            time.sleep(POLL_SECONDS)
    except KeyboardInterrupt:
        led.off()
        if buzzer:
            buzzer.value = 0
        print("\n[timecards] bye")


# ── Buzzer (passive, on a PWM-capable pin) — optional ───────────────
def try_init_buzzer():
    """Return a PWMOutputDevice for a passive buzzer, or None if not wired/available.
    A passive buzzer needs a square wave to make a pitch, which is what PWM gives us."""
    if BUZZER_PIN is None:
        return None
    try:
        from gpiozero import PWMOutputDevice     # type: ignore
    except ImportError:
        return None
    try:
        return PWMOutputDevice(BUZZER_PIN, frequency=440, initial_value=0)
    except Exception as e:                        # pragma: no cover - hardware path
        print(f"[timecards] buzzer init failed ({e}); continuing silent", file=sys.stderr)
        return None


def play_alarm(buzzer, pattern):
    """Play a (freq_hz, seconds) sequence. No-op without a buzzer or an empty pattern.
    Blocking, but patterns are well under a second — deliberately no threads, to match
    the rest of this loop."""
    if not buzzer or not pattern:
        return
    try:
        for freq, secs in pattern:
            if freq:
                buzzer.frequency = freq
                buzzer.value = 0.5               # 50% duty = loudest square wave
            else:
                buzzer.value = 0                 # a rest
            time.sleep(secs)
        buzzer.value = 0
    except Exception as e:                        # pragma: no cover - hardware path
        print(f"[timecards] buzzer error: {e}", file=sys.stderr)


# ── NFC (PN532 over I2C) — optional ─────────────────────────────────
def try_init_nfc():
    """Return a PN532 handle, or None if no reader / libraries absent.
    Kept optional so the script runs button-only on a bare Pi."""
    try:
        import board, busio                      # type: ignore
        from adafruit_pn532.i2c import PN532_I2C  # type: ignore
    except ImportError:
        return None
    try:
        i2c = busio.I2C(board.SCL, board.SDA)
        pn = PN532_I2C(i2c, debug=False)
        pn.SAM_configuration()                   # ready to read passive tags
        return pn
    except Exception as e:                        # pragma: no cover - hardware path
        print(f"[timecards] NFC init failed ({e}); continuing without it", file=sys.stderr)
        return None


def read_nfc_uid(pn):
    """Return an NFC tag UID like '04:A2:B1:C3', or None if no tag present."""
    try:
        raw = pn.read_passive_target(timeout=0.1)
    except Exception:                             # pragma: no cover - hardware path
        return None
    if not raw:
        return None
    return ":".join(f"{b:02X}" for b in raw)


if __name__ == "__main__":
    main()
