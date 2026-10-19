import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretBox, openSqliteMatterDatabase, type MatterDatabase } from "../src/persistence.js";
import {
  type CallStore,
  mcpToolName,
  memoryCallStore,
  OperationCallBridge,
  stableJson,
  ToolCallTimeoutError,
} from "../src/tool-bridge.js";

const opened: MatterDatabase[] = [];
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const stores: Record<string, () => CallStore> = {
  memory: memoryCallStore,
  sqlite: () => {
    const dir = mkdtempSync(join(tmpdir(), "matter-bridge-"));
    const db = openSqliteMatterDatabase({
      filename: join(dir, "m.sqlite"),
      connectionsDir: join(dir, "apps"),
      box: createSecretBox("bridge-secret-key-0001"),
    });
    opened.push(db);
    return db.calls;
  },
};

describe.each(Object.keys(stores))("OperationCallBridge (%s)", (kind) => {
  const bridge = (options: { matchTimeoutMs?: number; resultTimeoutMs?: number; store?: CallStore } = {}) =>
    new OperationCallBridge({ store: options.store ?? stores[kind]!(), pollMs: 5, ...options });

  it("answers a call that arrives before its tool-use event", async () => {
    const b = bridge();
    const call = b.call("s1", "reply", { b: 1, a: [2, { d: 3, c: 4 }] });
    await b.announce("s1", "cb1", "reply", { a: [2, { c: 4, d: 3 }], b: 1 });
    await b.resolve("cb1", { ok: true, result: "done" });
    expect(await call).toEqual({ ok: true, result: "done" });
  });

  it("answers a call that arrives after the event and after the result", async () => {
    const b = bridge();
    await b.announce("s1", "cb1", "reply", { markdown: "x" });
    await b.resolve("cb1", { ok: false, error: "refused" });
    expect(await b.call("s1", "reply", { markdown: "x" })).toEqual({ ok: false, error: "refused" });
  });

  it("pairs identical calls in announcement order and keeps sessions apart", async () => {
    const store = stores[kind]!();
    const b = bridge({ store });
    await b.announce("s1", "cb-z", "reply", { markdown: "x" });
    await b.announce("s2", "cb-m", "reply", { markdown: "x" });
    await b.announce("s1", "cb-a", "reply", { markdown: "x" });
    expect(await store.claim("s1", `reply\u0000${stableJson({ markdown: "x" })}`, "c1")).toBe("cb-z");
    expect(await store.claim("s1", `reply\u0000${stableJson({ markdown: "x" })}`, "c2")).toBe("cb-a");
    expect(await store.claim("s1", `reply\u0000${stableJson({ markdown: "x" })}`, "c3")).toBeUndefined();
  });

  it("rejects a call no Turn recorded", async () => {
    const b = bridge({ matchTimeoutMs: 30 });
    await b.announce("s1", "cb1", "reply", { markdown: "other" });
    await expect(b.call("s1", "reply", { markdown: "x" })).rejects.toBeInstanceOf(ToolCallTimeoutError);
  });

  it("drops unclaimed entries when a Turn ends", async () => {
    const b = bridge({ matchTimeoutMs: 30 });
    await b.announce("s1", "cb1", "reply", {});
    await b.release("s1");
    await expect(b.call("s1", "reply", {})).rejects.toBeInstanceOf(ToolCallTimeoutError);
  });

  it("accepts a replayed event after a Turn ended", async () => {
    const b = bridge();
    await b.announce("s1", "cb1", "reply", {});
    await b.release("s1");
    await b.announce("s1", "cb1", "reply", {});
    const call = b.call("s1", "reply", {});
    await b.resolve("cb1", { ok: true, result: "replayed" });
    expect(await call).toEqual({ ok: true, result: "replayed" });
  });

  it("times out a matched call the kernel never answers", async () => {
    const b = bridge({ resultTimeoutMs: 30 });
    await b.announce("s1", "cb1", "reply", {});
    await expect(b.call("s1", "reply", {})).rejects.toBeInstanceOf(ToolCallTimeoutError);
  });

  it("stops waiting when the caller aborts", async () => {
    const b = bridge();
    const controller = new AbortController();
    const call = b.call("s1", "reply", {}, controller.signal);
    controller.abort(new Error("client went away"));
    await expect(call).rejects.toThrow("client went away");
    // The aborted call claimed nothing; a later call gets the event.
    await b.announce("s1", "cb1", "reply", {});
    await b.resolve("cb1", { ok: true, result: 1 });
    expect(await b.call("s1", "reply", {})).toEqual({ ok: true, result: 1 });
  });

  it("lists the tools the connector set, across bridges sharing a store", async () => {
    const store = stores[kind]!();
    const turnSide = bridge({ store });
    const mcpSide = bridge({ store });
    expect(await mcpSide.tools("s1")).toEqual([]);
    const tools = [{ name: "feishu.message.reply", description: "Reply", inputSchema: { type: "object" } }];
    await turnSide.setTools("s1", tools);
    expect(await mcpSide.tools("s1")).toEqual(tools);
  });

  it("pairs a call received by one bridge with a Turn run by another", async () => {
    const store = stores[kind]!();
    const turnSide = bridge({ store });
    const mcpSide = bridge({ store });
    const call = mcpSide.call("s1", "reply", { markdown: "hi" });
    await turnSide.announce("s1", "cb1", "reply", { markdown: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await turnSide.resolve("cb1", { ok: true, result: { status: "sent" } });
    expect(await call).toEqual({ ok: true, result: { status: "sent" } });
  });
});

describe("names and keys", () => {
  it("maps OpenMatter tool names to MCP tool names", () => {
    expect(mcpToolName("feishu.message.reply")).toBe("feishu_message_reply");
    expect(mcpToolName("gitlab.mr-note")).toBe("gitlab_mr-note");
  });

  it("serializes objects with sorted keys and drops undefined fields", () => {
    expect(stableJson({ b: 1, a: undefined, c: [{ y: 1, x: null }] })).toBe('{"b":1,"c":[{"x":null,"y":1}]}');
  });
});
