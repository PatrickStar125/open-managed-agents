import { expect, it } from "vitest";
import { AgentService } from "../src/service";
import { InMemoryAgentRepo } from "../src/test-fakes";

it("resolves fixed versions in the tenant and refuses archived or missing references", async () => {
  const repo = new InMemoryAgentRepo();
  const member = { id: "child", name: "old", model: "m", system: "old", tools: [], version: 1, created_at: "2026-01-01T00:00:00Z" };
  await repo.insert({ id: "child", tenantId: "w", config: member, createdAt: 1 });
  const service = new AgentService({ repo });
  await service.update({ tenantId: "w", agentId: "child", input: { system: "new" } });
  const parent = { ...member, id: "parent", multiagent: { type: "multiagent_20261001" as const, advisor: { type: "disabled" as const }, workflows: { type: "disabled" as const }, subagents: { type: "enabled" as const, inline_agents: { type: "enabled" as const }, predefined_agents: [{ type: "agent" as const, id: "child", version: 1 }] } } };
  await repo.insert({ id: "parent", tenantId: "w", config: parent, createdAt: 1 });
  expect(await service.getRuntimeSnapshot({ tenantId: "w", agentId: "parent" })).toMatchObject({ multiagent: { subagents: { predefined_agents: [{ id: "child", system: "old", model: "m", version: 1, mcp_servers: [], skills: [] }] } } });
  expect(await service.getRuntimeSnapshot({ tenantId: "other", agentId: "parent" })).toBeNull();
  await repo.insert({ id: "missing-version", tenantId: "w", config: { ...parent, id: "missing-version", multiagent: { ...parent.multiagent, subagents: { ...parent.multiagent.subagents, predefined_agents: [{ type: "agent", id: "child", version: 99 }] } } }, createdAt: 1 });
  await expect(service.getRuntimeSnapshot({ tenantId: "w", agentId: "missing-version" })).rejects.toThrow(/unavailable/);
  await repo.insert({ id: "foreign", tenantId: "other", config: { ...member, id: "foreign" }, createdAt: 1 });
  await repo.insert({ id: "cross-tenant", tenantId: "w", config: { ...parent, id: "cross-tenant", multiagent: { ...parent.multiagent, subagents: { ...parent.multiagent.subagents, predefined_agents: [{ type: "agent", id: "foreign", version: 1 }] } } }, createdAt: 1 });
  await expect(service.getRuntimeSnapshot({ tenantId: "w", agentId: "cross-tenant" })).rejects.toThrow(/unavailable/);
  await service.archive({ tenantId: "w", agentId: "child" });
  await expect(service.getRuntimeSnapshot({ tenantId: "w", agentId: "parent" })).rejects.toThrow(/unavailable/);
});

it("materializes the API's nullable system prompt as the runtime empty prompt", async () => {
  const repo = new InMemoryAgentRepo();
  // The public agent API stores an omitted system prompt as null.
  const member = { id: "child", name: "c", model: "m", system: null, tools: [], version: 1, created_at: "2026-01-01T00:00:00Z" };
  await repo.insert({ id: "child", tenantId: "w", config: member as never, createdAt: 1 });
  const service = new AgentService({ repo });
  expect(await service.getRuntimeSnapshot({ tenantId: "w", agentId: "child" })).toMatchObject({ system: "" });
  const parent = { ...member, id: "parent", multiagent: { type: "multiagent_20261001" as const, advisor: { type: "disabled" as const }, workflows: { type: "disabled" as const }, subagents: { type: "enabled" as const, inline_agents: { type: "enabled" as const }, predefined_agents: [{ type: "agent" as const, id: "child", version: 1 }] } } };
  await repo.insert({ id: "parent", tenantId: "w", config: parent as never, createdAt: 1 });
  expect(await service.getRuntimeSnapshot({ tenantId: "w", agentId: "parent" })).toMatchObject({ system: "", multiagent: { subagents: { predefined_agents: [{ id: "child", system: "" }] } } });
});
