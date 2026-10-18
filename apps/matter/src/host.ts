/**
 * The running Matter service: one OpenMatter application per connected
 * Feishu app. Each has its own SQLite store and inbox, its own long
 * connection to Feishu, and the `feishu-agent` Loop bound to the OpenMA
 * Agent the user chose. All of them share the MCP endpoint (and its bridge),
 * which tells their Sessions apart by the per-Session bearer.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeConnectorAgentDriver } from "@openma/matter/agent";
import { createOpenMatter } from "@openma/matter/runtime";
import {
  feishuAgent,
  inspectFeishuApp,
  makeFeishuIntegration,
  mintTenantAccessToken,
  type FeishuCredentials,
} from "@openma/matter-feishu/bond";
import {
  makeFeishuLongConnectionSource,
  type FeishuLongConnectionOptions,
} from "@openma/matter-feishu/long-connection";
import { makeLocalLongConnectionRuntime } from "@openma/matter-host-local/runtime";
import { makeSqliteInbox } from "@openma/matter-inbox-sqlite";
import { makeSqliteStore } from "@openma/matter-store-sqlite";
import { Effect } from "effect";
import { createOpenMAConnector, isOmaSessionUnavailable } from "./connector.js";
import type { FeishuConnection } from "./feishu-connect.js";
import type { OmaClient, OmaMcpServer } from "./oma-client.js";
import type { FeishuAppRecord, MatterDatabase } from "./persistence.js";
import { sessionVaults } from "./session-tokens.js";
import type { OperationCallBridge } from "./tool-bridge.js";

export const DEFAULT_MCP_SERVER_NAME = "openmatter";

export interface MatterHostOptions {
  /** Where each app's store and inbox live (`<dataDir>/apps/<appId>/`). */
  readonly dataDir: string;
  readonly db: MatterDatabase;
  readonly bridge: OperationCallBridge;
  /** The OpenMA API client for a tenant, or null when this service cannot
   * act in that tenant. */
  readonly clientFor: (tenantId: string) => OmaClient | null;
  /** The Matter MCP endpoint as OpenMA reaches it. */
  readonly mcpServerUrl: string;
  readonly mcpServerName?: string;
  /** The OpenMA environment new sessions run in. */
  readonly environmentId: string;
  readonly fetch?: typeof fetch;
  /** Builds the Feishu WebSocket client; tests pass a fake. */
  readonly createWsClient?: FeishuLongConnectionOptions["createClient"];
  readonly onError?: (error: unknown, appId: string) => void;
}

export interface MatterHost {
  /** Start every connected app. */
  start(): Promise<void>;
  /** `onRegistered` for `FeishuConnectService`: store the app, give the
   * Agent the Matter MCP server, and start answering. */
  connect(connection: FeishuConnection): Promise<void>;
  /** Apps currently connected to Feishu. */
  running(): readonly string[];
  stop(): Promise<void>;
}

/**
 * Add the Matter MCP server (and the `mcp_toolset` OpenMA requires for it)
 * to an Agent, or point it at `url` again. Other servers and tools are kept.
 * A no-op when the Agent already has both.
 */
export const ensureAgentMcpServer = async (
  client: OmaClient,
  agentId: string,
  server: { readonly name: string; readonly url: string },
): Promise<void> => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const agent = await client.getAgent(agentId);
    if (agent === null) throw new Error(`OpenMA Agent ${agentId} not found`);
    const servers = agent.mcp_servers ?? [];
    const tools = agent.tools ?? [];
    const current = servers.find((s) => s.name === server.name);
    const toolset = tools.some(
      (t) => t.type === "mcp_toolset" && t.mcp_server_name === server.name,
    );
    if (current?.type === "url" && current.url === server.url && toolset) return;
    const next: OmaMcpServer[] = [
      ...servers.filter((s) => s.name !== server.name),
      { name: server.name, type: "url", url: server.url },
    ];
    try {
      await client.updateAgentMcp(agentId, agent.version, {
        mcp_servers: next,
        // Every MCP server must be referenced by an mcp_toolset. Nobody is
        // around to approve a call from a chat, so allow it explicitly
        // instead of relying on the server's default policy.
        tools: toolset
          ? tools
          : [
              ...tools,
              {
                type: "mcp_toolset",
                mcp_server_name: server.name,
                default_config: { permission_policy: { type: "always_allow" } },
              },
            ],
      });
      return;
    } catch (error) {
      // Someone saved the Agent in between; read it again.
      if ((error as { status?: number }).status !== 409) throw error;
    }
  }
  throw new Error(`OpenMA Agent ${agentId} kept changing; try again`);
};

/** Tenant tokens for one app, minted on demand and reused until shortly
 * before they expire. Never persisted. */
const tenantTokens = (app: FeishuAppRecord, doFetch?: typeof fetch) => {
  let cached: { token: string; refreshAt: number } | undefined;
  return async (): Promise<FeishuCredentials> => {
    if (cached === undefined || Date.now() >= cached.refreshAt) {
      const minted = await Effect.runPromise(
        mintTenantAccessToken({
          baseUrl: app.baseUrl,
          appId: app.appId,
          appSecret: app.appSecret,
          ...(doFetch === undefined ? {} : { fetch: doFetch }),
        }),
      );
      cached = {
        token: minted.token,
        refreshAt: Date.parse(minted.expiresAt) - 5 * 60_000,
      };
    }
    return { baseUrl: app.baseUrl, token: cached.token };
  };
};

interface Running {
  readonly stop: () => Promise<void>;
}

export const createMatterHost = (options: MatterHostOptions): MatterHost => {
  const mcpServerName = options.mcpServerName ?? DEFAULT_MCP_SERVER_NAME;
  const running = new Map<string, Running>();
  const report = (error: unknown, appId: string) =>
    options.onError?.(error, appId);

  const startApp = async (app: FeishuAppRecord): Promise<void> => {
    await running.get(app.appId)?.stop();
    running.delete(app.appId);
    const client = options.clientFor(app.tenantId);
    if (client === null) {
      report(new Error(`No OpenMA access for tenant ${app.tenantId}`), app.appId);
      return;
    }
    const dir = join(options.dataDir, "apps", app.appId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = makeSqliteStore({ filename: join(dir, "store.sqlite") });
    const inbox = makeSqliteInbox({ filename: join(dir, "inbox.sqlite") });
    const credentials = tenantTokens(app, options.fetch);
    const connector = createOpenMAConnector({
      client,
      bridge: options.bridge,
      mcpServerName,
      vaultIds: sessionVaults({
        client,
        tokens: options.db.tokens,
        mcpServerUrl: options.mcpServerUrl,
      }),
      environmentId: options.environmentId,
    });
    const application = createOpenMatter({
      store,
      integrations: {
        feishu: makeFeishuIntegration({
          // Every event of this application carries this app as authority.
          credentials: () => credentials(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      },
      agents: {
        [app.agentId]: makeConnectorAgentDriver({
          connector,
          agentId: app.agentId,
          isSessionUnavailable: isOmaSessionUnavailable,
        }),
      },
    });
    application.loop(feishuAgent, { agentId: app.agentId });
    const runtime = makeLocalLongConnectionRuntime({
      source: makeFeishuLongConnectionSource({
        baseUrl: app.baseUrl,
        appId: app.appId,
        appSecret: app.appSecret,
        authority: app.appId,
        ...(app.botOpenId === undefined ? {} : { botOpenId: app.botOpenId }),
        ...(options.createWsClient === undefined
          ? {}
          : { createClient: options.createWsClient }),
        onState: (state) => {
          if (state.state === "failed") report(state.error, app.appId);
        },
      }),
      application,
      inbox,
      connectionLabel: `Feishu app ${app.appId}`,
      onError: (error) => report(error, app.appId),
    });
    try {
      await runtime.start();
    } catch (error) {
      await Effect.runPromise(Effect.either(inbox.close));
      await Effect.runPromise(Effect.either(store.close));
      throw error;
    }
    running.set(app.appId, {
      stop: async () => {
        await runtime.stop();
        await Effect.runPromise(Effect.either(inbox.close));
        await Effect.runPromise(Effect.either(store.close));
      },
    });
  };

  return {
    start: async () => {
      for (const app of options.db.apps.list()) {
        try {
          await startApp(app);
        } catch (error) {
          report(error, app.appId);
        }
      }
    },
    connect: async (connection) => {
      if (connection.agentId === undefined) {
        throw new Error("Choose an Agent to answer in Feishu");
      }
      const client = options.clientFor(connection.tenantId);
      if (client === null) {
        throw new Error(`No OpenMA access for tenant ${connection.tenantId}`);
      }
      await ensureAgentMcpServer(client, connection.agentId, {
        name: mcpServerName,
        url: options.mcpServerUrl,
      });
      // The bot's open_id decides which group messages mention it. Without
      // it the long connection still delivers direct messages.
      const info = await Effect.runPromise(
        Effect.either(
          inspectFeishuApp({
            baseUrl: connection.app.baseUrl,
            appId: connection.app.appId,
            appSecret: connection.app.appSecret,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        ),
      );
      const record = options.db.apps.save(
        { ...connection, agentId: connection.agentId },
        info._tag === "Right" ? { botOpenId: info.right.botOpenId } : {},
      );
      await startApp(record);
    },
    running: () => [...running.keys()],
    stop: async () => {
      const all = [...running.values()];
      running.clear();
      await Promise.all(all.map((r) => r.stop()));
    },
  };
};
