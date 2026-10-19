import { makeConnectorAgentDriver, OPERATION_CALL_METHOD } from "@openma/matter/agent";
import type { AgentTurnInput, OpenMAEvent } from "@openma/common/agent-contract";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOmaClient,
  createOpenMAConnector,
  isOmaSessionUnavailable,
  OmaSessionUnavailableError,
  OperationCallBridge,
  SESSION_TITLE_PREFIX,
} from "../src/index.js";
import { FakeOma, type FakeEvent } from "./fake-oma.js";

const SERVER = "matter";
const REPLY_TOOL = {
  name: "feishu.message.reply",
  integrationId: "feishu",
  operation: "message.reply",
  description: "Reply in the conversation",
  inputSchema: { type: "object" },
};

const idle = { type: "session.status_idle", stop_reason: { type: "end_turn" } };
const running = { type: "session.status_running" };
const message = (text: string) => ({
  type: "agent.message",
  id: `msg_${text}`,
  content: [{ type: "text", text }],
});

let oma: FakeOma;
let bridge: OperationCallBridge;

const makeConnector = (extra: { vaultIds?: readonly string[] } = {}) =>
  createOpenMAConnector({
    client: createOmaClient({
      baseUrl: "https://oma.test/",
      apiKey: oma.apiKey,
      fetch: oma.fetch as typeof fetch,
    }),
    bridge,
    mcpServerName: SERVER,
    environmentId: "env_1",
    ...(extra.vaultIds === undefined
      ? {}
      : { vaultIds: async () => extra.vaultIds! }),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

const turn = (
  turnId: string,
  overrides: Partial<AgentTurnInput> = {},
): AgentTurnInput => ({
  sessionId: "matter-session-1",
  turnId,
  afterSequence: 0,
  content: "hello",
  metadata: { openmatter: { tools: [REPLY_TOOL] } },
  ...overrides,
});

const collect = async (events: AsyncIterable<OpenMAEvent>) => {
  const out: OpenMAEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
};

const respondOnMessage = (replies: readonly FakeEvent[]) => {
  oma.responder = (_id, event) =>
    event.type === "user.message" ? replies : undefined;
};

beforeEach(() => {
  oma = new FakeOma();
  bridge = new OperationCallBridge({ matchTimeoutMs: 2_000 });
});

describe("open", () => {
  it("creates one session per idempotency key and reuses it on replay", async () => {
    const connector = makeConnector({ vaultIds: ["vlt_1"] });
    const input = {
      sessionId: "s1",
      idempotencyKey: "key-1",
      generation: 0,
      agentId: "agent-1",
    };
    const first = await connector.open(input);
    const second = await connector.open(input);
    expect(second.externalSessionId).toBe(first.externalSessionId);
    expect(first).toMatchObject({ connectorId: "openma", placement: "managed" });
    const creates = oma.requests.filter(
      (r) => r.method === "POST" && r.path === "/v1/sessions",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toEqual({
      agent: "agent-1",
      title: `${SESSION_TITLE_PREFIX}key-1`,
      environment_id: "env_1",
      vault_ids: ["vlt_1"],
    });
  });

  it("does not reuse a session whose title only contains the key", async () => {
    oma.createSession(`${SESSION_TITLE_PREFIX}key-1-other`);
    const connector = makeConnector();
    const handle = await connector.open({
      sessionId: "s1",
      idempotencyKey: "key-1",
      generation: 0,
      agentId: "agent-1",
    });
    expect(oma.sessions.get(handle.externalSessionId)?.title).toBe(
      `${SESSION_TITLE_PREFIX}key-1`,
    );
  });

  it("reports a missing or archived session on resume as unavailable", async () => {
    const connector = makeConnector();
    const resume = {
      connectorId: "openma",
      externalSessionId: "sesn_missing",
      placement: "managed" as const,
    };
    const missing = connector
      .open({ sessionId: "s", idempotencyKey: "k", generation: 1, agentId: "a", resume })
      .catch((error: unknown) => error);
    expect(await missing).toBeInstanceOf(OmaSessionUnavailableError);
    expect(isOmaSessionUnavailable(await missing)).toBe(true);

    const id = oma.createSession("archived");
    oma.sessions.get(id)!.archived_at = "2026-01-01T00:00:00Z";
    const archived = await connector
      .open({
        sessionId: "s",
        idempotencyKey: "k",
        generation: 1,
        agentId: "a",
        resume: { ...resume, externalSessionId: id },
      })
      .catch((error: unknown) => error);
    expect(isOmaSessionUnavailable(archived)).toBe(true);
  });
});

describe("execute", () => {
  it("sends one user.message and streams the Turn until its terminal status", async () => {
    const id = oma.createSession("t");
    respondOnMessage([running, message("hi"), idle]);
    const connector = makeConnector();
    const events = await collect(
      connector.execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    );
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    for (const event of events) {
      expect(event.session_id).toBe("matter-session-1");
      expect(event.turn_id).toBe("turn-1");
    }
    expect(oma.sessions.get(id)!.events[0]).toMatchObject({
      type: "user.message",
      content: [{ type: "text", text: "hello" }],
    });
    // The MCP server lists the Turn's tools for this Session.
    expect((await bridge.tools("matter-session-1")).map((tool) => tool.name)).toEqual([
      "feishu.message.reply",
    ]);
  });

  it("ignores events of an earlier Turn already in the log", async () => {
    const id = oma.createSession("t");
    oma.append(id, { type: "user.message", content: [] });
    oma.append(id, message("old"));
    oma.append(id, idle);
    respondOnMessage([message("new"), idle]);
    const events = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-2"),
      ),
    );
    expect(events.map((e) => [e.type, (e.data as { text?: string }).text])).toEqual([
      ["agent.message", "new"],
      ["turn.completed", undefined],
    ]);
  });

  it("reports a Matter MCP tool call as an operation call and answers the MCP caller", async () => {
    const id = oma.createSession("t");
    respondOnMessage([
      {
        type: "agent.mcp_tool_use",
        id: "toolu_1",
        mcp_server_name: SERVER,
        name: `mcp__${SERVER}__feishu_message_reply`,
        input: { markdown: "done" },
      },
    ]);
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const iterator = connector.execute(handle, turn("turn-1"))[Symbol.asyncIterator]();

    const started = await iterator.next();
    expect(started.value?.type).toBe("tool.started");
    const callback = (await iterator.next()).value as OpenMAEvent;
    expect(callback).toMatchObject({
      type: "callback.requested",
      seq: 2,
      data: {
        callback_id: "toolu_1",
        method: OPERATION_CALL_METHOD,
        category: "extension",
        params: {
          integrationId: "feishu",
          operation: "message.reply",
          input: { markdown: "done" },
        },
      },
    });
    expect(typeof (callback.data as { fingerprint?: unknown }).fingerprint).toBe("string");

    // The MCP endpoint receives the same call; key order does not matter.
    const mcpCall = bridge.call("matter-session-1", "feishu_message_reply", { markdown: "done" });
    await connector.send(handle, {
      type: "callback.respond",
      callbackId: "toolu_1",
      result: { status: "succeeded" },
    });
    expect(await mcpCall).toEqual({ ok: true, result: { status: "succeeded" } });

    oma.append(id, { type: "agent.mcp_tool_result", mcp_tool_use_id: "toolu_1", content: "ok" });
    oma.append(id, idle);
    const rest: string[] = [];
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      rest.push(next.value.type);
    }
    expect(rest).toEqual(["tool.completed", "turn.completed"]);
  });

  it("reports a deferred call through mcp_invoke the same way", async () => {
    const id = oma.createSession("t");
    respondOnMessage([
      {
        type: "agent.tool_use",
        id: "toolu_2",
        name: "mcp_invoke",
        input: {
          tool_name: `mcp__${SERVER}__feishu_message_reply`,
          arguments: { markdown: "via search" },
        },
      },
      idle,
    ]);
    const events = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    );
    const callback = events.find((e) => e.type === "callback.requested");
    expect(callback?.data).toMatchObject({
      callback_id: "toolu_2",
      params: { operation: "message.reply", input: { markdown: "via search" } },
    });
  });

  it("ignores calls to other MCP servers and tools the Turn does not allow", async () => {
    const id = oma.createSession("t");
    respondOnMessage([
      {
        type: "agent.mcp_tool_use",
        id: "toolu_a",
        mcp_server_name: "github",
        name: "feishu_message_reply",
        input: {},
      },
      {
        type: "agent.tool_use",
        id: "toolu_c",
        name: "mcp_invoke",
        input: { tool_name: "mcp__github__feishu_message_reply", arguments: {} },
      },
      {
        type: "agent.mcp_tool_use",
        id: "toolu_b",
        mcp_server_name: SERVER,
        name: `mcp__${SERVER}__feishu_message_send`,
        input: {},
      },
      idle,
    ]);
    const events = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    );
    expect(events.some((e) => e.type === "callback.requested")).toBe(false);
  });

  it("replays a repeated turnId from the log without sending the message again", async () => {
    const id = oma.createSession("t");
    respondOnMessage([running, message("a")]);
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const first = connector.execute(handle, turn("turn-1"))[Symbol.asyncIterator]();
    const seen = [(await first.next()).value, (await first.next()).value] as OpenMAEvent[];
    await first.return?.(undefined);
    oma.append(id, idle);

    const replay = await collect(connector.execute(handle, turn("turn-1")));
    expect(replay.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(replay.slice(0, 2).map((e) => e.event_id)).toEqual(seen.map((e) => e.event_id));
    expect(replay.at(-1)?.type).toBe("turn.completed");
    const sent = oma.sessions.get(id)!.events.filter((e) => e.type === "user.message");
    expect(sent).toHaveLength(1);
  });

  it("ignores user events echoed on the stream", async () => {
    const id = oma.createSession("t");
    oma.echoUserEvents = true;
    respondOnMessage([message("hi"), idle]);
    const events = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["agent.message", "turn.completed"]);
  });

  it("does not repeat an event that is both listed and streamed", async () => {
    const id = oma.createSession("t");
    respondOnMessage([running]);
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const first = connector.execute(handle, turn("turn-1"))[Symbol.asyncIterator]();
    await first.next();
    await first.return?.(undefined);
    // Appended after the replay's stream opened and before its list answers.
    oma.onList = (sessionId) => {
      oma.onList = () => undefined;
      oma.append(sessionId, message("both"));
      setTimeout(() => oma.append(sessionId, idle), 0);
    };
    const replay = await collect(connector.execute(handle, turn("turn-1")));
    expect(replay.filter((e) => e.type === "agent.message")).toHaveLength(1);
    expect(replay.at(-1)?.type).toBe("turn.completed");
  });

  it("reads a repeated Turn back across pages of the event list", async () => {
    const id = oma.createSession("t");
    oma.append(id, { type: "user.message", content: [] });
    oma.append(id, message("earlier"));
    oma.append(id, idle);
    const many = Array.from({ length: 150 }, (_, i) => message(`m${i}`));
    respondOnMessage([running, ...many]);
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    const first = connector.execute(handle, turn("turn-1"))[Symbol.asyncIterator]();
    await first.next();
    await first.return?.(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    oma.append(id, idle);

    const replay = await collect(connector.execute(handle, turn("turn-1")));
    const texts = replay
      .filter((e) => e.type === "agent.message")
      .map((e) => (e.data as { text?: string }).text);
    expect(texts).toEqual(many.map((m) => m.content[0]!.text));
    expect(replay.at(-1)?.type).toBe("turn.completed");
    const pages = oma.requests.filter((r) => r.method === "GET" && r.path.includes("/events?"));
    expect(pages.length).toBeGreaterThan(1);
  });

  it("fails the Turn when the session is terminated", async () => {
    const id = oma.createSession("t");
    respondOnMessage([{ type: "session.status_terminated" }]);
    const result = await collect(
      makeConnector().execute(
        { connectorId: "openma", externalSessionId: id, placement: "managed" },
        turn("turn-1"),
      ),
    ).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(OmaSessionUnavailableError);
  });
});

describe("send and close", () => {
  it("cancels with user.interrupt, steers with user.message and archives on close", async () => {
    const id = oma.createSession("t");
    const connector = makeConnector();
    const handle = { connectorId: "openma", externalSessionId: id, placement: "managed" as const };
    await connector.send(handle, { type: "turn.cancel", turnId: "turn-1" });
    await connector.send(handle, { type: "turn.steer", content: "more" });
    expect(oma.sessions.get(id)!.events.map((e) => e.type)).toEqual([
      "user.interrupt",
      "user.message",
    ]);
    await connector.close(handle);
    await connector.close(handle);
    await connector.close({ ...handle, externalSessionId: "sesn_gone" });
    expect(oma.sessions.get(id)!.archived_at).not.toBeNull();
  });
});

describe("kernel driver", () => {
  it("advertises operation calls through makeConnectorAgentDriver", async () => {
    const driver = makeConnectorAgentDriver({
      connector: makeConnector(),
      agentId: "agent-1",
      isSessionUnavailable: isOmaSessionUnavailable,
    });
    const capabilities = await Effect.runPromise(driver.capabilities());
    expect(capabilities).toMatchObject({ operations: true, resume: true, cancel: true });
  });
});
