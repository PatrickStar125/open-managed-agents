// Unit tests for SqlUsageStore — the OSS half of the hybrid resource-
// billing pipeline. Verifies recordUsage / listUnbilled / ack semantics
// against a real D1 (migrations auto-applied from
// wrangler.test.jsonc's migrations_dir).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
// Importing the test worker triggers its migrations bootstrap on first
// fetch — we trigger it explicitly in beforeAll so this unit-style test
// doesn't have to drive an HTTP route just to get the schema applied.
import worker from "../test-worker";
import {
  SqlUsageStore,
  createCfUsageStore,
  clampUsageValue,
  MAX_VALUE_PER_EMIT_SEC,
} from "@open-managed-agents/services";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

const TENANT_A = "t_a";
const TENANT_B = "t_b";

function db(): D1Database {
  return (env as { AUTH_DB: D1Database }).AUTH_DB;
}

beforeAll(async () => {
  // Health-check fetch drives the lazy migration bootstrap in test-worker.ts.
  await worker.fetch(
    new Request("http://localhost/health"),
    env as unknown as Record<string, unknown>,
    {} as ExecutionContext,
  );
});

beforeEach(async () => {
  await db().exec(`DELETE FROM usage_events`);
});

describe("SqlUsageStore — recordUsage", () => {
  it("writes a row with the supplied (tenant, session, kind, value)", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      agentId: "agent_x",
      kind: "sandbox_active_seconds",
      value: 60,
    });
    const r = await db()
      .prepare(`SELECT tenant_id, session_id, agent_id, kind, value, billed_at FROM usage_events WHERE tenant_id = ?`)
      .bind(TENANT_A)
      .all<{ tenant_id: string; session_id: string; agent_id: string; kind: string; value: number; billed_at: number | null }>();
    expect(r.results).toHaveLength(1);
    expect(r.results![0]).toMatchObject({
      tenant_id: TENANT_A,
      session_id: "sess1",
      agent_id: "agent_x",
      kind: "sandbox_active_seconds",
      value: 60,
      billed_at: null,
    });
  });

  it("clamps value at MAX_VALUE_PER_EMIT_SEC (24h)", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "session_alive_seconds",
      value: MAX_VALUE_PER_EMIT_SEC * 10, // 240h
    });
    const r = await db()
      .prepare(`SELECT value FROM usage_events WHERE tenant_id = ?`)
      .bind(TENANT_A)
      .first<{ value: number }>();
    expect(r?.value).toBe(MAX_VALUE_PER_EMIT_SEC);
  });

  it("skips the insert when value clamps to 0", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "sandbox_active_seconds",
      value: 0,
    });
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "sandbox_active_seconds",
      value: -5,
    });
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "sess1",
      kind: "sandbox_active_seconds",
      value: Number.NaN,
    });
    const r = await db()
      .prepare(`SELECT COUNT(*) AS c FROM usage_events`)
      .first<{ c: number }>();
    expect(r?.c).toBe(0);
  });
});

describe("SqlUsageStore — listUnbilled + ack", () => {
  it("listUnbilled returns ordered ASC by id, only unbilled, only for tenantId", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    // Three events for A, one for B
    for (let i = 0; i < 3; i++) {
      await store.recordUsage({
        tenantId: TENANT_A,
        sessionId: `sess_a_${i}`,
        kind: "sandbox_active_seconds",
        value: 10 + i,
      });
    }
    await store.recordUsage({
      tenantId: TENANT_B,
      sessionId: "sess_b",
      kind: "session_alive_seconds",
      value: 100,
    });

    const rowsA = await store.listUnbilled(TENANT_A, 0, 500);
    expect(rowsA).toHaveLength(3);
    expect(rowsA.map((r) => r.value)).toEqual([10, 11, 12]);
    expect(rowsA.every((r) => r.tenant_id === TENANT_A)).toBe(true);
    // Ascending id
    expect(rowsA[0].id).toBeLessThan(rowsA[1].id);

    const rowsB = await store.listUnbilled(TENANT_B, 0, 500);
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0].tenant_id).toBe(TENANT_B);
  });

  it("ack marks billed_at and excludes from subsequent listUnbilled", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    for (let i = 0; i < 3; i++) {
      await store.recordUsage({
        tenantId: TENANT_A,
        sessionId: `s${i}`,
        kind: "sandbox_active_seconds",
        value: 10,
      });
    }
    const before = await store.listUnbilled(TENANT_A, 0, 500);
    expect(before).toHaveLength(3);
    const idsToAck = [before[0].id, before[1].id];
    await store.ack(idsToAck);

    const after = await store.listUnbilled(TENANT_A, 0, 500);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before[2].id);
  });

  it("second ack of same ids is a no-op (doesn't bump billed_at)", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "s1",
      kind: "sandbox_active_seconds",
      value: 10,
    });
    const [row] = await store.listUnbilled(TENANT_A, 0, 500);
    await store.ack([row.id]);
    const firstBilledAt = await db()
      .prepare(`SELECT billed_at FROM usage_events WHERE id = ?`)
      .bind(row.id)
      .first<{ billed_at: number | null }>();
    expect(firstBilledAt?.billed_at).toBeGreaterThan(0);

    // small delay so a hypothetical re-ack would set a later timestamp
    await new Promise((res) => setTimeout(res, 5));
    await store.ack([row.id]);
    const secondBilledAt = await db()
      .prepare(`SELECT billed_at FROM usage_events WHERE id = ?`)
      .bind(row.id)
      .first<{ billed_at: number | null }>();
    expect(secondBilledAt?.billed_at).toBe(firstBilledAt?.billed_at);
  });

  it("listUnbilled honours the since cursor", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    for (let i = 0; i < 5; i++) {
      await store.recordUsage({
        tenantId: TENANT_A,
        sessionId: `s${i}`,
        kind: "sandbox_active_seconds",
        value: 10,
      });
    }
    const all = await store.listUnbilled(TENANT_A, 0, 500);
    const cursor = all[1].id;
    const after = await store.listUnbilled(TENANT_A, cursor, 500);
    expect(after.every((r) => r.id > cursor)).toBe(true);
    expect(after).toHaveLength(3);
  });

  it("listUnbilledTenants returns each tenant once", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    await store.recordUsage({ tenantId: TENANT_A, sessionId: "x", kind: "sandbox_active_seconds", value: 10 });
    await store.recordUsage({ tenantId: TENANT_A, sessionId: "y", kind: "session_alive_seconds", value: 10 });
    await store.recordUsage({ tenantId: TENANT_B, sessionId: "z", kind: "browser_active_seconds", value: 10 });
    const tenants = await store.listUnbilledTenants();
    const ids = tenants.map((t) => t.tenant_id).sort();
    expect(ids).toEqual([TENANT_A, TENANT_B]);
  });
});

describe("SqlUsageStore — historical attribution reads", () => {
  it("returns billed and unbilled rows inside an inclusive/exclusive period", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    const insert = db().prepare(
      `INSERT INTO usage_events
        (tenant_id, session_id, agent_id, kind, value, created_at, billed_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)`,
    );
    await db().batch([
      insert.bind(TENANT_A, "s1", "session_alive_seconds", 10, 1000, 2000),
      insert.bind(TENANT_A, "s1", "sandbox_active_seconds", 20, 2000, null),
      insert.bind(TENANT_A, "s2", "browser_active_seconds", 30, 3000, null),
      insert.bind(TENANT_A, "s1", "session_alive_seconds", 40, 4000, null),
      insert.bind(TENANT_B, "s1", "session_alive_seconds", 50, 2000, null),
    ]);

    const rows = await store.listUsage({
      tenantId: TENANT_A,
      startMs: 1000,
      endMs: 4000,
      afterId: 0,
      limit: 50,
    });

    expect(rows.map(({ session_id, value, billed_at }) => ({ session_id, value, billed_at })))
      .toEqual([
        { session_id: "s1", value: 10, billed_at: 2000 },
        { session_id: "s1", value: 20, billed_at: null },
        { session_id: "s2", value: 30, billed_at: null },
      ]);
  });

  it("isolates session scope and advances with the immutable id cursor", async () => {
    const store = new SqlUsageStore(new CfD1SqlClient(db()));
    const insert = db().prepare(
      `INSERT INTO usage_events
        (tenant_id, session_id, agent_id, kind, value, created_at, billed_at)
       VALUES (?, ?, NULL, 'session_alive_seconds', ?, 1000, NULL)`,
    );
    await db().batch([
      insert.bind(TENANT_A, "s1", 10),
      insert.bind(TENANT_A, "s2", 20),
      insert.bind(TENANT_A, "s1", 30),
    ]);

    const first = await store.listUsage({
      tenantId: TENANT_A,
      sessionId: "s1",
      startMs: 0,
      endMs: 2000,
      afterId: 0,
      limit: 1,
    });
    const second = await store.listUsage({
      tenantId: TENANT_A,
      sessionId: "s1",
      startMs: 0,
      endMs: 2000,
      afterId: first[0].id,
      limit: 1,
    });

    expect(first.map((row) => row.value)).toEqual([10]);
    expect(second.map((row) => row.value)).toEqual([30]);
  });
});

describe("createCfUsageStore + clampUsageValue helpers", () => {
  it("createCfUsageStore wires the same SqlUsageStore over CfD1SqlClient", async () => {
    const store = createCfUsageStore({ db: db() });
    await store.recordUsage({
      tenantId: TENANT_A,
      sessionId: "fac1",
      kind: "session_alive_seconds",
      value: 42,
    });
    const rows = await store.listUnbilled(TENANT_A, 0, 500);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(42);
  });

  it("clampUsageValue floors fractionals + clamps overage + zeroes garbage", () => {
    expect(clampUsageValue(60.7)).toBe(60);
    expect(clampUsageValue(MAX_VALUE_PER_EMIT_SEC + 1)).toBe(MAX_VALUE_PER_EMIT_SEC);
    expect(clampUsageValue(-1)).toBe(0);
    expect(clampUsageValue(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampUsageValue(Number.NaN)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// v2 — the itemized ledger (design: docs/usage-ledger-design.md).
// Migration 0024 must have applied for these to pass.
// ═══════════════════════════════════════════════════════════════════════

import type { LedgerEntryInput, LedgerQuery } from "@open-managed-agents/services";

function ledgerStore(): SqlUsageStore {
  return new SqlUsageStore(new CfD1SqlClient(db()));
}

function callEntry(overrides: Partial<LedgerEntryInput> = {}): LedgerEntryInput {
  return {
    tenantId: TENANT_A,
    sessionId: "sess_v2",
    kind: "model_call",
    value: 1,
    correlationId: `corr_${Math.random().toString(36).slice(2)}`,
    input_tokens: 1_000,
    cached_read_tokens: 4_000,
    output_tokens: 200,
    dimensions: { modelId: "claude-sonnet-4-6" },
    ...overrides,
  };
}

describe("SqlUsageStore — v2 recordLedger", () => {
  it("writes a model_call row with its full token economics", async () => {
    await ledgerStore().recordLedger([callEntry()]);
    const r = await db()
      .prepare(`SELECT kind, value, input_tokens, cached_read_tokens, output_tokens,
                       cached_write_tokens, model_id, correlation_id, schema_version
                  FROM usage_events WHERE tenant_id = ?`)
      .bind(TENANT_A)
      .first<{ kind: string; value: number; input_tokens: number; cached_read_tokens: number;
               output_tokens: number; cached_write_tokens: number | null; model_id: string;
               correlation_id: string; schema_version: number }>();
    expect(r).toMatchObject({
      kind: "model_call",
      value: 1,
      input_tokens: 1_000,
      cached_read_tokens: 4_000,
      output_tokens: 200,
      cached_write_tokens: null,
      model_id: "claude-sonnet-4-6",
      schema_version: 2,
    });
    expect(r!.correlation_id).toMatch(/^corr_/);
  });

  it("is exactly-once: a redelivered correlation_id collapses to one row", async () => {
    const e = callEntry({ correlationId: "corr_dedupe_1" });
    const s = ledgerStore();
    await s.recordLedger([e]);
    await s.recordLedger([e]); // at-least-once redelivery
    await s.recordLedger([e]); // and again
    const r = await db()
      .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE correlation_id = ?`)
      .bind("corr_dedupe_1")
      .first<{ n: number }>();
    expect(r!.n).toBe(1);
  });

  it("clamps seconds but NEVER token measures (per-kind validation)", async () => {
    const s = ledgerStore();
    // A 10-day seconds emit clamps at 86,400…
    await s.recordLedger([callEntry({
      kind: "sandbox_active_seconds",
      value: 864_000,
      input_tokens: undefined, cached_read_tokens: undefined, output_tokens: undefined,
      dimensions: { runtimeId: "cloudflare-sandbox" },
      interval: { startMs: 1, endMs: 2 },
    })]);
    // …but a 10-million-token call passes through untouched.
    await s.recordLedger([callEntry({ input_tokens: 10_000_000, correlationId: "corr_big_tokens" })]);
    const clamped = await db()
      .prepare(`SELECT value FROM usage_events WHERE kind = 'sandbox_active_seconds' AND tenant_id = ?`)
      .bind(TENANT_A).first<{ value: number }>();
    const tokens = await db()
      .prepare(`SELECT input_tokens FROM usage_events WHERE correlation_id = 'corr_big_tokens'`)
      .first<{ input_tokens: number }>();
    expect(clamped!.value).toBe(86_400);
    expect(tokens!.input_tokens).toBe(10_000_000);
  });

  it("drops invalid rows instead of reshaping them", async () => {
    const s = ledgerStore();
    await s.recordLedger([
      callEntry({ correlationId: "corr_neg", input_tokens: -5 }),
      callEntry({ correlationId: "corr_frac", input_tokens: 10.5 }),
      callEntry({ correlationId: "corr_badval", value: -1 }),
      callEntry({ correlationId: "corr_zero", value: 0 }),
    ]);
    const r = await db()
      .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE correlation_id LIKE 'corr_%'`)
      .first<{ n: number }>();
    expect(r!.n).toBe(0);
  });
});

describe("SqlUsageStore — v2 query", () => {
  beforeEach(async () => {
    const s = ledgerStore();
    const entries: LedgerEntryInput[] = [];
    for (let i = 0; i < 12; i++) {
      entries.push(callEntry({
        correlationId: `corr_q_${i}`,
        sessionId: i % 2 === 0 ? "sess_even" : "sess_odd",
        agentId: i < 6 ? "agent_r" : "agent_d",
        dimensions: { modelId: i < 4 ? "gpt-5" : "claude-sonnet-4-6" },
      }));
    }
    await s.recordLedger(entries);
  });

  function q(overrides: Partial<LedgerQuery> = {}): LedgerQuery {
    return { tenantId: TENANT_A, fromMs: 0, toMs: Date.now() + 1000, limit: 5, ...overrides };
  }

  it("pages newest-first with a cursor and a filter-scoped total", async () => {
    const s = ledgerStore();
    const p1 = await s.query(q());
    expect(p1.rows).toHaveLength(5);
    expect(p1.completeness).toBe("complete");
    expect(p1.projectionLagMs).toBe(0);
    expect(p1.total).toBe(12);
    // newest-first: strictly descending ids
    const ids = p1.rows.map((r) => r.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(p1.nextCursor).toBe(String(ids[ids.length - 1]));

    const p2 = await s.query(q({ cursor: p1.nextCursor! }));
    expect(p2.rows).toHaveLength(5);
    expect(p2.rows[0].id).toBeLessThan(ids[ids.length - 1]);
    expect(p2.total).toBe(12); // total ignores the cursor
  });

  it("filters by session, agent, kind, and dimension columns", async () => {
    const s = ledgerStore();
    expect((await s.query(q({ sessionId: "sess_even", limit: 50 }))).total).toBe(6);
    expect((await s.query(q({ agentId: "agent_r", limit: 50 }))).total).toBe(6);
    expect((await s.query(q({ kind: "model_call", limit: 50 }))).total).toBe(12);
    expect((await s.query(q({ modelId: "gpt-5", limit: 50 }))).total).toBe(4);
    expect((await s.query(q({ sessionId: "sess_even", agentId: "agent_d", limit: 50 }))).total).toBe(3);
  });

  it("returns rowKind detail rows carrying the contract columns", async () => {
    const s = ledgerStore();
    const page = await s.query(q({ limit: 1 }));
    const row = page.rows[0];
    expect(row.rowKind).toBe("detail");
    expect(row.correlation_id).toMatch(/^corr_q_/);
    expect(row.model_id).toBeTruthy();
    expect(row.billed_at).toBeNull();
  });
});

describe("SqlUsageStore — v2 describe/listKinds", () => {
  it("declares the baseline SQL store honestly: forever detail, no rollup, no lag", async () => {
    const s = ledgerStore();
    expect(s.describe()).toEqual({
      detailRetentionDays: 0,
      rollupGranularity: "none",
      maxProjectionLagMs: 0,
    });
    expect(s.listKinds()).toEqual([
      { kind: "session_alive_seconds", unit: "s" },
      { kind: "sandbox_active_seconds", unit: "s" },
      { kind: "browser_active_seconds", unit: "s" },
      { kind: "model_call", unit: "call" },
      { kind: "tool_use", unit: "call" },
    ]);
  });
});

// ── Phase 3: q substring + dailyRollup (the dashboard projection) ────────

describe("SqlUsageStore — v2 query q (session substring)", () => {
  it("matches session ids by substring, and totals follow", async () => {
    const s = ledgerStore();
    await s.recordLedger([
      callEntry({ sessionId: "sess_alpha", correlationId: "cq1" }),
      callEntry({ sessionId: "sess_beta", correlationId: "cq2" }),
      callEntry({ sessionId: "sess_alpha_2", correlationId: "cq3" }),
    ]);
    const p = await s.query({
      tenantId: TENANT_A, fromMs: 0, toMs: Date.now() + 1000,
      q: "alpha", limit: 10,
    });
    expect(p.total).toBe(2);
    expect(p.rows.every((r) => r.session_id.includes("alpha"))).toBe(true);
  });
});

describe("SqlUsageStore — v2 dailyRollup", () => {
  beforeEach(async () => {
    const s = ledgerStore();
    const today = new Date().toISOString().slice(0, 10);
    // Two sessions, two models, one sandbox window; v1 seconds row mixed in.
    await s.recordLedger([
      callEntry({ sessionId: "sess_r1", agentId: "agent_r", correlationId: "r1a",
        input_tokens: 1000, cached_read_tokens: 3000, output_tokens: 100,
        dimensions: { modelId: "gpt-5" } }),
      callEntry({ sessionId: "sess_r1", agentId: "agent_r", correlationId: "r1b",
        input_tokens: 500, cached_read_tokens: 1000, output_tokens: 50,
        dimensions: { modelId: "claude-sonnet-4-6" } }),
      callEntry({ sessionId: "sess_r2", agentId: "agent_d", correlationId: "r2a",
        input_tokens: 200, cached_read_tokens: 0, output_tokens: 20,
        dimensions: { modelId: "gpt-5" } }),
      { tenantId: TENANT_A, sessionId: "sess_r1", agentId: "agent_r",
        kind: "sandbox_active_seconds", value: 120, // 2 minutes
        correlationId: `sbx:sess_r1:${Date.parse(`${today}T00:00:00Z`)}`,
        interval: { startMs: Date.parse(`${today}T00:00:00Z`), endMs: Date.parse(`${today}T00:00:00Z`) + 120_000 },
        dimensions: { runtimeId: "cloudflare-sandbox" } },
    ]);
    // A v1-style row (recordUsage) must still count in the rollup.
    await s.recordUsage({ tenantId: TENANT_A, sessionId: "sess_r2", agentId: "agent_d",
      kind: "session_alive_seconds", value: 600 });
  });

  it("aggregates totals, day buckets, and the three breakdowns", async () => {
    const s = ledgerStore();
    const r = await s.dailyRollup({ tenantId: TENANT_A, fromMs: 0, toMs: Date.now() + 86_400_000 });
    expect(r.totals).toMatchObject({
      sessions: 2, model_calls: 3, input_tokens: 1700,
      cached_read_tokens: 4000, output_tokens: 170, sandbox_minutes: 2,
    });
    expect(r.daily).toHaveLength(1);
    expect(r.daily[0].model_calls).toBe(3);
    const gpt5 = r.by_model.find((m) => m.model_id === "gpt-5");
    expect(gpt5).toMatchObject({ model_calls: 2, input_tokens: 1200 });
    const agentR = r.by_agent.find((a) => a.agent_id === "agent_r");
    expect(agentR).toMatchObject({ sessions: 1, input_tokens: 1500, sandbox_minutes: 2 });
    expect(agentR!.agent_name).toBe("agent_r"); // id-as-name shortcut
    expect(r.by_sandbox[0]).toMatchObject({
      runtime_id: "cloudflare-sandbox", sessions: 1, sandbox_minutes: 2,
    });
  });

  it("respects the time window (rows outside excluded)", async () => {
    const s = ledgerStore();
    const future = await s.dailyRollup({
      tenantId: TENANT_A, fromMs: Date.now() + 86_400_000, toMs: Date.now() + 2 * 86_400_000,
    });
    expect(future.totals.model_calls).toBe(0);
    // Empty window: no data days in range → no rows at all.
    expect(future.daily).toHaveLength(0);
  });
});
