# timecards

> Remember study timers? They're back! In card form.

Make **cards** for the things you give time to — Writing, Cooking, Crocheting,
Work, Studying, anything. Slot one card into the device, hit the big button to
start, pause, and resume. Each card keeps its own time, separately. Swap a card →
its data swaps in.

Each card can be an open **stopwatch** or a **countdown** (with a **chime / blip /
silent alarm** when it hits zero, and one-press **repeat** to run the same round
again), can carry a **deadline or streak** ("42 days left", "day 17"), and you can
**lock** the device so a stray tap won't stop your session. A **stats** view shows
totals, a daily chart, streaks, and recent sessions.

There's a **web app**, a **command line**, and a data model built to be read by a
**Raspberry Pi or Arduino** — even to recognize **NFC tags** like amiibos, so you
can tap a physical card to switch what you're tracking.

## Try it

**Web** (no install): build it and open the page.
```bash
node web/build.ts
cd docs && python3 -m http.server 8000   # then open http://localhost:8000
```

**Command line:**
```bash
node cli/timecards.ts new "Hobby"                       # creates a card (+ a stopwatch)
node cli/timecards.ts timer add hobby "Pomodoro" --down 25 --alarm blip
node cli/timecards.ts timers hobby                      # list the card's timers
node cli/timecards.ts slot hobby
node cli/timecards.ts press                             # big button: start/pause/resume
node cli/timecards.ts timer switch pomodoro             # suspends one, resumes the other
node cli/timecards.ts lock                              # freeze the button; `unlock` to release
node cli/timecards.ts config hobby --deadline 2026-09-01 --until   # 'N days left'
node cli/timecards.ts status
node cli/timecards.ts stop
```
A card holds up to 4 timers; switching suspends one and resumes another where it
left off. Add `--json` to any command for machine-readable output. Run
`node cli/timecards.ts help` for the full list.

Requires **Node 22+** (it runs the TypeScript directly — no build step, no
dependencies). Data lives in `~/.timecards/data.db` for the CLI; in your browser
for the web app.

## Hosting the web app

GitHub Pages serves the built app straight from this repo's `/docs` folder. Set
**Settings → Pages → Source: `main` / `/docs`**, push, and it's live.

## How it's built

One shared core (data model + timer logic + the big-button state machine); the
CLI and web UI are thin wrappers over it, each with its own storage backend
(SQLite for CLI/Pi, IndexedDB for the browser). See [`CLAUDE.md`](./CLAUDE.md) and
[`/guidance`](./guidance) for the full picture and how to extend it.

MIT licensed.
