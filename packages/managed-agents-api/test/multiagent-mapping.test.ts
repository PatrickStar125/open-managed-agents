import { describe, expect, it } from "vitest";
import { agentMultiagentInputSchema } from "../src/contracts/agent-input-components";
import { toAgentMultiagentInput } from "../src/mappers/agent-definition";

describe("multiagent patch mapping", () => {
  it("preserves a null subagents reset", () => {
    const wire = agentMultiagentInputSchema.parse({ type: "multiagent_20261001", subagents: null });
    expect(toAgentMultiagentInput(wire)).toEqual({ type: "multiagent_20261001", subagents: null });
  });

  it("preserves null list and inline resets", () => {
    const wire = agentMultiagentInputSchema.parse({ type: "multiagent_20261001", subagents: { type: "enabled", predefined_agents: null, inline_agents: null } });
    expect(toAgentMultiagentInput(wire)).toEqual({ type: "multiagent_20261001", subagents: { type: "enabled", predefinedAgents: null, inlineAgents: null } });
  });

  it("keeps omitted patch fields omitted", () => {
    expect(toAgentMultiagentInput({ type: "multiagent_20261001" })).toEqual({ type: "multiagent_20261001" });
  });
});
