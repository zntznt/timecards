// Self-check for the bridge's pure mapping logic: `node bridge.test.js`.
// No serial hardware needed — the hardware loop is guarded behind a direct-invoke
// check, so importing this module never touches serialport.

import assert from "node:assert/strict";
import { formatNfcUid, eventToCommand, stateToLed, parseCliJson } from "./bridge.js";

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok  ${name}`); }

test("formatNfcUid: arduino hex -> CLI colon-uid, uppercased", () => {
  assert.equal(formatNfcUid("04a2b1c3"), "04:A2:B1:C3");
  assert.equal(formatNfcUid("04A2B1C3"), "04:A2:B1:C3");
  assert.equal(formatNfcUid("0a0b"), "0A:0B");
  assert.equal(formatNfcUid(""), "");
});

test("eventToCommand: maps the serial protocol to CLI args", () => {
  assert.deepEqual(eventToCommand("PRESS"), ["press"]);
  assert.deepEqual(eventToCommand("PRESS\r"), ["press"]);   // tolerates CRLF
  assert.deepEqual(eventToCommand("HOLD"), ["stop"]);
  assert.deepEqual(eventToCommand("NFC:04a2b1c3"), ["slot", "--nfc", "04:A2:B1:C3"]);
  assert.equal(eventToCommand("READY"), null);              // ignored
  assert.equal(eventToCommand("ERR:no-pn532"), null);
  assert.equal(eventToCommand("garbage"), null);
  assert.equal(eventToCommand("NFC:"), null);               // empty uid -> ignore
});

test("stateToLed: state -> LED command", () => {
  assert.equal(stateToLed("running"), "LED:running");
  assert.equal(stateToLed("paused"), "LED:paused");
  assert.equal(stateToLed("finished"), "LED:finished");
  assert.equal(stateToLed("empty"), "LED:empty");
  assert.equal(stateToLed(""), "LED:off");                  // falsy -> off
  assert.equal(stateToLed(undefined), "LED:off");
});

test("parseCliJson: extracts JSON from noisy stdout", () => {
  const noisy = "zoxide: configuration issue\nDisable with _ZO_DOCTOR=0\n" +
                '{"state":"running","locked":false}\n';
  assert.deepEqual(parseCliJson(noisy), { state: "running", locked: false });
  assert.equal(parseCliJson("just noise\nno json\n"), null);
});

console.log(`\n${passed} bridge checks passed.`);
