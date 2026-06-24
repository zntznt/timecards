// Core data model. Shared by every interface (CLI, web, future Pi/Arduino).
// Times are integer epoch milliseconds. Durations are integer milliseconds.
// We never store floats — drift-free and exact. ponytail: ints over floats, no rounding bugs.

/** A thing the user wants to dedicate time to: a hobby, a category, a task.
 *  e.g. "Writing", "Cooking", "Studying". NOT a specific session — the bucket. */
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

  // ── Per-card defaults & extras (all optional for back-compat with old rows) ──
  /** What pressing start does for THIS card by default: open stopwatch ('up')
   *  or a countdown ('down'). A session can still override it. Default 'up'. */
  defaultMode?: TimerMode;
  /** For a 'down' default: the countdown length in ms (e.g. 25 min). */
  defaultTargetMs?: number | null;
  /** Which alarm fires when a countdown on this card hits zero.
   *  Falls back to a global default if unset. */
  alarmStyle?: AlarmStyle;
  /** Optional target date (epoch ms) for a day-count readout on the card. */
  deadline?: number | null;
  /** 'until' = days remaining to the date; 'since' = days elapsed from it
   *  (a streak / "day N"). Only meaningful when deadline is set. */
  deadlineKind?: DeadlineKind;
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

/** One tracked stretch of time against a card. Closed when ended. */
export interface Session {
  id: string;
  cardId: string;
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

/** The single "device slot": which card is in, and its live session.
 *  Exactly one card occupies the slot at a time (by design). */
export interface Slot {
  cardId: string | null;
  /** The in-progress session for the slotted card, or null if none open. */
  session: Session | null;
  /** When locked, the big button / stop ignore presses (prevents fat-finger
   *  stopping a running session). The lock toggle itself still works. */
  locked?: boolean;
}

/** A point-in-time snapshot for any interface to render. Pure derived data. */
export interface SlotView {
  state: RunState;
  card: Card | null;
  /** Elapsed run time in ms (excludes paused time). For 'down', counts down from target. */
  elapsedMs: number;
  /** For 'down' mode, ms remaining (clamped at 0). null for 'up'. */
  remainingMs: number | null;
  mode: TimerMode | null;
  /** True the instant a countdown hits zero. Interfaces fire the "alarm" on this. */
  finished: boolean;
  /** Which alarm to play if finished (resolved from the card, or global default). */
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

  // Sessions (history)
  putSession(session: Session): Promise<void>;
  listSessions(cardId?: string): Promise<Session[]>;

  // The single active slot (one row / one key).
  getSlot(): Promise<Slot>;
  setSlot(slot: Slot): Promise<void>;
}
