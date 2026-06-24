// Self-check for SupabaseStore: `node core/supabase-store.test.ts`.
// Uses a FAKE supabase client that mimics the v2 { data, error } query-builder API
// over in-memory tables — so we verify the adapter calls the right methods and
// round-trips, without a real Supabase project. Then we run the full Device flow
// through it to prove it satisfies the Storage contract.

import assert from "node:assert/strict";
import type { Card, Timer, Session } from "./types.ts";
import { SupabaseStore } from "./supabase-store.ts";
import { Device } from "./device.ts";

// ── a tiny fake of supabase-js: from(table).select/insert/update/upsert/delete ──
// Supports .eq().order().maybeSingle() chaining and returns { data, error }.
class FakeTable {
  rows: any[] = [];
  pk: string;
  constructor(pk = "id") { this.pk = pk; }
}
class Query {
  private filters: Array<[string, any]> = [];
  private orderBy: string | null = null;
  private table: FakeTable;
  private op: string;
  private payload: any;
  constructor(table: FakeTable, op: string, payload?: any) { this.table = table; this.op = op; this.payload = payload; }
  eq(col: string, val: any) { this.filters.push([col, val]); return this; }
  order(col: string) { this.orderBy = col; return this; }
  private match(r: any) { return this.filters.every(([c, v]) => r[c] === v); }

  private run() {
    const t = this.table;
    if (this.op === "insert") {
      const row = this.payload;
      if (t.rows.some(r => r[t.pk] === row[t.pk])) return { data: null, error: { message: "duplicate key", code: "23505" } };
      t.rows.push({ ...row }); return { data: null, error: null };
    }
    if (this.op === "upsert") {
      const row = this.payload;
      const i = t.rows.findIndex(r => r[t.pk] === row[t.pk]);
      if (i >= 0) t.rows[i] = { ...row }; else t.rows.push({ ...row });
      return { data: null, error: null };
    }
    if (this.op === "update") {
      for (const r of t.rows) if (this.match(r)) Object.assign(r, this.payload);
      return { data: null, error: null };
    }
    if (this.op === "delete") {
      t.rows = t.rows.filter(r => !this.match(r));
      return { data: null, error: null };
    }
    // select
    let rows = t.rows.filter(r => this.match(r));
    if (this.orderBy) rows = [...rows].sort((a, b) => (a[this.orderBy!] > b[this.orderBy!] ? 1 : -1));
    return { data: rows.map(r => ({ ...r })), error: null };
  }
  // thenable so `await query` resolves like supabase-js
  then(resolve: any) { resolve(this.run()); }
  maybeSingle() {
    const { data, error } = this.run() as any;
    return Promise.resolve({ data: error ? null : (data[0] ?? null), error });
  }
}
class FakeClient {
  tables: Record<string, FakeTable> = {
    cards: new FakeTable("id"), timers: new FakeTable("id"),
    sessions: new FakeTable("id"), slot: new FakeTable("id"),
  };
  from(name: string) {
    const t = this.tables[name];
    return {
      select: (_c?: string) => new Query(t, "select"),
      insert: (row: any) => new Query(t, "insert", row),
      upsert: (row: any) => new Query(t, "upsert", row),
      update: (row: any) => new Query(t, "update", row),
      delete: () => new Query(t, "delete"),
    };
  }
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`  ok  ${name}`); }

await test("SupabaseStore round-trips a card via the fake client", async () => {
  const store = new SupabaseStore(new FakeClient());
  const card: Card = { id: "x", name: "X", category: null, color: null, nfcUid: "04:AA",
    createdAt: 1, lastTimerId: null, deadline: null, deadlineKind: "until" };
  await store.createCard(card);
  assert.equal((await store.getCard("x"))?.name, "X");
  assert.equal((await store.getCardByNfc("04:AA"))?.id, "x");
  assert.equal(await store.getCard("nope"), null);          // maybeSingle -> null
  await store.updateCard({ ...card, name: "Renamed" });
  assert.equal((await store.getCard("x"))?.name, "Renamed");
});

await test("createCard surfaces a duplicate-key error (does not swallow)", async () => {
  const store = new SupabaseStore(new FakeClient());
  const card: Card = { id: "x", name: "X", category: null, color: null, nfcUid: null,
    createdAt: 1, lastTimerId: null, deadline: null, deadlineKind: "until" };
  await store.createCard(card);
  await assert.rejects(() => store.createCard(card), /supabase: duplicate key/);
});

await test("full Device flow works through SupabaseStore", async () => {
  const dev = new Device(new SupabaseStore(new FakeClient()),
    (() => { let t = 1000; return () => (t += 1000); })(),
    (() => { let n = 0; return () => `id${n++}`; })());
  const card = await dev.createCard("Hobby");
  const t2 = await dev.addTimer(card.id, { name: "Pomodoro", mode: "down", targetMs: 25 * 60000 });
  await dev.slot(card.id);
  await dev.press();                                  // start seeded stopwatch
  await dev.switchTimer(t2.id);                        // suspend it, activate pomo
  assert.equal((await dev.view()).timer?.name, "Pomodoro");
  await dev.switchTimer((await dev.listTimers(card.id))[0].id);
  assert.equal((await dev.view()).state, "paused");    // stopwatch suspended, not lost
  assert.equal((await dev.listTimers(card.id)).length, 2);
});

console.log(`\n${passed} supabase-store checks passed.`);
