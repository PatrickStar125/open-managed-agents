// Hybrid resource-billing — OSS-side usage event recorder.
//
// OSS counts raw resource usage in INTEGER seconds and writes one row per
// resource-emit into per-tenant `usage_events`. The hosted billing worker
// (managed-agents-billing) pulls unbilled rows via the internal HTTP API,
// applies a rate map, debits credit_ledger, then ack's the ids. Rates,
// money, ledger — all hosted. OSS knows none of it.
//
// Three resource kinds today:
//   session_alive_seconds   — wall-clock from session create to terminate
//   sandbox_active_seconds  — container running (start → stop)
//   browser_active_seconds  — Playwright Page open (first call → close)
//
// Why a thin SqlClient port (and not direct D1 here): keeps this file
// runtime-agnostic. CF impl below uses CfD1SqlClient; a future Node +
// Postgres deployment can wire createPgUsageStore({ pg }) without
// touching call sites in apps/agent.
//
// 24-hour clamp: each emit is bounded to MAX_VALUE_PER_EMIT_SEC to defend
// against bugs (clock skew, missed onStop, lost session_id) producing
// runaway bills. Cron sweep follow-up (slicing long-running sessions
// every 24h) is TODO — see SessionDO TODO.

import type { SqlClient } from "@open-managed-agents/sql-client";
import { CfD1SqlClient } from "@open-managed-agents/sql-client/adapters/cf-d1";

export type UsageKind =
  | "session_alive_seconds"
  | "sandbox_active_seconds"
  | "browser_active_seconds";

/** Hard ceiling on a single emit. 24h × 3600 = 86400. */
export const MAX_VALUE_PER_EMIT_SEC = 24 * 3600;

export interface UsageEventInput {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  kind: UsageKind;
  /** Seconds; non-finite, negative, or >MAX_VALUE_PER_EMIT_SEC are clamped. */
  value: number;
}

export interface UsageEventRow {
  id: number;
  tenant_id: string;
  session_id: string;
  agent_id: string | null;
  kind: UsageKind;
  value: number;
  created_at: number;
  billed_at: number | null;
}

export interface UsageHistoryQuery {
  tenantId: string;
  sessionId?: string;
  /** Inclusive event timestamp lower bound. */
  startMs: number;
  /** Exclusive event timestamp upper bound. */
  endMs: number;
  /** Immutable event id cursor; only rows with id greater than this are returned. */
  afterId: number;
  limit: number;
  signal?: AbortSignal;
}

export interface UsageStore {
  /** Insert one row. No-op if value clamps to 0. */
  recordUsage(e: UsageEventInput): Promise<void>;
  /**
   * Return up to `limit` unbilled rows for `tenantId` with id > `since`.
   * Ordered by id ASC so the billing worker can checkpoint with a single
   * cursor. Pass since=0 to fetch from the beginning.
   */
  listUnbilled(tenantId: string, since: number, limit: number): Promise<UsageEventRow[]>;
  /**
   * Read the immutable usage ledger for attribution and reconciliation.
   * Unlike listUnbilled this intentionally includes acknowledged rows: billing
   * status must never erase historical usage from a cost report.
   */
  listUsage(query: UsageHistoryQuery): Promise<UsageEventRow[]>;
  /**
   * Return DISTINCT tenant_ids that have at least one unbilled event on
   * this store. Used by the billing reconcile API's cross-shard fan-out
   * to discover which tenants on each shard have work pending — without
   * the caller having to pre-enumerate the tenant set.
   */
  listUnbilledTenants(): Promise<Array<{ tenant_id: string }>>;
  /** Mark the given ids as billed. Idempotent — re-acking already-acked rows is a no-op. */
  ack(ids: number[]): Promise<void>;
}

/** Sanitize an emit value into a non-negative integer ≤ MAX_VALUE_PER_EMIT_SEC. */
export function clampUsageValue(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  const v = Math.floor(raw);
  return v > MAX_VALUE_PER_EMIT_SEC ? MAX_VALUE_PER_EMIT_SEC : v;
}

/**
 * SQL-backed UsageStore. Constructed against a SqlClient — works on D1
 * (CfD1SqlClient), better-sqlite3 (Node tests), or postgres.js (future
 * Node+pg). Column names match migration 0017_usage_events.sql.
 */
export class SqlUsageStore implements UsageStore, LedgerStore {
  constructor(private readonly client: SqlClient) {}

  async recordUsage(e: UsageEventInput): Promise<void> {
    const value = clampUsageValue(e.value);
    if (value <= 0) return;
    await this.client
      .prepare(
        `INSERT INTO usage_events (tenant_id, session_id, agent_id, kind, value, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(e.tenantId, e.sessionId, e.agentId ?? null, e.kind, value, Date.now())
      .run();
  }

  async listUnbilledTenants(): Promise<Array<{ tenant_id: string }>> {
    const r = await this.client
      .prepare(
        `SELECT DISTINCT tenant_id FROM usage_events WHERE billed_at IS NULL`,
      )
      .all<{ tenant_id: string }>();
    return r.results ?? [];
  }

  async listUnbilled(
    tenantId: string,
    since: number,
    limit: number,
  ): Promise<UsageEventRow[]> {
    const cap = Math.max(1, Math.min(5000, Math.floor(limit) || 500));
    const r = await this.client
      .prepare(
        `SELECT id, tenant_id, session_id, agent_id, kind, value, created_at, billed_at
           FROM usage_events
          WHERE tenant_id = ? AND billed_at IS NULL AND id > ?
          ORDER BY id ASC
          LIMIT ?`,
      )
      .bind(tenantId, since, cap)
      .all<UsageEventRow>();
    return r.results ?? [];
  }

  async listUsage(query: UsageHistoryQuery): Promise<UsageEventRow[]> {
    query.signal?.throwIfAborted();
    const cap = Math.max(1, Math.min(5000, Math.floor(query.limit) || 500));
    const sessionClause = query.sessionId ? " AND session_id = ?" : "";
    const bindings: unknown[] = [
      query.tenantId,
      query.startMs,
      query.endMs,
      query.afterId,
    ];
    if (query.sessionId) bindings.push(query.sessionId);
    bindings.push(cap);
    const r = await this.client
      .prepare(
        `SELECT id, tenant_id, session_id, agent_id, kind, value, created_at, billed_at
           FROM usage_events
          WHERE tenant_id = ?
            AND created_at >= ? AND created_at < ?
            AND id > ?${sessionClause}
          ORDER BY id ASC
          LIMIT ?`,
      )
      .bind(...bindings)
      .all<UsageEventRow>();
    query.signal?.throwIfAborted();
    return r.results ?? [];
  }

  async ack(ids: number[]): Promise<void> {
    if (!ids.length) return;
    // Filter out non-integers + dedupe so a hostile payload can't smuggle
    // SQL via JSON parsing. Chunk into batches of 100 — D1 caps bound
    // params per statement. Each statement is idempotent (only marks
    // currently-unbilled rows; second ack of same id is a no-op).
    const clean = Array.from(
      new Set(
        ids.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0),
      ),
    );
    if (!clean.length) return;
    const now = Date.now();
    const CHUNK = 100;
    for (let i = 0; i < clean.length; i += CHUNK) {
      const batch = clean.slice(i, i + CHUNK);
      const placeholders = batch.map(() => "?").join(",");
      await this.client
        .prepare(
          `UPDATE usage_events
              SET billed_at = ?
            WHERE billed_at IS NULL AND id IN (${placeholders})`,
        )
        .bind(now, ...batch)
        .run();
    }
  }

  // ── v2 ledger methods (see the v2 section at the bottom of this file) ─

  async recordLedger(entries: LedgerEntryInput[]): Promise<void> {
    for (const raw of entries) {
      const e = normalizeLedgerEntry(raw);
      if (!e) continue; // dropped, never reshaped
      // INSERT OR IGNORE implements exactly-once rows: the partial
      // UNIQUE(correlation_id) collapses at-least-once redeliveries.
      // All other constraints are validated client-side above.
      await this.client
        .prepare(
          `INSERT OR IGNORE INTO usage_events
             (tenant_id, session_id, agent_id, kind, value, created_at,
              correlation_id, interval_start_ms, interval_end_ms,
              input_tokens, cached_read_tokens, output_tokens, cached_write_tokens,
              model_id, tool_name, runtime_id, schema_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2)`,
        )
        .bind(
          e.tenantId,
          e.sessionId,
          e.agentId ?? null,
          e.kind,
          e.value,
          Date.now(),
          e.correlationId,
          e.interval?.startMs ?? null,
          e.interval?.endMs ?? null,
          e.input_tokens ?? null,
          e.cached_read_tokens ?? null,
          e.output_tokens ?? null,
          e.cached_write_tokens ?? null,
          e.dimensions?.modelId ?? null,
          e.dimensions?.toolName ?? null,
          e.dimensions?.runtimeId ?? null,
        )
        .run();
    }
  }

  async query(q: LedgerQuery): Promise<LedgerPage> {
    const cap = Math.max(1, Math.min(5000, Math.floor(q.limit) || 25));
    const conds = ["tenant_id = ?", "created_at >= ?", "created_at < ?"];
    const binds: unknown[] = [q.tenantId, q.fromMs, q.toMs];
    if (q.sessionId) {
      conds.push("session_id = ?");
      binds.push(q.sessionId);
    }
    if (q.agentId) {
      conds.push("agent_id = ?");
      binds.push(q.agentId);
    }
    if (q.modelId) {
      conds.push("model_id = ?");
      binds.push(q.modelId);
    }
    if (q.runtimeId) {
      conds.push("runtime_id = ?");
      binds.push(q.runtimeId);
    }
    if (q.kind) {
      conds.push("kind = ?");
      binds.push(q.kind);
    }
    if (q.q) {
      // Escape LIKE wildcards so %/_ in user input match literally.
      // ESCAPE char is a single backslash; input wildcards get one too.
      conds.push(`session_id LIKE ? ESCAPE '\\'`);
      binds.push(`%${q.q.replace(/[%_\\]/g, "\\$&")}%`);
    }
    const where = conds.join(" AND ");

    // Newest-first; cursor is the prior page's last row id. An invalid
    // cursor degrades to the first page rather than erroring. The
    // cursor bind is always appended LAST, so the COUNT below can
    // slice it off — totals are filter-scoped, never page-scoped.
    let cursorBound = false;
    if (q.cursor) {
      const cur = Number(q.cursor);
      if (Number.isInteger(cur) && cur > 0) {
        conds.push("id < ?");
        binds.push(cur);
        cursorBound = true;
      }
    }
    const rowsSql = `SELECT ${LEDGER_COLUMNS} FROM usage_events
       WHERE ${conds.join(" AND ")} ORDER BY id DESC LIMIT ?`;
    const r = await this.client
      .prepare(rowsSql)
      .bind(...binds, cap)
      .all<Omit<LedgerRow, "rowKind">>();
    const rows = (r.results ?? []).map((row) => ({ ...row, rowKind: "detail" as const }));

    const totalBinds = cursorBound ? binds.slice(0, -1) : binds;
    const c = await this.client
      .prepare(`SELECT COUNT(*) AS total FROM usage_events WHERE ${where}`)
      .bind(...totalBinds)
      .first<{ total: number }>();

    return {
      rows,
      nextCursor: rows.length === cap ? String(rows[rows.length - 1].id) : null,
      // Single-tier store: everything is detail, writes are direct.
      completeness: "complete",
      projectionLagMs: 0,
      total: c?.total ?? rows.length,
    };
  }

  /**
   * Day-bucketed rollup over the ledger — the dashboard's projection,
   * computed at read time (GROUP BY over the indexed table; no
   * materialized usage_daily until a workload needs one).
   */
  async dailyRollup(q: {
    tenantId: string;
    fromMs: number;
    toMs: number;
  }): Promise<LedgerRollup> {
    const range = [q.tenantId, q.fromMs, q.toMs];
    const day = await this.client
      .prepare(
        `SELECT date(created_at / 1000, 'unixepoch') AS date,
                COUNT(DISTINCT session_id) AS sessions,
                SUM(CASE WHEN kind = 'model_call' THEN 1 ELSE 0 END) AS model_calls,
                SUM(CASE WHEN kind = 'model_call' THEN COALESCE(input_tokens, 0) END) AS input_tokens,
                SUM(CASE WHEN kind = 'model_call' THEN COALESCE(output_tokens, 0) END) AS output_tokens,
                SUM(CASE WHEN kind = 'model_call' THEN COALESCE(cached_read_tokens, 0) END) AS cached_read_tokens,
                ROUND(SUM(CASE WHEN kind = 'sandbox_active_seconds' THEN value ELSE 0 END) / 60.0) AS sandbox_minutes
           FROM usage_events
          WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
          GROUP BY date ORDER BY date`,
      )
      .bind(...range)
      .all<LedgerDailyRow>();
    const daily = (day.results ?? []).map((r) => ({
      ...r,
      sessions: r.sessions ?? 0,
      model_calls: r.model_calls ?? 0,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      cached_read_tokens: r.cached_read_tokens ?? 0,
      sandbox_minutes: r.sandbox_minutes ?? 0,
    }));
    // Zero-fill the requested window: GROUP BY only yields days with
    // rows, and the dashboard's chart spaces points by index — missing
    // days would compress the timeline instead of showing the gap.
    const byDate = new Map(daily.map((d) => [d.date, d]));
    const filled: LedgerDailyRow[] = [];
    const dayMs = 86_400_000;
    // Fill between the window START and the LAST DATA DAY (not toMs —
    // callers pass open-ended windows; past the last data day, zero
    // rows add no information). Also bounded by the data's first day so
    // an absurd fromMs doesn't mint decades of zeros.
    const lastMs = daily.length
      ? Date.parse(`${daily[daily.length - 1].date}T00:00:00Z`)
      : q.fromMs;
    const firstDataMs = daily.length
      ? Date.parse(`${daily[0].date}T00:00:00Z`)
      : q.fromMs;
    const firstMs = Math.max(
      Date.parse(`${new Date(q.fromMs).toISOString().slice(0, 10)}T00:00:00Z`),
      firstDataMs,
    );
    for (let t = firstMs; t <= lastMs; t += dayMs) {
      const iso = new Date(t).toISOString().slice(0, 10);
      filled.push(
        byDate.get(iso) ?? {
          date: iso,
          sessions: 0,
          model_calls: 0,
          input_tokens: 0,
          output_tokens: 0,
          cached_read_tokens: 0,
          sandbox_minutes: 0,
        },
      );
    }
    daily.length = 0;
    daily.push(...filled);
    const totals = daily.reduce(
      (a, d) => ({
        sessions: a.sessions + d.sessions,
        model_calls: a.model_calls + d.model_calls,
        input_tokens: a.input_tokens + d.input_tokens,
        output_tokens: a.output_tokens + d.output_tokens,
        cached_read_tokens: a.cached_read_tokens + d.cached_read_tokens,
        sandbox_minutes: a.sandbox_minutes + d.sandbox_minutes,
      }),
      { sessions: 0, model_calls: 0, input_tokens: 0, output_tokens: 0, cached_read_tokens: 0, sandbox_minutes: 0 },
    );

    const byModel = await this.client
      .prepare(
        `SELECT model_id, COUNT(*) AS model_calls,
                SUM(COALESCE(input_tokens, 0)) AS input_tokens,
                SUM(COALESCE(output_tokens, 0)) AS output_tokens,
                SUM(COALESCE(cached_read_tokens, 0)) AS cached_read_tokens
           FROM usage_events
          WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
            AND kind = 'model_call' AND model_id IS NOT NULL
          GROUP BY model_id ORDER BY input_tokens DESC`,
      )
      .bind(...range)
      .all<LedgerRollup["by_model"][number]>();

    const byAgent = await this.client
      .prepare(
        `SELECT agent_id, COUNT(DISTINCT session_id) AS sessions,
                SUM(CASE WHEN kind = 'model_call' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
                SUM(CASE WHEN kind = 'model_call' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
                ROUND(SUM(CASE WHEN kind = 'sandbox_active_seconds' THEN value ELSE 0 END) / 60.0) AS sandbox_minutes
           FROM usage_events
          WHERE tenant_id = ? AND created_at >= ? AND created_at < ? AND agent_id IS NOT NULL
          GROUP BY agent_id ORDER BY input_tokens DESC`,
      )
      .bind(...range)
      .all<Omit<LedgerRollup["by_agent"][number], "agent_name">>();

    const bySandbox = await this.client
      .prepare(
        `SELECT runtime_id, COUNT(DISTINCT session_id) AS sessions,
                ROUND(SUM(value) / 60.0) AS sandbox_minutes
           FROM usage_events
          WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
            AND kind = 'sandbox_active_seconds' AND runtime_id IS NOT NULL
          GROUP BY runtime_id ORDER BY sandbox_minutes DESC`,
      )
      .bind(...range)
      .all<Omit<LedgerRollup["by_sandbox"][number], "name">>();

    return {
      totals,
      daily,
      by_model: byModel.results ?? [],
      by_agent: (byAgent.results ?? []).map((r) => ({ ...r, agent_name: r.agent_id })),
      by_sandbox: (bySandbox.results ?? []).map((r) => ({ ...r, name: r.runtime_id })),
    };
  }

  describe(): LedgerCapabilities {
    // The baseline SQL store keeps detail forever, rolls up nothing,
    // and is written synchronously — there is no projection to lag.
    return { detailRetentionDays: 0, rollupGranularity: "none", maxProjectionLagMs: 0 };
  }

  listKinds(): Array<{ kind: LedgerKind; unit: string }> {
    return LEDGER_KIND_UNITS;
  }
}

/** CF wiring — wraps a D1Database in CfD1SqlClient + SqlUsageStore. */
export function createCfUsageStore(deps: { db: D1Database }): LedgerStore {
  return new SqlUsageStore(new CfD1SqlClient(deps.db));
}

// ═══════════════════════════════════════════════════════════════════════
// v2 — the itemized usage ledger (design: docs/usage-ledger-design.md).
// Volume note: model_call/tool_use rows flow into the v1 billing pull
// (listUnbilled has no kind filter) — 100–1000× the old seconds-only
// volume. Hosted rate maps must cover the new kinds before rollout or
// rows pile up unbilled (by design: never silently acked).
// Same table, extended in place: new kinds, correlation-id idempotency,
// token measures, dimension columns, and a cursor query. The v1 methods
// above are untouched — seconds emitters keep calling recordUsage until
// Phase-2 metering sources migrate them to recordLedger.
// ═══════════════════════════════════════════════════════════════════════

export type LedgerKind = UsageKind | "model_call" | "tool_use";

export interface LedgerEntryInput {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  kind: LedgerKind;
  /** Quantity only. Prices never enter the ledger. */
  value: number;
  /** Idempotency anchor to the fact source (event seq / op id).
   *  At-least-once writers + UNIQUE(correlation_id) = exactly-once rows. */
  correlationId: string;
  /** Interval window for the *_seconds family. Knowable only at emit
   *  time — ships in v2 so old rows remain roll-up-able. */
  interval?: { startMs: number; endMs: number };
  /** Token economics for model_call rows (one row per invocation). */
  input_tokens?: number;
  cached_read_tokens?: number;
  output_tokens?: number;
  cached_write_tokens?: number;
  dimensions?: {
    modelId?: string;
    toolName?: string;
    runtimeId?: string;
  };
}

export interface LedgerCapabilities {
  detailRetentionDays: number; // 0 = forever
  rollupGranularity: "day" | "none";
  /** Upper bound on projection lag; queries surface actual lag. */
  maxProjectionLagMs: number;
}

export interface LedgerQuery {
  tenantId: string;
  fromMs: number;
  toMs: number;
  sessionId?: string;
  agentId?: string;
  modelId?: string;
  runtimeId?: string;
  kind?: LedgerKind;
  /** Session-id substring search (the console's q box). */
  q?: string;
  /** Opaque cursor from a prior page (single tier: the last row id). */
  cursor?: string;
  limit: number;
}

/** A persisted row (DB naming, like UsageEventRow). */
export interface LedgerRow extends UsageEventRow {
  correlation_id: string | null;
  interval_start_ms: number | null;
  interval_end_ms: number | null;
  input_tokens: number | null;
  cached_read_tokens: number | null;
  output_tokens: number | null;
  cached_write_tokens: number | null;
  model_id: string | null;
  tool_name: string | null;
  runtime_id: string | null;
  schema_version: number;
  /** This store is single-tier; every row is detail. */
  rowKind: "detail";
}

export interface LedgerPage {
  rows: LedgerRow[];
  nextCursor: string | null;
  /** Honest degradation, in the contract, per page. */
  completeness: "complete" | "partial" | "rolled_up";
  projectionLagMs: number;
  /** Matched-row count for the filter — "loaded X of Y" footers and
   *  export cap warnings consume it. */
  total?: number;
}

/** Day-bucketed rollup — the shape the usage dashboard consumes. */
export interface LedgerDailyRow {
  /** YYYY-MM-DD, UTC */
  date: string;
  sessions: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_read_tokens: number;
  sandbox_minutes: number;
}

export interface LedgerRollup {
  totals: Omit<LedgerDailyRow, "date">;
  daily: LedgerDailyRow[];
  by_model: Array<{
    model_id: string;
    model_calls: number;
    input_tokens: number;
    output_tokens: number;
    cached_read_tokens: number;
  }>;
  by_agent: Array<{
    agent_id: string;
    /** shortcut: no names in the ledger — display join is the UI's job. */
    agent_name: string;
    sessions: number;
    input_tokens: number;
    output_tokens: number;
    sandbox_minutes: number;
  }>;
  by_sandbox: Array<{
    runtime_id: string;
    name: string;
    sessions: number;
    sandbox_minutes: number;
  }>;
}

export interface LedgerStore extends UsageStore {
  /** Idempotent batch write. Rows failing per-kind validation are
   *  dropped, never silently reshaped. */
  recordLedger(entries: LedgerEntryInput[]): Promise<void>;
  query(q: LedgerQuery): Promise<LedgerPage>;
  dailyRollup(q: { tenantId: string; fromMs: number; toMs: number }): Promise<LedgerRollup>;
  describe(): LedgerCapabilities;
  /** Kind enumeration so UIs are data-driven, not hardcoded tab lists. */
  listKinds(): Array<{ kind: LedgerKind; unit: string }>;
}

/** Shared column list for v2 reads (DB naming, snake_case). */
const LEDGER_COLUMNS = `id, tenant_id, session_id, agent_id, kind, value, created_at, billed_at,
  correlation_id, interval_start_ms, interval_end_ms, input_tokens, cached_read_tokens,
  output_tokens, cached_write_tokens, model_id, tool_name, runtime_id, schema_version`;

/** Static registry — the listKinds() payload. */
export const LEDGER_KIND_UNITS: Array<{ kind: LedgerKind; unit: string }> = [
  { kind: "session_alive_seconds", unit: "s" },
  { kind: "sandbox_active_seconds", unit: "s" },
  { kind: "browser_active_seconds", unit: "s" },
  { kind: "model_call", unit: "call" },
  { kind: "tool_use", unit: "call" },
];

/**
 * Per-kind validation (v3): the 86,400 clamp binds ONLY the *_seconds
 * family — applied universally it would silently cap token counts.
 * Token measures must be non-negative integers or absent; a violating
 * ROW is dropped (returns null), never reshaped.
 */
export function normalizeLedgerEntry(
  e: LedgerEntryInput,
): LedgerEntryInput | null {
  if (!Number.isInteger(e.value) || e.value < 0) return null;
  if (!e.correlationId) return null;
  const value = e.kind.endsWith("_seconds")
    ? clampUsageValue(e.value)
    : e.value;
  for (const t of [
    e.input_tokens,
    e.cached_read_tokens,
    e.output_tokens,
    e.cached_write_tokens,
  ]) {
    if (t !== undefined && (!Number.isInteger(t) || t < 0)) return null;
  }
  if (
    e.interval &&
    (!Number.isFinite(e.interval.startMs) || !Number.isFinite(e.interval.endMs))
  ) {
    return null;
  }
  return { ...e, value };
}
