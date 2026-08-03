#!/usr/bin/env python3
"""Off-Pi self-check for the glue logic: `python3 test_timecards_pi.py`.
No GPIO / NFC hardware needed — those imports live inside main(), so importing
this module is safe anywhere. We test the parts that silently misbehave:
JSON extraction from noisy CLI output, the LED policy, and UID formatting."""

import sys
import timecards_pi as tp


def test_cli_json_ignores_shell_noise():
    # The real CLI output is preceded by zoxide-style banner lines on this user's
    # shell. cli() must find the JSON line and ignore the noise.
    fake_stdout = (
        "zoxide: detected a possible configuration issue.\n"
        "Disable this message by setting _ZO_DOCTOR=0.\n"
        '{"state":"running","remainingMs":1499999,"locked":false}\n'
    )

    class FakeRun:
        stdout = fake_stdout

    orig = tp.subprocess.run
    tp.subprocess.run = lambda *a, **k: FakeRun()
    try:
        data = tp.cli("status", want_json=True)
    finally:
        tp.subprocess.run = orig
    assert data == {"state": "running", "remainingMs": 1499999, "locked": False}, data


def test_cli_json_handles_no_json():
    class FakeRun:
        stdout = "zoxide noise only\nno json here\n"

    orig = tp.subprocess.run
    tp.subprocess.run = lambda *a, **k: FakeRun()
    try:
        assert tp.cli("status", want_json=True) is None
    finally:
        tp.subprocess.run = orig


def test_cli_never_raises_on_subprocess_error():
    orig = tp.subprocess.run
    def boom(*a, **k):
        raise OSError("node not found")
    tp.subprocess.run = boom
    try:
        assert tp.cli("press") is None              # must swallow, not crash the loop
        assert tp.cli("status", want_json=True) is None
    finally:
        tp.subprocess.run = orig


def test_led_pattern_per_state():
    assert tp.led_pattern("running") == (1.0, 1.0)      # solid
    assert tp.led_pattern("paused")[0] == 0.5           # blink
    assert tp.led_pattern("finished")[1] < 0.5          # fast cycle
    assert tp.led_pattern("empty") == (0.0, 1.0)        # off
    assert tp.led_pattern("garbage") == (0.0, 1.0)      # unknown -> off


def test_read_nfc_uid_formats_bytes():
    class FakePN:
        def read_passive_target(self, timeout=0.1):
            return bytes([0x04, 0xA2, 0xB1, 0xC3])
    assert tp.read_nfc_uid(FakePN()) == "04:A2:B1:C3"

    class NoTag:
        def read_passive_target(self, timeout=0.1):
            return None
    assert tp.read_nfc_uid(NoTag()) is None


def test_try_init_nfc_returns_none_without_libs():
    # adafruit_pn532 isn't installed off-Pi → must return None, not raise.
    assert tp.try_init_nfc() is None


def _view(timer_ids, active_id):
    """Minimal SlotView with just the fields next_timer_id() reads."""
    return {
        "timers": [{"id": i} for i in timer_ids],
        "timer": {"id": active_id} if active_id else None,
    }


def test_next_timer_id_cycles_and_wraps():
    v = _view(["a", "b", "c"], "a")
    assert tp.next_timer_id(v) == "b"
    assert tp.next_timer_id(_view(["a", "b", "c"], "b")) == "c"
    assert tp.next_timer_id(_view(["a", "b", "c"], "c")) == "a"   # wraps


def test_next_timer_id_none_when_nothing_to_switch_to():
    assert tp.next_timer_id(_view([], None)) is None              # empty slot
    assert tp.next_timer_id(_view(["a"], "a")) is None            # only one timer
    assert tp.next_timer_id({}) is None                           # status unavailable
    assert tp.next_timer_id(None) is None                         # CLI returned nothing


def test_next_timer_id_falls_back_to_first_when_active_unknown():
    # A card with timers but no active timer (or a stale id) -> pick the first.
    assert tp.next_timer_id(_view(["a", "b"], None)) == "a"
    assert tp.next_timer_id(_view(["a", "b"], "gone")) == "a"


def test_alarm_pattern_per_style():
    assert tp.alarm_pattern("silent") == []                       # the only silent one
    assert tp.alarm_pattern("blip") == [(1200, 0.08)]
    assert len(tp.alarm_pattern("melody")) == 4
    # An AlarmStyle added to core later must still make a noise, not vanish.
    assert tp.alarm_pattern("some-new-style") == tp.ALARM_PATTERNS["chime"]
    # Every style in core/types.ts is covered explicitly.
    for style in ("chime", "blip", "digital", "bell", "melody", "silent"):
        assert style in tp.ALARM_PATTERNS, style


def test_play_alarm_is_noop_without_hardware():
    assert tp.play_alarm(None, [(440, 0.01)]) is None              # no buzzer wired

    class FakeBuzzer:
        def __init__(self): self.value = 0; self.frequency = 0; self.tones = []
    b = FakeBuzzer()
    assert tp.play_alarm(b, []) is None                            # silent style
    assert b.tones == []


def test_play_alarm_drives_buzzer_and_leaves_it_off():
    class FakeBuzzer:
        def __init__(self):
            self.frequency = 0
            self._value = 0
            self.log = []
        @property
        def value(self): return self._value
        @value.setter
        def value(self, v):
            self._value = v
            self.log.append((self.frequency, v))

    b = FakeBuzzer()
    orig_sleep = tp.time.sleep
    tp.time.sleep = lambda s: None                                 # don't really wait
    try:
        tp.play_alarm(b, [(880, 0.01), (0, 0.01), (659, 0.01)])
    finally:
        tp.time.sleep = orig_sleep
    assert (880, 0.5) in b.log and (659, 0.5) in b.log             # both tones sounded
    assert b.value == 0                                            # and it shut up after


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"\n{len(tests)} pi-glue checks passed.")
