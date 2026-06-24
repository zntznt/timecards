// Supabase storage adapter — opt-in cloud sync, shared by CLI/Pi and the web.
// Implements the SAME Storage interface as SqliteStore and IdbStore, so the core,
// timer logic, big button, and every view are identical. Only persistence differs.
//
// The query code below is runtime-agnostic: it takes an already-created supabase
// client. The ONLY thing that differs between Node and the browser is where that
// client's `createClient` is imported from — see makeSupabaseStoreNode (Node) and
// the web settings code (browser, CDN import). Schema: sql/supabase.sql.
//
// Supabase v2 calls never reject — they resolve to { data, error }. We throw on
// `error` so failures surface loudly rather than silently corrupting state.

                                                                      

/** The subset of the supabase-js client we use. Kept minimal so either runtime's
 *  client (Node import or browser CDN import) satisfies it without type wrangling. */
                                     
                           
 

const SLOT_ID = 0; // single-row slot table, id always 0

export class SupabaseStore                    {
          sb                    ;
  constructor(client                    ) { this.sb = client; }

  /** Throw on a Supabase error so callers don't proceed on a failed write. */
          check   (res                         )    {
    if (res.error) throw new Error(`supabase: ${res.error.message ?? res.error}`);
    return res.data;
  }

  // ── row <-> model mapping (snake_case columns) ────────────────
          toCard(r     )       {
    return { id: r.id, name: r.name, category: r.category, color: r.color, nfcUid: r.nfc_uid,
             createdAt: r.created_at, lastTimerId: r.last_timer_id ?? null,
             deadline: r.deadline ?? null, deadlineKind: r.deadline_kind ?? "until" };
  }
          cardRow(c      ) {
    return { id: c.id, name: c.name, category: c.category, color: c.color, nfc_uid: c.nfcUid,
             created_at: c.createdAt, last_timer_id: c.lastTimerId ?? null,
             deadline: c.deadline ?? null, deadline_kind: c.deadlineKind ?? "until" };
  }
          toTimer(r     )        {
    return { id: r.id, cardId: r.card_id, name: r.name, mode: r.mode, targetMs: r.target_ms,
             alarmStyle: r.alarm_style, liveSession: r.live_session ?? null, order: r.ord, createdAt: r.created_at };
  }
          timerRow(t       ) {
    return { id: t.id, card_id: t.cardId, name: t.name, mode: t.mode, target_ms: t.targetMs,
             alarm_style: t.alarmStyle, live_session: t.liveSession, ord: t.order, created_at: t.createdAt };
  }
          toSession(r     )          {
    return { id: r.id, cardId: r.card_id, timerId: r.timer_id, mode: r.mode, targetMs: r.target_ms,
             startedAt: r.started_at, endedAt: r.ended_at, pausedMs: r.paused_ms, pausedAt: r.paused_at };
  }
          sessionRow(s         ) {
    return { id: s.id, card_id: s.cardId, timer_id: s.timerId, mode: s.mode, target_ms: s.targetMs,
             started_at: s.startedAt, ended_at: s.endedAt, paused_ms: s.pausedMs, paused_at: s.pausedAt };
  }

  // ── Cards ─────────────────────────────────────────────────────
  async createCard(c      ) { this.check(await this.sb.from("cards").insert(this.cardRow(c))); }
  async getCard(id        ) {
    const d = this.check(await this.sb.from("cards").select("*").eq("id", id).maybeSingle());
    return d ? this.toCard(d) : null;
  }
  async listCards() {
    const d = this.check(await this.sb.from("cards").select("*").order("created_at")) ?? [];
    return d.map((r     ) => this.toCard(r));
  }
  async updateCard(c      ) { this.check(await this.sb.from("cards").update(this.cardRow(c)).eq("id", c.id)); }
  async deleteCard(id        ) {
    this.check(await this.sb.from("sessions").delete().eq("card_id", id));
    this.check(await this.sb.from("timers").delete().eq("card_id", id));
    this.check(await this.sb.from("cards").delete().eq("id", id));
  }
  async getCardByNfc(uid        ) {
    const d = this.check(await this.sb.from("cards").select("*").eq("nfc_uid", uid).maybeSingle());
    return d ? this.toCard(d) : null;
  }

  // ── Timers (upsert: insert-or-replace by id) ──────────────────
  async putTimer(t       ) { this.check(await this.sb.from("timers").upsert(this.timerRow(t))); }
  async getTimer(id        ) {
    const d = this.check(await this.sb.from("timers").select("*").eq("id", id).maybeSingle());
    return d ? this.toTimer(d) : null;
  }
  async listTimers(cardId        ) {
    const d = this.check(await this.sb.from("timers").select("*").eq("card_id", cardId).order("ord")) ?? [];
    return d.map((r     ) => this.toTimer(r));
  }
  async deleteTimer(id        ) { this.check(await this.sb.from("timers").delete().eq("id", id)); }

  // ── Sessions ──────────────────────────────────────────────────
  async putSession(s         ) { this.check(await this.sb.from("sessions").upsert(this.sessionRow(s))); }
  async listSessions(cardId         ) {
    let q = this.sb.from("sessions").select("*").order("started_at");
    if (cardId) q = q.eq("card_id", cardId);
    const d = this.check(await q) ?? [];
    return d.map((r     ) => this.toSession(r));
  }

  // ── Slot (single row, id = 0) ─────────────────────────────────
  async getSlot()                {
    const r = this.check(await this.sb.from("slot").select("*").eq("id", SLOT_ID).maybeSingle());
    return { cardId: r?.card_id ?? null, activeTimerId: r?.active_timer_id ?? null, locked: !!r?.locked };
  }
  async setSlot(slot      ) {
    this.check(await this.sb.from("slot").upsert({
      id: SLOT_ID, card_id: slot.cardId, active_timer_id: slot.activeTimerId, locked: !!slot.locked,
    }));
  }
}

/** Node/CLI factory: dynamically import supabase-js (the npm package) and wrap it.
 *  Browser builds DON'T use this — they import createClient from the esm.sh CDN
 *  and pass the client to `new SupabaseStore(client)` directly. */
export async function makeSupabaseStoreNode(url        , anonKey        )                         {
  let createClient     ;
  try {
    ({ createClient } = await import("@supabase/supabase-js"));
  } catch {
    throw new Error(
      "Supabase sync needs the @supabase/supabase-js package. Install it:\n" +
      "  npm install @supabase/supabase-js\n" +
      "(or unset TIMECARDS_SUPABASE_URL/_KEY to use the local SQLite store)",
    );
  }
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return new SupabaseStore(client);
}
