#!/usr/bin/env node
// timecards CLI — the big button from the terminal, plus card management.
// Every command takes --json for machine consumers (Arduino, Raspberry Pi, scripts).
//
// Usage:
//   timecards new "Writing" [--category hobby] [--color "#e8a"]
//   timecards cards                       list all cards
//   timecards slot <id|name>              put a card in the device
//   timecards slot --nfc <uid>            slot by NFC tag UID (hardware bridge)
//   timecards press [--down <mins>]       the big button (start/pause/resume/repeat)
//   timecards stop                        freeze & keep the run (nothing saved yet)
//   timecards finish                      bank the run to history
//   timecards eject                       remove card from device
//   timecards status                      what's slotted & running now
//   timecards report [<id>]               total tracked time per card
//   timecards nfc <id> <uid>              register an NFC tag to a card
//   timecards rm <id>                     delete a card + its history
//
// Add --json to any command to get a machine-readable object on stdout.

import { readFileSync, writeFileSync } from "node:fs";
import { Device, slugify } from "../core/device.ts";
import { SqliteStore } from "../core/sqlite-store.ts";
import { fmtDuration } from "../core/format.ts";
import { MAX_TIMERS } from "../core/types.ts";
import * as Stats from "../core/stats.ts";
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

/** A unicode block bar scaled to `max`, width 16. For terminal stats charts. */
function sparkBar(value: number, max: number, width = 16): string {
  if (max <= 0) return "";
  const filled = Math.round((value / max) * width);
  return "█".repeat(filled) + "·".repeat(Math.max(0, width - filled));
}

/** Resolve a user-typed timer ref (name or id) within a card. */
async function resolveTimer(dev: Device, cardId: string, q: string): Promise<Timer> {
  const timers = await dev.listTimers(cardId);
  const hit = timers.find(t => t.id === q) ?? timers.find(t => t.name.toLowerCase() === q.toLowerCase());
  if (!hit) die(`no timer "${q}" on card ${cardId}`);
  return hit;
}

/** Parse a "HH:MM", "MM", or plain minutes string into ms. "25"→25min, "1:30:00"→1h30m. */
// Accept three UNAMBIGUOUS forms (no bare "1:30" — is that 90s or 90m?):
//   plain minutes:  "25"
//   H:M:S triple:   "1:30:00"
//   unit-suffixed:  "90m", "1h30m", "45s", "1h", "2h15m30s"
// Each unit is validated; minutes/seconds must be 0–59 in the H:M:S / suffix forms.
function parseDuration(s: string): number {
  const t = s.trim().toLowerCase();
  // unit-suffixed
  const unit = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    const h = +(unit[1] ?? 0), m = +(unit[2] ?? 0), sec = +(unit[3] ?? 0);
    if (m > 59 || sec > 59) die(`bad duration "${s}" — minutes/seconds must be 0–59`);
    return ((h * 60 + m) * 60 + sec) * 1000;
  }
  const parts = t.split(":");
  if (parts.length === 1 && /^\d+$/.test(parts[0])) return +parts[0] * 60_000;     // minutes
  if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
    const [h, m, sec] = parts.map(Number);
    if (m > 59 || sec > 59) die(`bad duration "${s}" — minutes/seconds must be 0–59`);
    return ((h * 60 + m) * 60 + sec) * 1000;
  }
  die(`bad duration "${s}" — use minutes (25), H:M:S (1:30:00), or units (1h30m, 90s)`);
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
// Backend selection: if TIMECARDS_SUPABASE_URL + _KEY are set, sync to Supabase;
// otherwise use the local SQLite file. Opt-in — local stays the default.
const SB_URL = process.env.TIMECARDS_SUPABASE_URL;
const SB_KEY = process.env.TIMECARDS_SUPABASE_KEY;
let store: { close?: () => void };
let dev: Device;
let cliError: string | null = null;
if (SB_URL && SB_KEY) {
  try {
    const { makeSupabaseStoreNode } = await import("../core/supabase-store.ts");
    const sb = await makeSupabaseStoreNode(SB_URL, SB_KEY);
    store = sb as any;
    dev = new Device(sb);
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }
} else {
  const sqlite = new SqliteStore();
  store = sqlite;
  dev = new Device(sqlite);
}

try {
  switch (cmd) {
    case "new": {
      // Pull EVERY option before touching positionals: pullOpt/pullFlag splice by
      // name and are order-independent, but argv.shift() is not — read a flag late
      // and `new --category hobby "Reading"` names the card "--category".
      const down = pullOpt("--down");
      const category = pullOpt("--category");
      const color = pullOpt("--color");
      const alarm = pullOpt("--alarm") as AlarmStyle | undefined;
      const name = argv.shift();
      if (!name) die(`usage: timecards new "<name>" [--category X] [--color "#abc"] [--down <dur>] [--alarm chime|blip|digital|bell|melody|silent]`);
      const card = await dev.createCard(name, {
        category,
        color,
        defaultMode: down ? "down" : undefined,
        defaultTargetMs: down ? parseDuration(down) : undefined,
        alarmStyle: alarm,
      });
      out(`created card "${card.name}"  (id: ${card.id})`, card);
      break;
    }
    case "config": case "set": {
      // Card-level config: deadline / category / color. (Timer config lives under `timer`.)
      const deadlineStr = pullOpt("--deadline");
      const since = pullFlag("--since");
      const until = pullFlag("--until");
      const clearDeadline = pullFlag("--no-deadline");
      const category = pullOpt("--category");
      const color = pullOpt("--color");
      const id = await resolveCardId(dev, need("config <id> [--deadline YYYY-MM-DD] [--since|--until] [--no-deadline] [--category X] [--color #abc]"));
      const card = await dev.configureCard(id, {
        deadline: clearDeadline ? null : deadlineStr ? parseDate(deadlineStr) : undefined,
        deadlineKind: since ? "since" : until ? "until" : undefined,
        category,
        color,
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
        const down = pullOpt("--down");
        const alarm = pullOpt("--alarm") as AlarmStyle | undefined;
        const cardId = await resolveCardId(dev, need(`timer add <card> "<name>" [--down <dur>] [--alarm X]`));
        const name = argv.shift();
        const t = await dev.addTimer(cardId, {
          name,
          mode: down ? "down" : "up",
          targetMs: down ? parseDuration(down) : null,
          alarmStyle: alarm,
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
        const down = pullOpt("--down"); const up = pullFlag("--up");
        const newName = pullOpt("--name");
        const alarm = pullOpt("--alarm") as AlarmStyle | undefined;
        const cardId = await resolveCardId(dev, need(`timer edit <card> <timer> [--name X] [--down <dur>|--up] [--alarm X]`));
        const t = await resolveTimer(dev, cardId, need(`timer edit <card> <timer> ...`));
        const edited = await dev.configureTimer(t.id, {
          name: newName,
          mode: up ? "up" : down ? "down" : undefined,
          targetMs: down ? parseDuration(down) : up ? null : undefined,
          alarmStyle: alarm,
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
    case "stop": {                        // freeze & keep (pause, no history write)
      const v = await dev.stop();
      out(viewLine(v), v);
      break;
    }
    case "reset": case "clear": {         // discard the run (a finished round banks first)
      const v = await dev.reset();
      out(viewLine(v), v);
      break;
    }
    case "finish": case "save": {         // bank the run to history, timer idle
      const v = await dev.finish();
      out(viewLine(v), v);
      break;
    }
    case "repeat": case "again": {
      const v = await dev.repeat();
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
    case "stats": {
      const { sessions, cards, timers, now } = await dev.statsData();
      const filterId = argv[0] ? await resolveCardId(dev, argv[0]) : null;
      const scope = filterId ? sessions.filter(s => s.cardId === filterId) : sessions;
      const byCard = Stats.totalsByCard(scope, cards, timers, now);
      const days = Stats.byDay(scope, now, 14);
      const st = Stats.streaks(scope, now);
      const recent = Stats.recent(scope, cards, timers, now, 10);
      if (json) { out("", { totalMs: Stats.totalMs(scope, now), byCard, byDay: days, streaks: st, recent }); break; }

      console.log(`total: ${fmtDuration(Stats.totalMs(scope, now))}   🔥 streak ${st.current}d (longest ${st.longest}d, ${st.activeDays} active days)\n`);
      for (const c of byCard) {
        console.log(`${c.name}  —  ${fmtDuration(c.ms)}  (${c.sessions} sessions)`);
        for (const t of c.timers) console.log(`   ${t.name.padEnd(18)} ${fmtDuration(t.ms)}  ${sparkBar(t.ms, byCard[0]?.ms || 1)}`);
      }
      console.log(`\nlast 14 days:`);
      const max = Math.max(1, ...days.map(d => d.ms));
      for (const d of days) console.log(`  ${d.day.slice(5)}  ${sparkBar(d.ms, max)}  ${d.ms ? fmtDuration(d.ms) : ""}`);
      if (recent.length) {
        console.log(`\nrecent:`);
        for (const r of recent) console.log(`  ${r.cardName}/${r.timerName}`.padEnd(28) + `  ${fmtDuration(r.ms).padStart(8)}  ${r.session.startedAt ? new Date(r.session.startedAt).toLocaleString() : ""}`);
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
    case "export": {
      const file = pullOpt("--out") ?? argv[0];
      const dump = await dev.exportAll();
      const text = JSON.stringify(dump, null, 2);
      if (file) {
        writeFileSync(file, text);
        // Writing to a file frees stdout, so --json reports the write itself —
        // otherwise this is the one success path that emits nothing (breaking the
        // "--json on every command" contract for machine consumers).
        out(`exported to ${file}`, { file, cards: dump.cards.length, timers: dump.timers.length, sessions: dump.sessions.length });
      } else {
        console.log(text);                    // no file: the dump IS the stdout payload, for piping
      }
      break;
    }
    case "import": {
      const file = argv[0];
      if (!file) die(`usage: timecards import <file.json>`);
      const data = JSON.parse(readFileSync(file, "utf8"));
      const counts = await dev.importAll(data);
      out(`imported ${counts.cards} cards, ${counts.timers} timers, ${counts.sessions} sessions`, counts);
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
} catch (e) {
  // Anything the core throws (the MAX_TIMERS cap, a missing card, a storage error)
  // must still leave through die() — an uncaught throw prints a V8 stack to stderr
  // and NOTHING to stdout, which silently breaks every --json consumer.
  cliError = e instanceof Error ? e.message : String(e);
} finally {
  store.close?.();   // SQLite needs closing; Supabase store has nothing to close
}
if (cliError) die(cliError);   // after close(), so the db is released either way

function need(usage: string): string {
  const v = argv.shift();
  // A leftover "--flag" here means the option wasn't pulled before the positionals
  // (or the user mistyped one). Either way it must not become a card/timer NAME —
  // error through die(), which honors --json.
  if (!v || v.startsWith("--")) die(`usage: timecards ${usage}`);
  return v;
}

function printHelp() {
  console.log(`timecards — time tracking, in card form

CARDS
  new "<name>" [--category X] [--color "#abc"]   create a card (seeds a first timer)
       [--down <dur>] [--alarm chime|blip|digital|bell|melody|silent]  …make that first timer a countdown
  cards                                          list cards (▶ = slotted)
  config <id> [--deadline YYYY-MM-DD]            card-level: deadline / streak …
         [--since|--until] [--no-deadline] [--category X] [--color #abc]
  rm <id>                                        delete a card + its timers + history
  nfc <id> <uid>                                 register an NFC tag to a card

TIMERS (a card holds up to ${MAX_TIMERS})
  timers [<card>]                                list a card's timers (▶ = active)
  timer add <card> "<name>" [--down <dur>] [--alarm X]   add a timer
  timer rm <card> <timer>                        delete a timer
  timer switch <timer>                           switch the slotted card's active timer
  timer edit <card> <timer> [--name X] [--down <dur>|--up] [--alarm X]

DEVICE
  slot <id|name> | slot --nfc <uid>              put a card in the device
  press [--down <dur>] [--up]                    the big button: start / pause / resume
                                                 (press when finished = repeat)
  stop                                           freeze & keep (pause, nothing saved)
  reset                                          discard this run, back to full / zero
                                                 (a finished round is saved first)
  finish                                         bank the run to history, timer idle
  repeat                                         re-run the same countdown (saves the round)
  lock | unlock                                  freeze the setup (the big button stays live)
  eject                                          remove the card (suspends its timer)
  status                                         what's slotted & running
  report [<id>]                                  total tracked time
  stats [<id>]                                   totals, streaks, by-day, recent

DATA
  export [--out <file>]                          dump all data as JSON (backup / migrate)
  import <file.json>                             load data from an export (merge by id)

  <dur> = minutes (25), H:M:S (1:30:00), or units (1h30m, 90s). Switching timers suspends one and resumes
  another where it left off. Add --json for machine-readable output.
  Cloud sync: set TIMECARDS_SUPABASE_URL/_KEY to sync via your own Supabase project
  (see integrations/supabase/README.md).`);
}
