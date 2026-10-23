import { expect, it } from "vitest";
import { createBetterSqlite3SqlClient } from "@open-managed-agents/sql-client";
import { SqlAgentStore } from "../src";

it("uses existing agents/history without migration and preserves opaque extensions through CAS and archive", async () => {
  const db = await createBetterSqlite3SqlClient(":memory:");
  await db.exec(`CREATE TABLE agents (id text PRIMARY KEY, tenant_id text, config text, version integer, created_at integer, updated_at integer, archived_at integer);
  CREATE TABLE agent_versions (agent_id text, tenant_id text, snapshot text, version integer, created_at integer NOT NULL, PRIMARY KEY(agent_id,version));`);
  const raw = { id: "a", name: "old", model: { id: "m", vendor_extra: { runtimeId: "vendor", maxTokens: 7 } }, mcp_servers: [{ name: "srv", type: "url", url: "https://example.invalid", headers: { runtimeId: "header", maxTokens: 8 } }], version: 2, created_at: "2026-01-01T00:00:00.000Z", system: "hi", vendor_extra: { keep_me: 1 }, harness: "native", tools: [] };
  await db.prepare("INSERT INTO agents VALUES (?, ?, ?, 2, ?, NULL, NULL)").bind("a", "w", JSON.stringify(raw), Date.parse(raw.created_at)).run();
  await db.prepare("INSERT INTO agent_versions VALUES (?, ?, ?, 1, ?)").bind("a", "w", JSON.stringify({ ...raw, version: 1 }), Date.parse(raw.created_at)).run();
  const store = new SqlAgentStore(db);
  const agent = await store.findCurrent({ workspaceId: "w", agentId: "a" });
  expect(agent).toMatchObject({ id: "a", multiagent: null, model: { id: "m" }, openma: { harness: "native" } });
  expect(await store.findCurrent({ workspaceId: "other", agentId: "a" })).toBeNull();
  expect(await store.findVersion({ workspaceId: "w", agentId: "a", version: 1 })).toMatchObject({ version: 1, multiagent: null });
  if (!agent) throw Error("missing");
  const next = { ...agent, name: "new", version: 3, multiagent: { type: "multiagent_20261001" as const, advisor: { type: "disabled" as const }, workflows: { type: "disabled" as const }, subagents: { type: "enabled" as const, inlineAgents: { type: "enabled" as const }, predefinedAgents: [{ type: "agent" as const, agentId: "a", version: 2 }] } } };
  expect(await store.replaceCurrent({ workspaceId: "w", agentId: "a", expectedVersion: 2, next })).toMatchObject({ type: "replaced", agent: next });
  expect(await store.replaceCurrent({ workspaceId: "w", agentId: "a", expectedVersion: 2, next })).toMatchObject({ type: "version_conflict" });
  const row = await db.prepare("SELECT config FROM agents WHERE id = 'a'").first<{config:string}>();
  expect(JSON.parse(row!.config)).toMatchObject({ vendor_extra: { keep_me: 1 }, multiagent: { subagents: { predefined_agents: [{ type: "agent", id: "a", version: 2 }] } } });
  expect(await store.findVersion({ workspaceId: "w", agentId: "a", version: 2 })).toMatchObject({ name: "old", multiagent: null });
  await store.archiveCurrent({ workspaceId: "w", agentId: "a", archivedAt: "2026-10-01T00:00:00.000Z" });
  const archived = await db.prepare("SELECT config FROM agents WHERE id = 'a'").first<{config:string}>();
  for (const config of [row!.config, archived!.config]) expect(JSON.parse(config)).toMatchObject({ name: "new", model: raw.model, mcp_servers: raw.mcp_servers });
  expect(await store.findVersion({ workspaceId: "w", agentId: "a", version: 2 })).toMatchObject({ model: raw.model, mcpServers: raw.mcp_servers });
  expect(JSON.parse(archived!.config)).toMatchObject({ vendor_extra: { keep_me: 1 }, archived_at: "2026-10-01T00:00:00.000Z" });
});
