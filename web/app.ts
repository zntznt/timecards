// Web app: wires the DOM to the shared core. Big button, readout, deck of cards,
// and — within a slotted card — its list of timers (switch suspends/resumes).
// Same Device + timer logic as the CLI; only the storage adapter (IndexedDB) differs.

import { Device } from "../core/device.ts";
import { IdbStore } from "./idb-store.ts";
import { SupabaseStore } from "../core/supabase-store.ts";
import { fmtDuration } from "../core/format.ts";
import { bigButtonAction, elapsed } from "../core/timer.ts";
import { MAX_TIMERS } from "../core/types.ts";
import * as Stats from "../core/stats.ts";
import type { Storage, SlotView, Card, Timer, Session, TimerMode, AlarmStyle, DeadlineKind } from "../core/types.ts";

// Backend selection: if the user saved Supabase creds (settings ⚙), sync there;
// otherwise keep data in this browser's IndexedDB. Opt-in — IDB is the default.
async function makeStore(): Promise<Storage> {
  const url = localStorage.getItem("tc_sb_url");
  const key = localStorage.getItem("tc_sb_key");
  if (url && key) {
    try {
      // Browser imports supabase-js from the esm.sh CDN (no bundler in this project).
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
      return new SupabaseStore(createClient(url, key, { auth: { persistSession: false } }));
    } catch (e) {
      console.error("Supabase sync failed; falling back to local. ", e);
    }
  }
  return new IdbStore();
}

const dev = new Device(await makeStore());

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const elDevice = $("device");
const elCardName = $("card-name");
const elTimerName = $("timer-name");
const elDayCount = $("daycount");
const elReadout = $("readout");
const elSub = $("sub");
const elBig = $<HTMLButtonElement>("big-button");
const elBigLabel = $("big-label");
const elFinish = $<HTMLButtonElement>("finish");   // the SAVE key (banks to history)
const elReset = $<HTMLButtonElement>("reset");     // the DISCARD key (throws the run away)
const elLock = $<HTMLButtonElement>("lock-toggle");
const elTimers = $("timers");
const elTimerList = $("timer-list");
const elList = $("card-list");
const elCardEditor = $<HTMLDialogElement>("card-editor");

const GLYPH: Record<string, string> = { start: "▶", pause: "❚❚", resume: "▶", noop: "●" };
const WORD: Record<string, string> = { start: "START", pause: "PAUSE", resume: "RESUME", noop: "—" };
const elGhost = $("readout-ghost");
const elBigWord = $("big-word");

/** Drive the LCD digits + the all-segments-on ghost behind them. */
function setReadout(txt: string) {
  elReadout.textContent = txt;
  elGhost.textContent = txt.replace(/[0-9]/g, "8");
}

/** A countdown that ends while the tab is in the background is otherwise silent AND
 *  invisible — hidden tabs may have their audio suspended and their timers clamped.
 *  Guarded hard: `Notification` is absent in some contexts (a bare reference throws),
 *  and Android Chrome throws on the constructor because it demands a service worker.
 *  Permission is only ever asked for from a real press, never at load. */
function notifyFinished(v: SlotView) {
  if (!document.hidden) return;
  try {
    if (window.Notification?.permission !== "granted") return;
    new Notification(`${v.card!.name} ・ time's up`, {
      body: `${v.timer!.name} finished`,
      tag: v.timer!.id,     // the 5s re-begs coalesce into one banner, not a stack
    });
  } catch { /* unsupported here — the chime and the tab title still carry it */ }
}

/** Speak a state change once. Deliberately carries NO digits: the tick calls
 *  renderDevice ten times a second, and a live region containing the readout would
 *  interrupt the user ten times a second. Card, timer and the sub-line are enough. */
let saidLast = "";
function announce(s: string) {
  if (s === saidLast) return;
  saidLast = s;
  $("lcd-say").textContent = s;
}

/** The tab is the second readout: a backgrounded timer is invisible otherwise.
 *  Built from the view, not from the LCD's DOM (which isn't written yet at call
 *  time), and only assigned on change so the 10 Hz tick doesn't churn the title. */
function setTabTitle(v: SlotView) {
  let t = "timecards";
  if (v.card && v.timer) {
    // digits only while there's an actual run — a `ready` timer reading "▴ 00:00"
    // in the tab looks like a stopwatch counting when nothing has started
    const live = v.state === "running" || v.state === "paused" || v.state === "finished";
    const digits = !live ? null
                 : v.mode === "down" && v.remainingMs !== null ? fmtDuration(v.remainingMs)
                 : v.mode === "up" ? fmtDuration(v.elapsedMs)
                 : null;
    const mark = v.state === "finished" ? "⏰" : v.state === "paused" ? "❚❚" : v.mode === "down" ? "▾" : "▴";
    t = digits ? `${mark} ${digits} · ${v.card.name}` : `${v.card.name} · timecards`;
  }
  if (document.title !== t) document.title = t;
}

/** The LCD lamp row: each lamp lights (●/○ + color) from the real state. */
function setLamps(state: string, locked: boolean, alarmStyle?: string) {
  const on = (id: string, lit: boolean, litTxt: string, dimTxt: string) => {
    const el = $(id); el.classList.toggle("on", lit); el.textContent = lit ? litTxt : dimTxt;
  };
  on("lamp-run", state === "running", "●RUN", "○RUN");
  on("lamp-pause", state === "paused", "●PAUSE", "○PAUSE");
  on("lamp-done", state === "finished", "●DONE", "○DONE");
  // the lamp names the alarm STYLE, like the mock's ♪CHIME
  const alarmTxt = ({ blip: "♪BLIP", digital: "♪DIGITAL", bell: "♪BELL", melody: "♪MELODY", silent: "ALARM OFF" } as Record<string, string>)[alarmStyle ?? ""] ?? "♪CHIME";
  on("lamp-alarm", state === "finished" && alarmStyle !== "silent", alarmTxt, alarmTxt);
  on("lamp-lock", locked, "🔒LOCK", "○LOCK");
}

// ── alarm (WebAudio) ────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
/** The one place the context is created — and, every time, nudged out of
 *  `suspended`. This matters because the FIRST sound the app makes may be an alarm
 *  fired by the tick with no user gesture on the stack (reopen the page onto an
 *  already-running countdown and let it hit zero). A context born that way starts
 *  suspended, and since it is cached in a module-level `let`, every later click,
 *  latch, print and flip stayed silent for the rest of the session. */
function ac(): AudioContext {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  return audioCtx;
}
function beep(freq: number, durMs: number, when = 0) {
  const ctx = ac();
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq; osc.type = "sine";
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0); osc.stop(t0 + durMs / 1000 + 0.02);
}
function playAlarm(style: AlarmStyle) {
  switch (style) {
    case "silent": return;
    case "blip": beep(880, 90); return;
    case "digital":   // digital-watch double beep-beep
      for (const w of [0, 0.15, 0.45, 0.6]) beep(2093, 60, w);
      return;
    case "bell": bellAlarm(); return;
    case "melody":    // the rice-cooker idiom: a bright little arpeggio
      [523, 659, 784, 1047, 784, 659, 523].forEach((f, i) => beep(f, 130, i * 0.15));
      return;
    default:          // chime — three rising tones
      beep(660, 180, 0); beep(880, 180, 0.2); beep(1175, 320, 0.42);
  }
}
// a struck bell: inharmonic partials with a long metallic decay
function bellAlarm() {
  const c = ac(), t = c.currentTime;
  const partials: Array<[number, number]> = [[1568, 0.22], [2489, 0.12], [3951, 0.06]];
  for (const [f, g0] of partials) {
    const o = c.createOscillator(), g = c.createGain();
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + 1.25);
  }
}
// ── printer sounds (from the mock): key click, dot-matrix chatter, tear ──
function tone(freq: number, dur: number, type: OscillatorType = "square", gain = 0.18, slideTo?: number) {
  const c = ac(), t = c.currentTime, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noiseClick(dur = 0.03, gain = 0.25) {
  const c = ac(), n = c.createBufferSource(), buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  n.buffer = buf;
  const g = c.createGain(); g.gain.value = gain;
  const f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 1400;
  n.connect(f).connect(g).connect(c.destination); n.start();
}
const sndClick = () => { noiseClick(0.025, 0.22); tone(220, 0.04, "square", 0.12); };
const sndDome = () => { noiseClick(0.03, 0.2); tone(140, 0.08, "sine", 0.26, 90); };   // the big dome: deeper travel
const sndTick = () => tone(1200, 0.015, "square", 0.08);                               // small ui tick (from the mock)
function sndLatch() { // the lock: a two-stage click-CLACK
  noiseClick(0.02, 0.2); tone(320, 0.03, "square", 0.1);
  setTimeout(() => { noiseClick(0.025, 0.24); tone(210, 0.045, "square", 0.14); }, 80);
}
function sndBank() { // finish: key click + a bright "banked" confirmation tick
  sndClick();
  setTimeout(() => beep(1319, 90), 100);
}
function sndDenied() { // poking a LOCKED control: a short low buzz that says "no"
  tone(150, 0.08, "sawtooth", 0.16);
  setTimeout(() => tone(120, 0.09, "sawtooth", 0.14), 55);
}
const sndThunk = () => { tone(150, 0.16, "sine", 0.3, 60); noiseClick(0.04, 0.15); };   // card insert
const sndEject = () => tone(90, 0.2, "sine", 0.25, 200);
function sndPrint() { // dot-matrix printer chatter
  let t = 0;
  const iv = setInterval(() => {
    tone(900 + Math.random() * 400, 0.02, "square", 0.06); noiseClick(0.012, 0.08);
    if (++t > 16) clearInterval(iv);
  }, 38);
}
function sndCut() { noiseClick(0.06, 0.28); tone(2600, 0.05, "sawtooth", 0.12, 600); noiseClick(0.05, 0.2); }
// card FLIP — a short PAPER turn: low thock + swept-noise whoosh + settle snap (from the mock)
function sndFlip() {
  const c = ac(), t = c.currentTime;
  const j = 1 + (Math.random() * 0.16 - 0.08);   // ±8% jitter so flips don't sound canned
  tone(95 * j, 0.05, "sine", 0.09);
  const n = c.createBufferSource(), dur = 0.12 * j;
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  n.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.8;
  bp.frequency.setValueAtTime(700, t); bp.frequency.exponentialRampToValueAtTime(2800, t + 0.09);
  const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.16, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 6000;   // keep it papery
  n.connect(bp).connect(g).connect(lp).connect(c.destination); n.start(t); n.stop(t + dur + 0.02);
  setTimeout(() => { noiseClick(0.012, 0.13); tone(3100 * j, 0.015, "sine", 0.08); }, 300);
}
// SHEET — an index card sliding across the desk: a soft band-swept paper hiss,
// with a settle tap when it arrives (dir 1 = pulled up, -1 = tossed away).
function sndSheet(dir: 1 | -1 = 1) {
  const c = ac(), t = c.currentTime, dur = 0.3;
  const n = c.createBufferSource();
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  n.buffer = buf;
  const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.7;
  bp.frequency.setValueAtTime(dir === 1 ? 700 : 2400, t);
  bp.frequency.exponentialRampToValueAtTime(dir === 1 ? 2400 : 600, t + dur * 0.9);
  const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  n.connect(bp).connect(g).connect(c.destination); n.start(t); n.stop(t + dur + 0.02);
  if (dir === 1) setTimeout(() => { noiseClick(0.015, 0.12); tone(120, 0.04, "sine", 0.1); }, 340);
}
let alarmedFor: string | null = null; // timerId:sessionId we've already alarmed
let lastChimeAt = 0;                  // last time the ringing chime re-played
const CHIME_EVERY_MS = 5_000;         // chime begs until acknowledged; blip stays a one-shot nudge
let liveUpSession: Session | null = null;  // the running count-up session, for the rAF hundredths
let rafId = 0;                        // the hundredths loop, only alive while one runs
let lastState = "empty";              // last rendered RunState — lets the tick sleep when idle
let deckIsEmpty = true;               // no cards at all: the empty LCD names the way in

// ── the pull-tab at the device's bottom center: pull DOWN to take the card out ──
const elPullTab = $<HTMLButtonElement>("pull-tab");
let tabPull: { startY: number; id: number } | null = null;
elPullTab.addEventListener("pointerdown", (e) => {
  if (elPullTab.classList.contains("empty")) return;                       // nothing slotted — the gate is inert
  if (elDevice.classList.contains("is-locked")) { scoldLock(); return; }   // the lock holds the card in
  tabPull = { startY: e.clientY, id: e.pointerId };
  elPullTab.style.transition = "none";
  try { elPullTab.setPointerCapture?.(e.pointerId); } catch {}
});
elPullTab.addEventListener("pointermove", (e) => {
  if (!tabPull || e.pointerId !== tabPull.id) return;
  const dy = Math.max(0, Math.min(30, e.clientY - tabPull.startY));
  elPullTab.style.transform = `translate(-50%, ${dy}px)`;
});
async function endTabPull(e: PointerEvent) {
  if (!tabPull || e.pointerId !== tabPull.id) return;
  const dy = e.clientY - tabPull.startY;
  tabPull = null;
  elPullTab.style.transition = ""; elPullTab.style.transform = "";
  if (dy > 20 || Math.abs(dy) < 4) {              // pulled through — or a plain click: it IS the eject button
    sndEject();
    await dev.eject();
    await renderAll();
  } else {                                        // an aborted pull springs back
    elPullTab.style.transition = "transform .15s ease";
    requestAnimationFrame(() => { elPullTab.style.transform = ""; });
  }
}
elPullTab.addEventListener("pointerup", endTabPull);
elPullTab.addEventListener("pointercancel", endTabPull);
// keyboard activation (click events with no pointer) ejects too
elPullTab.addEventListener("click", async (e) => {
  if (e.detail !== 0 || elPullTab.classList.contains("empty") || elDevice.classList.contains("is-locked")) return;
  sndEject(); await dev.eject(); await renderAll();
});

// ── render ──────────────────────────────────────────────────────
async function renderDevice(pre?: SlotView): Promise<SlotView> {
  // `pre` lets a caller that just performed an action hand us the view it already
  // has, instead of a second round-trip to storage for the same answer.
  const v: SlotView = pre ?? await dev.view();
  lastState = v.state;      // set HERE, not at the end — there are early returns below
  liveUpSession = null;     // disarm the hundredths loop; the running branch re-arms it.
                            // Without this, ejecting mid-stopwatch left the LCD reading
                            // "— NO CARD —" while the digits kept counting up forever.
  elDevice.className = v.state + (v.locked ? " is-locked" : "");
  elLock.dataset.locked = String(v.locked);
  elLock.setAttribute("aria-pressed", String(v.locked));
  elLock.title = v.locked ? "slide to unlock the controls" : "slide to lock the controls";

  if (v.dayCount) {
    const d = v.dayCount;
    elDayCount.hidden = false;
    elDayCount.className = "daycount" + (d.passed ? " passed" : d.kind === "since" ? " streak" : "");
    elDayCount.textContent = d.kind === "until"
      ? (d.passed ? "⏰ deadline passed" : `⏰ ${d.days} day${d.days === 1 ? "" : "s"} left`)
      : `🔥 day ${d.days}`;
  } else elDayCount.hidden = true;

  setLamps(v.state, v.locked, v.alarmStyle);
  setTabTitle(v);
  // the machine acknowledges its card: backlight + collar key to its color,
  // its emblem lights as a custom LCD segment, TODAY counts its day
  if (v.card) {
    elDevice.style.setProperty("--card-accent", v.card.color || "#6f7457");
    $("lcd-emblem").textContent = v.card.emblem?.trim() || ([...v.card.name][0]?.toUpperCase() ?? "");
    const live = (v.state === "running" || v.state === "paused" || v.state === "finished") ? v.elapsedMs : 0;
    $("lcd-today").textContent = `TODAY ${fmtDuration((todayBanked.get(v.card.id) ?? 0) + live)}`;
    $("lcd-stars").textContent = rarityFor((allBanked.get(v.card.id) ?? 0) + live);
    elDevice.dataset.tx = v.card.texture && TEXTURES.includes(v.card.texture) ? v.card.texture : "cosmos";
    elPullTab.classList.remove("empty");   // a card is in: the gate is live (still just reads EJECT)
  } else {
    elDevice.style.removeProperty("--card-accent");
    $("lcd-emblem").textContent = "";
    $("lcd-today").textContent = "";
    $("lcd-stars").textContent = "";
    delete elDevice.dataset.tx;
    elPullTab.classList.add("empty");      // nothing slotted: same EJECT tab, but inert
  }

  if (v.state === "empty") {
    elCardName.textContent = "— NO CARD —"; elCardName.classList.add("empty");
    elTimerName.textContent = "—";
    setReadout("--:--");
    // a first-time visitor has an empty binder and no idea the sleeves are clickable
    elSub.textContent = deckIsEmpty
      ? "no cards yet ・ + in the binder, or start a quick timer"
      : "slot a card ・ or start a quick timer";
    elBigLabel.textContent = "●"; elBigWord.textContent = "—";
    elBig.setAttribute("aria-label", "no card in the device");
    elBig.disabled = true; elFinish.disabled = elReset.disabled = true;
    announce(elSub.textContent ?? "");
    // the machine can't shrink: the rack stays, now a QUICK-TIMER LAUNCHER
    elTimers.hidden = false;
    renderLauncher();
    return v;
  }
  elCardName.classList.remove("empty");
  elCardName.textContent = v.card!.name;
  elTimers.hidden = false;
  renderTimerList(v);

  // No timer selected (card has none): prompt to add one.
  if (!v.timer) {
    elTimerName.textContent = "no timers yet";
    setReadout("--:--");
    elSub.textContent = "add a timer to begin";
    elBigLabel.textContent = "●"; elBigWord.textContent = "—";
    elBig.setAttribute("aria-label", "this card has no timers yet");
    elBig.disabled = true; elFinish.disabled = elReset.disabled = true;
    announce(`${v.card!.name} ・ add a timer to begin`);
    return v;
  }
  // The LCD's mode line reads the direction of time, like the mock ("COUNTDOWN ▼");
  // the active timer's NAME lives on the lit rack row below.
  elTimerName.innerHTML = v.timer.mode === "down" ? "COUNTDOWN <b>▼</b>" : "STOPWATCH <b>▲</b>";
  // The big dome stays LIVE while locked — the lock freezes setup, not the run.
  elBig.disabled = false;

  if (v.mode === "down" && v.remainingMs !== null) setReadout(fmtDuration(v.remainingMs));
  else if (v.mode === "up") setReadout(fmtDuration(v.elapsedMs, true));
  else setReadout(v.timer.mode === "down" && v.timer.targetMs ? fmtDuration(v.timer.targetMs) : "00:00.00");

  // a RUNNING count-up shows hundredths — drive those from rAF (the 10x/sec device
  // tick is too coarse: it made the centiseconds jump in steps of ~10). Cache the
  // live session so the frame loop can recompute elapsed with the engine's formula,
  // and start the loop only when there is something to animate.
  liveUpSession = (v.state === "running" && v.mode === "up") ? (v.timer.liveSession ?? null) : null;
  if (liveUpSession && !rafId) rafId = requestAnimationFrame(readoutFrame);

  elBigLabel.textContent = v.state === "finished" ? "↻" : (GLYPH[bigButtonAction(v.state)] ?? "●");
  // The label tells the truth about THIS press (mock review C1/U10: no static START/STOP lie).
  elBigWord.textContent = v.state === "finished" ? "REPEAT" : (WORD[bigButtonAction(v.state)] ?? "—");
  // the button's NAME is the word under it — never a static "start, pause, or resume"
  elBig.setAttribute("aria-label", `${elBigWord.textContent.toLowerCase()} ${v.timer.name}`);

  // the dome pauses/resumes; the two end keys are SAVE (bank to history) and
  // DISCARD (throw the run away). Both need a live run to act on.
  const hasRun = v.state === "running" || v.state === "paused" || v.state === "finished";
  elFinish.disabled = v.locked || !hasRun;
  elReset.disabled = v.locked || !hasRun;

  if (v.state === "ready") { elSub.textContent = "press to start"; }
  else if (v.state === "running") { elSub.textContent = v.mode === "down" ? "▾ counting down" : "▴ counting up"; }
  else if (v.state === "paused") { elSub.textContent = "❚❚ paused · press to resume · save or discard"; }
  else if (v.state === "finished") {
    // NOT "round saved": a finished round is still only timer.liveSession and is
    // absent from the card's total until an exit path banks it (↻, SAVE or DISCARD).
    elSub.textContent = "time's up ・ ↻ repeats · SAVE banks it";
    const key = v.timer.id + ":" + (v.timer.liveSession?.id ?? "");
    if (alarmedFor !== key) {
      alarmedFor = key; lastChimeAt = Date.now(); playAlarm(v.alarmStyle);
      notifyFinished(v);
    }
    else if (v.alarmStyle !== "blip" && v.alarmStyle !== "silent" && Date.now() - lastChimeAt >= CHIME_EVERY_MS) {
      lastChimeAt = Date.now(); playAlarm(v.alarmStyle); // the tick loop re-renders while finished, so this re-begs
    }
  }
  announce(`${v.card!.name} ・ ${v.timer.name} ・ ${elSub.textContent ?? ""}`);
  return v;
}

// The rack's contents change on user action, not on the clock — but renderDevice
// runs 10×/sec while a timer runs. Rebuilding then is not just wasted DOM: it swaps
// out the <li> and its ✎/✕ BETWEEN a pointerdown and its pointerup, so the click
// never lands, and switching timers mid-run failed at random. Rebuild only when the
// rack's actual contents differ.
let rackSig = "";
function renderTimerList(v: SlotView) {
  const sig = v.timers.map(t => [t.id, t.name, t.mode, t.targetMs,
                                t.liveSession?.id ?? "", t.liveSession?.pausedAt ?? ""].join("~")).join("|")
    // the active row's LED, plus everything the add/socket rows read off the card
    + "#" + (v.timer?.id ?? "") + "#" + (v.card?.id ?? "") + "#" + (v.card?.emblem ?? "") + "#" + (v.card?.name ?? "");
  if (sig === rackSig) return;
  rackSig = sig;

  elTimerList.innerHTML = "";
  $("rack-count").textContent = `${String(v.timers.length).padStart(2, "0")} / ${MAX_TIMERS}`;
  for (const t of v.timers) elTimerList.appendChild(timerRow(t, v.timer?.id ?? null));
  // a 2x2 socket panel: after the timers comes ONE dashed add socket (if room),
  // then blank sockets fill the machine's remaining bays
  let filled = v.timers.length;
  if (filled < MAX_TIMERS) {
    const add = document.createElement("li");
    add.className = "timer-row add";
    add.textContent = "+ ADD TIMER";
    add.title = "add a timer";
    operable(add, "add a timer to this card",
      () => { if (isLocked()) return scoldLock(); if (v.card) openTimerEditor(v.card.id, null); });
    elTimerList.appendChild(add);
    filled++;
  }
  for (; filled < MAX_TIMERS; filled++) {
    const socket = el("li", "timer-row socket") as HTMLLIElement;
    if (v.card) socket.dataset.emblem = v.card.emblem?.trim() || ([...v.card.name][0]?.toUpperCase() ?? "");
    elTimerList.appendChild(socket);
  }
}

// ── the QUICK-TIMER LAUNCHER: with no card, the 2x2 rack offers two live bays
// (start a stopwatch / start a countdown). The machine can't shrink, so the
// physical plate is always here — it just does the right thing when empty. ──
const QUICK_ID = "quick";
async function getQuickCard(): Promise<Card> {
  return (await dev.getCard(QUICK_ID))
    ?? await dev.createCard("Quick", { id: QUICK_ID, emblem: "⚡", color: "#8a8577", category: "quick" });
}
/** Start (or set up) a quick timer with no card: uses the auto "Quick" card. */
async function quickStart(mode: TimerMode) {
  const card = await getQuickCard();
  await dev.slot(card.id);
  if (mode === "up") {
    // reuse the card's seeded stopwatch (createCard makes one), or add one
    const timers = await dev.listTimers(card.id);
    let sw = timers.find(t => t.mode === "up");
    if (!sw) sw = await dev.addTimer(card.id, { name: "Stopwatch", mode: "up" });
    await dev.switchTimer(sw.id);
    await dev.press();            // start counting up immediately
    sndThunk();
    await renderAll();
  } else {
    // countdown needs a length — open the programming panel, start on save
    await renderAll();            // now a card is slotted; the rack is a real 2x2
    openTimerEditor(card.id, null, { forceMode: "down", startOnSave: true });
  }
}
function renderLauncher() {
  rackSig = "";              // the other writer of this <ul> — leaving a stale signature
                             // here would make a re-slotted card keep showing the bays
  elTimerList.innerHTML = "";
  $("rack-count").textContent = "⚡ QUICK";
  const bay = (cls: string, glyph: string, label: string, jp: string, onClick: () => void) => {
    const li = el("li", `timer-row launch ${cls}`) as HTMLLIElement;
    li.append(el("span", "lc-glyph", glyph), el("span", "lc-label", label), el("span", "lc-jp", jp));
    // the lock guard has to live HERE too: keyboard activation never reaches the
    // pointerdown scold handler on #device
    return operable(li, `start a quick ${label.toLowerCase()}`,
      () => { if (isLocked()) return scoldLock(); onClick(); });
  };
  elTimerList.append(
    bay("up", "▶", "STOPWATCH", "ストップウォッチ", () => quickStart("up")),
    bay("down", "⧖", "COUNTDOWN", "カウントダウン", () => quickStart("down")),
    el("li", "timer-row socket"),
    el("li", "timer-row socket"),
  );
}

function timerRow(t: Timer, activeId: string | null): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "timer-row" + (t.id === activeId ? " active" : "");
  const top = document.createElement("div"); top.className = "tc-top";
  const bot = document.createElement("div"); bot.className = "tc-bot";
  const led = document.createElement("span"); led.className = "t-led"; // lit by CSS on .active
  // The name is a real <button>: the row itself can't be one (it contains the ✎/✕
  // buttons), so without this the card's central interaction — switching timers —
  // has no keyboard path at all. CSS resets it back to looking like the label it was.
  const nm = document.createElement("button"); nm.type = "button";
  nm.className = "t-nm"; nm.textContent = t.name;
  nm.setAttribute("aria-label", `switch to ${t.name}`);
  if (t.id === activeId) nm.setAttribute("aria-current", "true");
  nm.onclick = async (e) => {
    e.stopPropagation();
    if (isLocked()) return scoldLock();
    sndTick();
    await renderDevice(await dev.switchTimer(t.id));
  };
  const cfg = document.createElement("span"); cfg.className = "t-cfg";
  cfg.textContent = t.mode === "down" && t.targetMs ? fmtDuration(t.targetMs) : "stopwatch";
  const live = document.createElement("span");
  if (t.liveSession) {
    const held = t.liveSession.pausedAt !== null;
    live.className = "t-live " + (held ? "held" : "run");
    live.textContent = held ? "⏸" : "▶";
  }
  // title alone names an element only when it has no text — these read out as
  // "pencil" and "multiplication x" otherwise, four times over, with no idea which
  // timer is about to be deleted.
  const edit = document.createElement("button");
  edit.className = "t-del"; edit.textContent = "✎"; edit.title = "edit timer";
  edit.setAttribute("aria-label", `edit timer ${t.name}`);
  edit.onclick = (e) => { e.stopPropagation(); if (isLocked()) return scoldLock(); openTimerEditor(t.cardId, t); };
  const del = document.createElement("button");
  del.className = "t-del"; del.textContent = "✕"; del.title = "delete timer";
  del.setAttribute("aria-label", `delete timer ${t.name}`);
  del.onclick = async (e) => {
    e.stopPropagation();
    if (isLocked()) return scoldLock();   // the lock holds the timer set, too
    if (confirm(`Delete timer "${t.name}"? Its time is saved to history.`)) await deleteTimerWithUndo(t);
  };
  // switching suspends one timer and resumes another — a device-side change only
  li.onclick = async () => { if (isLocked()) return scoldLock(); sndTick(); await renderDevice(await dev.switchTimer(t.id)); };
  top.append(led, nm, live);
  bot.append(cfg, edit, del);
  li.append(top, bot);
  return li;
}

// Cards flip like the physical stickers they are: TAP turns a card over to its
// documentary back (this card's stats); the pocket's SLOT tab inserts it.
const flippedCards = new Set<string>();
const todayBanked = new Map<string, number>();   // per-card banked ms since local midnight
const allBanked = new Map<string, number>();     // per-card banked ms, all time
// the curated foil structures; legacy stored values alias to the nearest one
const FOILS = ["foil-holo", "foil-gold", "foil-chrome", "foil-aurora", "foil-cracked", "foil-galaxy", "foil-refractor"];
const FOIL_ALIAS: Record<string, string> = { prism: "holo", emerald: "aurora", violet: "holo", sunset: "gold" };
const TEXTURES = ["cosmos", "waves", "rays", "pin", "ichimatsu", "lattice", "dots"];
function foilFor(id: string): string { // stable per-card foil treatment
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) | 0;
  return FOILS[Math.abs(h) % FOILS.length];
}
function rarityFor(totalMs: number): string { // cards level up with tracked time
  return totalMs >= 36_000_000 ? "★★★" : totalMs >= 3_600_000 ? "★★☆" : "★☆☆";
}
// optical centering for medallion glyphs: the FONT's line box centers fine, but the
// INK sits low inside it (Zen Kaku reserves kana headroom; emoji have their own ideas).
// Measure the actual ink per glyph and counter-shift. Cache per glyph+size.
const inkCache = new Map<string, number>();
function inkShiftY(glyph: string, px: number): number {
  const key = `${glyph}@${px}`;
  if (!inkCache.has(key)) {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `900 ${px}px "Zen Kaku Gothic New", sans-serif`;
    const m = ctx.measureText(glyph);
    const boxCenter = ((m.fontBoundingBoxAscent ?? px * 0.8) - (m.fontBoundingBoxDescent ?? px * 0.2)) / 2;
    const inkCenter = ((m.actualBoundingBoxAscent ?? boxCenter) - (m.actualBoundingBoxDescent ?? 0)) / 2;
    inkCache.set(key, Math.round((inkCenter - boxCenter) * 10) / 10);
  }
  return inkCache.get(key)!;
}
// metrics measured before the webfont arrives are wrong — remeasure once it lands
document.fonts?.ready.then(() => { if (inkCache.size) { inkCache.clear(); renderAll(); } });

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag); e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** Make a non-button element a real control: focusable, named, and activated by
 *  Enter/Space as well as a click. Used for the moulded parts of the machine — the
 *  rack's sockets and the binder's sleeves — which are <li>s for layout reasons but
 *  are the only route to "add a timer" / "new card". */
function operable<T extends HTMLElement>(node: T, label: string, fn: () => void): T {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", label);
  node.onclick = fn;
  node.onkeydown = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();      // Space must press this, not scroll the page
    fn();
  };
  return node;
}

const elBinderPage = document.querySelector(".binder__page") as HTMLElement;

// fill the bench remainder with EMPTY welded sleeves so the page reads as a real
// binder page with open pockets. The "+ add" sleeve comes FIRST after the real cards
// (deviation from the mock, which puts it last: on a phone the bench shows ~1.5
// pockets, so a trailing + would hide behind a scroll of empties).
function fillEmptySleeves() {
  const POCKET_W = 262;
  // count the REAL pockets explicitly — ".pocket" also matches the empties, and
  // relying on them having just been removed is how this miscounts if reordered
  const realCount = elList.querySelectorAll(".pocket:not(.pocket--empty)").length;
  const fit = Math.ceil(elBinderPage.clientWidth / POCKET_W) + 1;
  const need = Math.max(1, fit - realCount);
  const existing = elList.querySelectorAll(".pocket--empty");
  if (existing.length === need) return;          // a resize that changed nothing
  existing.forEach(p => p.remove());
  for (let i = 0; i < need; i++) {
    const empty = el("li", "pocket pocket--empty" + (i === 0 ? " pocket--add" : ""));
    empty.append(el("span", "pocket__ring"), el("span", "pocket__weld-b"), el("span", "pocket__lip"));
    if (i === 0) {
      empty.title = "new card";
      // the only route to a named card in the whole app — say so, and make it work
      // from a keyboard (it was a bare onclick on an <li>)
      empty.append(el("span", "pocket__new", "NEW CARD ・ 新規"));
      operable(empty, "new card", () => { sndClick(); openCardEditor(null); });
      // once the bench is full the add sleeve lands past the fold, where a phone
      // never scrolls to — put it FIRST instead of losing it
      if (realCount >= fit - 1) { elList.prepend(empty); continue; }
    }
    elList.appendChild(empty);
  }
}
// resize fires in bursts (a drag, a phone rotation); do the work once per frame
let sleeveRaf = 0;
window.addEventListener("resize", () => {
  if (sleeveRaf) return;
  sleeveRaf = requestAnimationFrame(() => { sleeveRaf = 0; fillEmptySleeves(); });
});

/** Per-card banked totals, recomputed from one sessions list. renderDevice reads
 *  these for the LCD's TODAY line and rarity, so it must run BEFORE renderDevice —
 *  when renderDeck filled them afterwards, the first paint showed TODAY 00:00 on a
 *  card with hours on it, and TODAY visibly dropped for a moment after SAVE. */
function refreshBanked(sessions: Session[], now: number) {
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  todayBanked.clear(); allBanked.clear();
  for (const sn of sessions) {
    const ms = elapsed(sn, now);
    allBanked.set(sn.cardId, (allBanked.get(sn.cardId) ?? 0) + ms);
    if (sn.startedAt >= dayStart.getTime()) {
      todayBanked.set(sn.cardId, (todayBanked.get(sn.cardId) ?? 0) + ms);
    }
  }
}

/** Draw the binder from a snapshot the caller already fetched. Takes the view and
 *  the stats data rather than re-reading storage: this used to issue listCards() +
 *  view() + statsData() and then ANOTHER listTimers() per card. */
function renderDeck(v: SlotView, data: { sessions: Session[]; cards: Card[]; timers: Timer[]; now: number }) {
  const active = v.card?.id ?? null;
  // bucket the timers once instead of a storage round-trip per card
  const byCard = new Map<string, Timer[]>();
  for (const t of data.timers) {
    const list = byCard.get(t.cardId);
    if (list) list.push(t); else byCard.set(t.cardId, [t]);
  }
  for (const list of byCard.values()) list.sort((a, b) => a.order - b.order);
  // a card portaled to <body> mid-gesture belongs to the OLD render — clear it
  document.querySelectorAll("body > .card").forEach(c => c.remove());
  elList.innerHTML = "";
  for (let i = 0; i < data.cards.length; i++) {
    const c = data.cards[i];
    elList.appendChild(cardItem(c, active, i, data.sessions, data.now, byCard.get(c.id) ?? []));
  }
  fillEmptySleeves();
}

function cardItem(c: Card, active: string | null, index: number, sessions: Session[], now: number, timers: Timer[]): HTMLLIElement {
  const mine = sessions.filter(s => s.cardId === c.id);
  const total = mine.reduce((sum, s) => sum + elapsed(s, now), 0);
  const longest = mine.reduce((max, s) => Math.max(max, elapsed(s, now)), 0);
  const since = mine.length ? isoDate(Math.min(...mine.map(s => s.startedAt))) : "—";
  const perTimer = new Map<string, number>();
  for (const s of mine) perTimer.set(s.timerId, (perTimer.get(s.timerId) ?? 0) + elapsed(s, now));

  const stars = rarityFor(total);
  const no = String(index + 1).padStart(3, "0");
  const series = c.category ? c.category.toUpperCase().slice(0, 10) : null;
  const inUse = c.id === active;
  const chosenFoil = c.foil ? (FOIL_ALIAS[c.foil] ?? c.foil) : null;
  const foilCls = chosenFoil && FOILS.includes("foil-" + chosenFoil) ? "foil-" + chosenFoil : foilFor(c.id);
  const texCls = "tx-" + (c.texture && TEXTURES.includes(c.texture) ? c.texture : "cosmos");

  const li = el("li", "pocket" + (inUse ? " in-use" : "")) as HTMLLIElement;
  li.append(el("span", "pocket__ring"), el("span", "pocket__weld-b"), el("span", "pocket__lip"));

  // the pocket tab: SLOT inserts; the slotted pocket wears IN USE (mock review U14/D4)
  const tab = el("button", "pocket-tab", inUse ? "IN USE ・ 使用中" : "SLOT ・ 挿入") as HTMLButtonElement;
  tab.disabled = inUse;
  tab.onclick = async (e) => { e.stopPropagation(); if (!inUse) await slotCard(c.id); };

  // .card = the drag/positioning wrapper (portaled to <body> mid-gesture, like the mock)
  const card = el("div", `card ${foilCls} ${texCls}` + (flippedCards.has(c.id) ? " flipped resting" : ""));
  card.dataset.cardId = c.id;
  const card3d = el("div", "card-3d");
  card3d.style.setProperty("--cat", c.color || "#6f7457");

  // ── FRONT: the Bikkuriman sticker ──
  const front = el("div", "card-face front");
  front.appendChild(el("span", "foil"));
  front.appendChild(el("span", "tx"));   // the texture ALSO stamps over the foil (embossed, not buried)

  const rank = el("div", "card-rank");
  rank.title = "rarity grows with tracked time ・ 1h ★★ / 10h ★★★";
  rank.appendChild(el("span", "rarity", stars));
  if (series) rank.appendChild(el("span", "card-series", series));   // no filler chip without a category
  const noEl = el("span", "card-no");
  noEl.title = "pocket number";
  noEl.append(el("span", "l", "No."), el("span", "n", no));
  rank.appendChild(noEl);

  const art = el("div", "card-art");
  const emblem = el("div", "card-emblem");
  {
    const glyph = c.emblem?.trim() || ([...c.name][0]?.toUpperCase() ?? "★");
    const g = el("span", "g", glyph);
    g.style.transform = `translateY(${inkShiftY(glyph, 30)}px)`;
    emblem.appendChild(g);
  }
  const id = el("div", "card-id");
  id.append(el("div", "card-nm jp", c.name), el("div", "card-cat",
    c.category ? c.category.toUpperCase() : `${timers.length} TIMER${timers.length === 1 ? "" : "S"}`));
  art.append(emblem, id);

  const foot = el("div", "card-foot");
  const chips = el("div", "card-timers");
  for (const t of timers.slice(0, 4)) {
    chips.appendChild(el("span", "tdot", t.mode === "down" && t.targetMs ? `⧖ ${fmtDuration(t.targetMs)}` : "⏱ SW"));
  }
  const tot = el("span", "card-total", fmtDuration(total));
  foot.append(chips, tot);

  front.append(rank, art, foot, el("div", "barcode"));

  // ── BACK: matte documentary reverse — THIS card's ledger ──
  const back = el("div", "card-back");
  const cbId = el("div", "cb-id");
  cbId.append(el("span", "", series ? `${series} ・ No.${no}` : `No.${no}`), el("span", "cb-rank", stars));
  const nameRow = el("div", "cb-name-row");
  nameRow.append(el("div", "cb-name", c.name),
    el("span", "cb-seal", (c.deadlineKind === "since" && c.deadline) ? "STREAK" : c.deadline ? "DEADLINE" : "TIMER"));
  const ledger = el("div", "cb-ledger");
  const row = (label: string, value: string, cls = "cb-row") => {
    const r = el("div", cls);
    r.append(el("span", "", label), el("i", ""), el("b", "", value));
    return r;
  };
  ledger.append(
    row("TOTAL", fmtDuration(total)),
    row("SESSIONS", String(mine.length)),
    row("LONGEST", fmtDuration(longest)),
    row("SINCE", since),
    el("div", "cb-rule"),
  );
  const roster = el("div", "cb-roster");
  for (const t of timers) {
    roster.appendChild(row(`${t.mode === "down" ? "▼" : "▲"} ${t.name}`, fmtDuration(perTimer.get(t.id) ?? 0), "cb-trow"));
  }
  ledger.appendChild(roster);
  const cbFoot = el("div", "cb-foot");
  const reg = el("div", "cb-reg");
  reg.append(el("span", "", "© TIMECARDS ・ 使用記録"), el("span", "cb-chop", "✓"));
  cbFoot.append(el("div", "cb-tick"), reg);
  back.append(cbId, nameRow, ledger, cbFoot);

  card3d.append(front, back);
  // backface-visibility only hides the reverse VISUALLY — a screen reader was
  // reading both faces of every pocket, doubling the binder's verbosity.
  setFaceVisibility(card3d, flippedCards.has(c.id));

  const actions = el("div", "card-actions");
  // The flip is otherwise a pointer-only secret: nothing says "tap me", and a
  // keyboard never gets there at all. This cluster is a SIBLING of .card, outside the
  // document-level drag gesture, so a key here can't also arm a drag.
  const flip = el("button", "card-flip", "⟲") as HTMLButtonElement;
  flip.title = "flip ・ 裏面";
  flip.setAttribute("aria-label", `flip ${c.name} over to its record`);
  flip.onclick = (e) => {
    e.stopPropagation();
    const cardEl = (e.currentTarget as HTMLElement).closest(".pocket")?.querySelector(".card") as HTMLElement | null;
    if (cardEl) flipCard(cardEl);
  };
  const edit = el("button", "card-edit", "✎") as HTMLButtonElement;
  edit.title = "edit card";
  edit.setAttribute("aria-label", `edit card ${c.name}`);
  edit.onclick = (e) => { e.stopPropagation(); openCardEditor(c); };
  const del = el("button", "card-del", "✕") as HTMLButtonElement;
  del.title = "delete card";
  del.setAttribute("aria-label", `delete card ${c.name}`);
  del.onclick = async (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${c.name}", its timers, and history?`)) await deleteCardWithUndo(c);
  };
  actions.append(flip, edit, del);

  // taps and drags on the card are handled by the unified pointer gesture (below)
  card.appendChild(card3d);
  li.append(tab, card, actions);
  return li;
}

/** Full repaint: ONE storage fetch feeds both halves, and the banked totals are
 *  filled before the LCD reads them. */
// ── UNDO ────────────────────────────────────────────────────────
// Deleting a card cascades its timers AND its whole history, with no recovery and
// (until the settings sheet's export) no backup. Rather than invent a trash can, we
// snapshot the affected rows FIRST and offer them back for a few seconds:
// Device.importAll upserts by id, so a restore returns byte-identical data.
const UNDO_MS = 10_000;
let undoTimer = 0;
const elUndo = el("div", "undo-strip");
elUndo.id = "undo-strip";
elUndo.hidden = true;
elUndo.setAttribute("role", "status");
document.body.appendChild(elUndo);

function offerUndo(message: string, restore: () => Promise<void>) {
  clearTimeout(undoTimer);
  elUndo.innerHTML = "";
  const btn = el("button", "undo-key", "UNDO ・ 取消") as HTMLButtonElement;
  btn.type = "button";
  btn.onclick = async () => {
    clearTimeout(undoTimer);
    elUndo.hidden = true;
    sndSheet(1);
    await restore();
    await renderAll();
  };
  elUndo.append(el("span", "undo-msg", message), btn);
  elUndo.hidden = false;
  undoTimer = window.setTimeout(() => { elUndo.hidden = true; }, UNDO_MS);
}

async function deleteCardWithUndo(c: Card) {
  // snapshot BEFORE the delete — afterwards the rows are gone
  const timers = await dev.listTimers(c.id);
  const sessions = await dev.listSessions(c.id);
  const slot = (await dev.view()).card?.id === c.id;
  await dev.deleteCard(c.id);
  await renderAll();
  offerUndo(`deleted "${c.name}"`, async () => {
    await dev.importAll({ version: 1, exportedAt: Date.now(), cards: [c], timers, sessions,
                          slot: { cardId: slot ? c.id : null, activeTimerId: slot ? (c.lastTimerId ?? null) : null, locked: false } });
  });
}

async function deleteTimerWithUndo(t: Timer) {
  const card = await dev.getCard(t.cardId);
  await dev.deleteTimer(t.id);   // banks any in-progress run to history first
  await renderAll();
  offerUndo(`deleted timer "${t.name}"`, async () => {
    // Restore the CONFIG with no live session: deleteTimer already banked the run to
    // history, so bringing liveSession back would leave the same stretch of time
    // counted twice — once on the timer, once in the ledger.
    const restored: Timer = { ...t, liveSession: null };
    // leave the slot exactly as it is; only the timer row is coming back
    const now = await dev.view();
    await dev.importAll({ version: 1, exportedAt: Date.now(), cards: card ? [card] : [],
                          timers: [restored], sessions: [],
                          slot: { cardId: now.card?.id ?? null, activeTimerId: now.timer?.id ?? null, locked: now.locked } });
  });
}

async function renderAll() {
  const data = await dev.statsData();
  deckIsEmpty = data.cards.length === 0;
  refreshBanked(data.sessions, data.now);
  const v = await renderDevice();
  renderDeck(v, data);
}

/** Slot a card into the device: thunk + the LCD wakes with a flicker (the mock's insert).
 *  No card may be left showing its reverse or lifted out of its pocket. */
async function slotCard(cardId: string) {
  // The engine refuses to swap the card while locked (device.ts slot()), but the UI
  // used to thunk, flip every card face-down and flicker the LCD anyway — the machine
  // performing an action it did not perform. Answer the poke honestly instead.
  if (isLocked()) return scoldLock();
  document.querySelectorAll<HTMLElement>(".card.flipped, .card.airborne, .card.resting").forEach(resetCard);
  flippedCards.clear();
  sndThunk();
  await dev.slot(cardId);
  await renderAll();
  const lcd = document.querySelector(".lcd")!;
  lcd.classList.remove("waking"); void (lcd as HTMLElement).offsetWidth; lcd.classList.add("waking");
}

// ── CARD GESTURES (the mock's, faithfully): a tap FLIPS the card over in a
// three-beat lift→turn→settle; a mostly-UPWARD drag picks it up to drop on the
// device; a horizontal move is left to the bench's native scroll. ──────────────
const LIFT_GAP = 18;   // px of daylight above the binder while flipping
const elBinder = $("deck");

// REVIEW U2/U3: never trust transitionend as the only clock — a skipped or canceled
// transition (reduced motion, interrupt) never fires it. Race a timeout.
function onTopEnd(card: HTMLElement, fn: () => void) {
  let done = false;
  const go = () => { if (!done) { done = true; card.removeEventListener("transitionend", h); fn(); } };
  const h = (e: TransitionEvent) => { if (e.target === card && e.propertyName === "top") go(); };
  card.addEventListener("transitionend", h);
  setTimeout(go, 700);   // safety net only — far past the 220ms travel, so the next
                         // beat can never start while the card is still moving
}
function onFlipEnd(card: HTMLElement, fn: () => void) {
  let done = false;
  const el3d = card.querySelector(".card-3d") as HTMLElement;
  const go = () => { if (!done) { done = true; el3d.removeEventListener("transitionend", h); fn(); } };
  // ONLY the flip's own transform counts — the foil layers' transitions (opacity,
  // facet vars) bubble up here and would end the beat early, starting the descent
  // while the card is still turning
  const h = (e: TransitionEvent) => { if (e.target === el3d && e.propertyName === "transform") go(); };
  el3d.addEventListener("transitionend", h);
  setTimeout(go, 800);   // safety net only
}

// pin the card at its on-screen spot in viewport-fixed coords. PORTAL to <body> first:
// the binder row's perspective forms a containing block that would trap position:fixed.
function pin(card: HTMLElement): DOMRect {
  const pocket = card.closest(".pocket") as HTMLElement;
  const r = card.getBoundingClientRect();
  (card as any)._homePocket = pocket;
  pocket.classList.add("bn-lent");              // hold the sleeve open while the card is away
  card.classList.add("airborne");
  card.style.left = r.left + "px";
  card.style.width = r.width + "px";
  card.style.top = r.top + "px";
  document.body.appendChild(card);
  void card.offsetWidth;                        // flush layout so the next `top` animates
  return r;
}
function unpin(card: HTMLElement) {
  card.classList.remove("airborne");
  card.style.left = card.style.width = card.style.top = "";
  const home = (card as any)._homePocket as HTMLElement | null;
  if (home) {
    home.classList.remove("bn-lent");
    home.appendChild(card);
    (card as any)._homePocket = null;
  }
}
function restInPocket(card: HTMLElement) { unpin(card); card.classList.add("resting"); }
function resetCard(card: HTMLElement) {
  card.classList.remove("flipped", "flipping", "dragging", "resting");
  if (card.dataset.cardId) flippedCards.delete(card.dataset.cardId);
  delete card.dataset.busy;
  if (card.classList.contains("airborne") || (card as any)._homePocket) unpin(card);
  else {
    card.closest(".pocket")?.classList.remove("bn-lent");
    card.style.left = card.style.width = card.style.top = "";
  }
}

/** Expose exactly the face that is showing to assistive tech. */
function setFaceVisibility(card3d: Element, showingBack: boolean) {
  card3d.querySelector(".card-face.front")?.setAttribute("aria-hidden", String(showingBack));
  card3d.querySelector(".card-back")?.setAttribute("aria-hidden", String(!showingBack));
}

function flipCard(card: HTMLElement) {
  if (card.dataset.busy) return;
  const toBack = !card.classList.contains("flipped");
  card.dataset.busy = "1";
  elList.classList.add("cards--flipping");
  const pocket = card.closest(".pocket") as HTMLElement;
  card.classList.remove("resting");
  const r = pin(card);
  const liftTop = elBinder.getBoundingClientRect().top - r.height - LIFT_GAP;
  const id = card.dataset.cardId!;
  const settle = (after: () => void) => {
    card.style.top = (pocket.getBoundingClientRect().top + 6) + "px";
    onTopEnd(card, () => { after(); delete card.dataset.busy; elList.classList.remove("cards--flipping"); });
  };
  requestAnimationFrame(() => { card.style.top = liftTop + "px"; });   // beat 1: lift out
  onTopEnd(card, () => {
    sndFlip();                                                          // beat 2: flip mid-air
    card.classList.toggle("flipped", toBack);
    const c3d = card.querySelector(".card-3d");
    if (c3d) setFaceVisibility(c3d, toBack);
    if (toBack) flippedCards.add(id); else flippedCards.delete(id);
    onFlipEnd(card, () => {
      settle(() => { if (toBack) restInPocket(card); else unpin(card); });   // beat 3: settle
    });
  });
}

// UNIFIED POINTER DRAG — touch AND mouse. Press that moves mostly UP = pick the card
// up; mostly horizontal = bench scroll; barely moves = tap → flip.
const DRAG_THRESH = 8;
let drag: { card: HTMLElement; startX: number; startY: number; pointerId: number;
            active: boolean; moved: boolean; offX?: number; offY?: number } | null = null;

document.addEventListener("pointerdown", (e) => {
  const card = (e.target as HTMLElement).closest(".card") as HTMLElement | null;
  if (!card || e.button > 0) return;
  drag = { card, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, active: false, moved: false };
});
document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
  if (!drag.active) {
    if (Math.hypot(dx, dy) <= DRAG_THRESH) return;
    drag.moved = true;
    if (Math.abs(dx) > Math.abs(dy)) { drag = null; return; }   // horizontal → bench scroll
    if (dy > 0) { drag = null; return; }                        // downward → let the page scroll
    startCardDrag(e);
  }
  if (drag?.active) { e.preventDefault(); moveCardTo(e.clientX, e.clientY); }
}, { passive: false });
document.addEventListener("pointerup", async (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag; drag = null;
  if (d.active) {
    const id = d.card.dataset.cardId!;
    endCardDrag(d.card);
    if (overDevice(e.clientX, e.clientY)) await slotCard(id);
  } else if (!d.moved) {
    flipCard(d.card);                                            // a tap → flip
  }
});
document.addEventListener("pointercancel", () => {
  if (drag?.active) endCardDrag(drag.card);
  drag = null;
});

function startCardDrag(e: PointerEvent) {
  const card = drag!.card;
  resetCard(card);                     // snap to front-up, un-portal any flip state
  drag!.active = true;
  const r = card.getBoundingClientRect();
  drag!.offX = e.clientX - r.left; drag!.offY = e.clientY - r.top;
  (card as any)._dragHome = card.closest(".pocket");
  (card as any)._dragHome?.classList.add("bn-lent");
  card.style.width = r.width + "px";
  card.classList.add("dragging");
  document.body.appendChild(card);
  try { (card as any).setPointerCapture?.(e.pointerId); } catch {}
  moveCardTo(e.clientX, e.clientY);
}
function moveCardTo(x: number, y: number) {
  drag!.card.style.left = (x - drag!.offX!) + "px";
  drag!.card.style.top = (y - drag!.offY!) + "px";
}
// the WHOLE device is the drop zone — drop a card anywhere on it to load it
function overDevice(x: number, y: number): boolean {
  const r = elDevice.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function endCardDrag(card: HTMLElement) {
  card.classList.remove("dragging");
  card.style.left = card.style.width = card.style.top = "";
  const home = (card as any)._dragHome as HTMLElement | null;
  home?.classList.remove("bn-lent");
  home?.appendChild(card);
  (card as any)._dragHome = null;
}
// The bench scrolls horizontally and hides both scrollbars, so a plain desktop mouse
// (vertical wheel, no shift) could not move it at all. Map the wheel onto it — but
// only when the wheel is genuinely vertical, so trackpad side-swipes still work.
elBinderPage.addEventListener("wheel", (e) => {
  if (e.deltaX !== 0 || Math.abs(e.deltaY) < 2) return;
  if (elBinderPage.scrollWidth <= elBinderPage.clientWidth) return;   // nothing to scroll
  e.preventDefault();
  elBinderPage.scrollLeft += e.deltaY;
}, { passive: false });

// a card mid-FLIGHT is position:fixed; keep it aligned to its pocket if the bench scrolls
elBinderPage.addEventListener("scroll", () => {
  document.querySelectorAll<HTMLElement>(".card.airborne").forEach(card => {
    const home = (card as any)._homePocket as HTMLElement | null;
    if (home) card.style.left = (home.getBoundingClientRect().left + 6) + "px";
  });
}, { passive: true });

// ── device interactions (each key clicks like the mock's) ───────
// A press only moves the LCD and one rack LED — nothing it writes is read by the
// binder — so it repaints the device, not the whole deck. The exception is leaving
// `finished`: that banks the round, which DOES change the card's totals.
elBig.onclick = async () => {
  sndDome();
  // ask for notification permission from a real press — never at load, and only once
  if (window.Notification?.permission === "default") Notification.requestPermission().catch(() => {});
  const wasFinished = lastState === "finished";
  const v = await dev.press();
  if (wasFinished) await renderAll(); else await renderDevice(v);
};
elFinish.onclick = async () => { sndBank(); alarmedFor = null; await dev.finish(); await renderAll(); }; // bank to history
elReset.onclick = async () => { sndClick(); alarmedFor = null; await dev.reset(); await renderAll(); }; // discard
elLock.onclick = async () => { sndLatch(); await dev.lock(); await renderDevice(); };

// ── the lock demands attention: while LOCKED, poking any control on the device
// (except the lock) jolts the latch, flashes the LOCK lamp, and buzzes "no". The
// engine already no-ops these, but disabled controls don't fire clicks — so we
// catch the attempt at the capture phase on the device and answer it physically.
function isLocked() { return elDevice.classList.contains("is-locked"); }
let lockScoldAt = 0;
function scoldLock() {
  const now = Date.now();
  if (now - lockScoldAt < 260) return;   // one jolt per poke, don't stack
  lockScoldAt = now;
  elLock.classList.remove("scold"); void elLock.offsetWidth; elLock.classList.add("scold");
  const lamp = $("lamp-lock");
  lamp.classList.remove("flash"); void lamp.offsetWidth; lamp.classList.add("flash");
  if (!reducedMotion()) sndDenied();
}
elDevice.addEventListener("pointerdown", (e) => {
  if (!elDevice.classList.contains("is-locked")) return;
  const t = e.target as HTMLElement;
  if (elLock.contains(t)) return;                    // the lock itself is always live
  if (t.closest("#big-button")) return;              // the big dome is LIVE while locked — never scold it
  if (elRackArea.classList.contains("editing")) return;  // the programming panel is its own thing
  if (t.closest("#pull-tab")) return;                // the pull-tab handles its own locked guard
  // a poke on any FROZEN device control (the small keys, the rack) while locked → scold
  if (t.closest(".skey,.timer-row,.rack-editor")) scoldLock();
}, true);

document.addEventListener("keydown", (e) => {
  // Escape backs out of the programming panel, the way it does out of the card editor.
  if (e.key === "Escape" && elRackArea.classList.contains("editing")) {
    e.preventDefault();
    sndClick();
    closeTimerEditor();
    return;
  }
  if (e.code !== "Space") return;
  if (elCardEditor.open || elRackArea.classList.contains("editing")) return;
  // Space IS the big dome — live even while locked. But it must not steal the key
  // from a focused control (Space is how you activate a button), and while a paper
  // is out Space belongs to the tape: scrolling it, or pressing its printed keys.
  const t = e.target as HTMLElement | null;
  if (t && t !== elBig && t.closest("button, input, select, textarea, [contenteditable]")) return;
  if (paperOut) return;
  e.preventDefault();
  elBig.click();
});

// ── the index-card editors: pulled up from the desk, tossed away on close ──
function openEditor(dlg: HTMLDialogElement) { dlg.showModal(); sndSheet(1); }
async function closeEditor(dlg: HTMLDialogElement) {
  const card = dlg.querySelector(".index-card") as HTMLElement;
  sndSheet(-1);
  if (!reducedMotion()) {
    card.classList.add("away");
    await new Promise(r => setTimeout(r, 300));
    card.classList.remove("away");
  }
  dlg.close();
}
// Esc = the same toss-away, not an instant vanish
elCardEditor.addEventListener("cancel", (e) => { e.preventDefault(); closeEditor(elCardEditor); });

// ── card editor ─────────────────────────────────────────────────
let editingCardId: string | null = null;
$("c-emblem-chips").addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (b) { sndTick(); $<HTMLInputElement>("c-emblem").value = b.textContent ?? ""; }
});

function openCardEditor(card: Card | null) {
  editingCardId = card?.id ?? null;
  $("card-title").textContent = card ? "Edit card" : "New card";
  $<HTMLInputElement>("c-name").value = card?.name ?? "";
  $<HTMLInputElement>("c-category").value = card?.category ?? "";
  $<HTMLInputElement>("c-color").value = card?.color ?? "#6f7457";
  $<HTMLInputElement>("c-emblem").value = card?.emblem ?? "";
  const foilRadio = elCardEditor.querySelector(`input[name=cfoil][value="${card?.foil ?? ""}"]`) as HTMLInputElement | null;
  (foilRadio ?? elCardEditor.querySelector('input[name=cfoil][value=""]') as HTMLInputElement).checked = true;
  const texRadio = elCardEditor.querySelector(`input[name=ctexture][value="${card?.texture ?? ""}"]`) as HTMLInputElement | null;
  (texRadio ?? elCardEditor.querySelector('input[name=ctexture][value=""]') as HTMLInputElement).checked = true;
  $<HTMLInputElement>("c-deadline").value = card?.deadline ? isoDate(card.deadline) : "";
  const dk = card?.deadlineKind ?? "until";
  (elCardEditor.querySelector(`input[name=dkind][value=${dk}]`) as HTMLInputElement).checked = true;
  openEditor(elCardEditor);
}
$("card-cancel").onclick = () => closeEditor(elCardEditor);
$<HTMLFormElement>("card-form").onsubmit = async (e) => {
  e.preventDefault();
  const nameEl = $<HTMLInputElement>("c-name");
  const name = nameEl.value.trim();
  if (!name) {
    // A whitespace-only name passes `required` but fails our trim, and the form used
    // to just return — the save key did nothing, with nothing said. Empty the field
    // so the browser's own "please fill this in" bubble fires on the right input.
    nameEl.value = "";
    nameEl.reportValidity();
    return;
  }
  const category = $<HTMLInputElement>("c-category").value.trim() || null;
  const color = $<HTMLInputElement>("c-color").value;
  const emblem = $<HTMLInputElement>("c-emblem").value.trim() || null;
  const foil = (elCardEditor.querySelector("input[name=cfoil]:checked") as HTMLInputElement)?.value || null;
  const texture = (elCardEditor.querySelector("input[name=ctexture]:checked") as HTMLInputElement)?.value || null;
  const dateStr = $<HTMLInputElement>("c-deadline").value;
  const deadline = dateStr ? new Date(dateStr + "T00:00").getTime() : null;
  const deadlineKind = (elCardEditor.querySelector("input[name=dkind]:checked") as HTMLInputElement).value as DeadlineKind;
  if (editingCardId) {
    await dev.renameCard(editingCardId, name);
    await dev.configureCard(editingCardId, { category, color, deadline, deadlineKind, emblem, foil, texture });
  } else {
    const c = await dev.createCard(name, { category: category ?? undefined, color,
      emblem: emblem ?? undefined, foil: foil ?? undefined, texture: texture ?? undefined });
    if (deadline) await dev.configureCard(c.id, { deadline, deadlineKind });
    await dev.slot(c.id); // slot the new card so its timers are visible
    setTimeout(sndThunk, 350); // ...and it lands in the device once the sheet is away
  }
  await closeEditor(elCardEditor);
  await renderAll();
};

// ── the PROGRAMMING PANEL: timers are edited on the machine, not on paper ──
const elRackArea = $("timers");
const elRackEditor = $("rack-editor");
let editingTimerId: string | null = null;
let timerEditorCardId: string | null = null;
let editMode: TimerMode = "up";
let editAlarm: AlarmStyle = "chime";
const ALARM_CYCLE: AlarmStyle[] = ["chime", "blip", "digital", "bell", "melody", "silent"];
const ALARM_LABEL: Record<string, string> = {
  chime: "♪ CHIME", blip: "♪ BLIP", digital: "♪ DIGITAL",
  bell: "♪ BELL", melody: "♪ MELODY", silent: "ALARM OFF",
};

// Bounded H:M:S entry — steppers AND typed override, like the physical device.
const elH = $<HTMLInputElement>("t-h"), elM = $<HTMLInputElement>("t-m"), elS = $<HTMLInputElement>("t-s");
const elDurFields = $("dur-fields");
const UNIT = { h: { el: elH, max: 23 }, m: { el: elM, max: 59 }, s: { el: elS, max: 59 } } as const;

/** Read + clamp the H:M:S inputs to ms. Empty fields count as 0. */
function readDurationMs(): number {
  const clamp = (el2: HTMLInputElement, max: number) => {
    let n = Math.floor(Number(el2.value));
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (n > max) { n = max; el2.value = String(max); }  // visibly enforce the ceiling
    return n;
  };
  const h = clamp(elH, 23), m = clamp(elM, 59), sec = clamp(elS, 59);
  return ((h * 60 + m) * 60 + sec) * 1000;
}
/** Write ms back into the H:M:S inputs. */
function writeDurationMs(ms: number | null) {
  const total = Math.floor((ms ?? 0) / 1000);
  elH.value = ms ? String(Math.floor(total / 3600)) : "";
  elM.value = ms ? String(Math.floor((total % 3600) / 60)) : "";
  elS.value = ms ? String(total % 60) : "";
}
/** Latch the mode keys; steppers only matter for a countdown. */
function syncTimerModeUI() {
  $("re-up").classList.toggle("on", editMode === "up");
  $("re-down").classList.toggle("on", editMode === "down");
  elDurFields.classList.toggle("disabled", editMode !== "down");
}
$("re-up").onclick = () => { sndTick(); editMode = "up"; syncTimerModeUI(); };
$("re-down").onclick = () => { sndTick(); editMode = "down"; syncTimerModeUI(); };

// touching time = countdown intent (a set length is never a stopwatch)
for (const el2 of [elH, elM, elS]) {
  el2.addEventListener("input", () => { editMode = "down"; syncTimerModeUI(); });
  el2.addEventListener("blur", () => readDurationMs());  // clamp to bounds on leaving a field
}
// steppers: tap steps once, hold repeats — kitchen-timer keys, with wrap
function stepUnit(u: keyof typeof UNIT, d: number) {
  const { el: el2, max } = UNIT[u];
  let n = Math.floor(Number(el2.value));
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = (n + d + max + 1) % (max + 1);
  el2.value = String(n);
  editMode = "down"; syncTimerModeUI();
  sndTick();
}
for (const btn of document.querySelectorAll<HTMLButtonElement>(".re-step")) {
  const u = btn.dataset.u as keyof typeof UNIT, d = Number(btn.dataset.d);
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    stepUnit(u, d);
    let iv = 0;
    const t1 = setTimeout(() => { iv = window.setInterval(() => stepUnit(u, d), 110); }, 420);
    const stop = () => { clearTimeout(t1); if (iv) clearInterval(iv); };
    btn.addEventListener("pointerup", stop, { once: true });
    btn.addEventListener("pointercancel", stop, { once: true });
    btn.addEventListener("pointerleave", stop, { once: true });
  });
}
// the alarm key cycles the voices — and each press PREVIEWS the one it lands on
$("t-alarm-key").onclick = () => {
  editAlarm = ALARM_CYCLE[(ALARM_CYCLE.indexOf(editAlarm) + 1) % ALARM_CYCLE.length];
  $("t-alarm-key").textContent = ALARM_LABEL[editAlarm];
  playAlarm(editAlarm);
};

/** The panel's own way of saying no — a browser alert() would break the illusion
 *  that this is a machine, and it steals focus out of the panel. The message rides
 *  on the panel itself and clears on the next interaction. */
const elRackNag = el("div", "re-nag");
elRackNag.id = "re-nag";
elRackNag.hidden = true;
elRackNag.setAttribute("role", "alert");
function nagPanel(msg: string) {
  elRackNag.textContent = msg;
  elRackNag.hidden = false;
  elRackNag.classList.remove("flash"); void elRackNag.offsetWidth; elRackNag.classList.add("flash");
  if (!reducedMotion()) sndDenied();
}

// focus goes into the panel and comes back out to whatever opened it: the plate the
// ✎ lives on is display:none'd while editing, so the browser would drop focus to
// <body> and a keyboard user would be stranded at the top of the document.
let rackReturnFocus: HTMLElement | null = null;

function openTimerEditor(cardId: string, timer: Timer | null, opts: { forceMode?: TimerMode; startOnSave?: boolean } = {}) {
  timerEditorCardId = cardId;
  editingTimerId = timer?.id ?? null;
  startOnSave = !!opts.startOnSave;   // the launcher: create the timer AND start it on save
  // the plate must not change size: pin the editor to the grid's measured height
  elRackEditor.style.height = `${elTimerList.getBoundingClientRect().height}px`;
  $<HTMLInputElement>("t-name").value = timer?.name ?? "";
  editMode = opts.forceMode ?? timer?.mode ?? "up";
  writeDurationMs(timer?.targetMs ?? null);
  editAlarm = timer?.alarmStyle ?? "chime";
  $("t-alarm-key").textContent = ALARM_LABEL[editAlarm];
  syncTimerModeUI();
  elRackNag.hidden = true;
  if (!elRackNag.parentElement) elRackEditor.appendChild(elRackNag);
  rackReturnFocus = document.activeElement as HTMLElement | null;
  elRackArea.classList.add("editing");
  elRackEditor.hidden = false;
  // focus the PANEL, not #t-name — focusing a text field pops the soft keyboard on
  // a phone and changes how the machine feels to touch
  elRackEditor.tabIndex = -1;
  elRackEditor.focus();
  sndClick();
}
function closeTimerEditor() {
  elRackArea.classList.remove("editing");
  elRackEditor.hidden = true;
  elRackNag.hidden = true;
  editingTimerId = null; timerEditorCardId = null; startOnSave = false;
  // hand focus back — but SAVE re-renders the rack, so the node that opened us may
  // be detached by now; fall back to whatever now stands in its place
  const back = rackReturnFocus;
  rackReturnFocus = null;
  queueMicrotask(() => {
    if (back?.isConnected) back.focus();
    else (elTimerList.querySelector(".timer-row.add, .t-nm") as HTMLElement | null)?.focus();
  });
}
let startOnSave = false;
$("t-cancel").onclick = () => { sndClick(); closeTimerEditor(); };
$("t-save").onclick = async () => {
  const name = $<HTMLInputElement>("t-name").value.trim();
  const targetMs = readDurationMs();
  // Intent: a non-zero H:M:S IS a countdown — a set length can never be
  // silently discarded as a stopwatch.
  const mode: TimerMode = targetMs > 0 ? "down" : editMode === "down" ? "down" : "up";
  const finalTarget = mode === "down" ? targetMs : null;
  if (mode === "down" && !finalTarget) { nagPanel("set a length first ・ h / m / s"); return; }
  const launch = startOnSave;
  sndClick();
  if (editingTimerId) {
    await dev.configureTimer(editingTimerId, { name: name || undefined, mode, targetMs: finalTarget, alarmStyle: editAlarm });
  } else if (timerEditorCardId) {
    try {
      const t = await dev.addTimer(timerEditorCardId, { name, mode, targetMs: finalTarget, alarmStyle: editAlarm });
      await dev.switchTimer(t.id); // make the new timer active
      if (launch) { await dev.press(); sndDome(); }   // launcher: start the quick countdown immediately
    } catch (err) { nagPanel(String(err instanceof Error ? err.message : err)); return; }
  }
  closeTimerEditor();
  await renderAll();
};

// ── settings: Supabase sync (printed onto the settings sheet) ───
function fillSettings() {
  $<HTMLInputElement>("sb-url").value = localStorage.getItem("tc_sb_url") ?? "";
  $<HTMLInputElement>("sb-key").value = localStorage.getItem("tc_sb_key") ?? "";
  const where = localStorage.getItem("tc_sb_url")
    ? "CURRENTLY SYNCING TO SUPABASE."
    : "CURRENTLY LOCAL ONLY (THIS BROWSER).";
  // Say plainly how durable "local" is — "best-effort" storage can be evicted.
  const durable = storagePersisted === null ? "" : storagePersisted
    ? "  ・ STORAGE: PERSISTENT."
    : "  ・ STORAGE: BEST-EFFORT — PRINT A BACKUP.";
  $("sb-status").textContent = where + durable;
}

// Ask once for durable storage, and remember what the browser said (the sheet is
// only filled when it prints, so this must not wait until then).
let storagePersisted: boolean | null = null;
navigator.storage?.persisted?.().then(async (p) => {
  storagePersisted = p || await (navigator.storage.persist?.() ?? Promise.resolve(false));
}).catch(() => {});

// ── backup: export / import the whole dataset from the settings sheet ──
$("sb-export").onclick = async () => {
  sndClick();
  try {
    const dump = await dev.exportAll();
    const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `timecards-${isoDate(Date.now())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    $("sb-status").textContent = `EXPORTED ${dump.cards.length} CARDS ・ ${dump.sessions.length} SESSIONS.`;
  } catch (e) {
    $("sb-status").textContent = "EXPORT FAILED — " + (e instanceof Error ? e.message : String(e));
  }
};
$("sb-import-key").onclick = () => { sndClick(); $<HTMLInputElement>("sb-import").click(); };
$<HTMLInputElement>("sb-import").onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const counts = await dev.importAll(data);
    $("sb-status").textContent = `IMPORTED ${counts.cards} CARDS ・ ${counts.timers} TIMERS ・ ${counts.sessions} SESSIONS.`;
    await renderAll();
  } catch (err) {
    // never an alert() — the message belongs on the paper the user is reading
    $("sb-status").textContent = "IMPORT FAILED — " + (err instanceof Error ? err.message : String(err));
  } finally {
    ($("sb-import") as HTMLInputElement).value = "";   // let the same file be picked again
  }
};
$("sb-clear").onclick = () => {
  localStorage.removeItem("tc_sb_url");
  localStorage.removeItem("tc_sb_key");
  location.reload();   // re-init with IndexedDB
};
$<HTMLFormElement>("settings-form").onsubmit = (e) => {
  e.preventDefault();
  const url = $<HTMLInputElement>("sb-url").value.trim();
  const key = $<HTMLInputElement>("sb-key").value.trim();
  if (url && key) { localStorage.setItem("tc_sb_url", url); localStorage.setItem("tc_sb_key", key); }
  else { localStorage.removeItem("tc_sb_url"); localStorage.removeItem("tc_sb_key"); }
  location.reload();   // re-init with the chosen backend
};

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── THE PRINTER (from the mock, faithfully) ─────────────────────
// One mouth, one paper out at a time. Pressing EITHER print key while a paper is
// out CUTS it (whichever it is) — you never get a second paper from the one mouth.
// A print freezes the app's data onto the paper at THAT moment; the at-rest stub
// hides while a paper is out (it has BECOME the paper) and feeds back after a cut.
const elPrinter = $("printer");
const elPaperReport = $("paper-report");
const elPaperSettings = $("paper-settings");
const elPaperDetailed = $("paper-detailed");
const elStub = elPrinter.querySelector(".pr-stub") as HTMLElement;
type PaperKind = "report" | "settings" | "detailed";
let paperOut: PaperKind | null = null;
let printBusy = false;
const paperEl = (k: PaperKind) =>
  k === "report" ? elPaperReport : k === "settings" ? elPaperSettings : elPaperDetailed;
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function randTilt(): string { // a cut sheet drifts with a small random tilt — light paper
  const deg = 2 + Math.random() * 4;
  return (Math.random() < 0.5 ? -deg : deg).toFixed(2) + "deg";
}
function feedStubBack(done: () => void) {
  elPrinter.classList.remove("paper-is-out");
  if (reducedMotion()) { done(); return; }
  elStub.classList.remove("feeding"); void elStub.offsetWidth; elStub.classList.add("feeding");
  sndPrint();
  elStub.addEventListener("animationend", () => { elStub.classList.remove("feeding"); done(); }, { once: true });
}
async function printPaper(kind: PaperKind) {
  printBusy = true;
  try {
    if (kind === "report") await renderStats();     // freeze the data onto the paper NOW
    else if (kind === "detailed") { window.scrollTo({ top: 0 }); await renderDetailed(); }
    else fillSettings();
  } catch (e) {
    // A storage failure while composing the paper must not leave the printer jammed:
    // printBusy stuck true blocks every print key — including SETUP, the only way
    // back to the sync settings that may have caused it.
    console.error("print failed", e);
    printBusy = false;
    elPrinter.classList.remove("printing", "paper-is-out");
    return;
  }
  elPrinter.classList.add("printing", "paper-is-out");
  const el = paperEl(kind);
  el.hidden = false;
  el.classList.remove("cut");
  el.classList.remove("spooling"); void el.offsetWidth; el.classList.add("spooling");
  sndPrint();
  setTimeout(() => { elPrinter.classList.remove("printing"); paperOut = kind; printBusy = false; }, 750);
}
function cutPaper() {
  if (!paperOut) return;
  printBusy = true;
  const el = paperEl(paperOut);
  sndCut();
  if (reducedMotion()) {
    el.hidden = true; el.classList.remove("spooling");
    paperOut = null; feedStubBack(() => { printBusy = false; });
    return;
  }
  el.style.setProperty("--fall-tilt", randTilt());
  el.classList.remove("spooling");
  el.classList.add("cut");
  el.addEventListener("animationend", () => {
    el.hidden = true;
    el.classList.remove("cut", "spooling");
    paperOut = null;
    feedStubBack(() => { printBusy = false; });  // mouth feeds stub → ready
  }, { once: true });
}
function pressPrintKey(kind: PaperKind) {
  sndClick();
  if (printBusy) return;              // mid print/cut/feed — ignore
  if (paperOut) { cutPaper(); return; }   // a paper is out → cut it, whichever key
  printPaper(kind);
}
$("print-report").onclick = () => pressPrintKey("report");
$("print-detailed").onclick = () => pressPrintKey("detailed");
$("print-settings").onclick = () => pressPrintKey("settings");
// the printed ✂ CUT buttons on the papers themselves
document.querySelectorAll<HTMLButtonElement>("[data-cut]").forEach(b => {
  b.onclick = () => { if (!printBusy && paperOut) cutPaper(); };
});

// ── the DETAILED report: overview / one page per card / session log ──
let pdPage = 1;
let pdPageEls: HTMLElement[] = [];
function pdRow(label: string, value: string): HTMLElement {
  const r = el("div", "p-row");
  r.append(el("span", "", label), el("b", "", value));
  return r;
}
function showPdPage(n: number) {
  pdPage = Math.max(1, Math.min(pdPageEls.length, n));
  const host = $("pd-pages"); host.innerHTML = "";
  if (pdPageEls[pdPage - 1]) host.appendChild(pdPageEls[pdPage - 1]);
  $("pd-pgno").textContent = String(pdPage);
  $("pd-pgtotal").textContent = String(pdPageEls.length);
  ($("pd-prev") as HTMLButtonElement).disabled = pdPage === 1;
  ($("pd-next") as HTMLButtonElement).disabled = pdPage === pdPageEls.length;
}
$("pd-prev").onclick = () => { sndTick(); showPdPage(pdPage - 1); };
$("pd-next").onclick = () => { sndTick(); showPdPage(pdPage + 1); };

async function renderDetailed() {
  const { sessions, cards, timers, now } = await dev.statsData();
  const d = new Date(now);
  $("pd-stamp").textContent = `${isoDate(now)}  ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const pages: HTMLElement[] = [];
  const st = Stats.streaks(sessions, now);
  const total = Stats.totalMs(sessions, now);
  const sparse = sessions.length < 10 || st.activeDays < 7;   // young accounts get honesty, not noise

  const cols = (data: Array<{ label: string; ms: number; hot?: boolean }>) => {
    const host = el("div", "pd-cols");
    const max = Math.max(1, ...data.map(x => x.ms));
    for (const x of data) {
      const col = el("div", "pd-col" + (x.hot ? " hot" : ""));
      const bar = document.createElement("i");
      bar.style.height = `${Math.round((x.ms / max) * 100)}%`;
      col.append(bar, el("b", "", x.label));
      host.appendChild(col);
    }
    return host;
  };

  // ── page 1: SUMMARY — the account header ──
  const p1 = el("div", "");
  p1.appendChild(el("h3", "p-lbl", "SUMMARY ・ 概要"));
  const since = sessions.length ? isoDate(Math.min(...sessions.map(x => x.startedAt))) : "—";
  let longestMs = 0, longestAt = 0;
  for (const sn of sessions) { const ms = elapsed(sn, now); if (ms > longestMs) { longestMs = ms; longestAt = sn.startedAt; } }
  p1.append(
    pdRow("SINCE", since),
    pdRow("TOTAL TRACKED", shortDur(total)),
    pdRow("SESSIONS", String(sessions.length)),
    pdRow("ACTIVE DAYS", String(st.activeDays)),
    pdRow("AVG / ACTIVE DAY", shortDur(total / Math.max(1, st.activeDays))),
    pdRow("AVG SESSION", shortDur(total / Math.max(1, sessions.length))),
    pdRow("LONGEST SESSION", longestMs ? `${fmtDuration(longestMs)} (${isoDate(longestAt)})` : "—"),
    pdRow("STREAK", `${st.current} DAYS`),
    pdRow("BEST STREAK", `${st.longest} DAYS`),
  );
  pages.push(p1);

  // ── page 2: RHYTHM — when the practice happens ──
  const p2 = el("div", "");
  p2.appendChild(el("h3", "p-lbl", "RHYTHM ・ 週間"));
  if (sparse) {
    p2.appendChild(el("div", "pd-note", "not enough data yet ・ keep tracking"));
  } else {
    const WD = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
    const wd = new Array(7).fill(0);
    const HB = ["0-4", "4-8", "8-12", "12-16", "16-20", "20-24"];
    const hb = new Array(6).fill(0);
    for (const sn of sessions) {
      const t = new Date(sn.startedAt); const ms = elapsed(sn, now);
      wd[(t.getDay() + 6) % 7] += ms;
      hb[Math.min(5, Math.floor(t.getHours() / 4))] += ms;
    }
    const topWd = wd.indexOf(Math.max(...wd)), topHb = hb.indexOf(Math.max(...hb));
    p2.appendChild(cols(WD.map((label, i) => ({ label, ms: wd[i], hot: i === topWd }))));
    p2.appendChild(el("h3", "p-lbl", "TIME OF DAY ・ 時間帯"));
    p2.appendChild(cols(HB.map((label, i) => ({ label, ms: hb[i], hot: i === topHb }))));
    const HBN = ["NIGHT", "DAWN", "MORNING", "AFTERNOON", "EVENING", "LATE"];
    p2.appendChild(el("div", "pd-note", `MOST ACTIVE: ${WD[topWd]} ・ ${HBN[topHb]}`));
  }
  pages.push(p2);

  // ── page 3: TREND — is it growing? ──
  const p3 = el("div", "");
  p3.appendChild(el("h3", "p-lbl", "TREND ・ 8 WEEKS"));
  if (sparse) {
    p3.appendChild(el("div", "pd-note", "not enough data yet ・ keep tracking"));
  } else {
    const weekStart = (ms: number) => {
      const w = new Date(ms); w.setHours(0, 0, 0, 0);
      w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
      return w.getTime();
    };
    const thisWk = weekStart(now);
    const WEEK = 7 * 24 * 3600 * 1000;
    const weeks = new Array(8).fill(0);
    for (const sn of sessions) {
      const idx = Math.round((thisWk - weekStart(sn.startedAt)) / WEEK);
      if (idx >= 0 && idx < 8) weeks[7 - idx] += elapsed(sn, now);
    }
    p3.appendChild(cols(weeks.map((ms, i) => ({ label: i === 7 ? "NOW" : `-${7 - i}W`, ms, hot: i === 7 }))));
    const delta = weeks[6] > 0 ? Math.round(((weeks[7] - weeks[6]) / weeks[6]) * 100) : null;
    p3.appendChild(el("div", "pd-note",
      delta === null ? "THIS WEEK (in progress)" : `THIS WEEK vs LAST: ${delta >= 0 ? "+" : ""}${delta}% (in progress)`));
  }
  pages.push(p3);

  // ── page 4: ALLOCATION — where the time goes, and where it's drifting ──
  const p4 = el("div", "");
  p4.appendChild(el("h3", "p-lbl", "ALLOCATION ・ 配分"));
  const wkStartMs = (() => { const w = new Date(now); w.setHours(0,0,0,0); w.setDate(w.getDate() - ((w.getDay() + 6) % 7)); return w.getTime(); })();
  const byCard = Stats.totalsByCard(sessions, cards, timers, now);
  const wkByCard = new Map<string, number>();
  for (const sn of sessions) if (sn.startedAt >= wkStartMs)
    wkByCard.set(sn.cardId, (wkByCard.get(sn.cardId) ?? 0) + elapsed(sn, now));
  if (!byCard.length) p4.appendChild(el("div", "pd-note", "no tracked time yet"));
  for (const c of byCard) {
    const pct = total ? Math.round((c.ms / total) * 100) : 0;
    const head = el("div", "bd-card-head");
    const bar = document.createElement("u"); const fill = document.createElement("i");
    fill.style.width = `${pct}%`; bar.appendChild(fill);
    head.append(el("span", "", c.name), bar, el("b", "", `${pct}% ・ wk ${shortDur(wkByCard.get(c.id) ?? 0)}`));
    p4.appendChild(head);
  }
  pages.push(p4);

  // ── pages 5+: the LOG, grouped by day, chunked ──
  const recents = Stats.recent(sessions, cards, timers, now, 60);
  const chunks: Array<typeof recents> = [];
  for (let i = 0; i < recents.length; i += 12) chunks.push(recents.slice(i, i + 12));
  if (!chunks.length) {
    const pl = el("div", "");
    pl.append(el("h3", "p-lbl", "SESSION LOG ・ 記録"), el("div", "pd-note", "no sessions yet"));
    pages.push(pl);
  }
  chunks.forEach((chunk, ci) => {
    const pl = el("div", "");
    pl.appendChild(el("h3", "p-lbl", `SESSION LOG ・ 記録 (${ci + 1}/${chunks.length})`));
    let lastDay = "";
    for (const r of chunk) {
      const day = isoDate(r.session.startedAt);
      if (day !== lastDay) { lastDay = day; pl.appendChild(el("div", "pd-day", day)); }
      const when = new Date(r.session.startedAt);
      const sub = el("div", "pd-sub");
      sub.append(
        el("span", "", `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}  ${r.cardName}/${r.timerName}`),
        el("span", "", fmtDuration(r.ms)),
      );
      pl.appendChild(sub);
    }
    pages.push(pl);
  });

  pdPageEls = pages;
  showPdPage(1);
}

// ── stats rendering ─────────────────────────────────────────────
function shortDur(ms: number): string {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

async function renderStats() {
  const { sessions, cards, timers, now } = await dev.statsData();
  const d = new Date(now);
  $("s-stamp").textContent = `${isoDate(now)}  ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const today = sessions.filter(sn => sn.startedAt >= dayStart.getTime())
    .sort((a, b) => a.startedAt - b.startedAt);
  const cardName = new Map(cards.map(c => [c.id, c.name]));
  const timerName = new Map(timers.map(t => [t.id, t.name]));

  // today's sessions are the receipt's LINE ITEMS
  const items = $("s-items"); items.innerHTML = "";
  for (const sn of today) {
    const li = el("li", "recent-item");
    li.append(el("span", "", `${cardName.get(sn.cardId) ?? sn.cardId} / ${timerName.get(sn.timerId) ?? "(deleted)"}`),
              el("span", "r-ms", fmtDuration(elapsed(sn, now))));
    items.appendChild(li);
  }
  // a live run is on the tape too, marked — the receipt must agree with the LCD
  const v = await dev.view();
  const live = v.card && v.timer && (v.state === "running" || v.state === "paused" || v.state === "finished")
    ? v.elapsedMs : 0;
  if (live) {
    const li = el("li", "recent-item r-live");
    li.append(el("span", "", `▸ ${v.card!.name} / ${v.timer!.name} (running)`),
              el("span", "r-ms", fmtDuration(live)));
    items.appendChild(li);
  }
  if (!today.length && !live) items.appendChild(el("li", "stats-empty", "no sessions yet today"));

  $("s-count").textContent = String(today.length + (live ? 1 : 0));
  const totalToday = today.reduce((a, sn) => a + elapsed(sn, now), 0) + live;
  $("s-total").textContent = fmtDuration(totalToday);

  // BY CARD — today only
  const bd = $("s-breakdown"); bd.innerHTML = "";
  const perCard = new Map<string, number>();
  for (const sn of today) perCard.set(sn.cardId, (perCard.get(sn.cardId) ?? 0) + elapsed(sn, now));
  if (live && v.card) perCard.set(v.card.id, (perCard.get(v.card.id) ?? 0) + live);
  const rows = [...perCard.entries()].sort((a, b) => b[1] - a[1]);
  if (!rows.length) bd.appendChild(el("div", "stats-empty", "—"));
  const maxCard = rows[0]?.[1] || 1;
  for (const [cid, ms] of rows) {
    const head = el("div", "bd-card-head");
    const bar = document.createElement("u"); const fill = document.createElement("i");
    fill.style.width = `${Math.round((ms / maxCard) * 100)}%`; bar.appendChild(fill);
    head.append(el("span", "", cardName.get(cid) ?? cid), bar, el("b", "", shortDur(ms)));
    bd.appendChild(head);
  }

  // context strip: the 14-day bars
  const chart = $("s-chart"); chart.innerHTML = "";
  const days = Stats.byDay(sessions, now, 14);
  const maxDay = Math.max(1, ...days.map(x => x.ms));
  const todayKey = days[days.length - 1].day;
  for (const x of days) {
    const bar = document.createElement("i");
    bar.style.height = `${Math.round((x.ms / maxDay) * 100)}%`;
    if (x.day === todayKey) bar.className = "hot";
    chart.appendChild(bar);
  }

  // the loyalty line
  const st = Stats.streaks(sessions, now);
  $("s-loyalty").textContent = `STREAK ${st.current} DAYS 🔥 ・ BEST ${st.longest}`;
}

// ── device tick: re-render 10×/sec so a running/finished readout advances ──
// (a printed report is a frozen snapshot — it never re-renders; the device below
// the paper keeps ticking, as a real appliance would). This handles the countdown
// seconds and all state; the count-up HUNDREDTHS are driven by rAF below.
//
// It reads the CACHED state rather than querying storage: asking "is anything
// running?" cost three IndexedDB transactions, and renderDevice then asked the same
// question again — 60 transactions/second while running, and 30/second forever on an
// idle page left open all day. Every action ends in renderDevice/renderAll, so the
// cache can only be stale in one direction: running → finished, which is polled.
setInterval(() => {
  if (lastState !== "running" && lastState !== "finished") return;   // idle: stay quiet
  renderDevice();
}, 100);

// Any real gesture is a chance to un-suspend the audio hardware (browsers only let
// us resume from one). Capture phase so a handler that stops propagation can't hide it.
document.addEventListener("pointerdown", () => { audioCtx?.resume().catch(() => {}); }, { capture: true });

// Coming back to the tab: hidden tabs clamp setInterval to ~1/sec, so a countdown
// that ended while away should be shown — and rung — the instant we're looked at again.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  audioCtx?.resume().catch(() => {});
  renderDevice();
});

// ── the stopwatch's hundredths, at display refresh rate ──
// Recompute elapsed with the engine's exact formula from the cached live session,
// so the centiseconds run smoothly instead of jumping in ~10-step increments. The
// loop parks itself when no stopwatch is running; renderDevice restarts it.
function readoutFrame() {
  if (!liveUpSession) { rafId = 0; return; }
  setReadout(fmtDuration(elapsed(liveUpSession, Date.now()), true));
  rafId = requestAnimationFrame(readoutFrame);
}

// First paint. If storage itself is unavailable (private browsing, a blocked
// IndexedDB, an evicted origin) the app would otherwise sit as a half-built machine
// with no explanation — say so on the LCD, where the user is already looking.
try {
  await renderAll();
} catch (e) {
  console.error("timecards: storage unavailable", e);
  elCardName.textContent = "— NO CARD —"; elCardName.classList.add("empty");
  setReadout("--:--");
  elSub.textContent = "storage unavailable ・ private browsing?";
  elBig.disabled = true; elFinish.disabled = elReset.disabled = true;
}
