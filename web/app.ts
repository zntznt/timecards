// Web app: wires the DOM to the shared core. Big button, readout, deck of cards,
// and — within a slotted card — its list of timers (switch suspends/resumes).
// Same Device + timer logic as the CLI; only the storage adapter (IndexedDB) differs.

import { Device } from "../core/device.ts";
import { IdbStore } from "./idb-store.ts";
import { SupabaseStore } from "../core/supabase-store.ts";
import { fmtDuration } from "../core/format.ts";
import { bigButtonAction } from "../core/timer.ts";
import { MAX_TIMERS } from "../core/types.ts";
import * as Stats from "../core/stats.ts";
import type { Storage, SlotView, Card, Timer, TimerMode, AlarmStyle, DeadlineKind } from "../core/types.ts";

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
const elStop = $<HTMLButtonElement>("stop");
const elFinish = $<HTMLButtonElement>("finish");
const elReset = $<HTMLButtonElement>("reset");
const elEject = $<HTMLButtonElement>("eject");
const elLock = $<HTMLButtonElement>("lock-toggle");
const elTimers = $("timers");
const elTimerList = $("timer-list");
const elAddTimer = $<HTMLButtonElement>("add-timer");
const elList = $("card-list");
const elAdd = $<HTMLButtonElement>("add-card");
const elCardEditor = $<HTMLDialogElement>("card-editor");
const elTimerEditor = $<HTMLDialogElement>("timer-editor");
const elSettings = $<HTMLDialogElement>("settings-editor");
const elTabDevice = $<HTMLButtonElement>("tab-device");
const elTabStats = $<HTMLButtonElement>("tab-stats");
const elViewDevice = $("view-device");
const elViewStats = $("view-stats");

const GLYPH: Record<string, string> = { start: "▶", pause: "❚❚", resume: "▶", noop: "●" };

// ── alarm (WebAudio) ────────────────────────────────────────────
let audioCtx: AudioContext | null = null;
function beep(freq: number, durMs: number, when = 0) {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
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
function playAlarm(style: AlarmStyle) {
  if (style === "silent") return;
  if (style === "blip") { beep(880, 90); return; }
  beep(660, 180, 0); beep(880, 180, 0.2); beep(1175, 320, 0.42);
}
let alarmedFor: string | null = null; // timerId:sessionId we've already alarmed
let lastChimeAt = 0;                  // last time the ringing chime re-played
const CHIME_EVERY_MS = 5_000;         // chime begs until acknowledged; blip stays a one-shot nudge

// ── render ──────────────────────────────────────────────────────
async function renderDevice() {
  const v: SlotView = await dev.view();
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

  if (v.state === "empty") {
    elCardName.textContent = "no card"; elCardName.classList.add("empty");
    elTimerName.textContent = "";
    elReadout.textContent = "00:00";
    elSub.textContent = "slot a card from your deck to begin";
    elBigLabel.textContent = "●";
    elBig.disabled = true; elStop.disabled = elFinish.disabled = elReset.disabled = elEject.disabled = true;
    elTimers.hidden = true;
    return;
  }
  elCardName.classList.remove("empty");
  elCardName.textContent = v.card!.name;
  elEject.disabled = v.locked; // the lock holds the card in
  elTimers.hidden = false;
  renderTimerList(v);

  // No timer selected (card has none): prompt to add one.
  if (!v.timer) {
    elTimerName.textContent = "no timers yet";
    elReadout.textContent = "—";
    elSub.textContent = "add a timer to begin";
    elBigLabel.textContent = "●";
    elBig.disabled = true; elStop.disabled = elFinish.disabled = elReset.disabled = true;
    return;
  }
  elTimerName.textContent = v.timer.name;
  // When finished, the big button stays active and REPEATS the round (press()).
  elBig.disabled = v.locked;

  if (v.mode === "down" && v.remainingMs !== null) elReadout.textContent = fmtDuration(v.remainingMs);
  else if (v.mode === "up") elReadout.textContent = fmtDuration(v.elapsedMs, true);
  else elReadout.textContent = v.timer.mode === "down" && v.timer.targetMs ? fmtDuration(v.timer.targetMs) : "00:00";

  elBigLabel.textContent = v.state === "finished" ? "↻" : (GLYPH[bigButtonAction(v.state)] ?? "●");

  // stop = freeze a RUNNING timer; finish = bank any live run to history;
  // reset = discard any live run (running/paused/finished).
  const hasRun = v.state === "running" || v.state === "paused" || v.state === "finished";
  elStop.disabled = v.locked || v.state !== "running";
  elFinish.disabled = v.locked || !hasRun;
  elReset.disabled = v.locked || !hasRun;

  if (v.state === "ready") { elSub.textContent = "press to start"; }
  else if (v.state === "running") { elSub.textContent = v.mode === "down" ? "counting down…" : "tracking…"; }
  else if (v.state === "paused") { elSub.textContent = "paused: press to resume · finish saves · reset discards"; }
  else if (v.state === "finished") {
    elSub.textContent = "time's up, round saved · press ↻ to repeat · reset to clear";
    const key = v.timer.id + ":" + (v.timer.liveSession?.id ?? "");
    if (alarmedFor !== key) { alarmedFor = key; lastChimeAt = Date.now(); playAlarm(v.alarmStyle); }
    else if (v.alarmStyle === "chime" && Date.now() - lastChimeAt >= CHIME_EVERY_MS) {
      lastChimeAt = Date.now(); playAlarm("chime"); // the tick loop re-renders while finished, so this re-begs
    }
  }
}

function renderTimerList(v: SlotView) {
  elTimerList.innerHTML = "";
  elAddTimer.disabled = v.timers.length >= MAX_TIMERS;
  elAddTimer.title = elAddTimer.disabled ? `max ${MAX_TIMERS} timers` : "add a timer";
  if (v.timers.length === 0) {
    const li = document.createElement("li");
    li.className = "timers-empty";
    li.textContent = "no timers — add one to start tracking";
    elTimerList.appendChild(li);
    return;
  }
  for (const t of v.timers) elTimerList.appendChild(timerRow(t, v.timer?.id ?? null));
}

function timerRow(t: Timer, activeId: string | null): HTMLLIElement {
  const li = document.createElement("li");
  li.className = "timer-row" + (t.id === activeId ? " active" : "");
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
  li.append(nm, cfg, live, edit, del);
  return li;
}

async function renderDeck() {
  const cards = await dev.listCards();
  const active = (await dev.view()).card?.id ?? null;
  elList.innerHTML = "";
  if (cards.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-deck"; li.textContent = "no cards yet — make one with “+ new card”";
    elList.appendChild(li); return;
  }
  for (const c of cards) elList.appendChild(await cardItem(c, active));
}

async function cardItem(c: Card, active: string | null): Promise<HTMLLIElement> {
  const total = await dev.totalMs(c.id);
  const timers = await dev.listTimers(c.id);
  const li = document.createElement("li");
  li.className = "card-item" + (c.id === active ? " active" : "");
  const swatch = document.createElement("span");
  swatch.className = "card-swatch"; swatch.style.background = c.color || "#6ee7b7";
  const meta = document.createElement("div"); meta.className = "card-meta";
  const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = c.name;
  const det = document.createElement("div"); det.className = "det";
  const bits: string[] = [`${timers.length} timer${timers.length === 1 ? "" : "s"}`];
  if (c.category) bits.unshift(c.category);
  if (c.deadline) bits.push((c.deadlineKind ?? "until") === "until" ? "⏰ deadline" : "🔥 streak");
  det.textContent = bits.join("  ·  ");
  meta.append(nm, det);
  const tot = document.createElement("div"); tot.className = "card-total"; tot.textContent = fmtDuration(total);
  const actions = document.createElement("div"); actions.className = "card-actions";
  const edit = document.createElement("button");
  edit.className = "card-edit"; edit.textContent = "✎"; edit.title = "edit card";
  edit.onclick = (e) => { e.stopPropagation(); openCardEditor(c); };
  const del = document.createElement("button");
  del.className = "card-del"; del.textContent = "✕"; del.title = "delete card";
  del.onclick = async (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${c.name}", its timers, and history?`)) { await dev.deleteCard(c.id); await renderAll(); }
  };
  actions.append(edit, del);
  li.onclick = async () => { await dev.slot(c.id); await renderAll(); };
  li.append(swatch, meta, tot, actions);
  return li;
}

async function renderAll() { await renderDevice(); await renderDeck(); }

// ── device interactions ─────────────────────────────────────────
elBig.onclick = async () => { await dev.press(); await renderAll(); };
elStop.onclick = async () => { await dev.stop(); await renderAll(); };          // freeze & keep
elFinish.onclick = async () => { alarmedFor = null; await dev.finish(); await renderAll(); }; // bank to history
elReset.onclick = async () => { alarmedFor = null; await dev.reset(); await renderAll(); }; // discard
elEject.onclick = async () => { await dev.eject(); await renderAll(); };
elLock.onclick = async () => { await dev.lock(); await renderDevice(); };

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLSelectElement) && !elCardEditor.open && !elTimerEditor.open) {
    e.preventDefault(); elBig.click();
  }
});

// ── card editor ─────────────────────────────────────────────────
let editingCardId: string | null = null;
elAdd.onclick = () => openCardEditor(null);

function openCardEditor(card: Card | null) {
  editingCardId = card?.id ?? null;
  $("card-title").textContent = card ? "Edit card" : "New card";
  $<HTMLInputElement>("c-name").value = card?.name ?? "";
  $<HTMLInputElement>("c-category").value = card?.category ?? "";
  $<HTMLInputElement>("c-color").value = card?.color ?? "#6ee7b7";
  $<HTMLInputElement>("c-deadline").value = card?.deadline ? isoDate(card.deadline) : "";
  const dk = card?.deadlineKind ?? "until";
  (elCardEditor.querySelector(`input[name=dkind][value=${dk}]`) as HTMLInputElement).checked = true;
  elCardEditor.showModal();
}
$("card-cancel").onclick = () => elCardEditor.close();
$<HTMLFormElement>("card-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("c-name").value.trim();
  if (!name) return;
  const category = $<HTMLInputElement>("c-category").value.trim() || null;
  const color = $<HTMLInputElement>("c-color").value;
  const dateStr = $<HTMLInputElement>("c-deadline").value;
  const deadline = dateStr ? new Date(dateStr + "T00:00").getTime() : null;
  const deadlineKind = (elCardEditor.querySelector("input[name=dkind]:checked") as HTMLInputElement).value as DeadlineKind;
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
let editingTimerId: string | null = null;
let timerEditorCardId: string | null = null;

elAddTimer.onclick = async () => {
  const cardId = (await dev.view()).card?.id;
  if (cardId) openTimerEditor(cardId, null);
};

// Bounded H:M:S entry — discrete units like the physical device, no free text.
const elH = $<HTMLInputElement>("t-h"), elM = $<HTMLInputElement>("t-m"), elS = $<HTMLInputElement>("t-s");
const elDurFields = $("dur-fields");

/** Read + clamp the H:M:S inputs to ms. Empty fields count as 0. */
function readDurationMs(): number {
  const clamp = (el: HTMLInputElement, max: number) => {
    let n = Math.floor(Number(el.value));
    if (!Number.isFinite(n) || n < 0) n = 0;
    if (n > max) { n = max; el.value = String(max); }  // visibly enforce the ceiling
    return n;
  };
  const h = clamp(elH, 23), m = clamp(elM, 59), s = clamp(elS, 59);
  return ((h * 60 + m) * 60 + s) * 1000;
}

/** Write ms back into the H:M:S inputs. */
function writeDurationMs(ms: number | null) {
  const total = Math.floor((ms ?? 0) / 1000);
  elH.value = ms ? String(Math.floor(total / 3600)) : "";
  elM.value = ms ? String(Math.floor((total % 3600) / 60)) : "";
  elS.value = ms ? String(total % 60) : "";
}

/** Grey out the H:M:S fields unless Countdown is selected. */
function syncTimerModeUI() {
  const down = (elTimerEditor.querySelector("input[name=tmode]:checked") as HTMLInputElement)?.value === "down";
  elDurFields.classList.toggle("disabled", !down);
}

// Picking a mode radio updates the fields' look.
elTimerEditor.querySelectorAll<HTMLInputElement>("input[name=tmode]").forEach(r => {
  r.addEventListener("change", syncTimerModeUI);
});
// Editing any H:M:S field clearly means "countdown" — auto-select it, and clamp live.
for (const el of [elH, elM, elS]) {
  el.addEventListener("input", () => {
    (elTimerEditor.querySelector("input[name=tmode][value=down]") as HTMLInputElement).checked = true;
    syncTimerModeUI();
  });
  el.addEventListener("blur", () => readDurationMs());  // clamp to bounds on leaving a field
}

function openTimerEditor(cardId: string, timer: Timer | null) {
  timerEditorCardId = cardId;
  editingTimerId = timer?.id ?? null;
  $("timer-title").textContent = timer ? "Edit timer" : "New timer";
  $<HTMLInputElement>("t-name").value = timer?.name ?? "";
  const mode = timer?.mode ?? "up";
  (elTimerEditor.querySelector(`input[name=tmode][value=${mode}]`) as HTMLInputElement).checked = true;
  writeDurationMs(timer?.targetMs ?? null);
  $<HTMLSelectElement>("t-alarm").value = timer?.alarmStyle ?? "chime";
  syncTimerModeUI();
  elTimerEditor.showModal();
}
$("timer-cancel").onclick = () => elTimerEditor.close();
$<HTMLFormElement>("timer-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("t-name").value.trim();
  const targetMs = readDurationMs();
  // Intent: a non-zero H:M:S IS a countdown, whatever the radio says — a set length
  // can never be silently discarded as a stopwatch.
  const radioMode = (elTimerEditor.querySelector("input[name=tmode]:checked") as HTMLInputElement).value as TimerMode;
  const mode: TimerMode = targetMs > 0 ? "down" : radioMode === "down" ? "down" : "up";
  const finalTarget = mode === "down" ? targetMs : null;
  const alarmStyle = $<HTMLSelectElement>("t-alarm").value as AlarmStyle;
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

// ── settings: Supabase sync ─────────────────────────────────────
$("settings-btn").onclick = () => {
  $<HTMLInputElement>("sb-url").value = localStorage.getItem("tc_sb_url") ?? "";
  $<HTMLInputElement>("sb-key").value = localStorage.getItem("tc_sb_key") ?? "";
  $("sb-status").textContent = localStorage.getItem("tc_sb_url")
    ? "Currently syncing to Supabase."
    : "Currently local only (this browser).";
  elSettings.showModal();
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

// ── view toggle: device ⇆ stats ─────────────────────────────────
let onStats = false;
function showView(stats: boolean) {
  onStats = stats;
  elViewDevice.hidden = stats;
  elViewStats.hidden = !stats;
  elTabDevice.classList.toggle("active", !stats);
  elTabStats.classList.toggle("active", stats);
  if (stats) renderStats();
}
elTabDevice.onclick = () => showView(false);
elTabStats.onclick = () => showView(true);

// ── stats rendering ─────────────────────────────────────────────
function shortDur(ms: number): string {
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(ms / 1000)}s`;
}

async function renderStats() {
  const { sessions, cards, timers, now } = await dev.statsData();
  $("s-total").textContent = shortDur(Stats.totalMs(sessions, now));
  const st = Stats.streaks(sessions, now);
  $("s-streak").textContent = String(st.current);
  $("s-longest").textContent = String(st.longest);
  $("s-active").textContent = String(st.activeDays);

  // Day chart.
  const chart = $("s-chart"); chart.innerHTML = "";
  const days = Stats.byDay(sessions, now, 14);
  const maxDay = Math.max(1, ...days.map(d => d.ms));
  const todayKey = days[days.length - 1].day;
  for (const d of days) {
    const row = document.createElement("div");
    row.className = "chart-row" + (d.day === todayKey ? " today" : "");
    const label = d.day.slice(5).replace("-", "/");
    row.innerHTML = `<span class="c-day">${label}</span>` +
      `<span class="chart-bar"><span style="width:${Math.round((d.ms / maxDay) * 100)}%"></span></span>` +
      `<span class="c-val">${d.ms ? shortDur(d.ms) : ""}</span>`;
    chart.appendChild(row);
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// ── tick: re-render the running readout 10×/sec so hundredths move ──
setInterval(async () => {
  if (onStats) return;                 // don't churn the stats DOM while it's open
  const v = await dev.view();
  if (v.state === "running" || v.state === "finished") await renderDevice();
}, 100);

await renderAll();
