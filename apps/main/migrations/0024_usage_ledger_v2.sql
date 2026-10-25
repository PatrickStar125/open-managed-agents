-- 0024_usage_ledger_v2.sql — itemized usage ledger (design:
-- docs/usage-ledger-design.md). Additive only; the v1 billing-pull
-- protocol (listUnbilled/ack) is untouched.
--
-- correlation_id: idempotency anchor for at-least-once writers. The
-- unique index is partial — SQLite/D1 allow multiple NULLs anyway, and
-- pre-v2 rows (and v1 recordUsage seconds emits) have none.
--
-- interval_*: the *_seconds family's covered window. Knowable only at
-- emit time; ships now so old rows remain roll-up-able.
--
-- token measures + dimensions: the model_call composite row (one row
-- per invocation carrying its full token economics) and tool/runtime
-- attribution. schema_version distinguishes v1 (1) and v2 (2) rows.

ALTER TABLE usage_events ADD COLUMN correlation_id TEXT;
ALTER TABLE usage_events ADD COLUMN interval_start_ms INTEGER;
ALTER TABLE usage_events ADD COLUMN interval_end_ms INTEGER;
ALTER TABLE usage_events ADD COLUMN input_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN cached_read_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN output_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN cached_write_tokens INTEGER;
ALTER TABLE usage_events ADD COLUMN model_id TEXT;
ALTER TABLE usage_events ADD COLUMN tool_name TEXT;
ALTER TABLE usage_events ADD COLUMN runtime_id TEXT;
ALTER TABLE usage_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_correlation
  ON usage_events (correlation_id) WHERE correlation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_time
  ON usage_events (tenant_id, created_at DESC, id DESC);
