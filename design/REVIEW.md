# Mock UI review

Date: 2026-07-01. Subject: `design/mock.html` (single self-contained file, ~2150 lines).
Three-lens review: spec coverage (mock vs the engine in `core/` and `guidance/`), usability/UX, visual design craft.

**Verdict: the mock covers the read side of the app well and the object language is strong. It does not yet cover the write side (creating or configuring anything), and the finished/alarm state, the payoff moment of a timer app, has no UI at all.**

Severity legend: **B** blocker for the real app, **H** high, **M** medium, **L** low.

---

## 1. Spec coverage: mock vs engine

Sources of truth: `guidance/TIMER.md`, `guidance/INTERFACES.md`, `guidance/ARCHITECTURE.md`, `core/{types,device,timer,stats,format}.ts`.

### Covered (maps cleanly onto the engine)

- Slot a card (`Device.slot`): drag from binder onto device, LCD wakes, timers fill the rack.
- Eject / empty state (`Device.eject`): EJECT key blanks LCD, clears rack, big button no-ops.
- Big button start/pause/resume; glyph and sub-line follow.
- Two modes with correct formats: stopwatch hundredths (`00:00.00`), countdown MM:SS from preset.
- Multiple timers per card, 10 cap (`MAX_TIMERS`), rack rows, `.rack-count`.
- Switching the active timer (`Device.switchTimer`): lit LED plus full readout re-drive.
- Timers travel with the card on insert/eject.
- Card deck browsing: pockets, per-card color, timer chips, total time.
- Per-card history on the card backs (TOTAL, SESSIONS, SINCE, timer roster).
- Quick receipt maps ~1:1 onto `core/stats.ts` (totals, session count, streaks, byDay(14), totalsByCard, recent).
- Detailed report pages 1-3 (overview, per-card with per-timer lines, session log).
- STOP and RESET affordances exist as separate keys (correctly separated from the big button).
- State/alarm/lock lamp row exists (`.lcd-ticks`).
- Card creation entry point (`+` sleeve).
- Prints stamp the real moment (snapshot semantics, per ARCHITECTURE.md).

### Missing

| # | Sev | Gap | Spec |
|---|-----|-----|------|
| S1 | B | **Finished / alarm / repeat.** No UI path reaches `finished`: DONE lamp never lights, no alarm (chime/blip/silent), no press-to-repeat. Note: TIMER.md's big-button table lists `finished` twice (repeat vs nothing); device.ts implements repeat, the UI should follow device.ts. | TIMER.md States, Repeat, Alarm; INTERFACES.md `finished`, `alarmStyle` |
| S2 | B | **FINISH (commit to history) action.** `finish()` is the only way a stopwatch run reaches history. Without it the mock's own receipts could never contain stopwatch data. | TIMER.md "Three ways to end a run" |
| S3 | B | **Timer create/edit/delete.** `+ ADD TIMER` is inert; no form for name/mode/targetMs/alarmStyle. Alarm style has no selection UI anywhere. | `Device.addTimer/configureTimer/deleteTimer`; INTERFACES.md CLI `timer add\|rm\|edit` |
| S4 | B/M | **Real card creation/editing.** `addCard()` clones "New Card" with no naming; no rename/delete/config UI. (Blocker for naming, important for edit/delete.) | `Device.createCard/renameCard/deleteCard/configureCard` |
| S5 | M | **Lock toggle.** Passive LOCK tick only; no way to lock/unlock, no ignored-press feedback. | TIMER.md Lock; README |
| S6 | M | **Deadline / day-count.** `card.deadline`, `deadlineKind`, `SlotView.dayCount` ("42 days left / day 17") appear nowhere; no way to set. | TIMER.md Day-count; README |
| S7 | M | **Held (suspended) session indicators.** Rack rows and card backs show config only, never "this timer holds a paused 12:47". The engine's signature suspend/resume move is invisible. | TIMER.md "Switching timers = suspend & resume"; INTERFACES.md `timers` array rationale |
| S8 | M | **Per-session mode override.** "Web mode chips" are precedence #1 for mode; nothing in the mock does this. | TIMER.md "Where mode comes from" |
| S9 | M | **Export / import.** The browser's only backup/migration path; no UI. | `Device.exportAll/importAll`; INTERFACES.md |
| S10 | L | NFC registration (`registerNfc`). Arguably out of scope for the web mock. | types.ts |

### Contradicts the engine

| # | Contradiction |
|---|---------------|
| C1 | Big button labeled **START / STOP** (`.bigbtn-label`), but the engine's big button never stops (start/pause/resume/repeat only); stop is deliberately the separate STOP key the mock already has. |
| C2 | **Ready and paused conflated.** Any non-running state shows "❚❚ paused" (`setSubDirection`), including a freshly slotted never-started timer, which the engine calls `ready`. |
| C3 | **Card swap keeps running.** Dropping a card while running leaves `.running` set; engine suspends the outgoing timer and the incoming one waits for a press. |
| C4 | **Timer switch resets readout and keeps running.** Clicking a rack row shows the full preset (`cfgTime`) and preserves running; engine pauses the outgoing timer and shows the target's held session where it left off. |
| C5 | **Detailed report shows stats the core cannot produce**: AVG/DAY, MOST ACTIVE DAY, BUSIEST HOUR, FIRST SESSION, LONGEST SESSION, MILESTONES. Some derivable; busiest-hour and milestones need new core functions (milestones need persistence too). Same for the LONGEST row on card backs. |
| C6 | **Every inserted card loads the same three timers** (`cardTimersHTML` snapshot, `rackCount` hardcoded "03 / 10"), contradicting the card fronts (Cooking advertises "⧖ 45m", loads Pomodoro/Deep Work/Quick Note). |
| C7 | Duration formats drift from shared `core/format.ts` (`18h 41m`, `12h30` vs `HH:MM:SS`/`MM:SS`). Minor. |

### Ambiguous (no spec backing; decide if functional or flavor)

- MODE side key: no engine action is called "mode"; closest are per-session override chips or `configureTimer`.
- Collectible apparatus (rarity stars, series, card number, faction seals, foil variants, emblem, barcode): `Card` has only id/name/category/color/nfcUid. If rarity is meant to be earned, the core has nothing for it.
- "🔥 day 6" on Studying: per-card streak or `deadlineKind: 'since'` day-count? Two different engine concepts.
- CHIME tick always lit, LOCK never: placeholders or the intended `alarmStyle`/`locked` surface?
- Printer power dot: decorative, no state behind it.
- Model number mismatch: faceplate TC-580 vs footstamp MODEL TC-08.

---

## 2. Usability / UX

### High

| # | Finding | Fix |
|---|---------|-----|
| U1 | **Core gesture has no signifier.** Nothing tells a new user cards drag onto the device or that tapping flips; `cursor:grab` is the only affordance and doesn't exist on touch; the device never highlights as a drop target during a drag (the `.hint` CSS rule at ~line 878 has no matching DOM element). | Restore a hint line; toggle a drop-target glow on `#device` from `moveCardTo()` when `overDevice()` is true. |
| U2 | **`prefers-reduced-motion` wedges the flip permanently.** The media query makes the rotate instant, so the `transitionend` that `onFlipEnd()` waits for never fires: card stuck airborne, `dataset.busy` set forever. The airborne `top` flight is also untouched by the query. | Drive flip beats on `Promise.race([transitionend, timeout])` or timers; gate the `top` transition under the same query. |
| U3 | **Interrupting a flip corrupts later flips.** Airborne cards are still pressable; grabbing one mid-flight fires `transitioncancel` (not `transitionend`), leaking the pending handlers and sticking `cards--flipping`. Next flip double-fires. | Abort pending handlers in `resetCard()` (AbortController per gesture); always clear `cards--flipping`. |
| U4 | **Second touch strands a dragged card.** `pointerdown` unconditionally reassigns the single `drag` var; the first card is left `position:fixed` + `pointer-events:none` until reload (`insertCard` resets `.flipped/.airborne/.resting` but never `.dragging`). | `if (drag) return;` at pointerdown; include `.dragging` in reset sweeps. |
| U5 | **Binder overflow unreachable by mouse.** Scrollbar hidden, planned edge fades never implemented, vertical wheel doesn't map to horizontal scroll: cards past the edge are invisible and unreachable without a trackpad. | Edge-peek fades + wheel handler mapping vertical delta to `scrollLeft`. |

### Medium

| # | Finding | Fix |
|---|---------|-----|
| U6 | **Print keys silently become "cut" with zero mode visibility.** With a receipt out, pressing DETAILED tears the receipt and prints nothing. | Light `.pr-power` while paper is out, or auto-chain cut-then-print. |
| U7 | **Printed receipt occludes and blocks the device.** No `pointer-events:none`, no dismiss affordance on the paper. | Make the receipt clickable-to-cut, or pass pointer events through. |
| U8 | **LCD lamps never track state.** Pause leaves RUN lit; after eject+insert all lamps stay dark while "counting down" shows; DONE never lights anywhere. | One `setLamps(state)` called from big button, `insertCard`, `ejectCard`; add a mock DONE state. |
| U9 | **Invalid big-button press indistinguishable from valid.** Ejected press: same travel, same click, nothing happens. | Flash the "insert a card" line (reuse `flicker`), duller dead-key sound. |
| U10 | **Dead controls give live feedback.** MODE/RESET/STOP keys and ADD TIMER press and click with no effect; reads as bugs in testing. Plus the START / STOP label mismatch (see C1). | Stub LCD acknowledgment, or style as inert; relabel big button START / PAUSE. |
| U11 | **Touch targets under 44px** on a touch-first design: `.pr-print-btn` 28px, `.pr-big-btn` ~27px, `.trow` ~35px, tape PREV/NEXT/CLOSE. | More padding or invisible hit-area extension; the chunky look tolerates it. |
| U12 | **Cards hijack vertical page scroll on touch.** `touch-action:pan-x` on cards and binder means any vertical swipe in the binder region picks up a card or is blocked. | Press-and-hold before vertical drag arms, or a much higher vertical threshold. |
| U13 | **No keyboard/AT path; drag-only load is structurally hard to retrofit.** Cards are divs (no tabindex/role), print keys are spans, no live region for LCD changes. Flip and load exist only as pointer gestures. | Make print keys `<button>` now; define one non-drag load affordance (Enter on focused card, or LOAD on the card back). |
| U14 | **Loaded card never leaves the binder (conceptual-model break).** After a drop the card snaps home while the LCD claims it's loaded; nothing in the scene answers "which card is in the machine?"; EJECT visibly returns nothing. | Mark the loaded pocket (dim card / IN USE stamp) and/or a landing animation into the device (see D4). |
| U15 | **`#bigClose` bypasses the busy guard.** Mashing ✂ CLOSE stacks `animationend` listeners and double-plays `feedStubBack()`. | `if (bigBusy) return;` at top of `closeDetailed()`. |
| U16 | **Mouse drag paints text selection across the page** (dragged card is `pointer-events:none`, browser sees a selection drag). | `user-select:none` on body while `drag.active`, or preventDefault on card pointerdown. |

### Low

- U17: freshly inserted card reads "❚❚ paused"; needs a READY wording (same root as C2).
- U18: mock data self-contradicts (same 3 timers everywhere, hardcoded count, addCard clones Writing's stats); derive rack rows from card `data-` attributes (same as C6).
- U19: success and failure drops look identical for the first beat; animate failure snap-back + soft reject sound.
- U20: tiny type carries real content: card-back ledger 9-9.5px, `.cb-seal` 7px; `.t-cfg` (#7e7a6a on dark) ~3.2:1 at 11px, under AA.
- U21: tooltips (`title=`) are the only labels on print keys/power lamp; invisible on touch.
- U22: `syncMouthY()` runs before webfonts settle; paper anchors a few px off until resize. Also call on `document.fonts.ready`. (Found independently by both reviewers; see D7.)
- U23: short landscape viewports can push the tape's nav (incl. ✂ CLOSE) below the fold; `max-height` + `overflow-y:auto` on `.pr-big-tape`.

### Already good, keep

Eject recovery messaging ("⏏ ejected ・ insert a card"); whole-device drop zone; timer rows are real buttons; one-paper-at-a-time rule (just needs mode visibility); PREV/NEXT disabled states on the tape.

---

## 3. Visual design craft

### High

| # | Finding | Fix |
|---|---------|-----|
| D1 | **Device ignores the responsive system.** `.device { width:540px }` fixed while `--header-w` exists for exactly this; below ~572px the page scrolls horizontally and the device diverges from the header. | `width: var(--header-w)`. Internals survive narrow widths except D3. |
| D2 | **Barcode renders blank.** `.barcode` lists the ~93%-opaque cream plate gradient first (on top), so the ink stripes show at ~7%. | Swap the two background layers. |
| D3 | **64px readout overflows at narrow widths** once D1 lands: 8-glyph `00:00.00` needs ~260px, LCD interior at 360px viewport is ~234px. | `font-size: clamp(40px, 13vw, 64px)` or derive from `--header-w`. |
| D4 | **The drop has no landing.** On success the card teleports home while `insertCard` swaps the LCD; the product's namesake action has no receiving animation (slotted-card visual removed, nothing replaced it). | ~200ms scale/slide-into-device before returning the card; pairs with U14. |
| D5 | **Always-on foil outshines the LCD.** `.foil` at .86 opacity + 55%-white glare makes six permanent rainbow rectangles the brightest zone; the sage LCD loses first fixation. | Rest opacity ~.55, hover bloom to 1. |

### Medium

| # | Finding | Fix |
|---|---------|-----|
| D6 | Two model numbers on one device: faceplate TC-580, footstamp MODEL TC-08. | Pick one. |
| D7 | `syncMouthY` stale after webfont load (same as U22). | `document.fonts.ready.then(syncMouthY)`. |
| D8 | RUN/CHIME lamps die permanently after first eject; nothing re-lights them (same root as U8). | Drive lamps from the running toggle. |
| D9 | Ejected LCD keeps full backlight (cardless glows like live); no DONE/alarm visual exists at all (the timer's payoff frame). | `.device.ejected .lcd { filter: brightness(.9) saturate(.6) }`; sketch the DONE state (pairs with S1). |
| D10 | Long card names overflow three surfaces: `.lcd-card` (no min-width/ellipsis), `.card-name` (nowrap, hard-clipped), `.cb-name` (nowrap, no text-overflow). | Ellipsize all three. |
| D11 | Gold palette hardcoded and drifting (`#caa23e/#e3bd5c/#a9802a/#fff7d6/#8a6418` + strays `#e8c878`, `#e7b84e` across `.rarity`, `.card-series`, `.card-no .n`, `.card-name`, `.card-face::before`, `.card-emblem`). | `--gold-hi/--gold/--gold-lo` tokens in `:root`. |
| D12 | ~150 lines of dead CSS from prior iterations: `.right-col`, `.card-slot`/`.slot-line`, `.slotted-card` block, `.deck*`, `.print-key`, `.hint`, `.pr-controls-lbl`, slot-empty rules + `@keyframes insert`, `.card.lifted`, a typo'd duplicate background in `.skey`, `.card .foil` declared twice with conflicting radius. | Delete in one pass (decide first whether the slotted-card visual ever returns). |
| D13 | A 10-timer card stretches the chassis ~300px; the molded case should not change height per card. | Cap the rack at ~5 rows with internal scroll (the milled-slot idiom supports it). |

### Low

- D14: microtype floor: `.pr-badge em` 7px Dela Gothic (JP display at 7px is an ink blob), `.cb-seal`/`.cb-reg` 7px, `.lcd-ticks` 10px at .6 opacity. Floor Latin 8px / JP 9px; ticks to .75 opacity. Receipt microprint can stay as flavor.
- D15: motion token drift on the paper path (spool .7s `(.2,.85,.3,1)` vs feed .55s `(.2,.8,.3,1)`; cut-fall .6s vs big-out .65s). Shared `--ease-spool`/`--ease-fall` + durations. Also the full flip is ~.75s and busy-locked; trimming lift/drop to ~.16s keeps the three beats and cuts repeat friction.
- D16: reduced-motion coverage is token-level only; spool, cut-fall (a 115vh drop), big-in/out, and LCD flicker still animate. One global `prefers-reduced-motion` block for `pr-*` keyframes and `.waking`. (Do together with U2.)
- D17: printer's neutral `rgba(0,0,0,.5)` shadow vs the warm shadows everywhere else; warm it. Device side gutters alternate 6px/8px across faceplate/bezel/controls/rack/footstamp; pick one. `POCKET_W = 262` in JS duplicates `.pocket { width:262px }`; derive from DOM or a shared var.

### Genuinely good, keep

Per-object token scoping (`--pr-*`, device shell, binder) with vermilion-only-when-live; identical paper mask shared by stub/receipt/tape so all paper reads as one roll; the pin/portal flip solution; consistent top-left key light across screws, dome, bezels, welds; the 74deg pocket specular deliberately crossing the 118deg card glare.

---

## 4. Priority order

1. **Design the missing payoff: finished/alarm/repeat** (S1, S2, U8, D9). Lamps, LCD, sound, the vermilion moment. Blocker for the app and the mock's best unrealized scene.
2. **Make the loaded card visible** (U14, D4, U1). Landing animation + pocket IN USE cue + drop-target highlight during drag. Fixes the metaphor and discoverability together.
3. **Quick mechanical fixes**: U4 (`if (drag) return;`), D1 (device width var), D2 (barcode layers), U22/D7 (`fonts.ready`), C1/U10 (START / PAUSE label), U15 (bigClose guard), D12 (dead CSS purge).
4. **Flip state machine hardening** (U2, U3, D16): stop trusting transition events as the clock; one reduced-motion block.
5. **Then the write side** (S3, S4): timer add/edit form and card naming, the biggest open design questions in the object language.

Notes on root causes worth remembering:
- U2 and U3 share one cause: the flip state machine uses CSS transition events as its clock, and those don't fire when a transition is skipped (reduced motion) or canceled (interrupt). Timers or `Promise.race` fix both.
- S2 matters beyond completeness: without FINISH in the flow, the stats surfaces the mock is proudest of (receipts, card backs) describe data the demo flow can never generate.
