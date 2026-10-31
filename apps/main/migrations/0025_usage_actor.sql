-- 0025_usage_actor.sql — actor attribution on the usage ledger.
-- See docs/usage-ledger-design.md (Seam 3: dimension evolution) and
-- SessionActor in managed-agents-domain. Both columns nullable: rows
-- written before this migration (and seconds emitters on paths that
-- have no actor context) carry NULL — never a fabricated attribution.

ALTER TABLE usage_events ADD COLUMN actor_type TEXT;
ALTER TABLE usage_events ADD COLUMN actor_id TEXT;
CREATE INDEX IF NOT EXISTS idx_usage_events_tenant_actor
  ON usage_events (tenant_id, actor_type, actor_id);
