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


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print(f"  ok  {t.__name__}")
    print(f"\n{len(tests)} pi-glue checks passed.")
