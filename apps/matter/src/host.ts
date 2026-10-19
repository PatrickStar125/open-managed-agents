/**
 * The running Matter service: one OpenMatter application per connection
 * (a Feishu app, a GitLab instance, …), whatever its kind. Each has its own
 * SQLite store and inbox, its adapter's event source and Loops, and an Agent
 * driver for the OpenMA Agent the user chose. All of them share the MCP
 * endpoint (and its bridge), which tells their Sessions apart by the
 * per-Session bearer. What differs per kind lives in a `MatterAdapter`.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeConnectorAgentDriver } from "@openma/matter/agent";
import { createOpenMatter } from "@openma/matter/runtime";
import { makeLocalLongConnectionRuntime } from "@openma/matter-host-local/runtime";
import { makeSqliteInbox } from "@openma/matter-inbox-sqlite";
import { makeSqliteStore } from "@openma/matter-store-sqlite";
import { Effect } from "effect";
import { isSafeConnectionKey, type MatterAdapter, type MatterConnection } from "./adapter.js";
import { createOpenMAConnector, isOmaSessionUnavailable } from "./connector.js";
import type { OmaClient, OmaMcpServer } from "./oma-client.js";
import type { MatterDatabase } from "./persistence.js";
import { sessionVaults } from "./session-tokens.js";
import type { OperationCallBridge } from "./tool-bridge.js";

export const DEFAULT_MCP_SERVER_NAME = "openmatter";

export interface MatterHostOptions {
  /** Where each connection's store and inbox live (`<dataDir>/apps/<key>/`). */
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
  /** Every kind of connection the service runs. Keys must not collide. */
  readonly adapters: readonly MatterAdapter<MatterConnection>[];
  readonly onError?: (error: unknown, key: string) => void;
}

export interface MatterHost {
  /** Start every saved connection of every adapter. */
  start(): Promise<void>;
  /** Start one saved connection, or start it again after it changed. */
  restart(kind: string, key: string): Promise<void>;
  /** Give an Agent the Matter MCP server before a connection uses it.
   * Throws when this service cannot act in the tenant. */
  prepareAgent(tenantId: string, agentId: string): Promise<void>;
  /** Keys of the connections currently running. */
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

interface Running {
  readonly stop: () => Promise<void>;
}

export const createMatterHost = (options: MatterHostOptions): MatterHost => {
  const mcpServerName = options.mcpServerName ?? DEFAULT_MCP_SERVER_NAME;
  const running = new Map<string, Running>();
  const report = (error: unknown, key: string) => options.onError?.(error, key);
  const adapterOf = (kind: string) => {
    const adapter = options.adapters.find((a) => a.kind === kind);
    if (adapter === undefined) throw new Error(`No adapter for ${kind}`);
    return adapter;
  };

  const startConnection = async (
    adapter: MatterAdapter<MatterConnection>,
    connection: MatterConnection,
  ): Promise<void> => {
    const { key } = connection;
    if (!isSafeConnectionKey(key)) throw new Error(`Unsafe connection key ${JSON.stringify(key)}`);
    await running.get(key)?.stop();
    running.delete(key);
    const client = options.clientFor(connection.tenantId);
    if (client === null) {
      report(new Error(`No OpenMA access for tenant ${connection.tenantId}`), key);
      return;
    }
    const dir = join(options.dataDir, "apps", key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const store = makeSqliteStore({ filename: join(dir, "store.sqlite") });
    const inbox = makeSqliteInbox({ filename: join(dir, "inbox.sqlite") });
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
    const wiring = adapter.wire(connection, (error) => report(error, key));
    const application = createOpenMatter({
      store,
      integrations: wiring.integrations,
      agents: {
        [connection.agentId]: makeConnectorAgentDriver({
          connector,
          agentId: connection.agentId,
          isSessionUnavailable: isOmaSessionUnavailable,
        }),
      },
    });
    wiring.install(application);
    const runtime = makeLocalLongConnectionRuntime({
      source: wiring.source,
      application,
      inbox,
      connectionLabel: connection.label,
      onError: (error) => report(error, key),
    });
    try {
      await runtime.start();
    } catch (error) {
      await Effect.runPromise(Effect.either(inbox.close));
      await Effect.runPromise(Effect.either(store.close));
      throw error;
    }
    running.set(key, {
      stop: async () => {
        await runtime.stop();
        await Effect.runPromise(Effect.either(inbox.close));
        await Effect.runPromise(Effect.either(store.close));
      },
    });
  };

  return {
    start: async () => {
      for (const adapter of options.adapters) {
        for (const connection of adapter.list()) {
          try {
            await startConnection(adapter, connection);
          } catch (error) {
            report(error, connection.key);
          }
        }
      }
    },
    restart: async (kind, key) => {
      const adapter = adapterOf(kind);
      const connection = adapter.get(key);
      if (connection === undefined) throw new Error(`No ${kind} connection ${key}`);
      await startConnection(adapter, connection);
    },
    prepareAgent: async (tenantId, agentId) => {
      const client = options.clientFor(tenantId);
      if (client === null) throw new Error(`No OpenMA access for tenant ${tenantId}`);
      await ensureAgentMcpServer(client, agentId, {
        name: mcpServerName,
        url: options.mcpServerUrl,
      });
    },
    running: () => [...running.keys()],
    stop: async () => {
      const all = [...running.values()];
      running.clear();
      await Promise.all(all.map((r) => r.stop()));
    },
  };
};
