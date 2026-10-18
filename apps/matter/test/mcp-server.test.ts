import { beforeEach, describe, expect, it } from "vitest";
import {
  createMatterMcpHandler,
  createMemorySessionTokenStore,
  createOmaClient,
  OperationCallBridge,
  sessionVaults,
  type SessionTokenStore,
} from "../src/index.js";
import { FakeOma } from "./fake-oma.js";

const REPLY_TOOL = {
  name: "feishu.message.reply",
  description: "Reply in the conversation",
  inputSchema: {
    type: "object",
    properties: { markdown: { type: "string" } },
    required: ["markdown"],
  },
};

let bridge: OperationCallBridge;
let tokens: SessionTokenStore;
let handler: (request: Request) => Promise<Response>;
let token: string;

const post = (body: unknown, bearer: string | null = token) =>
  handler(
    new Request("https://matter.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );

const rpc = async (method: string, params?: unknown, id: number = 1) => {
  const response = await post({ jsonrpc: "2.0", id, method, params });
  expect(response.status).toBe(200);
  return (await response.json()) as { result?: any; error?: { code: number; message: string } };
};

beforeEach(async () => {
  bridge = new OperationCallBridge({ matchTimeoutMs: 50 });
  tokens = createMemorySessionTokenStore();
  handler = createMatterMcpHandler({ bridge, tokens, version: "1.2.3" });
  token = await tokens.issue("session-a");
  bridge.setTools("session-a", [REPLY_TOOL]);
});

describe("authentication", () => {
  it("refuses a request without a bearer issued for a Session", async () => {
    for (const bearer of [null, "omt_unknown", ""]) {
      const response = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, bearer);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
  });

  it("issues distinct tokens and resolves each to its Session", async () => {
    const other = await tokens.issue("session-b");
    expect(other).not.toBe(token);
    expect(await tokens.resolve(token)).toBe("session-a");
    expect(await tokens.resolve(other)).toBe("session-b");
    expect(await tokens.resolve(`${token}x`)).toBeNull();
  });

  it("refuses GET", async () => {
    const response = await handler(new Request("https://matter.test/mcp"));
    expect(response.status).toBe(405);
  });
});

describe("protocol", () => {
  it("negotiates the protocol version and advertises tools", async () => {
    const known = await rpc("initialize", { protocolVersion: "2025-03-26" });
    expect(known.result).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "openmatter", version: "1.2.3" },
    });
    const unknown = await rpc("initialize", { protocolVersion: "1999-01-01" });
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("accepts notifications without a body and answers ping", async () => {
    const notification = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    expect((await rpc("ping")).result).toEqual({});
  });

  it("answers a batch in order and reports unknown methods and bad JSON", async () => {
    const response = await post([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "resources/list" },
    ]);
    expect(await response.json()).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: resources/list" } },
    ]);
    expect((await post("{not json")).status).toBe(400);
    expect((await post([])).status).toBe(400);
  });
});

describe("tools", () => {
  it("lists the Session's tools under MCP names", async () => {
    const listed = await rpc("tools/list");
    expect(listed.result.tools).toEqual([
      {
        name: "feishu_message_reply",
        description: REPLY_TOOL.description,
        inputSchema: REPLY_TOOL.inputSchema,
      },
    ]);
    const other = await tokens.issue("session-b");
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, other);
    expect(((await response.json()) as any).result.tools).toEqual([]);
  });

  it("forwards a call to the kernel and returns its result", async () => {
    const pending = rpc("tools/call", {
      name: "feishu_message_reply",
      arguments: { markdown: "hi" },
    });
    bridge.announce("session-a", "toolu_1", "feishu_message_reply", { markdown: "hi" });
    bridge.resolve("toolu_1", { ok: true, result: { status: "delivered" } });
    expect((await pending).result).toEqual({
      content: [{ type: "text", text: '{"status":"delivered"}' }],
      isError: false,
    });
  });

  it("marks refused, failed and uncertain results as errors but not a conflict", async () => {
    const cases: [unknown, boolean][] = [
      [{ status: "refused", reason: "not allowed" }, true],
      [{ status: "failed", reason: "boom", retryable: true }, true],
      [{ status: "uncertain", reason: "timeout" }, true],
      [{ status: "conflict", effect: "not-applied", conflict: { reason: "newer_messages", messages: [] }, seenRevision: 3 }, false],
    ];
    for (const [index, [result, isError]] of cases.entries()) {
      const callbackId = `toolu_${index}`;
      bridge.announce("session-a", callbackId, "feishu_message_reply", { markdown: String(index) });
      bridge.resolve(callbackId, { ok: true, result: result as never });
      const response = await rpc("tools/call", {
        name: "feishu_message_reply",
        arguments: { markdown: String(index) },
      });
      expect(response.result.isError).toBe(isError);
      expect(JSON.parse(response.result.content[0].text)).toEqual(result);
    }
  });

  it("reports a callback error and a call no Turn recorded as tool errors", async () => {
    bridge.announce("session-a", "toolu_e", "feishu_message_reply", { markdown: "e" });
    bridge.resolve("toolu_e", { ok: false, error: { message: "kernel failed" } });
    const failed = await rpc("tools/call", { name: "feishu_message_reply", arguments: { markdown: "e" } });
    expect(failed.result).toEqual({
      content: [{ type: "text", text: '{"message":"kernel failed"}' }],
      isError: true,
    });
    const orphan = await rpc("tools/call", { name: "feishu_message_reply", arguments: { markdown: "x" } });
    expect(orphan.result.isError).toBe(true);
    expect(orphan.result.content[0].text).toContain("not part of an active Turn");
  });

  it("rejects a tool the Session does not have and malformed arguments", async () => {
    const unknown = await rpc("tools/call", { name: "feishu_message_send", arguments: {} });
    expect(unknown.error?.code).toBe(-32602);
    const malformed = await rpc("tools/call", { name: "feishu_message_reply", arguments: [] });
    expect(malformed.error?.code).toBe(-32602);
  });
});

describe("sessionVaults", () => {
  it("puts a fresh token for the Session in its own vault", async () => {
    const oma = new FakeOma();
    const client = createOmaClient({
      baseUrl: "https://oma.test",
      apiKey: oma.apiKey,
      fetch: oma.fetch as typeof fetch,
    });
    const vaultIds = await sessionVaults({
      client,
      tokens,
      mcpServerUrl: "https://matter.test/mcp",
    })({ sessionId: "session-c", idempotencyKey: "k", generation: 0, agentId: "agent-1" });
    expect(vaultIds).toHaveLength(1);
    const vault = oma.vaults.get(vaultIds[0]!)!;
    expect(vault.name).toBe("openmatter:session-c");
    const credential = vault.credentials[0] as {
      display_name: string;
      auth: { type: string; mcp_server_url: string; token: string };
    };
    expect(credential.auth.type).toBe("static_bearer");
    expect(credential.auth.mcp_server_url).toBe("https://matter.test/mcp");
    expect(await tokens.resolve(credential.auth.token)).toBe("session-c");
  });
});
