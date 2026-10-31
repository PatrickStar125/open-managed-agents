import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services, LedgerKind, LedgerRow } from "@open-managed-agents/services";
import { LEDGER_KIND_UNITS } from "@open-managed-agents/services";

/**
 * Usage surface backed by the v2 ledger (packages/services/src/usage.ts,
 * design: docs/usage-ledger-design.md):
 *
 *   GET /            — day-bucketed rollup (the usage dashboard)
 *   GET /ledger      — itemized rows, OMA cursor envelope ({data,
 *                      next_cursor, total}) so the console's standard
 *                      list hooks work unchanged; ?mocks=1 still
 *                      intercepts locally.
 *
 * Tenant auth/db/services arrive via the global /v1 middleware chain
 * (same as model_cards). Date params are inclusive YYYY-MM-DD, UTC.
 */

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 90;

/** Parse a YYYY-MM-DD bound; null = absent or calendar-invalid
 *  (2026-13-01 passes the regex but not the Date parse). Invalid is a
 *  400, consistent with unknown-kind — never a silent default window. */
function parseDay(v: string | undefined): Date | null {
  if (!v || !DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** Inclusive valid window → UTC ms range, clamped to 90 days. */
function rangeOf(from: string | undefined, to: string | undefined) {
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const toD = parseDay(to) ?? today;
  const toIso = toD.toISOString().slice(0, 10);
  let fromD = new Date(toD);
  fromD.setUTCDate(fromD.getUTCDate() - 13);
  const parsedFrom = parseDay(from);
  if (parsedFrom) fromD = parsedFrom;
  // Clamp: at most MAX_SPAN_DAYS, from never after to.
  if (fromD > toD) fromD = new Date(toD);
  const minFrom = new Date(toD);
  minFrom.setUTCDate(minFrom.getUTCDate() - (MAX_SPAN_DAYS - 1));
  if (fromD < minFrom) fromD = minFrom;
  return {
    fromIso: fromD.toISOString().slice(0, 10),
    toIso,
    fromMs: fromD.getTime(),
    toMs: toD.getTime() + 86_400_000, // exclusive end of `to` day
  };
}

const invalidDate = (v?: string) => v !== undefined && !DATE_RE.test(v);
const badDate = (v?: string) => DATE_RE.test(v ?? "") && Number.isNaN(Date.parse(`${v}T00:00:00Z`));

app.get("/", async (c) => {
  for (const v of [c.req.query("from"), c.req.query("to")]) {
    if (invalidDate(v) || badDate(v))
      return c.json({ error: { type: "invalid_request", message: `invalid date: ${v}` } }, 400);
  }
  const r = rangeOf(c.req.query("from"), c.req.query("to"));
  const rollup = await c.get("services").usage.dailyRollup({
    tenantId: c.get("tenant_id"),
    fromMs: r.fromMs,
    toMs: r.toMs,
  });
  return c.json({
    range: { from: r.fromIso, to: r.toIso, days: rollup.daily.length },
    ...rollup,
  });
});

const UNIT_BY_KIND = new Map(LEDGER_KIND_UNITS.map((k) => [k.kind, k.unit]));

/** Store row → the console's row shape (adds ts/unit; agent has no name
 *  in the ledger — the id travels as the name, display join is UI-side). */
function toConsoleRow(r: LedgerRow) {
  return {
    id: r.id,
    ts: new Date(r.created_at).toISOString(),
    actor_type: r.actor_type ?? undefined,
    actor_id: r.actor_id ?? undefined,
    correlation_id: r.correlation_id,
    session_id: r.session_id,
    agent_id: r.agent_id ?? "",
    agent_name: r.agent_id ?? "",
    kind: r.kind,
    value: r.value,
    unit: UNIT_BY_KIND.get(r.kind as LedgerKind) ?? "",
    input_tokens: r.input_tokens ?? undefined,
    cached_read_tokens: r.cached_read_tokens ?? undefined,
    output_tokens: r.output_tokens ?? undefined,
    cached_write_tokens: r.cached_write_tokens ?? undefined,
    model_id: r.model_id ?? undefined,
    tool_name: r.tool_name ?? undefined,
    runtime_id: r.runtime_id ?? undefined,
  };
}

app.get("/ledger", async (c) => {
  const actorType = c.req.query("actor_type") as
    | "member"
    | "api_key"
    | "integration"
    | undefined;
  const actorIdRaw = c.req.query("actor_id");
  const tenantId = c.get("tenant_id");
  for (const v of [c.req.query("from"), c.req.query("to")]) {
    if (invalidDate(v) || badDate(v))
      return c.json({ error: { type: "invalid_request", message: `invalid date: ${v}` } }, 400);
  }
  const kind = c.req.query("kind");
  // Contract: an unregistered kind is an error, never a silent empty page.
  if (kind && !UNIT_BY_KIND.has(kind as LedgerKind)) {
    return c.json({ error: { type: "invalid_request", message: `unknown kind: ${kind}` } }, 400);
  }
  const r = rangeOf(c.req.query("from"), c.req.query("to"));
  const limitRaw = Number(c.req.query("limit") ?? 25);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 25, 1), 5000);
  const page = await c.get("services").usage.query({
    tenantId,
    actorType,
    actorId: actorIdRaw !== undefined ? actorIdRaw : undefined,
    fromMs: r.fromMs,
    toMs: r.toMs,
    sessionId: c.req.query("session_id"),
    agentId: c.req.query("agent_id"),
    modelId: c.req.query("model_id"),
    runtimeId: c.req.query("runtime_id"),
    kind: kind as LedgerKind | undefined,
    q: c.req.query("q") ?? undefined,
    cursor: c.req.query("cursor"),
    limit,
  });
  return c.json({
    data: page.rows.map(toConsoleRow),
    next_cursor: page.nextCursor,
    total: page.total ?? page.rows.length,
  });
});

export default app;
