import { expect, it } from "vitest";
import { decodeAgent, encodeAgent } from "../src/codec";

it("preserves opaque extension settings and unknown nested fields through encoding", () => {
  const raw = { id: "a", name: "old", model: { id: "m", provider_options: { maxTokens: 7 } }, version: 1, created_at: "2026-01-01T00:00:00.000Z", tools: [],
    context_management: { maxTokens: 7, nested: { runtimeId: "opaque" } },
    model_settings: { maxTokens: 8 },
    vendor_extra: { runtimeId: "vendor" },
    acp: { agent: { command: "test", env: { runtimeId: "opaque" } }, idle_timeout_ms: 100, per_turn_timeout_ms: 200, restart: { mode: "on-crash", max_restarts: 2, window_ms: 300 } },
  };
  expect(decodeAgent(JSON.stringify(raw))).toMatchObject({ openma: { acp: { idleTimeoutMs: 100, perTurnTimeoutMs: 200, restart: { maxRestarts: 2, windowMs: 300 } } } });
  expect(JSON.parse(encodeAgent(decodeAgent(JSON.stringify(raw))))).toMatchObject(raw);
});
