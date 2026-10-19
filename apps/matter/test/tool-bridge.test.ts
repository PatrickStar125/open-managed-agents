import { describe, expect, it } from "vitest";
import {
  mcpToolName,
  OperationCallBridge,
  stableJson,
  ToolCallTimeoutError,
} from "../src/tool-bridge.js";

describe("OperationCallBridge", () => {
  it("answers a call that arrives before its tool-use event", async () => {
    const bridge = new OperationCallBridge();
    const call = bridge.call("s1", "reply", { b: 1, a: [2, { d: 3, c: 4 }] });
    bridge.announce("s1", "cb1", "reply", { a: [2, { c: 4, d: 3 }], b: 1 });
    bridge.resolve("cb1", { ok: true, result: "done" });
    expect(await call).toEqual({ ok: true, result: "done" });
  });

  it("answers a call that arrives after the event and after the result", async () => {
    const bridge = new OperationCallBridge();
    bridge.announce("s1", "cb1", "reply", { markdown: "x" });
    bridge.resolve("cb1", { ok: false, error: "refused" });
    expect(await bridge.call("s1", "reply", { markdown: "x" })).toEqual({
      ok: false,
      error: "refused",
    });
  });

  it("matches identical calls in order and keeps sessions apart", async () => {
    const bridge = new OperationCallBridge();
    bridge.announce("s1", "cb1", "reply", { markdown: "x" });
    bridge.announce("s2", "cb2", "reply", { markdown: "x" });
    bridge.announce("s1", "cb3", "reply", { markdown: "x" });
    const first = bridge.call("s1", "reply", { markdown: "x" });
    const second = bridge.call("s1", "reply", { markdown: "x" });
    bridge.resolve("cb3", { ok: true, result: 3 });
    bridge.resolve("cb2", { ok: true, result: 2 });
    bridge.resolve("cb1", { ok: true, result: 1 });
    expect(await first).toEqual({ ok: true, result: 1 });
    expect(await second).toEqual({ ok: true, result: 3 });
  });

  it("rejects a call no Turn recorded", async () => {
    const bridge = new OperationCallBridge({ matchTimeoutMs: 10 });
    bridge.announce("s1", "cb1", "reply", { markdown: "other" });
    await expect(bridge.call("s1", "reply", { markdown: "x" })).rejects.toBeInstanceOf(
      ToolCallTimeoutError,
    );
  });

  it("drops unclaimed entries when a Turn ends", async () => {
    const bridge = new OperationCallBridge({ matchTimeoutMs: 10 });
    bridge.announce("s1", "cb1", "reply", {});
    bridge.release("s1");
    await expect(bridge.call("s1", "reply", {})).rejects.toBeInstanceOf(
      ToolCallTimeoutError,
    );
  });

  it("accepts a replayed event after a Turn ended", async () => {
    const bridge = new OperationCallBridge();
    bridge.announce("s1", "cb1", "reply", {});
    bridge.release("s1");
    bridge.announce("s1", "cb1", "reply", {});
    const call = bridge.call("s1", "reply", {});
    bridge.resolve("cb1", { ok: true, result: "replayed" });
    expect(await call).toEqual({ ok: true, result: "replayed" });
  });

  it("times out a matched call the kernel never answers", async () => {
    const bridge = new OperationCallBridge({ resultTimeoutMs: 10 });
    bridge.announce("s1", "cb1", "reply", {});
    await expect(bridge.call("s1", "reply", {})).rejects.toBeInstanceOf(
      ToolCallTimeoutError,
    );
  });

  it("stops waiting when the caller aborts", async () => {
    const bridge = new OperationCallBridge();
    const controller = new AbortController();
    const call = bridge.call("s1", "reply", {}, controller.signal);
    controller.abort(new Error("client went away"));
    await expect(call).rejects.toThrow("client went away");
    // The aborted waiter no longer claims a later event.
    bridge.announce("s1", "cb1", "reply", {});
    bridge.resolve("cb1", { ok: true, result: 1 });
    expect(await bridge.call("s1", "reply", {})).toEqual({ ok: true, result: 1 });
  });
});

describe("names and keys", () => {
  it("maps OpenMatter tool names to MCP tool names", () => {
    expect(mcpToolName("feishu.message.reply")).toBe("feishu_message_reply");
    expect(mcpToolName("gitlab.mr-note")).toBe("gitlab_mr-note");
  });

  it("serializes objects with sorted keys and drops undefined fields", () => {
    expect(stableJson({ b: 1, a: undefined, c: [{ y: 1, x: null }] })).toBe(
      '{"b":1,"c":[{"x":null,"y":1}]}',
    );
  });
});
