// Web app: wires the DOM to the shared core. Big button, readout, deck, plus
// countdown, alarm, deadline/day-count, lock, and the card editor.
// Same Device + timer logic as the CLI — only the storage adapter (IndexedDB) differs.

import { Device } from "../core/device.ts";
import { IdbStore } from "./idb-store.ts";
import { fmtDuration } from "../core/format.ts";
import { bigButtonAction } from "../core/timer.ts";
import type { SlotView, Card, TimerMode, AlarmStyle, DeadlineKind } from "../core/types.ts";

const dev = new Device(new IdbStore());

// ── element refs ────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const elDevice = $("device");
const elCardName = $("card-name");
const elDayCount = $("daycount");
const elReadout = $("readout");
const elSub = $("sub");
const elBig = $<HTMLButtonElement>("big-button");
const elBigLabel = $("big-label");
const elStop = $<HTMLButtonElement>("stop");
const elEject = $<HTMLButtonElement>("eject");
const elLock = $<HTMLButtonElement>("lock-toggle");
const elModeRow = $("mode-row");
const elList = $("card-list");
const elAdd = $<HTMLButtonElement>("add-card");
const elEditor = $<HTMLDialogElement>("editor");
const elDurDialog = $<HTMLDialogElement>("dur-dialog");

const GLYPH: Record<string, string> = { start: "▶", pause: "❚❚", resume: "▶", noop: "●" };

// ── alarm (WebAudio, no asset files) ────────────────────────────
// A short synthesized tone so there's nothing to host. Style picks the pattern.
let audioCtx: AudioContext | null = null;
function beep(freq: number, durMs: number, when = 0) {
  if (!audioCtx) audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const ctx = audioCtx;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = freq;
  osc.type = "sine";
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.3, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}
function playAlarm(style: AlarmStyle) {
  if (style === "silent") return;          // visual pulse only (handled by CSS)
  if (style === "blip") { beep(880, 90); return; }
  // chime: three rising tones
  beep(660, 180, 0); beep(880, 180, 0.2); beep(1175, 320, 0.42);
}

// Track which session we've already alarmed for, so it fires once.
let alarmedSessionId: string | null = null;

// ── per-session mode override chosen via the chips, applied on next start ──
let pendingMode: { mode: TimerMode; targetMs?: number } | null = null;

// ── render ──────────────────────────────────────────────────────
async function renderDevice() {
  const v: SlotView = await dev.view();
  elDevice.className = v.state + (v.locked ? " is-locked" : "");
  elLock.textContent = v.locked ? "🔒" : "🔓";

  // Day-count badge.
  if (v.dayCount) {
    const d = v.dayCount;
    elDayCount.hidden = false;
    elDayCount.className = "daycount" + (d.passed ? " passed" : d.kind === "since" ? " streak" : "");
    elDayCount.textContent = d.kind === "until"
      ? (d.passed ? "⏰ deadline passed" : `⏰ ${d.days} day${d.days === 1 ? "" : "s"} left`)
      : `🔥 day ${d.days}`;
  } else {
    elDayCount.hidden = true;
  }

  if (v.state === "empty") {
    elCardName.textContent = "no card";
    elCardName.classList.add("empty");
    elReadout.textContent = "00:00";
    elSub.textContent = "slot a card from your deck to begin";
    elBigLabel.textContent = "●";
    elBig.disabled = true;
    elStop.disabled = elEject.disabled = true;
    elModeRow.hidden = true;
    return;
  }
  elCardName.classList.remove("empty");
  elCardName.textContent = v.card!.name;
  elBig.disabled = v.locked || v.state === "finished";
  elEject.disabled = false;

  // Readout: countdown shows remaining; stopwatch shows elapsed with hundredths.
  if (v.mode === "down" && v.remainingMs !== null) {
    elReadout.textContent = fmtDuration(v.remainingMs);
  } else if (v.mode === "up") {
    elReadout.textContent = fmtDuration(v.elapsedMs, true); // hundredths
  } else {
    // ready: preview the default that a press would start with
    const previewDown = v.card!.defaultMode === "down" && v.card!.defaultTargetMs;
    elReadout.textContent = previewDown ? fmtDuration(v.card!.defaultTargetMs!) : "00:00";
  }

  const action = bigButtonAction(v.state);
  elBigLabel.textContent = GLYPH[action] ?? "●";

  // Mode chips only while idle (ready).
  elModeRow.hidden = v.state !== "ready";
  if (v.state === "ready") markSelectedChip(v.card!);

  if (v.state === "ready") { elSub.textContent = "press to start"; elStop.disabled = true; }
  else if (v.state === "running") { elSub.textContent = v.mode === "down" ? "counting down…" : "tracking…"; elStop.disabled = false; }
  else if (v.state === "paused") { elSub.textContent = "paused"; elStop.disabled = false; }
  else if (v.state === "finished") {
    elSub.textContent = "time's up — press stop to save";
    elStop.disabled = false;
    // Fire the alarm once per finished session.
    const sid = (await dev.view()).card?.id + ":fin";
    if (alarmedSessionId !== sid) { alarmedSessionId = sid; playAlarm(v.alarmStyle); }
  }
}

function markSelectedChip(card: Card) {
  const chips = elModeRow.querySelectorAll<HTMLButtonElement>(".chip");
  chips.forEach(c => c.classList.remove("sel"));
  // Reflect the pending override, else the card default.
  let key = "up";
  if (pendingMode) {
    key = pendingMode.mode === "up" ? "up" : String((pendingMode.targetMs ?? 0) / 60000);
  } else if (card.defaultMode === "down" && card.defaultTargetMs) {
    key = String(card.defaultTargetMs / 60000);
  }
  const match = [...chips].find(c => c.dataset.mode === key);
  (match ?? chips[0]).classList.add("sel");
}

async function renderDeck() {
  const cards = await dev.listCards();
  const active = (await dev.view()).card?.id ?? null;
  elList.innerHTML = "";
  if (cards.length === 0) {
    const li = document.createElement("li");
    li.className = "empty-deck";
    li.textContent = "no cards yet — make one with “+ new card”";
    elList.appendChild(li);
    return;
  }
  for (const c of cards) elList.appendChild(await cardItem(c, active));
}

async function cardItem(c: Card, active: string | null): Promise<HTMLLIElement> {
  const total = await dev.totalMs(c.id);
  const li = document.createElement("li");
  li.className = "card-item" + (c.id === active ? " active" : "");

  const swatch = document.createElement("span");
  swatch.className = "card-swatch";
  swatch.style.background = c.color || "#6ee7b7";

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const nm = document.createElement("div"); nm.className = "nm"; nm.textContent = c.name;
  const det = document.createElement("div"); det.className = "det";
  const bits: string[] = [];
  if (c.category) bits.push(c.category);
  if (c.defaultMode === "down" && c.defaultTargetMs) bits.push(`⏲ ${fmtDuration(c.defaultTargetMs)}`);
  if (c.deadline) bits.push((c.deadlineKind ?? "until") === "until" ? "⏰ deadline" : "🔥 streak");
  det.textContent = bits.join("  ·  ") || "—";
  meta.append(nm, det);

  const tot = document.createElement("div");
  tot.className = "card-total";
  tot.textContent = fmtDuration(total);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const edit = document.createElement("button");
  edit.className = "card-edit"; edit.textContent = "✎"; edit.title = "edit card";
  edit.onclick = (e) => { e.stopPropagation(); openEditor(c); };
  const del = document.createElement("button");
  del.className = "card-del"; del.textContent = "✕"; del.title = "delete card";
  del.onclick = async (e) => {
    e.stopPropagation();
    if (confirm(`Delete "${c.name}" and its history?`)) { await dev.deleteCard(c.id); await renderAll(); }
  };
  actions.append(edit, del);

  li.onclick = async () => { pendingMode = null; await dev.slot(c.id); await renderAll(); };
  li.append(swatch, meta, tot, actions);
  return li;
}

async function renderAll() { await renderDevice(); await renderDeck(); }

// ── interactions ────────────────────────────────────────────────
elBig.onclick = async () => {
  const v = await dev.view();
  if (v.state === "ready") {
    await dev.press(pendingMode ?? {});   // honor a chip override, else the card default
    pendingMode = null;
  } else {
    await dev.press();                    // pause / resume
  }
  await renderAll();
};
elStop.onclick = async () => { alarmedSessionId = null; await dev.stop(); await renderAll(); };
elEject.onclick = async () => { pendingMode = null; await dev.eject(); await renderAll(); };
elLock.onclick = async () => { await dev.lock(); await renderDevice(); };

// Mode chips: set the pending override for the next start.
elModeRow.querySelectorAll<HTMLButtonElement>(".chip").forEach(chip => {
  chip.onclick = async () => {
    const m = chip.dataset.mode!;
    if (m === "up") pendingMode = { mode: "up" };
    else if (m === "custom") {
      const ms = await askDuration();
      if (ms == null) return;
      pendingMode = { mode: "down", targetMs: ms };
    } else {
      pendingMode = { mode: "down", targetMs: Number(m) * 60_000 };
    }
    await renderDevice();
  };
});

// Spacebar = the big button (unless typing in a field / dialog open).
document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLSelectElement) && !elEditor.open && !elDurDialog.open) {
    e.preventDefault();
    elBig.click();
  }
});

// ── custom-duration mini dialog ─────────────────────────────────
function askDuration(): Promise<number | null> {
  return new Promise(resolve => {
    const input = $<HTMLInputElement>("dur-input");
    input.value = "";
    elDurDialog.showModal();
    const form = elDurDialog.querySelector("form")!;
    const cancel = $("dur-cancel");
    const done = (val: number | null) => { elDurDialog.close(); form.onsubmit = null; resolve(val); };
    form.onsubmit = (e) => { e.preventDefault(); done(parseDuration(input.value)); };
    cancel.onclick = () => done(null);
  });
}

// ── card editor (create + edit) ─────────────────────────────────
let editingId: string | null = null;

elAdd.onclick = () => openEditor(null);

function openEditor(card: Card | null) {
  editingId = card?.id ?? null;
  $("editor-title").textContent = card ? "Edit card" : "New card";
  $<HTMLInputElement>("f-name").value = card?.name ?? "";
  $<HTMLInputElement>("f-category").value = card?.category ?? "";
  $<HTMLInputElement>("f-color").value = card?.color ?? "#6ee7b7";
  const mode = card?.defaultMode ?? "up";
  (elEditor.querySelector(`input[name=mode][value=${mode}]`) as HTMLInputElement).checked = true;
  $<HTMLInputElement>("f-duration").value = card?.defaultTargetMs ? fmtDuration(card.defaultTargetMs) : "";
  $<HTMLSelectElement>("f-alarm").value = card?.alarmStyle ?? "chime";
  $<HTMLInputElement>("f-deadline").value = card?.deadline ? isoDate(card.deadline) : "";
  const dk = card?.deadlineKind ?? "until";
  (elEditor.querySelector(`input[name=dkind][value=${dk}]`) as HTMLInputElement).checked = true;
  elEditor.showModal();
}

$("editor-cancel").onclick = () => elEditor.close();
$<HTMLFormElement>("editor-form").onsubmit = async (e) => {
  e.preventDefault();
  const name = $<HTMLInputElement>("f-name").value.trim();
  if (!name) return;
  const category = $<HTMLInputElement>("f-category").value.trim() || null;
  const color = $<HTMLInputElement>("f-color").value;
  const mode = (elEditor.querySelector("input[name=mode]:checked") as HTMLInputElement).value as TimerMode;
  const durStr = $<HTMLInputElement>("f-duration").value.trim();
  const targetMs = mode === "down" && durStr ? parseDuration(durStr) : null;
  const alarmStyle = $<HTMLSelectElement>("f-alarm").value as AlarmStyle;
  const dateStr = $<HTMLInputElement>("f-deadline").value;
  const deadline = dateStr ? new Date(dateStr + "T00:00").getTime() : null;
  const deadlineKind = (elEditor.querySelector("input[name=dkind]:checked") as HTMLInputElement).value as DeadlineKind;

  if (editingId) {
    await dev.configureCard(editingId, { defaultMode: mode, defaultTargetMs: targetMs, alarmStyle, deadline, deadlineKind, category, color });
    await dev.renameCard(editingId, name);
  } else {
    const c = await dev.createCard(name, { category: category ?? undefined, color, defaultMode: mode, defaultTargetMs: targetMs, alarmStyle });
    if (deadline) await dev.configureCard(c.id, { deadline, deadlineKind });
  }
  elEditor.close();
  await renderAll();
};

// ── small parsers (mirror the CLI) ──────────────────────────────
function parseDuration(s: string): number | null {
  if (!s.trim()) return null;
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 1) return Math.round(parts[0] * 60_000);        // minutes
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 60_000;  // H:M
  return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;          // H:M:S
}
function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── tick ────────────────────────────────────────────────────────
// The readout is cosmetic; truth is in storage. Re-render the device while live.
// 100ms so the hundredths digits actually move on a running stopwatch.
setInterval(async () => {
  const v = await dev.view();
  if (v.state === "running" || v.state === "finished") await renderDevice();
}, 100);

await renderAll();
