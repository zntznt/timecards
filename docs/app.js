// Web app: wires the DOM to the shared core. Big button, readout, deck of cards,
// and — within a slotted card — its list of timers (switch suspends/resumes).
// Same Device + timer logic as the CLI; only the storage adapter (IndexedDB) differs.

import { Device } from "./core/device.js";
import { IdbStore } from "./idb-store.js";
import { SupabaseStore } from "./core/supabase-store.js";
import { fmtDuration } from "./core/format.js";
import { bigButtonAction, elapsed } from "./core/timer.js";
import { MAX_TIMERS } from "./core/types.js";
import * as Stats from "./core/stats.js";
                                                                                                                     

// Backend selection: if the user saved Supabase creds (settings ⚙), sync there;
// otherwise keep data in this browser's IndexedDB. Opt-in — IDB is the default.
async function makeStore()                   {
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

const $ =                        (id        ) => document.getElementById(id)     ;
const elDevice = $("device");
const elCardName = $("card-name");
const elTimerName = $("timer-name");
const elDayCount = $("daycount");
const elReadout = $("readout");
const elSub = $("sub");
const elBig = $                   ("big-button");
const elBigLabel = $("big-label");
const elStop = $                   ("stop");
const elFinish = $                   ("finish");
const elReset = $                   ("reset");
const elEject = $                   ("eject");
const elLock = $                   ("lock-toggle");
const elTimers = $("timers");
const elTimerList = $("timer-list");
const elAddTimer = $                   ("add-timer");
const elList = $("card-list");
const elCardEditor = $                   ("card-editor");
const elTimerEditor = $                   ("timer-editor");

const GLYPH                         = { start: "▶", pause: "❚❚", resume: "▶", noop: "●" };
const WORD                         = { start: "START", pause: "PAUSE", resume: "RESUME", noop: "—" };
const elGhost = $("readout-ghost");
const elBigWord = $("big-word");

/** Drive the LCD digits + the all-segments-on ghost behind them. */
function setReadout(txt        ) {
  elReadout.textContent = txt;
  elGhost.textContent = txt.replace(/[0-9]/g, "8");
}

/** The LCD lamp row: each lamp lights (●/○ + color) from the real state. */
function setLamps(state        , locked         , alarmStyle         ) {
  const on = (id        , lit         , litTxt        , dimTxt        ) => {
    const el = $(id); el.classList.toggle("on", lit); el.textContent = lit ? litTxt : dimTxt;
  };
  on("lamp-run", state === "running", "●RUN", "○RUN");
  on("lamp-pause", state === "paused", "●PAUSE", "○PAUSE");
  on("lamp-done", state === "finished", "●DONE", "○DONE");
  // the lamp names the alarm STYLE, like the mock's ♪CHIME
  const alarmTxt = alarmStyle === "blip" ? "♪BLIP" : alarmStyle === "silent" ? "ALARM OFF" : "♪CHIME";
  on("lamp-alarm", state === "finished" && alarmStyle !== "silent", alarmTxt, alarmTxt);
  on("lamp-lock", locked, "🔒LOCK", "○LOCK");
}

// ── alarm (WebAudio) ────────────────────────────────────────────
let audioCtx                      = null;
function beep(freq        , durMs        , when = 0) {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window       ).webkitAudioContext)();
  const ctx = audioCtx;
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
function playAlarm(style            ) {
  if (style === "silent") return;
  if (style === "blip") { beep(880, 90); return; }
  beep(660, 180, 0); beep(880, 180, 0.2); beep(1175, 320, 0.42);
}
// ── printer sounds (from the mock): key click, dot-matrix chatter, tear ──
function tone(freq        , dur        , type                 = "square", gain = 0.18, slideTo         ) {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window       ).webkitAudioContext)();
  const c = audioCtx, t = c.currentTime, o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
}
function noiseClick(dur = 0.03, gain = 0.25) {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window       ).webkitAudioContext)();
  const c = audioCtx, n = c.createBufferSource(), buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
  n.buffer = buf;
  const g = c.createGain(); g.gain.value = gain;
  const f = c.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 1400;
  n.connect(f).connect(g).connect(c.destination); n.start();
}
const sndClick = () => { noiseClick(0.025, 0.22); tone(220, 0.04, "square", 0.12); };
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
  if (!audioCtx) audioCtx = new (window.AudioContext || (window       ).webkitAudioContext)();
  const c = audioCtx, t = c.currentTime;
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
let alarmedFor                = null; // timerId:sessionId we've already alarmed
let lastChimeAt = 0;                  // last time the ringing chime re-played
const CHIME_EVERY_MS = 5_000;         // chime begs until acknowledged; blip stays a one-shot nudge

// ── render ──────────────────────────────────────────────────────
async function renderDevice() {
  const v           = await dev.view();
  elDevice.className = v.state + (v.locked ? " is-locked" : "");
  elLock.textContent = v.locked ? "🔒" : "🔓";

  if (v.dayCount) {
    const d = v.dayCount;
    elDayCount.hidden = false;
    elDayCount.className = "daycount" + (d.passed ? " passed" : d.kind === "since" ? " streak" : "");
    elDayCount.textContent = d.kind === "until"
      ? (d.passed ? "⏰ deadline passed" : `⏰ ${d.days} day${d.days === 1 ? "" : "s"} left`)
      : `🔥 day ${d.days}`;
  } else elDayCount.hidden = true;

  setLamps(v.state, v.locked, v.alarmStyle);

  if (v.state === "empty") {
    elCardName.textContent = "— NO CARD —"; elCardName.classList.add("empty");
    elTimerName.textContent = "—";
    setReadout("--:--");
    elSub.textContent = "⏏ ejected ・ insert a card";
    elBigLabel.textContent = "●"; elBigWord.textContent = "—";
    elBig.disabled = true; elStop.disabled = elFinish.disabled = elReset.disabled = elEject.disabled = true;
    elTimers.hidden = true;
    return;
  }
  elCardName.classList.remove("empty");
  elCardName.textContent = v.card .name;
  elEject.disabled = v.locked; // the lock holds the card in
  elTimers.hidden = false;
  renderTimerList(v);

  // No timer selected (card has none): prompt to add one.
  if (!v.timer) {
    elTimerName.textContent = "no timers yet";
    setReadout("--:--");
    elSub.textContent = "add a timer to begin";
    elBigLabel.textContent = "●"; elBigWord.textContent = "—";
    elBig.disabled = true; elStop.disabled = elFinish.disabled = elReset.disabled = true;
    return;
  }
  // The LCD's mode line reads the direction of time, like the mock ("COUNTDOWN ▼");
  // the active timer's NAME lives on the lit rack row below.
  elTimerName.innerHTML = v.timer.mode === "down" ? "COUNTDOWN <b>▼</b>" : "STOPWATCH <b>▲</b>";
  // When finished, the big button stays active and REPEATS the round (press()).
  elBig.disabled = v.locked;

  if (v.mode === "down" && v.remainingMs !== null) setReadout(fmtDuration(v.remainingMs));
  else if (v.mode === "up") setReadout(fmtDuration(v.elapsedMs, true));
  else setReadout(v.timer.mode === "down" && v.timer.targetMs ? fmtDuration(v.timer.targetMs) : "00:00");

  elBigLabel.textContent = v.state === "finished" ? "↻" : (GLYPH[bigButtonAction(v.state)] ?? "●");
  // The label tells the truth about THIS press (mock review C1/U10: no static START/STOP lie).
  elBigWord.textContent = v.state === "finished" ? "REPEAT" : (WORD[bigButtonAction(v.state)] ?? "—");

  // stop = freeze a RUNNING timer; finish = bank any live run to history;
  // reset = discard any live run (running/paused/finished).
  const hasRun = v.state === "running" || v.state === "paused" || v.state === "finished";
  elStop.disabled = v.locked || v.state !== "running";
  elFinish.disabled = v.locked || !hasRun;
  elReset.disabled = v.locked || !hasRun;

  if (v.state === "ready") { elSub.textContent = "press to start"; }
  else if (v.state === "running") { elSub.textContent = v.mode === "down" ? "▾ counting down" : "▴ counting up"; }
  else if (v.state === "paused") { elSub.textContent = "❚❚ paused"; }
  else if (v.state === "finished") {
    elSub.textContent = "time's up, round saved · press ↻ to repeat · reset to clear";
    const key = v.timer.id + ":" + (v.timer.liveSession?.id ?? "");
    if (alarmedFor !== key) { alarmedFor = key; lastChimeAt = Date.now(); playAlarm(v.alarmStyle); }
    else if (v.alarmStyle === "chime" && Date.now() - lastChimeAt >= CHIME_EVERY_MS) {
      lastChimeAt = Date.now(); playAlarm("chime"); // the tick loop re-renders while finished, so this re-begs
    }
  }
}

function renderTimerList(v          ) {
  elTimerList.innerHTML = "";
  elAddTimer.disabled = v.timers.length >= MAX_TIMERS;
  elAddTimer.title = elAddTimer.disabled ? `max ${MAX_TIMERS} timers` : "add a timer";
  $("rack-count").textContent = `${String(v.timers.length).padStart(2, "0")} / ${MAX_TIMERS}`;
  if (v.timers.length === 0) {
    const li = document.createElement("li");
    li.className = "timers-empty";
    li.textContent = "no timers — add one to start tracking";
    elTimerList.appendChild(li);
    return;
  }
  for (const t of v.timers) elTimerList.appendChild(timerRow(t, v.timer?.id ?? null));
}

function timerRow(t       , activeId               )                {
  const li = document.createElement("li");
  li.className = "timer-row" + (t.id === activeId ? " active" : "");
  const led = document.createElement("span"); led.className = "t-led"; // lit by CSS on .active
  const nm = document.createElement("span"); nm.className = "t-nm"; nm.textContent = t.name;
  const cfg = document.createElement("span"); cfg.className = "t-cfg";
  cfg.textContent = t.mode === "down" && t.targetMs ? fmtDuration(t.targetMs) : "stopwatch";
  const live = document.createElement("span");
  if (t.liveSession) {
    const held = t.liveSession.pausedAt !== null;
    live.className = "t-live " + (held ? "held" : "run");
    live.textContent = held ? "⏸" : "▶";
  }
  const edit = document.createElement("button");
  edit.className = "t-del"; edit.textContent = "✎"; edit.title = "edit timer";
  edit.onclick = (e) => { e.stopPropagation(); openTimerEditor(t.cardId, t); };
  const del = document.createElement("button");
  del.className = "t-del"; del.textContent = "✕"; del.title = "delete timer";
  del.onclick = async (e) => {
    e.stopPropagation();
    if (confirm(`Delete timer "${t.name}"? Its time is saved to history.`)) { await dev.deleteTimer(t.id); await renderAll(); }
  };
  li.onclick = async () => { await dev.switchTimer(t.id); await renderAll(); };
  li.append(led, nm, cfg, live, edit, del);
  return li;
}

// Cards flip like the physical stickers they are: TAP turns a card over to its
// documentary back (this card's stats); the pocket's SLOT tab inserts it.
const flippedCards = new Set        ();
const FOILS = ["foil-prism", "foil-gold", "foil-holo", "foil-emerald", "foil-violet"];
function foilFor(id        )         { // stable per-card foil treatment
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0) ) | 0;
  return FOILS[Math.abs(h) % FOILS.length];
}
function rarityFor(totalMs        )         { // cards level up with tracked time
  return totalMs >= 36_000_000 ? "★★★" : totalMs >= 3_600_000 ? "★★☆" : "★☆☆";
}
const el = (tag        , cls        , text         ) => {
  const e = document.createElement(tag); e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const elBinderPage = document.querySelector(".binder__page")               ;

// fill the bench remainder with EMPTY welded sleeves so the page reads as a real
// binder page with open pockets; the LAST empty sleeve is the "+ add" one (the mock's
// card-creation entry point).
function fillEmptySleeves() {
  elList.querySelectorAll(".pocket--empty").forEach(p => p.remove());
  const POCKET_W = 262;
  const realCount = elList.querySelectorAll(".pocket").length;
  const fit = Math.ceil(elBinderPage.clientWidth / POCKET_W) + 1;
  const need = Math.max(1, fit - realCount);
  for (let i = 0; i < need; i++) {
    const empty = el("li", "pocket pocket--empty" + (i === need - 1 ? " pocket--add" : ""));
    empty.append(el("span", "pocket__ring"), el("span", "pocket__weld-b"), el("span", "pocket__lip"));
    if (i === need - 1) { empty.title = "new card"; empty.onclick = () => { sndClick(); openCardEditor(null); }; }
    elList.appendChild(empty);
  }
}
window.addEventListener("resize", fillEmptySleeves);

async function renderDeck() {
  const cards = await dev.listCards();
  const active = (await dev.view()).card?.id ?? null;
  const { sessions, now } = await dev.statsData();
  // a card portaled to <body> mid-gesture belongs to the OLD render — clear it
  document.querySelectorAll("body > .card").forEach(c => c.remove());
  elList.innerHTML = "";
  for (let i = 0; i < cards.length; i++) {
    elList.appendChild(await cardItem(cards[i], active, i, sessions, now));
  }
  fillEmptySleeves();
}

async function cardItem(c      , active               , index        , sessions           , now        )                         {
  const timers = await dev.listTimers(c.id);
  const mine = sessions.filter(s => s.cardId === c.id);
  const total = mine.reduce((sum, s) => sum + elapsed(s, now), 0);
  const longest = mine.reduce((max, s) => Math.max(max, elapsed(s, now)), 0);
  const since = mine.length ? isoDate(Math.min(...mine.map(s => s.startedAt))) : "—";
  const perTimer = new Map                ();
  for (const s of mine) perTimer.set(s.timerId, (perTimer.get(s.timerId) ?? 0) + elapsed(s, now));

  const stars = rarityFor(total);
  const no = String(index + 1).padStart(3, "0");
  const series = (c.category ?? "SER.01").toUpperCase().slice(0, 10);
  const inUse = c.id === active;

  const li = el("li", `pocket ${foilFor(c.id)}` + (inUse ? " in-use" : ""))                 ;
  li.append(el("span", "pocket__ring"), el("span", "pocket__weld-b"), el("span", "pocket__lip"));

  // the pocket tab: SLOT inserts; the slotted pocket wears IN USE (mock review U14/D4)
  const tab = el("button", "pocket-tab", inUse ? "IN USE ・ 使用中" : "SLOT ・ 挿入")                     ;
  tab.disabled = inUse;
  tab.onclick = async (e) => { e.stopPropagation(); if (!inUse) await slotCard(c.id); };

  // .card = the drag/positioning wrapper (portaled to <body> mid-gesture, like the mock)
  const card = el("div", "card" + (flippedCards.has(c.id) ? " flipped resting" : ""));
  card.dataset.cardId = c.id;
  const card3d = el("div", "card-3d");
  card3d.style.setProperty("--cat", c.color || "#6f7457");

  // ── FRONT: the Bikkuriman sticker ──
  const front = el("div", "card-face front");
  front.appendChild(el("span", "foil"));

  const rank = el("div", "card-rank");
  rank.append(el("span", "rarity", stars), el("span", "card-series", series));
  const noEl = el("span", "card-no");
  noEl.append(el("span", "l", "No."), el("span", "n", no));
  rank.appendChild(noEl);

  const art = el("div", "card-art");
  const emblem = el("div", "card-emblem", [...c.name][0]?.toUpperCase() ?? "★");
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
  cbId.append(el("span", "", `${series} ・ No.${no}`), el("span", "cb-rank", stars));
  const nameRow = el("div", "cb-name-row");
  nameRow.append(el("div", "cb-name", c.name),
    el("span", "cb-seal", (c.deadlineKind === "since" && c.deadline) ? "STREAK" : c.deadline ? "DEADLINE" : "TIMER"));
  const ledger = el("div", "cb-ledger");
  const row = (label        , value        , cls = "cb-row") => {
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

  const actions = el("div", "card-actions");
  const edit = el("button", "card-edit", "✎")                     ;
  edit.title = "edit card";
  edit.onclick = (e) => { e.stopPropagation(); openCardEditor(c); };
  const del = el("button", "card-del", "✕")                     ;
  del.title = "delete card";
  del.onclick = async (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${c.name}", its timers, and history?`)) { await dev.deleteCard(c.id); await renderAll(); }
  };
  actions.append(edit, del);

  // taps and drags on the card are handled by the unified pointer gesture (below)
  card.appendChild(card3d);
  li.append(tab, card, actions);
  return li;
}

async function renderAll() { await renderDevice(); await renderDeck(); }

/** Slot a card into the device: thunk + the LCD wakes with a flicker (the mock's insert).
 *  No card may be left showing its reverse or lifted out of its pocket. */
async function slotCard(cardId        ) {
  document.querySelectorAll             (".card.flipped, .card.airborne, .card.resting").forEach(resetCard);
  flippedCards.clear();
  sndThunk();
  await dev.slot(cardId);
  await renderAll();
  const lcd = document.querySelector(".lcd") ;
  lcd.classList.remove("waking"); void (lcd               ).offsetWidth; lcd.classList.add("waking");
}

// ── CARD GESTURES (the mock's, faithfully): a tap FLIPS the card over in a
// three-beat lift→turn→settle; a mostly-UPWARD drag picks it up to drop on the
// device; a horizontal move is left to the bench's native scroll. ──────────────
const LIFT_GAP = 12;   // px of daylight above the binder while flipping
const elBinder = $("deck");

// REVIEW U2/U3: never trust transitionend as the only clock — a skipped or canceled
// transition (reduced motion, interrupt) never fires it. Race a timeout.
function onTopEnd(card             , fn            ) {
  let done = false;
  const go = () => { if (!done) { done = true; card.removeEventListener("transitionend", h); fn(); } };
  const h = (e                 ) => { if (e.target === card && e.propertyName === "top") go(); };
  card.addEventListener("transitionend", h);
  setTimeout(go, 320);
}
function onFlipEnd(card             , fn            ) {
  let done = false;
  const go = () => { if (!done) { done = true; fn(); } };
  card.querySelector(".card-3d") .addEventListener("transitionend", go, { once: true });
  setTimeout(go, 380);
}

// pin the card at its on-screen spot in viewport-fixed coords. PORTAL to <body> first:
// the binder row's perspective forms a containing block that would trap position:fixed.
function pin(card             )          {
  const pocket = card.closest(".pocket")               ;
  const r = card.getBoundingClientRect();
  (card       )._homePocket = pocket;
  pocket.classList.add("bn-lent");              // hold the sleeve open while the card is away
  card.classList.add("airborne");
  card.style.left = r.left + "px";
  card.style.width = r.width + "px";
  card.style.top = r.top + "px";
  document.body.appendChild(card);
  void card.offsetWidth;                        // flush layout so the next `top` animates
  return r;
}
function unpin(card             ) {
  card.classList.remove("airborne");
  card.style.left = card.style.width = card.style.top = "";
  const home = (card       )._homePocket                      ;
  if (home) {
    home.classList.remove("bn-lent");
    home.appendChild(card);
    (card       )._homePocket = null;
  }
}
function restInPocket(card             ) { unpin(card); card.classList.add("resting"); }
function resetCard(card             ) {
  card.classList.remove("flipped", "flipping", "dragging", "resting");
  if (card.dataset.cardId) flippedCards.delete(card.dataset.cardId);
  delete card.dataset.busy;
  if (card.classList.contains("airborne") || (card       )._homePocket) unpin(card);
  else {
    card.closest(".pocket")?.classList.remove("bn-lent");
    card.style.left = card.style.width = card.style.top = "";
  }
}

function flipCard(card             ) {
  if (card.dataset.busy) return;
  const toBack = !card.classList.contains("flipped");
  card.dataset.busy = "1";
  elList.classList.add("cards--flipping");
  const pocket = card.closest(".pocket")               ;
  card.classList.remove("resting");
  const r = pin(card);
  const liftTop = elBinder.getBoundingClientRect().top - r.height - LIFT_GAP;
  const id = card.dataset.cardId ;
  const settle = (after            ) => {
    card.style.top = (pocket.getBoundingClientRect().top + 6) + "px";
    onTopEnd(card, () => { after(); delete card.dataset.busy; elList.classList.remove("cards--flipping"); });
  };
  requestAnimationFrame(() => { card.style.top = liftTop + "px"; });   // beat 1: lift out
  onTopEnd(card, () => {
    sndFlip();                                                          // beat 2: flip mid-air
    card.classList.toggle("flipped", toBack);
    if (toBack) flippedCards.add(id); else flippedCards.delete(id);
    onFlipEnd(card, () => {
      settle(() => { if (toBack) restInPocket(card); else unpin(card); });   // beat 3: settle
    });
  });
}

// UNIFIED POINTER DRAG — touch AND mouse. Press that moves mostly UP = pick the card
// up; mostly horizontal = bench scroll; barely moves = tap → flip.
const DRAG_THRESH = 8;
let drag                                                                         
                                                                                   = null;

document.addEventListener("pointerdown", (e) => {
  const card = (e.target               ).closest(".card")                      ;
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
    startCardDrag(e);
  }
  if (drag?.active) { e.preventDefault(); moveCardTo(e.clientX, e.clientY); }
}, { passive: false });
document.addEventListener("pointerup", async (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag; drag = null;
  if (d.active) {
    const id = d.card.dataset.cardId ;
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

function startCardDrag(e              ) {
  const card = drag .card;
  resetCard(card);                     // snap to front-up, un-portal any flip state
  drag .active = true;
  const r = card.getBoundingClientRect();
  drag .offX = e.clientX - r.left; drag .offY = e.clientY - r.top;
  (card       )._dragHome = card.closest(".pocket");
  (card       )._dragHome?.classList.add("bn-lent");
  card.style.width = r.width + "px";
  card.classList.add("dragging");
  document.body.appendChild(card);
  try { (card       ).setPointerCapture?.(e.pointerId); } catch {}
  moveCardTo(e.clientX, e.clientY);
}
function moveCardTo(x        , y        ) {
  drag .card.style.left = (x - drag .offX ) + "px";
  drag .card.style.top = (y - drag .offY ) + "px";
}
// the WHOLE device is the drop zone — drop a card anywhere on it to load it
function overDevice(x        , y        )          {
  const r = elDevice.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
function endCardDrag(card             ) {
  card.classList.remove("dragging");
  card.style.left = card.style.width = card.style.top = "";
  const home = (card       )._dragHome                      ;
  home?.classList.remove("bn-lent");
  home?.appendChild(card);
  (card       )._dragHome = null;
}
// a card mid-FLIGHT is position:fixed; keep it aligned to its pocket if the bench scrolls
elBinderPage.addEventListener("scroll", () => {
  document.querySelectorAll             (".card.airborne").forEach(card => {
    const home = (card       )._homePocket                      ;
    if (home) card.style.left = (home.getBoundingClientRect().left + 6) + "px";
  });
}, { passive: true });

// ── device interactions (each key clicks like the mock's) ───────
elBig.onclick = async () => { sndClick(); await dev.press(); await renderAll(); };
elStop.onclick = async () => { sndClick(); await dev.stop(); await renderAll(); };          // freeze & keep
elFinish.onclick = async () => { sndClick(); alarmedFor = null; await dev.finish(); await renderAll(); }; // bank to history
elReset.onclick = async () => { sndClick(); alarmedFor = null; await dev.reset(); await renderAll(); }; // discard
elEject.onclick = async () => { sndEject(); await dev.eject(); await renderAll(); };
elLock.onclick = async () => { sndClick(); await dev.lock(); await renderDevice(); };

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLSelectElement) && !elCardEditor.open && !elTimerEditor.open) {
    e.preventDefault(); elBig.click();
  }
});

// ── card editor ─────────────────────────────────────────────────
let editingCardId                = null;

function openCardEditor(card             ) {
  editingCardId = card?.id ?? null;
  $("card-title").textContent = card ? "Edit card" : "New card";
  $                  ("c-name").value = card?.name ?? "";
  $                  ("c-category").value = card?.category ?? "";
  $                  ("c-color").value = card?.color ?? "#6f7457";
  $                  ("c-deadline").value = card?.deadline ? isoDate(card.deadline) : "";
  const dk = card?.deadlineKind ?? "until";
  (elCardEditor.querySelector(`input[name=dkind][value=${dk}]`)                    ).checked = true;
  elCardEditor.showModal();
}
$("card-cancel").onclick = () => elCardEditor.close();
$                 ("card-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $                  ("c-name").value.trim();
  if (!name) return;
  const category = $                  ("c-category").value.trim() || null;
  const color = $                  ("c-color").value;
  const dateStr = $                  ("c-deadline").value;
  const deadline = dateStr ? new Date(dateStr + "T00:00").getTime() : null;
  const deadlineKind = (elCardEditor.querySelector("input[name=dkind]:checked")                    ).value                ;
  if (editingCardId) {
    await dev.renameCard(editingCardId, name);
    await dev.configureCard(editingCardId, { category, color, deadline, deadlineKind });
  } else {
    const c = await dev.createCard(name, { category: category ?? undefined, color });
    if (deadline) await dev.configureCard(c.id, { deadline, deadlineKind });
    await dev.slot(c.id); // slot the new card so its timers are visible
  }
  elCardEditor.close();
  await renderAll();
};

// ── timer editor ────────────────────────────────────────────────
let editingTimerId                = null;
let timerEditorCardId                = null;

elAddTimer.onclick = async () => {
  const cardId = (await dev.view()).card?.id;
  if (cardId) openTimerEditor(cardId, null);
};

// Bounded H:M:S entry — discrete units like the physical device, no free text.
const elH = $                  ("t-h"), elM = $                  ("t-m"), elS = $                  ("t-s");
const elDurFields = $("dur-fields");

/** Read + clamp the H:M:S inputs to ms. Empty fields count as 0. */
function readDurationMs()         {
  const clamp = (el                  , max        ) => {
    let n = Math.floor(Number(el.value));
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (n > max) { n = max; el.value = String(max); }  // visibly enforce the ceiling
    return n;
  };
  const h = clamp(elH, 23), m = clamp(elM, 59), s = clamp(elS, 59);
  return ((h * 60 + m) * 60 + s) * 1000;
}

/** Write ms back into the H:M:S inputs. */
function writeDurationMs(ms               ) {
  const total = Math.floor((ms ?? 0) / 1000);
  elH.value = ms ? String(Math.floor(total / 3600)) : "";
  elM.value = ms ? String(Math.floor((total % 3600) / 60)) : "";
  elS.value = ms ? String(total % 60) : "";
}

/** Grey out the H:M:S fields unless Countdown is selected. */
function syncTimerModeUI() {
  const down = (elTimerEditor.querySelector("input[name=tmode]:checked")                    )?.value === "down";
  elDurFields.classList.toggle("disabled", !down);
}

// Picking a mode radio updates the fields' look.
elTimerEditor.querySelectorAll                  ("input[name=tmode]").forEach(r => {
  r.addEventListener("change", syncTimerModeUI);
});
// Editing any H:M:S field clearly means "countdown" — auto-select it, and clamp live.
for (const el of [elH, elM, elS]) {
  el.addEventListener("input", () => {
    (elTimerEditor.querySelector("input[name=tmode][value=down]")                    ).checked = true;
    syncTimerModeUI();
  });
  el.addEventListener("blur", () => readDurationMs());  // clamp to bounds on leaving a field
}

function openTimerEditor(cardId        , timer              ) {
  timerEditorCardId = cardId;
  editingTimerId = timer?.id ?? null;
  $("timer-title").textContent = timer ? "Edit timer" : "New timer";
  $                  ("t-name").value = timer?.name ?? "";
  const mode = timer?.mode ?? "up";
  (elTimerEditor.querySelector(`input[name=tmode][value=${mode}]`)                    ).checked = true;
  writeDurationMs(timer?.targetMs ?? null);
  $                   ("t-alarm").value = timer?.alarmStyle ?? "chime";
  syncTimerModeUI();
  elTimerEditor.showModal();
}
$("timer-cancel").onclick = () => elTimerEditor.close();
$                 ("timer-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $                  ("t-name").value.trim();
  const targetMs = readDurationMs();
  // Intent: a non-zero H:M:S IS a countdown, whatever the radio says — a set length
  // can never be silently discarded as a stopwatch.
  const radioMode = (elTimerEditor.querySelector("input[name=tmode]:checked")                    ).value             ;
  const mode            = targetMs > 0 ? "down" : radioMode === "down" ? "down" : "up";
  const finalTarget = mode === "down" ? targetMs : null;
  const alarmStyle = $                   ("t-alarm").value              ;
  if (mode === "down" && !finalTarget) { alert("Set a countdown length greater than zero (h / m / s)."); return; }
  if (editingTimerId) {
    await dev.configureTimer(editingTimerId, { name: name || undefined, mode, targetMs: finalTarget, alarmStyle });
  } else if (timerEditorCardId) {
    try {
      const t = await dev.addTimer(timerEditorCardId, { name, mode, targetMs: finalTarget, alarmStyle });
      await dev.switchTimer(t.id); // make the new timer active
    } catch (err) { alert(String(err instanceof Error ? err.message : err)); }
  }
  elTimerEditor.close();
  await renderAll();
};

// ── settings: Supabase sync (printed onto the settings sheet) ───
function fillSettings() {
  $                  ("sb-url").value = localStorage.getItem("tc_sb_url") ?? "";
  $                  ("sb-key").value = localStorage.getItem("tc_sb_key") ?? "";
  $("sb-status").textContent = localStorage.getItem("tc_sb_url")
    ? "CURRENTLY SYNCING TO SUPABASE."
    : "CURRENTLY LOCAL ONLY (THIS BROWSER).";
}
$("sb-clear").onclick = () => {
  localStorage.removeItem("tc_sb_url");
  localStorage.removeItem("tc_sb_key");
  location.reload();   // re-init with IndexedDB
};
$                 ("settings-form").onsubmit = (e) => {
  e.preventDefault();
  const url = $                  ("sb-url").value.trim();
  const key = $                  ("sb-key").value.trim();
  if (url && key) { localStorage.setItem("tc_sb_url", url); localStorage.setItem("tc_sb_key", key); }
  else { localStorage.removeItem("tc_sb_url"); localStorage.removeItem("tc_sb_key"); }
  location.reload();   // re-init with the chosen backend
};

function isoDate(ms        )         {
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
const elStub = elPrinter.querySelector(".pr-stub")               ;
                                       
let paperOut                   = null;
let printBusy = false;
const paperEl = (k           ) => (k === "report" ? elPaperReport : elPaperSettings);
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function randTilt()         { // a cut sheet drifts with a small random tilt — light paper
  const deg = 2 + Math.random() * 4;
  return (Math.random() < 0.5 ? -deg : deg).toFixed(2) + "deg";
}
function feedStubBack(done            ) {
  elPrinter.classList.remove("paper-is-out");
  if (reducedMotion()) { done(); return; }
  elStub.classList.remove("feeding"); void elStub.offsetWidth; elStub.classList.add("feeding");
  sndPrint();
  elStub.addEventListener("animationend", () => { elStub.classList.remove("feeding"); done(); }, { once: true });
}
async function printPaper(kind           ) {
  printBusy = true;
  if (kind === "report") await renderStats();     // freeze the data onto the paper NOW
  else fillSettings();
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
function pressPrintKey(kind           ) {
  sndClick();
  if (printBusy) return;              // mid print/cut/feed — ignore
  if (paperOut) { cutPaper(); return; }   // a paper is out → cut it, whichever key
  printPaper(kind);
}
$("print-report").onclick = () => pressPrintKey("report");
$("print-settings").onclick = () => pressPrintKey("settings");
// the printed ✂ CUT buttons on the papers themselves
document.querySelectorAll                   ("[data-cut]").forEach(b => {
  b.onclick = () => { if (!printBusy && paperOut) cutPaper(); };
});

// ── stats rendering ─────────────────────────────────────────────
function shortDur(ms        )         {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

async function renderStats() {
  const { sessions, cards, timers, now } = await dev.statsData();
  const d = new Date(now);
  $("s-stamp").textContent = `${isoDate(now)}  ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  $("s-total").textContent = shortDur(Stats.totalMs(sessions, now));
  const st = Stats.streaks(sessions, now);
  $("s-streak").textContent = String(st.current);
  $("s-longest").textContent = String(st.longest);
  $("s-active").textContent = String(st.activeDays);

  // Day chart — the mock receipt's 14 vertical dotted-ink bars, today in amber.
  const chart = $("s-chart"); chart.innerHTML = "";
  const days = Stats.byDay(sessions, now, 14);
  const maxDay = Math.max(1, ...days.map(d => d.ms));
  const todayKey = days[days.length - 1].day;
  for (const d of days) {
    const bar = document.createElement("i");
    bar.style.height = `${Math.round((d.ms / maxDay) * 100)}%`;
    if (d.day === todayKey) bar.className = "hot";
    chart.appendChild(bar);
  }

  // Breakdown by card → timer.
  const bd = $("s-breakdown"); bd.innerHTML = "";
  const byCard = Stats.totalsByCard(sessions, cards, timers, now);
  if (byCard.length === 0) {
    bd.innerHTML = `<div class="stats-empty">no tracked time yet — start a timer!</div>`;
  } else {
    const maxCard = byCard[0].ms || 1;
    for (const c of byCard) {
      const block = document.createElement("div"); block.className = "bd-card";
      const head = document.createElement("div"); head.className = "bd-card-head";
      head.innerHTML = `<span>${escapeHtml(c.name)}</span><span class="bd-ms">${shortDur(c.ms)}</span>`;
      block.appendChild(head);
      for (const t of c.timers) {
        const row = document.createElement("div"); row.className = "bd-timer";
        row.innerHTML = `<span>${escapeHtml(t.name)}</span>` +
          `<span class="bt-bar"><span style="width:${Math.round((t.ms / maxCard) * 100)}%"></span></span>` +
          `<span class="bt-ms">${shortDur(t.ms)}</span>`;
        block.appendChild(row);
      }
      bd.appendChild(block);
    }
  }

  // Recent sessions.
  const rec = $("s-recent"); rec.innerHTML = "";
  const recents = Stats.recent(sessions, cards, timers, now, 20);
  if (recents.length === 0) {
    const li = document.createElement("li"); li.className = "stats-empty"; li.textContent = "no sessions yet";
    rec.appendChild(li);
  } else {
    for (const r of recents) {
      const li = document.createElement("li"); li.className = "recent-item";
      const when = new Date(r.session.startedAt);
      li.innerHTML = `<span><strong>${escapeHtml(r.cardName)}</strong> / ${escapeHtml(r.timerName)}` +
        `<br><span class="r-when">${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span></span>` +
        `<span class="r-ms">${fmtDuration(r.ms)}</span>`;
      rec.appendChild(li);
    }
  }
}

function escapeHtml(s        )         {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] ));
}

// ── tick: re-render the running readout 10×/sec so hundredths move ──
// (a printed report is a frozen snapshot — it never re-renders; the device below
// the paper keeps ticking, as a real appliance would)
setInterval(async () => {
  const v = await dev.view();
  if (v.state === "running" || v.state === "finished") await renderDevice();
}, 100);

await renderAll();
