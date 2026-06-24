// Core data model. Shared by every interface (CLI, web, future Pi/Arduino).
// Times are integer epoch milliseconds. Durations are integer milliseconds.
// We never store floats — drift-free and exact. ponytail: ints over floats, no rounding bugs.

/** Max timers a single card may hold. Keeps scope from exploding. */
export const MAX_TIMERS = 10;

/** A thing the user wants to dedicate time to: a hobby, a category, a task.
 *  e.g. "Writing", "Cooking", "Studying". NOT a specific session — the bucket.
 *  A card OWNS a list of Timers (≤ MAX_TIMERS); the timers hold the actual
 *  mode/duration/alarm config and their own in-progress session. */
export interface Card {
  /** Stable, URL/CLI-safe identity. Also what an NFC tag maps to. Never changes. */
  id: string;
  /** Human label, e.g. "Crocheting". Free to rename. */
  name: string;
  /** Optional grouping, e.g. "hobby", "work". Purely organizational. */
  category: string | null;
  /** Hex color for UI, e.g. "#e8a", or null for a default. */
  color: string | null;
  /** Physical NFC tag UID once registered (e.g. "04:A2:..."), else null.
   *  Reserved from day one so a reader can do tag -> card lookup later. */
  nfcUid: string | null;
  /** When the card was created (epoch ms). */
  createdAt: number;
  /** Which timer loads when this card is slotted (the last one used). null if
   *  the card has no timers yet. */
  lastTimerId?: string | null;

  // ── Card-level extras (deadline is about the card, not a timer) ──
  /** Optional target date (epoch ms) for a day-count readout on the card. */
  deadline?: number | null;
  /** 'until' = days remaining to the date; 'since' = days elapsed from it
   *  (a streak / "day N"). Only meaningful when deadline is set. */
  deadlineKind?: DeadlineKind;
}

/** A reusable timer configuration that lives inside a card. A card can hold up
 *  to MAX_TIMERS of these (e.g. 5 countdowns + 2 stopwatches). Each carries its
 *  own in-progress session, so switching timers suspends one and resumes another. */
export interface Timer {
  /** Stable id, unique within its card. */
  id: string;
  cardId: string;
  /** User-given name, e.g. "Deep work", "Quick sprint", "Reading". */
  name: string;
  /** 'up' = stopwatch, 'down' = countdown. */
  mode: TimerMode;
  /** Countdown length in ms when mode is 'down'; null for 'up'. */
  targetMs: number | null;
  /** Alarm to play when a countdown finishes. */
  alarmStyle: AlarmStyle;
  /** This timer's held in-progress session (running OR paused/suspended), or
   *  null if idle. Switching away suspends it; switching back resumes it. */
  liveSession: Session | null;
  /** Position in the card's list (for stable ordering). */
  order: number;
  createdAt: number;
}

/** Alarm behavior at countdown zero. Mirrors a physical alarm-duration switch:
 *  a real chime, a short blip, or silent (visual pulse only). */
export type AlarmStyle = "chime" | "blip" | "silent";

/** Direction of a card's day-count. */
export type DeadlineKind = "until" | "since";

/** A normalized view of a card's deadline for rendering. */
export interface DayCount {
  /** Whole days remaining ('until') or elapsed ('since'). Never negative. */
  days: number;
  kind: DeadlineKind;
  /** True for 'until' when the date has passed (0 days, overdue). */
  passed: boolean;
}

/** One tracked stretch of time against a specific timer (on a card). Closed when ended. */
export interface Session {
  id: string;
  cardId: string;
  /** Which timer this session belongs to. */
  timerId: string;
  /** Direction: 'up' = open-ended stopwatch, 'down' = countdown to a target. */
  mode: TimerMode;
  /** For 'down' mode: the target duration in ms. null for 'up'. */
  targetMs: number | null;
  startedAt: number;
  /** null while running or paused; set when stopped. */
  endedAt: number | null;
  /** Sum of paused durations (ms), so elapsed excludes pauses. */
  pausedMs: number;
  /** If currently paused, when the pause began (epoch ms); else null. */
  pausedAt: number | null;
}

export type TimerMode = "up" | "down";

/** What the slotted card is doing right now. Drives the big button. */
export type RunState = "empty" | "ready" | "running" | "paused" | "finished";

/** The single "device slot": which card is in, and which of its timers is active.
 *  Exactly one card and one active timer at a time. The live session lives on the
 *  Timer (not here), so switching timers is suspend/resume, and the slot only
 *  needs to remember which timer is currently selected. */
export interface Slot {
  cardId: string | null;
  /** The currently selected timer on the slotted card, or null. */
  activeTimerId: string | null;
  /** When locked, the big button / stop ignore presses (prevents fat-finger
   *  stopping a running session). The lock toggle itself still works. */
  locked?: boolean;
}

/** A point-in-time snapshot for any interface to render. Pure derived data. */
export interface SlotView {
  state: RunState;
  card: Card | null;
  /** The active timer on the slotted card, or null if the card has none. */
  timer: Timer | null;
  /** All timers on the slotted card (for the picker), ordered. Empty if none. */
  timers: Timer[];
  /** Elapsed run time in ms (excludes paused time). For 'down', counts down from target. */
  elapsedMs: number;
  /** For 'down' mode, ms remaining (clamped at 0). null for 'up'. */
  remainingMs: number | null;
  mode: TimerMode | null;
  /** True the instant a countdown hits zero. Interfaces fire the "alarm" on this. */
  finished: boolean;
  /** Which alarm to play if finished (resolved from the active timer). */
  alarmStyle: AlarmStyle;
  /** Whether the slot is locked (presses ignored). */
  locked: boolean;
  /** The card's day-count, if it has a deadline set; else null. */
  dayCount: DayCount | null;
}

/** Storage contract. SQLite (CLI/Pi) and IndexedDB (web) each implement this.
 *  Deliberately tiny: the core holds all logic, adapters only persist. */
export interface Storage {
  // Cards
  createCard(card: Card): Promise<void>;
  getCard(id: string): Promise<Card | null>;
  listCards(): Promise<Card[]>;
  updateCard(card: Card): Promise<void>;
  deleteCard(id: string): Promise<void>;
  /** Find a card by its registered NFC tag UID. For the hardware bridge. */
  getCardByNfc(nfcUid: string): Promise<Card | null>;

  // Timers (live config + in-progress session live here)
  putTimer(timer: Timer): Promise<void>;
  getTimer(id: string): Promise<Timer | null>;
  /** All timers for a card, ordered by `order`. */
  listTimers(cardId: string): Promise<Timer[]>;
  deleteTimer(id: string): Promise<void>;

  // Sessions (history)
  putSession(session: Session): Promise<void>;
  listSessions(cardId?: string): Promise<Session[]>;

  // The single active slot (one row / one key).
  getSlot(): Promise<Slot>;
  setSlot(slot: Slot): Promise<void>;
}
