# Usage Ledger — Design Note

**Status**: PROPOSAL — nothing here is implemented. This note exists so the
contract conversation has a durable artifact before any code lands.
**Date**: 2026-10-25
**Accompanies**: the console demo on `feat/usage-dashboard` (usage dashboard +
ledger sub-page, MSW demo dataset)

## Context

The OSS console has no usage surface. The hosted billing pipeline meters
exactly three resource kinds (`session_alive_seconds`,
`sandbox_active_seconds`, `browser_active_seconds`) in
`packages/services/src/usage.ts` — an append-only, id-cursor,
ack-staged table that is already an immutable ledger, just a thin one.
Token and tool consumption live only inside per-session event logs,
which are durable but not queryable across sessions.

Two gaps follow:

1. **No itemized history.** Nothing answers "what did this tenant
   consume, entry by entry, last quarter" — the cost-attribution
   doctrine (never zero-fill, never fabricate) has no ledger to apply
   to at query time.
2. **Two-sourced aggregates.** A usage dashboard built off event logs +
   the resource table directly would drift from any ledger view. The
   board's totals and the ledger's totals must be the same numbers
   because they come from the same rows.

## Decision

**Extend `usage_events` in place; do not add a second store.** The
existing table is the seed of the itemized ledger. The evolution is
additive: more kinds, more dimensions, one public query surface. The
billing pull protocol (`listUnbilled` / `ack`) keeps its checkpoint
cursor over the same rows — see "v2 landing" for what new kinds mean
for the pull's *payload*.

Aggregates (usage dashboard, `usage_daily`) are **projections of the
ledger**, never independent reads. Board totals therefore reconcile
with ledger totals by construction.

### Scope note

This note covers the contract layer only. The console demo on this
branch is an MSW mock and neither implements nor depends on anything
specified here. The demo's **row** shape deliberately matches; its
transport envelope intentionally reuses the console's existing OMA
cursor envelope (`data`/`next_cursor`) until the real endpoint lands.

## Non-goals

- Not a billing system: rates, money, and credit live in the hosted
  worker and in `CostAttributionPort` envelopes at read time. The
  ledger records quantities, never prices.
- Not an enforcement path: rate limits and wallet checks stay on the
  synchronous counter path (`packages/rate-limit`); nothing here is
  read-your-writes.

## Contract sketch

```ts
type LedgerKind =
  // Registered, open-ended. Querying an unregistered kind is a
  // contract-level error, not a silent empty result.
  | "session_alive_seconds"
  | "sandbox_active_seconds"
  | "browser_active_seconds"
  // One row per model invocation, carrying the call's full token
  // economics — see "Itemization model".
  | "model_call"
  | "tool_use" // tool name in dimensions; see MCP note
  ;

interface LedgerEntryInput {
  tenantId: string;
  sessionId: string;
  agentId?: string | null;
  kind: LedgerKind;
  value: number; // quantity only. Prices never enter the ledger.
  // Idempotency anchor to the fact source (event seq / op id).
  // At-least-once writers + unique(correlation_id) = exactly-once rows.
  correlationId: string;
  // Interval kinds (the *_seconds family) carry the covered window so
  // compaction can re-emit coarser intervals without losing totals.
  // Windows are knowable ONLY at emit time — skipping the column now
  // makes old rows forever un-rollable — so it ships in v2 even though
  // its consumer (rollup arithmetic) is still an open decision.
  interval?: { startMs: number; endMs: number };
  // Token economics for model_call rows.
  // cached_write has no console reader yet, but the emit sites already
  // record it (cache_creation_input_tokens in the harness loops), so
  // the column costs nothing at the write site.
  input_tokens?: number;
  cached_read_tokens?: number;
  output_tokens?: number;
  cached_write_tokens?: number;
  dimensions?: {
    modelId?: string;
    toolName?: string;
    runtimeId?: string; // sandbox provider
  };
}

interface LedgerCapabilities {
  detailRetentionDays: number; // 0 = provider keeps detail forever
  rollupGranularity: "day" | "none";
  /** Upper bound on projection lag; queries surface actual lag. */
  maxProjectionLagMs: number;
}

interface LedgerQuery {
  tenantId: string;
  fromMs: number;
  toMs: number;
  sessionId?: string;
  agentId?: string;
  modelId?: string;
  runtimeId?: string;
  kind?: LedgerKind;
  cursor?: string; // valid across tiers; encodes tier + position
  limit: number;
}

interface LedgerRow extends LedgerEntryInput {
  id: number;
  createdAt: number;
  billedAt: number | null;
  rowKind: "detail" | "rollup";
}

interface LedgerPage {
  rows: LedgerRow[];
  nextCursor: string | null;
  /** Honest degradation, in the contract, per page. */
  completeness: "complete" | "partial" | "rolled_up";
  projectionLagMs: number;
  /** Matched-row count for the filter — the "loaded X of Y" footer and
   *  the export cap warning consume it today. */
  total?: number;
}

interface LedgerStore {
  record(entries: LedgerEntryInput[]): Promise<void>;
  query(q: LedgerQuery): Promise<LedgerPage>;
  describe(): LedgerCapabilities;
  /** Kind enumeration so UIs are data-driven, not hardcoded tab lists
   *  (the demo's per-row unit rendering needs this mapping). */
  listKinds(): Promise<Array<{ kind: LedgerKind; unit: string }>>;
  /** Billing pull protocol — unchanged from UsageStore v1. */
  listUnbilled(tenantId: string, since: number, limit: number): Promise<LedgerRow[]>;
  /** Cross-shard reconcile fan-out (live consumer: internal routes). */
  listUnbilledTenants(): Promise<Array<{ tenant_id: string }>>;
  /** Immutable history for attribution; includes acknowledged rows.
   *  Live consumer: createRuntimeUsageReader (cost attribution) — keeps
   *  the v1 query shape ({sessionId, startMs/endMs, numeric afterId,
   *  AbortSignal}), NOT LedgerQuery; the reader migrates only if
   *  query() ever subsumes it. */
  listUsage(query: RuntimeUsageListQuery): Promise<LedgerRow[]>;
  ack(ids: number[]): Promise<void>;
}
```

### Value validation is per-kind

The existing clamp (floor-to-int, drop ≤ 0, cap 86 400) is
seconds-specific. Applied universally it would silently cap token
counts at 86 400 and corrupt token metering — a money-adjacent trust
boundary. `record()` validates per kind: the clamp binds only the
`*_seconds` family; token measures validate non-negative-integer and
drop the row on violation, never silently reshape it.

## Principles

1. **Quantities in, prices out.** If an item's price comes from an
   external provider, it enters as a `CostAttributionPort` adapter, not
   as a price column here.
2. **Compaction is an accounting event.** A provider that folds detail
   rows into rollup rows must record the compaction — irreversible
   actions leave a trace.
3. **Redact, don't delete.** GDPR erasure follows the memory-versions
   precedent: wipe values, keep the row shell. Retention drops
   *granularity*, erasure drops *content*, and neither may remove the
   account skeleton itself.
4. **Query honesty is structural.** A cold window answered from rollups
   returns `completeness: "rolled_up"` rows with per-row `rowKind`, never
   synthetic per-call rows (see Two-tier retention).

## Itemization model

One `model_call` row per invocation, carrying the call's full token
economics (`input_tokens` / `cached_read_tokens` / `output_tokens` /
optional `cached_write_tokens`). The row is the decision unit — "what
did this call cost" — and the cache split is the biggest lever, so
hiding it inside per-kind rows would bury the signal. Rejected
alternative: one row per token kind (up to five rows per call) — the
system's highest-frequency fact multiplied fivefold, and the demo's
composite row already matches the shape readers want. Analytics that
want per-kind splits group by the row's measures or join via
`correlationId`.

## Two-tier retention

Detail rows keep a bounded retention (default 90 days, per
capabilities); day-granularity rollup rows are permanent. Long-window
queries degrade to rollup with explicit `completeness` — cheap to
store, honest to read. Tiered DB providers (hot SQL + cold object
store) are an adapter concern behind the same Port; the capabilities
object is how an adapter declares what it actually offers.

## v2 landing

- **Schema**: additive columns only — `correlation_id` (UNIQUE;
  SQLite/D1 allows multiple NULLs, so pre-v2 rows survive the index),
  `interval_start/end`, the token measures, `dimensions`,
  `schema_version` — mirroring the event catalog's additive policy.
  Backfill for existing rows is a one-time migration script.
- **Billing-pull compatibility**: `listUnbilled` returns every unbilled
  row regardless of kind (no kind filter exists today). Rule for new
  kinds: **an unbilled row whose kind has no rate-map entry stays
  unbilled — it is never silently acked, and it never blocks the pull.**
  Rate-map entries ship before a kind starts emitting in hosted
  deployments.
- **Rollout**: dual-write with a reconciliation diff against the old
  path, switch the dashboard reads to the projection once clean, then
  retire the old write path. Every step is revertible.

## MCP note

`tool_use` is recorded with the platform's own dispatch visibility
only: the native harness emits `agent.mcp_tool_use` with machine tool
names, while `acp-translate.ts` emits plain `agent.tool_use` carrying
display titles, and stdio MCP inside ACP children is invisible at every
layer. Tool-call counts therefore carry no cross-lane guarantee and no
price — observation only.

## Adding a settlement item (extension guide)

New billable things arrive constantly. The seams:

**Seam 1 — kind registry (always).** Register the kind; state its unit.
Pricing is data on the billing side (rate-map entry), not code.

**Seam 2 — metering sources.** New consumption facts plug in through a
source adapter in one of three shapes: *event-projection* (derived from
session events), *runtime-emit* (lifecycle intervals), or *sweep*
(periodic scan of a non-event-sourced store — e.g. object storage).
Sweep sources re-collect on a schedule and overwrite-by-correlation:
their correlation key is `(tenant, bucket, day)`, so re-sweeps are
idempotent, unlike per-call correlation.

**Seam 3 — dimension evolution.** New items may need new dimensions
(`integrationId`, `regionId`, …). Policy: additive columns + row
`schema_version`, mirroring the event catalog — old readers ignore
unknown dimensions, new readers tolerate old rows lacking them. A
free-form dimension bag is explicitly rejected: it moves index and
filter planning out of the contract.

**Authoring checklist** (in the spirit of the cost-op checklist in the
recovery docs):

- [ ] Kind registered? Unit stated (`listKinds` carries it)?
- [ ] Which source shape — and is the correlation key stable under
      re-delivery / re-sweep?
- [ ] Does the pricing live in the rate map or in an attribution
      adapter? (Never both; never in the ledger.)
- [ ] Does a UI need a new dimension filter — and is it an additive
      column, not a payload blob?
- [ ] Retention: detail-worthy, or rollup-only from day one?

## Open decisions

- Multi-shard query composition: how shard-level partial rolls up into
  page-level completeness across the D1 fan-out.
- Rollup arithmetic for interval kinds: re-emit coarse windows vs sum.

## Testing

Extend `test/unit/usage-store.test.ts` (or its v2 successor): exactly-once
via `correlationId` under at-least-once writers; per-kind value
validation (the 86 400 clamp must never touch token measures);
`completeness` honesty under a rolled-up window. The store ships as the
house pattern requires: SqlClient port + cf/pg adapters + test fakes +
conformance.

## References

- `packages/services/src/usage.ts` — the existing store this note extends
  (kinds, `listUnbilled`/`ack` billing pull, immutable-history reads)
- `apps/agent/src/harness/acp-translate.ts` — why tool-call identity is
  display-grade on the ACP lane (see MCP note)
- `docs/adr/0007-sandbox-credential-egress.md` — the Ports-and-adapters
  precedent the tiered provider adapters follow
- `apps/docs/src/content/docs/self-host/operations.mdx` (Cost attribution) —
  the evidence-envelope vocabulary (`completeness`, never zero-fill)
  this contract inherits
- `apps/docs/src/content/docs/contribute/recovery-and-idempotency.mdx` —
  the `op_id` pattern the `correlationId` field derives from

## Relationship map

```
SessionDO event log ──┐
Sandbox/browser timer ─┼──► usage_events (ledger, v2) ──► query API ──► console
Resource emits ────────┘        │                              │
                                ├─► billing pull (protocol unchanged;
                                │    unknown-kind rule above)
                                └─► usage_daily projection ──► dashboard API
```
