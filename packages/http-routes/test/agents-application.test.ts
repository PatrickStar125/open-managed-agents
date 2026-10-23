import { describe, expect, it, vi } from "vitest";
import { buildAgentRoutes } from "../src/agents";
import { AgentsApplicationService } from "../../managed-agents-application/src/agents/application";

describe("OMA agents use the shared application", () => {
  it("creates and updates a pinned self through a mounted real application", async () => {
    let stored: any;
    const versions = new Map<number, any>();
    const application = new AgentsApplicationService({ workspaceId: "workspace", store: {
      insert: async ({ agent }: any) => (stored = agent),
      findCurrent: async ({ workspaceId, agentId }: any) => workspaceId === "workspace" && stored?.id === agentId ? stored : null,
      findVersion: async ({ version }: any) => versions.get(version) ?? null,
      replaceCurrent: async ({ next }: any) => { versions.set(stored.version, stored); stored = next; return { type: "replaced", agent: next }; },
    } as never, clock: { now: () => new Date("2026-10-01T00:00:00Z") }, ids: { nextAgentId: () => "a" } });
    const { Hono } = await import("hono");
    const app = new Hono().route("/v1/oma/agents", buildAgentRoutes({ application }));
    const headers = { "Content-Type": "application/json" };
    const created = await app.request("/v1/oma/agents", { method: "POST", headers, body: JSON.stringify({ name: "self", model: "m", multiagent: { type: "multiagent_20261001", workflows: { type: "disabled" }, subagents: { type: "enabled", predefined_agents: [{ type: "self" }] } } }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ multiagent: { subagents: { predefined_agents: [{ id: "a", version: 1 }] } } });
    const updated = await app.request("/v1/oma/agents/a", { method: "PUT", headers, body: JSON.stringify({ multiagent: { type: "multiagent_20261001", subagents: { type: "enabled", inline_agents: { type: "disabled" } } } }) });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ version: 2, multiagent: { subagents: { predefined_agents: [{ id: "a", version: 1 }] } } });
    const historical = await app.request("/v1/oma/agents/a/versions/1");
    expect(historical.status).toBe(200);
    expect(await historical.json()).toMatchObject({ version: 1 });
  });
  it("preserves PUT and version-path aliases without requiring a beta header", async () => {
    const updateAgent = vi.fn(async () => ({ type: "not_found" }));
    const retrieveAgent = vi.fn(async () => ({ type: "not_found" }));
    const app = buildAgentRoutes({ application: { updateAgent, retrieveAgent } as never });
    expect((await app.request("/a", { method: "PUT", headers: { "Content-Type": "application/json" }, body: '{"name":"new"}' })).status).toBe(404);
    expect(updateAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: "a", name: "new" }));
    expect((await app.request("/a/versions/7")).status).toBe(404);
    expect(retrieveAgent).toHaveBeenCalledWith({ agentId: "a", version: 7 });
  });
  it("enforces field caps and model cards before writes", async () => {
    const createAgent = vi.fn();
    const application = { createAgent } as never;
    for (const guards of [
      { validateAgentLimits: () => ({ ok: false, error: "cap" }) },
      { validateModel: async () => ({ valid: false, error: "model card" }) },
    ]) {
      const app = buildAgentRoutes({ application, ...guards });
      const res = await app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"name":"n","model":"m"}' });
      expect(res.status).toBe(400);
    }
    expect(createAgent).not.toHaveBeenCalled();
  });
  it("blocks deletion for active sessions and evals", async () => {
    const remove = vi.fn();
    const services = { agents: { get: async () => ({ id: "a" }), delete: remove } } as never;
    for (const guards of [
      { hasActiveSessionsByAgent: async () => true },
      { hasActiveEvalsByAgent: async () => true },
    ]) {
      const app = buildAgentRoutes({ application: { retrieveAgent: async () => ({ type: "found", agent: {} }) } as never, services, ...guards });
      expect((await app.request("/a", { method: "DELETE" })).status).toBe(409);
    }
    expect(remove).not.toHaveBeenCalled();
  });
  it.each([
    { type: "multiagent_20261001" },
    { type: "multiagent_20261001", workflows: { type: "enabled" } },
    { type: "multiagent_20261001", workflows: { type: "unknown" } },
    { type: "multiagent_20261001", workflows: { type: "disabled" }, advisor: { type: "enabled", model: "m" } },
    { type: "multiagent_20261001", workflows: { type: "disabled" }, advisor: { type: "unknown" } },
  ])("returns 400 for unsupported modes %j", async (multiagent) => {
    const application = new AgentsApplicationService({ workspaceId: "w", store: {} as never, clock: { now: () => new Date() }, ids: { nextAgentId: () => "a" } });
    const app = buildAgentRoutes({ application });
    const response = await app.request("/", { method: "POST", headers: { "Content-Type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" }, body: JSON.stringify({ name: "test", model: "m", multiagent }) });
    expect(response.status).toBe(400);
  });
  it("passes all multiagent fields and pins to the application without flattening", async () => {
    const createAgent = vi.fn(async () => ({ type: "invalid_request", message: "test rejection" }));
    const app = buildAgentRoutes({ application: { createAgent } as never });
    const response = await app.request("/", { method: "POST", headers: { "Content-Type": "application/json", "anthropic-beta": "managed-agents-2026-04-01" }, body: JSON.stringify({
      name: "test", model: "m", multiagent: { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: { type: "enabled", inline_agents: { type: "enabled" }, predefined_agents: [{ type: "agent", id: "member", version: 7 }, { type: "self" }] } },
    }) });
    expect(response.status).toBe(400);
    expect(createAgent).toHaveBeenCalledWith(expect.objectContaining({ multiagent: { type: "multiagent_20261001", advisor: { type: "disabled" }, workflows: { type: "disabled" }, subagents: { type: "enabled", inlineAgents: { type: "enabled" }, predefinedAgents: [{ type: "agent", agentId: "member", version: 7 }, { type: "self" }] } } }));
  });
});
