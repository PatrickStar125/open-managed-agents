import { expect, it } from "vitest";
import { buildSessionRoutes } from "../src/sessions";

it("preserves the expanded roster on create/get/list without internal agent fields", async () => {
  const child = { id: "child", type: "agent", version: 2, name: "child", model: "m", system: "child system", tools: [], skills: [], mcp_servers: [], tenant_id: "secret", acp: { secret: true }, created_at: "2026-01-01T00:00:00Z" };
  const multiagent = { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [child] } };
  const snapshot = { ...child, id: "parent", multiagent };
  let row: any;
  const routes = buildSessionRoutes({ services: { agents: { get: async () => snapshot, getRuntimeSnapshot: async () => snapshot }, sessions: {
    create: async (input: any) => { row = { id: "s", tenant_id: "secret", agent_id: "parent", agent_snapshot: input.agentSnapshot, status: "idle", created_at: "2026-01-01T00:00:00Z" }; return { session: row, resources: [] }; },
    get: async () => row, listPage: async () => ({ items: [row] }),
  } } as never, router: { init: async () => {}, getFullStatus: async () => null } as never, loadEnvironment: async () => ({ id: "env" } as never) });
  const created = await routes.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent: "parent", environment_id: "env" }) });
  expect(created.status).toBe(201);
  const outputs = [await created.json(), await (await routes.request("/s")).json(), (await (await routes.request("/")).json()).data[0]];
  for (const output of outputs) {
    expect(output.agent.multiagent).toMatchObject({ type: "multiagent_20261001", subagents: { inline_agents: { type: "enabled" }, predefined_agents: [{ id: "child", version: 2, system: "child system", tools: [], skills: [], mcp_servers: [] }] } });
    expect(output.agent).not.toHaveProperty("tenant_id");
    expect(output.agent).not.toHaveProperty("acp");
    expect(output.agent.multiagent.subagents.predefined_agents[0]).not.toHaveProperty("tenant_id");
    expect(output.agent.multiagent.subagents.predefined_agents[0]).not.toHaveProperty("acp");
  }
});
