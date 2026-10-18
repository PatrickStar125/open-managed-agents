import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FeishuWsClient,
  FeishuWsClientParams,
} from "@openma/matter-feishu/long-connection";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureAgentMcpServer } from "../src/host.js";
import { createOmaClient } from "../src/oma-client.js";
import { createSecretBox, openMatterDatabase } from "../src/persistence.js";
import {
  createMatterService,
  loadMatterConfig,
  type MatterConfig,
  type MatterService,
} from "../src/server.js";
import { FakeOma, type FakeEvent } from "./fake-oma.js";

const APP_ID = "cli_0123456789abcdef";
const APP_SECRET = "app-secret-value";

type Invoke = (data: unknown) => Promise<unknown>;

/** Plays the Lark SDK's WSClient: frames go to `invoke`; a throw is a failed ack. */
class FakeWsClient implements FeishuWsClient {
  invoke: Invoke | undefined;
  closed = 0;
  constructor(readonly params: FeishuWsClientParams) {}
  async start(p: { eventDispatcher: { invoke: Invoke } }) {
    this.invoke = p.eventDispatcher.invoke;
    this.params.onReady();
  }
  close() {
    this.closed += 1;
  }
}

/** open.feishu.cn: tenant tokens, bot info and message replies. */
class FakeFeishu {
  readonly replies: { messageId: string; body: Record<string, unknown> }[] = [];
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      const body = JSON.parse(String(init?.body)) as { app_id: string; app_secret: string };
      if (body.app_id !== APP_ID || body.app_secret !== APP_SECRET) {
        return reply({ code: 10014, msg: "app secret invalid" });
      }
      return reply({ code: 0, tenant_access_token: "t-tenant", expire: 7200 });
    }
    if (url.pathname === "/open-apis/bot/v3/info") {
      return reply({ code: 0, bot: { open_id: "ou_bot", app_name: "Helpdesk" } });
    }
    const replyPath = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reply$/.exec(url.pathname);
    if (replyPath?.[1] !== undefined) {
      this.replies.push({
        messageId: replyPath[1],
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return reply({ code: 0, data: { message_id: `om_reply_${this.replies.length}` } });
    }
    return reply({ code: 0, data: {} });
  }) as typeof fetch;
}

const mention = (eventId: string, messageId: string) => ({
  schema: "2.0",
  header: {
    event_id: eventId,
    event_type: "im.message.receive_v1",
    create_time: "1792000000000",
    app_id: APP_ID,
    tenant_key: "tk_test",
  },
  event: {
    sender: { sender_id: { open_id: "ou_alice" }, sender_type: "user" },
    message: {
      message_id: messageId,
      chat_id: "oc_dm",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "What is the build status?" }),
      mentions: [],
    },
  },
});

const waitFor = async <T>(read: () => T | undefined, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

let dir: string;
let oma: FakeOma;
let feishu: FakeFeishu;
let ws: FakeWsClient[];
let services: MatterService[];
let config: MatterConfig;

const start = () => {
  const service = createMatterService(config, {
    omaFetch: oma.fetch as typeof fetch,
    fetch: feishu.fetch,
    createWsClient: (params) => {
      const client = new FakeWsClient(params);
      ws.push(client);
      return client;
    },
    onError: () => {},
  });
  services.push(service);
  return service;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matter-host-"));
  oma = new FakeOma();
  oma.agents.set("agent-1", {
    id: "agent-1",
    version: 1,
    mcp_servers: [{ name: "github", type: "url", url: "https://gh.test/mcp" }],
    tools: [{ type: "agent_toolset_20260401" }, { type: "mcp_toolset", mcp_server_name: "github" }],
  });
  feishu = new FakeFeishu();
  ws = [];
  services = [];
  config = loadMatterConfig({
    MATTER_DATA_DIR: dir,
    MATTER_PROXY_SECRET: "proxy-secret",
    MATTER_SECRET_KEY: "a-long-enough-secret-key",
    OMA_URL: "https://oma.test",
    OMA_API_KEY: "test-key",
    OMA_ENVIRONMENT_ID: "env_1",
    MATTER_MCP_URL: "https://matter.test/mcp",
  });
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  rmSync(dir, { recursive: true, force: true });
});

const connection = {
  app: { appId: APP_ID, appSecret: APP_SECRET, brand: "feishu" as const, baseUrl: "https://open.feishu.cn" },
  tenantId: "default",
  userId: "usr_1",
  agentId: "agent-1",
};

describe("Matter service", () => {
  it("connects an app, answers a Feishu message through the Agent's tool call, and survives a restart", async () => {
    const service = start();
    await service.host.connect(connection);

    // The Agent got the Matter MCP server; its other servers stay.
    expect(oma.agents.get("agent-1")?.mcp_servers).toEqual([
      { name: "github", type: "url", url: "https://gh.test/mcp" },
      { name: "openmatter", type: "url", url: "https://matter.test/mcp" },
    ]);
    expect(oma.agents.get("agent-1")?.tools).toEqual([
      { type: "agent_toolset_20260401" },
      { type: "mcp_toolset", mcp_server_name: "github" },
      {
        type: "mcp_toolset",
        mcp_server_name: "openmatter",
        default_config: { permission_policy: { type: "always_allow" } },
      },
    ]);
    expect(service.host.running()).toEqual([APP_ID]);
    expect(ws[0]?.params).toMatchObject({ appId: APP_ID, appSecret: APP_SECRET, domain: "https://open.feishu.cn" });

    // The OpenMA harness: on the user's message, call the Matter MCP tool
    // with the Session's bearer (from its vault), then finish the Turn.
    const mcpResults: unknown[] = [];
    oma.responder = (sessionId, event) => {
      if (event.type !== "user.message") return undefined;
      setTimeout(() => {
        void (async () => {
          const session = oma.sessions.get(sessionId)!;
          expect(session.environment_id).toBe("env_1");
          const vault = oma.vaults.get(session.vault_ids[0] ?? "")!;
          const credential = vault.credentials[0] as { auth: { token: string; mcp_server_url: string } };
          expect(credential.auth.mcp_server_url).toBe("https://matter.test/mcp");
          const rpc = (method: string, params: unknown) =>
            service.fetch(
              new Request("https://matter.test/mcp", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                  authorization: `Bearer ${credential.auth.token}`,
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
              }),
            );
          const listed = (await (await rpc("tools/list", {})).json()) as {
            result: { tools: { name: string }[] };
          };
          expect(listed.result.tools.map((t) => t.name)).toContain("feishu_message_reply");
          const call = rpc("tools/call", {
            name: "feishu_message_reply",
            arguments: { markdown: "All green." },
          });
          oma.append(sessionId, {
            type: "agent.mcp_tool_use",
            id: "toolu_1",
            mcp_server_name: "openmatter",
            name: "mcp__openmatter__feishu_message_reply",
            input: { markdown: "All green." },
          });
          mcpResults.push(await (await call).json());
          oma.append(sessionId, { type: "agent.mcp_tool_result", mcp_tool_use_id: "toolu_1", content: "ok" });
          oma.append(sessionId, { type: "session.status_idle", stop_reason: { type: "end_turn" } } as FakeEvent);
        })();
      }, 10);
      return undefined;
    };

    // Resolving is the ack: the event is in the inbox.
    await ws[0]!.invoke!(mention("ev_1", "om_1"));

    const posted = await waitFor(() => feishu.replies[0]);
    expect(posted.messageId).toBe("om_1");
    expect(JSON.stringify(posted.body)).toContain("All green.");
    const result = await waitFor(() => mcpResults[0]);
    expect(result).toMatchObject({ result: { isError: false } });

    // One OpenMA session for the Turn, titled for idempotent re-open.
    const sessions = [...oma.sessions.values()];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.title.startsWith("openmatter:")).toBe(true);
    expect(sessions[0]?.agent).toBe("agent-1");

    // The app secret is sealed at rest; the bearer is stored only as a hash.
    const raw = readFileSync(join(dir, "matter.sqlite")).toString("latin1");
    expect(raw).not.toContain(APP_SECRET);
    const token = (oma.vaults.values().next().value!.credentials[0] as { auth: { token: string } }).auth.token;
    expect(raw).not.toContain(token);
    expect(readdirSync(join(dir, "apps", APP_ID)).sort()).toEqual(
      expect.arrayContaining(["inbox.sqlite", "store.sqlite"]),
    );

    // Restart: the app reconnects from the database and old bearers still resolve.
    await service.close();
    services.splice(services.indexOf(service), 1);
    expect(ws[0]?.closed).toBeGreaterThan(0);
    const again = start();
    await again.host.start();
    expect(again.host.running()).toEqual([APP_ID]);
    expect(ws).toHaveLength(2);
    expect(await again.db.tokens.resolve(token)).toEqual(expect.stringMatching(/.+/));
    const health = await (await again.fetch(new Request("https://matter.test/health"))).json();
    expect(health).toEqual({ status: "ok", apps: 1 });
  });

  it("refuses apps of a workspace it cannot act in", async () => {
    const service = start();
    await expect(service.host.connect({ ...connection, tenantId: "other" })).rejects.toThrow(/No OpenMA access/);
    await expect(service.host.connect({ ...connection, agentId: undefined as never })).rejects.toThrow(/Choose an Agent/);
    expect(service.db.apps.list()).toEqual([]);
    expect(ws).toHaveLength(0);
    const page = await service.fetch(
      new Request("https://matter.test/connect/feishu/registrations", {
        method: "POST",
        headers: {
          "x-matter-proxy-secret": "proxy-secret",
          "x-oma-tenant-id": "other",
        },
      }),
    );
    expect(page.status).toBe(401);
  });

  it("answers unknown paths with 404 and rejects MCP calls without a bearer", async () => {
    const service = start();
    expect((await service.fetch(new Request("https://matter.test/nope"))).status).toBe(404);
    const mcp = await service.fetch(
      new Request("https://matter.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(mcp.status).toBe(401);
  });
});

describe("ensureAgentMcpServer", () => {
  const client = () => createOmaClient({ baseUrl: "https://oma.test", apiKey: "test-key", fetch: oma.fetch as typeof fetch });

  beforeEach(() => {
    oma = new FakeOma();
  });

  it("adds the server once, repoints a stale URL, and retries a concurrent save", async () => {
    oma.agents.set("a", { id: "a", version: 3, mcp_servers: [] });
    await ensureAgentMcpServer(client(), "a", { name: "openmatter", url: "https://m.test/mcp" });
    expect(oma.agents.get("a")).toMatchObject({ version: 4, mcp_servers: [{ name: "openmatter", type: "url", url: "https://m.test/mcp" }] });
    const writes = () => oma.requests.filter((r) => r.method === "POST").length;
    const before = writes();
    await ensureAgentMcpServer(client(), "a", { name: "openmatter", url: "https://m.test/mcp" });
    expect(writes()).toBe(before);
    // A server left without its toolset gets one; nothing is duplicated.
    oma.agents.get("a")!.tools = [];
    await ensureAgentMcpServer(client(), "a", { name: "openmatter", url: "https://m.test/mcp" });
    expect(oma.agents.get("a")?.tools?.filter((t) => t.mcp_server_name === "openmatter")).toHaveLength(1);
    await ensureAgentMcpServer(client(), "a", { name: "openmatter", url: "https://m2.test/mcp" });
    expect(oma.agents.get("a")?.mcp_servers).toEqual([{ name: "openmatter", type: "url", url: "https://m2.test/mcp" }]);

    // A save in between bumps the version; the update is retried on 409.
    let raced = false;
    const racing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!raced && init?.method === "POST") {
        raced = true;
        oma.agents.get("a")!.version += 1;
      }
      return oma.fetch(input as string, init);
    }) as typeof fetch;
    await ensureAgentMcpServer(
      createOmaClient({ baseUrl: "https://oma.test", apiKey: "test-key", fetch: racing }),
      "a",
      { name: "openmatter", url: "https://m3.test/mcp" },
    );
    expect(oma.agents.get("a")?.mcp_servers).toEqual([{ name: "openmatter", type: "url", url: "https://m3.test/mcp" }]);
  });

  it("fails for a missing Agent", async () => {
    await expect(ensureAgentMcpServer(client(), "missing", { name: "openmatter", url: "https://m.test/mcp" })).rejects.toThrow(/not found/);
  });
});

describe("persistence", () => {
  it("seals with the purpose bound and refuses another key or purpose", () => {
    const box = createSecretBox("first-secret-key-0001");
    const sealed = box.seal("hello", "p1");
    expect(sealed).not.toContain("hello");
    expect(box.open(sealed, "p1")).toBe("hello");
    expect(() => box.open(sealed, "p2")).toThrow();
    expect(() => createSecretBox("second-secret-key-002").open(sealed, "p1")).toThrow();
    expect(() => createSecretBox("short")).toThrow(/at least 16/);
  });

  it("replaces an app connected again and resolves only issued tokens", async () => {
    dir = mkdtempSync(join(tmpdir(), "matter-db-"));
    const db = openMatterDatabase({ filename: join(dir, "m.sqlite"), box: createSecretBox("first-secret-key-0001") });
    db.apps.save(connection);
    db.apps.save({ ...connection, agentId: "agent-2", userId: undefined as never }, { botOpenId: "ou_bot" });
    expect(db.apps.list()).toEqual([
      expect.objectContaining({ appId: APP_ID, appSecret: APP_SECRET, agentId: "agent-2", botOpenId: "ou_bot", tenantId: "default" }),
    ]);
    expect(db.apps.get(APP_ID)?.userId).toBeUndefined();
    expect(db.apps.get("cli_other")).toBeUndefined();
    const token = await db.tokens.issue("session-1");
    expect(token).toMatch(/^omt_/);
    expect(await db.tokens.resolve(token)).toBe("session-1");
    expect(await db.tokens.resolve(`${token}x`)).toBeNull();
    expect(await db.tokens.resolve("")).toBeNull();
    db.close();
  });
});

describe("loadMatterConfig", () => {
  it("lists every problem and applies defaults", () => {
    expect(() => loadMatterConfig({})).toThrow(/MATTER_PROXY_SECRET is required[\s\S]*MATTER_SECRET_KEY is required[\s\S]*OMA_URL is required[\s\S]*OMA_API_KEY is required[\s\S]*OMA_ENVIRONMENT_ID is required/);
    expect(() =>
      loadMatterConfig({ MATTER_PROXY_SECRET: "s", MATTER_SECRET_KEY: "short", OMA_URL: "ftp://x", OMA_API_KEY: "k", MATTER_PORT: "x" }),
    ).toThrow(/MATTER_PORT[\s\S]*at least 16[\s\S]*OMA_URL must be/);
    expect(
      loadMatterConfig({ MATTER_PROXY_SECRET: "s", MATTER_SECRET_KEY: "a-long-enough-secret", OMA_URL: "http://oma:8787/", OMA_API_KEY: "k", OMA_ENVIRONMENT_ID: "env_1" }),
    ).toEqual({
      host: "127.0.0.1",
      port: 4720,
      dataDir: "./data/matter",
      proxySecret: "s",
      secretKey: "a-long-enough-secret",
      omaUrl: "http://oma:8787",
      omaApiKey: "k",
      omaTenantId: "default",
      mcpUrl: "http://127.0.0.1:4720/mcp",
      environmentId: "env_1",
    });
  });
});
