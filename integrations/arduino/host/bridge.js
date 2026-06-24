#!/usr/bin/env node
// timecards — Arduino host bridge.
//
// The Arduino can't run Node or touch the SQLite file, so this host script sits in
// the middle: it reads serial events from the Arduino and runs the timecards CLI,
// then polls CLI state and pushes it back to the Arduino's LED. Pure glue — it
// reimplements no timer logic, so it can't drift from the app.
//
//   Arduino "PRESS"        -> timecards press
//   Arduino "HOLD"         -> timecards stop
//   Arduino "NFC:04A2B1C3" -> timecards slot --nfc 04:A2:B1:C3
//   CLI status.state       -> Arduino "LED:<state>"
//
// Run: node integrations/arduino/host/bridge.js   (Node 22+; needs `npm i serialport`)
// Wiring + flashing the sketch: see ../README.md.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = ["node", join(__dirname, "..", "..", "..", "cli", "timecards.ts")];
const BAUD = 115200;
const POLL_MS = 300;

// ── pure helpers (unit-tested in bridge.test.js) ────────────────────

/** Format an Arduino NFC hex string ("04a2b1c3") as the CLI's UID ("04:A2:B1:C3"). */
export function formatNfcUid(hex) {
  const up = hex.trim().toUpperCase().replace(/[^0-9A-F]/g, "");
  return up.match(/.{1,2}/g)?.join(":") ?? "";
}

/** Map a serial event line to the timecards CLI args to run, or null to ignore. */
export function eventToCommand(line) {
  const msg = line.trim();
  if (msg === "PRESS") return ["press"];
  if (msg === "HOLD") return ["stop"];
  if (msg.startsWith("NFC:")) {
    const uid = formatNfcUid(msg.slice(4));
    return uid ? ["slot", "--nfc", uid] : null;
  }
  return null; // READY, ERR:*, unknown -> ignore
}

/** Map a CLI status state to the LED command line for the Arduino. */
export function stateToLed(state) {
  return `LED:${state || "off"}`;
}

/** Extract the JSON object from possibly-noisy CLI stdout (zoxide banners etc.). */
export function parseCliJson(stdout) {
  for (const line of stdout.split("\n").reverse()) {
    const t = line.trim();
    if (t.startsWith("{")) { try { return JSON.parse(t); } catch { /* keep scanning */ } }
  }
  return null;
}

// ── CLI bridge ──────────────────────────────────────────────────────
function cli(args, wantJson = false) {
  const full = wantJson ? [...CLI.slice(1), ...args, "--json"] : [...CLI.slice(1), ...args];
  const res = spawnSync(CLI[0], full, { encoding: "utf8", timeout: 10000 });
  if (res.error) { console.error("[timecards] CLI error:", res.error.message); return null; }
  return wantJson ? parseCliJson(res.stdout || "") : null;
}

function currentState() {
  return cli(["status"], true)?.state ?? "empty";
}

// ── main (hardware path; skipped under test) ────────────────────────
async function main() {
  let SerialPort, ReadlineParser;
  try {
    ({ SerialPort, ReadlineParser } = await import("serialport"));
  } catch {
    console.error("serialport not installed. Run: npm i serialport");
    process.exit(1);
  }

  const path = await findArduino(SerialPort);
  if (!path) { console.error("No serial port found. Is the Arduino plugged in?"); process.exit(1); }

  const port = new SerialPort({ path, baudRate: BAUD });
  const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
  const send = (s) => port.write(`${s}\n`);

  port.on("open", () => console.log(`[timecards] connected ${path} @ ${BAUD}`));
  port.on("error", (e) => console.error("[timecards] port error:", e.message));

  parser.on("data", (line) => {
    const cmd = eventToCommand(line);
    if (cmd) { console.log(`[timecards] ${line.trim()} -> timecards ${cmd.join(" ")}`); cli(cmd); }
  });

  // Push current state to the LED on a loop.
  let lastLed = "";
  setInterval(() => {
    const led = stateToLed(currentState());
    if (led !== lastLed) { lastLed = led; send(led); }
  }, POLL_MS);

  console.log("[timecards] bridge running. Ctrl-C to quit.");
}

async function findArduino(SerialPort) {
  const ports = await SerialPort.list();
  const hit = ports.find((p) =>
    /arduino|wch|silicon ?labs|ftdi/i.test(`${p.manufacturer ?? ""} ${p.friendlyName ?? ""}`) ||
    p.vendorId === "2341" || p.vendorId === "1a86");
  return hit?.path ?? ports[0]?.path;
}

// Only run the hardware loop when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
