#!/usr/bin/env node
// timecards CLI — the big button from the terminal, plus card management.
// Every command takes --json for machine consumers (Arduino, Raspberry Pi, scripts).
//
// Usage:
//   timecards new "Writing" [--category hobby] [--color "#e8a"]
//   timecards cards                       list all cards
//   timecards slot <id|name>              put a card in the device
//   timecards slot --nfc <uid>            slot by NFC tag UID (hardware bridge)
//   timecards press [--down <mins>]       the big button (start/pause/resume)
//   timecards stop                        stop & save current session
//   timecards eject                       remove card from device
//   timecards status                      what's slotted & running now
//   timecards report [<id>]               total tracked time per card
//   timecards nfc <id> <uid>              register an NFC tag to a card
//   timecards rm <id>                     delete a card + its history
//
// Add --json to any command to get a machine-readable object on stdout.

import { Device, slugify } from "../core/device.ts";
import { SqliteStore } from "../core/sqlite-store.ts";
import { fmtDuration } from "../core/format.ts";
import type { SlotView, Card, Timer, TimerMode, AlarmStyle, DeadlineKind } from "../core/types.ts";

// ── arg parsing (tiny, no dependency) ───────────────────────────
const argv = process.argv.slice(2);
const json = pullFlag("--json");
const cmd = argv.shift();

function pullFlag(name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}
function pullOpt(name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

// ── output helpers ──────────────────────────────────────────────
function out(human: string, data: unknown) {
  if (json) console.log(JSON.stringify(data));
  else console.log(human);
}
function die(msg: string): never {
  if (json) console.log(JSON.stringify({ error: msg }));
  else console.error(`error: ${msg}`);
  process.exit(1);
}

function dayCountLabel(v: SlotView): string {
  if (!v.dayCount) return "";
  const d = v.dayCount;
  if (d.kind === "until") return d.passed ? "  ⏰ deadline passed" : `  ⏰ ${d.days}d left`;
  return `  🔥 day ${d.days}`;
}

function viewLine(v: SlotView): string {
  const lock = v.locked ? "  🔒" : "";
  if (v.state === "empty") return "[ empty slot ]  — slot a card with: timecards slot <id>";
  const card = v.card!.name;
  const tname = v.timer ? ` / ${v.timer.name}` : " (no timers — add one)";
  const head = `[ ${card}${tname} ]`;
  const dc = dayCountLabel(v);
  if (!v.timer) return `${head}${dc}${lock}`;
  if (v.state === "ready") return `${head}  ready  — press to start${dc}${lock}`;
  if (v.mode === "down") {
    const tag = v.finished ? `DONE 🔔(${v.alarmStyle})` : v.state.toUpperCase();
    return `${head}  ${tag}  ${fmtDuration(v.remainingMs ?? 0)} left${dc}${lock}`;
  }
  return `${head}  ${v.state.toUpperCase()}  ${fmtDuration(v.elapsedMs, true)}${dc}${lock}`;
}

function cardLine(c: Card, active: string | null, totalMs: number, timerCount: number): string {
  const mark = c.id === active ? "▶" : " ";
  const cat = c.category ? `  (${c.category})` : "";
  const nfc = c.nfcUid ? `  nfc:${c.nfcUid}` : "";
  const tc = `  ⏲ ${timerCount} timer${timerCount === 1 ? "" : "s"}`;
  const dl = c.deadline ? `  ⏰ ${(c.deadlineKind ?? "until") === "until" ? "until" : "since"}` : "";
  return `${mark} ${c.id.padEnd(16)} ${c.name}${cat}  —  ${fmtDuration(totalMs)} total${tc}${dl}${nfc}`;
}

function timerLine(t: Timer, activeId: string | null | undefined, totalMs: number): string {
  const mark = t.id === activeId ? "▶" : " ";
  const cfg = t.mode === "down" && t.targetMs ? `⏲ ${fmtDuration(t.targetMs)}` : "stopwatch";
  const live = t.liveSession ? (t.liveSession.pausedAt !== null ? " ⏸ held" : " ▶ running") : "";
  return `${mark} ${t.name.padEnd(18)} ${cfg.padEnd(12)} ${fmtDuration(totalMs)} total  🔔${t.alarmStyle}${live}`;
}

/** Resolve a user-typed timer ref (name or id) within a card. */
async function resolveTimer(dev: Device, cardId: string, q: string): Promise<Timer> {
  const timers = await dev.listTimers(cardId);
  const hit = timers.find(t => t.id === q) ?? timers.find(t => t.name.toLowerCase() === q.toLowerCase());
  if (!hit) die(`no timer "${q}" on card ${cardId}`);
  return hit;
}

/** Parse a "HH:MM", "MM", or plain minutes string into ms. "25"→25min, "1:30:00"→1h30m. */
function parseDuration(s: string): number {
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) die(`bad duration "${s}" — use minutes (25) or H:M:S (1:30:00)`);
  if (parts.length === 1) return Math.round(parts[0] * 60_000);       // minutes
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 60_000; // M:S? no — H:M. Treat as H:M
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;          // H:M:S
}

/** Parse a date "YYYY-MM-DD" to epoch ms (local midnight). */
function parseDate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) die(`bad date "${s}" — use YYYY-MM-DD`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/** Resolve a user-typed identifier to a real card id: try id, then slug, then name match. */
async function resolveCardId(dev: Device, q: string): Promise<string> {
  if (await dev.getCard(q)) return q;
  const slug = slugify(q);
  if (await dev.getCard(slug)) return slug;
  const byName = (await dev.listCards()).find(c => c.name.toLowerCase() === q.toLowerCase());
  if (byName) return byName.id;
  die(`no card matching "${q}"`);
}

// ── main ────────────────────────────────────────────────────────
const store = new SqliteStore();
const dev = new Device(store);

try {
  switch (cmd) {
    case "new": {
      const name = argv.shift();
      if (!name) die(`usage: timecards new "<name>" [--category X] [--color "#abc"] [--down <dur>] [--alarm chime|blip|silent]`);
      const down = pullOpt("--down");
      const card = await dev.createCard(name, {
        category: pullOpt("--category"),
        color: pullOpt("--color"),
        defaultMode: down ? "down" : undefined,
        defaultTargetMs: down ? parseDuration(down) : undefined,
        alarmStyle: pullOpt("--alarm") as AlarmStyle | undefined,
      });
      out(`created card "${card.name}"  (id: ${card.id})`, card);
      break;
    }
    case "config": case "set": {
      // Card-level config: deadline / category / color. (Timer config lives under `timer`.)
      const id = await resolveCardId(dev, need("config <id> [--deadline YYYY-MM-DD] [--since|--until] [--no-deadline] [--category X] [--color #abc]"));
      const deadlineStr = pullOpt("--deadline");
      const since = pullFlag("--since");
      const until = pullFlag("--until");
      const clearDeadline = pullFlag("--no-deadline");
      const card = await dev.configureCard(id, {
        deadline: clearDeadline ? null : deadlineStr ? parseDate(deadlineStr) : undefined,
        deadlineKind: since ? "since" : until ? "until" : undefined,
        category: pullOpt("--category"),
        color: pullOpt("--color"),
      });
      out(`configured "${card.name}"`, card);
      break;
    }
    case "timers": {
      // List a card's timers. Defaults to the slotted card if no id given.
      const arg = argv[0];
      const cardId = arg ? await resolveCardId(dev, arg) : (await dev.view()).card?.id;
      if (!cardId) die("no card — slot one or pass an id: timecards timers <card>");
      const timers = await dev.listTimers(cardId);
      const slot = await dev.view();
      const activeId = slot.card?.id === cardId ? slot.timer?.id : null;
      if (json) {
        const rows = await Promise.all(timers.map(async t => ({ ...t, totalMs: await dev.timerTotalMs(t.id) })));
        out("", { cardId, activeTimerId: activeId, timers: rows });
      } else if (timers.length === 0) {
        console.log(`${cardId}: no timers — add one: timecards timer add ${cardId} "Name" [--down <dur>]`);
      } else {
        for (const t of timers) console.log(timerLine(t, activeId, await dev.timerTotalMs(t.id)));
      }
      break;
    }
    case "timer": {
      const sub = argv.shift();
      if (sub === "add") {
        const cardId = await resolveCardId(dev, need(`timer add <card> "<name>" [--down <dur>] [--alarm X]`));
        const name = argv.shift();
        const down = pullOpt("--down");
        const t = await dev.addTimer(cardId, {
          name,
          mode: down ? "down" : "up",
          targetMs: down ? parseDuration(down) : null,
          alarmStyle: pullOpt("--alarm") as AlarmStyle | undefined,
        });
        out(`added timer "${t.name}" to ${cardId}`, t);
      } else if (sub === "rm" || sub === "delete") {
        const cardId = await resolveCardId(dev, need(`timer rm <card> <timer-name|id>`));
        const t = await resolveTimer(dev, cardId, need(`timer rm <card> <timer-name|id>`));
        const v = await dev.deleteTimer(t.id);
        out(`deleted timer "${t.name}"`, v);
      } else if (sub === "switch" || sub === "use") {
        const cardId = (await dev.view()).card?.id;
        if (!cardId) die("slot a card first: timecards slot <card>");
        const t = await resolveTimer(dev, cardId, need(`timer switch <timer-name|id>`));
        const v = await dev.switchTimer(t.id);
        out(viewLine(v), v);
      } else if (sub === "edit") {
        const cardId = await resolveCardId(dev, need(`timer edit <card> <timer> [--name X] [--down <dur>|--up] [--alarm X]`));
        const t = await resolveTimer(dev, cardId, need(`timer edit <card> <timer> ...`));
        const down = pullOpt("--down"); const up = pullFlag("--up");
        const edited = await dev.configureTimer(t.id, {
          name: pullOpt("--name"),
          mode: up ? "up" : down ? "down" : undefined,
          targetMs: down ? parseDuration(down) : up ? null : undefined,
          alarmStyle: pullOpt("--alarm") as AlarmStyle | undefined,
        });
        out(`edited timer "${edited.name}"`, edited);
      } else {
        die(`usage: timecards timer add|rm|switch|edit …`);
      }
      break;
    }
    case "lock": {
      const v = await dev.lock(true);
      out(viewLine(v), v);
      break;
    }
    case "unlock": {
      const v = await dev.lock(false);
      out(viewLine(v), v);
      break;
    }
    case "cards": case "ls": {
      const cards = await dev.listCards();
      const slot = await dev.view();
      const active = slot.card?.id ?? null;
      if (json) {
        const data = await Promise.all(cards.map(async c => ({
          ...c, totalMs: await dev.totalMs(c.id), timers: await dev.listTimers(c.id),
        })));
        out("", { active, cards: data });
      } else if (cards.length === 0) {
        console.log("no cards yet — create one: timecards new \"Writing\"");
      } else {
        for (const c of cards) {
          console.log(cardLine(c, active, await dev.totalMs(c.id), (await dev.listTimers(c.id)).length));
        }
      }
      break;
    }
    case "slot": {
      const nfc = pullOpt("--nfc");
      const v = nfc ? await dev.slotByNfc(nfc) : await dev.slot(await resolveCardId(dev, need("slot <id|name>")));
      out(viewLine(v), v);
      break;
    }
    case "press": case "button": {
      const down = pullOpt("--down");   // override: countdown for this session
      const up = pullFlag("--up");      // override: force stopwatch this session
      const opts = down ? { mode: "down" as const, targetMs: parseDuration(down) }
                 : up   ? { mode: "up" as const }
                 : {};                  // no override -> honor the card's default
      const v = await dev.press(opts);
      out(viewLine(v), v);
      break;
    }
    case "stop": {
      const v = await dev.stop();
      out(viewLine(v), v);
      break;
    }
    case "eject": {
      const v = await dev.eject();
      out(viewLine(v), v);
      break;
    }
    case "status": case "view": {
      const v = await dev.view();
      out(viewLine(v), v);
      break;
    }
    case "report": {
      const id = argv[0] ? await resolveCardId(dev, argv[0]) : undefined;
      if (id) {
        const total = await dev.totalMs(id);
        const sessions = await dev.listSessions(id);
        out(`${id}: ${fmtDuration(total)} across ${sessions.length} sessions`, { cardId: id, totalMs: total, sessions });
      } else {
        const cards = await dev.listCards();
        const rows = await Promise.all(cards.map(async c => ({ id: c.id, name: c.name, totalMs: await dev.totalMs(c.id) })));
        if (json) out("", { report: rows });
        else for (const r of rows) console.log(`${r.id.padEnd(16)} ${fmtDuration(r.totalMs)}`);
      }
      break;
    }
    case "nfc": {
      const [id, uid] = [argv[0], argv[1]];
      if (!id || !uid) die(`usage: timecards nfc <card-id> <tag-uid>`);
      const card = await dev.registerNfc(await resolveCardId(dev, id), uid);
      out(`registered tag ${uid} -> ${card.name}`, card);
      break;
    }
    case "rm": case "delete": {
      const id = await resolveCardId(dev, need("rm <id>"));
      await dev.deleteCard(id);
      out(`deleted ${id}`, { deleted: id });
      break;
    }
    case "help": case undefined: case "--help": case "-h":
      printHelp();
      break;
    default:
      die(`unknown command "${cmd}" — try: timecards help`);
  }
} finally {
  store.close();
}

function need(usage: string): string {
  const v = argv.shift();
  if (!v) die(`usage: timecards ${usage}`);
  return v;
}

function printHelp() {
  console.log(`timecards — time tracking, in card form

CARDS
  new "<name>" [--category X] [--color "#abc"]   create a card (seeds a first timer)
       [--down <dur>] [--alarm chime|blip|silent]  …make that first timer a countdown
  cards                                          list cards (▶ = slotted)
  config <id> [--deadline YYYY-MM-DD]            card-level: deadline / streak …
         [--since|--until] [--no-deadline] [--category X] [--color #abc]
  rm <id>                                        delete a card + its timers + history
  nfc <id> <uid>                                 register an NFC tag to a card

TIMERS (a card holds up to 10)
  timers [<card>]                                list a card's timers (▶ = active)
  timer add <card> "<name>" [--down <dur>] [--alarm X]   add a timer
  timer rm <card> <timer>                        delete a timer
  timer switch <timer>                           switch the slotted card's active timer
  timer edit <card> <timer> [--name X] [--down <dur>|--up] [--alarm X]

DEVICE
  slot <id|name> | slot --nfc <uid>              put a card in the device
  press [--down <dur>] [--up]                    the big button: start / pause / resume
  stop                                           stop & save the active timer's session
  lock | unlock                                  freeze / unfreeze the big button
  eject                                          remove the card (suspends its timer)
  status                                         what's slotted & running
  report [<id>]                                  total tracked time

  <dur> = minutes (25) or H:M:S (1:30:00). Switching timers suspends one and
  resumes another where it left off. Add --json for machine-readable output.`);
}
