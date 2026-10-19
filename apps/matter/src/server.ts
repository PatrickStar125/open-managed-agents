/**
 * The Matter service process: configuration from the environment, one HTTP
 * listener for the MCP endpoint and the "Connect Feishu" API, and the host
 * that runs every connection (see `adapter.ts`).
 */

import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import {
  createFeishuConnectHandler,
  FeishuConnectService,
  trustedProxyPrincipal,
  type FeishuConnection,
} from "./feishu-connect.js";
import type { FeishuLongConnectionOptions } from "@openma/matter-feishu/long-connection";
import { connectFeishuApp, createFeishuAdapter } from "./feishu-adapter.js";
import { createMatterHost, type MatterHost, type MatterHostOptions } from "./host.js";
import { createMatterMcpHandler } from "./mcp-server.js";
import { createOmaClient, type OmaClient } from "./oma-client.js";
import { createSecretBox, openMatterDatabase, type MatterDatabase } from "./persistence.js";
import { OperationCallBridge } from "./tool-bridge.js";

export interface MatterConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  /** Shared with the OpenMA control plane (`MATTER_PROXY_SECRET`). */
  readonly proxySecret: string;
  /** Seals app secrets at rest. */
  readonly secretKey: string;
  readonly omaUrl: string;
  readonly omaApiKey: string;
  /** The OpenMA workspace the API key belongs to; apps of other workspaces
   * are refused. */
  readonly omaTenantId: string;
  /** The MCP endpoint as OpenMA reaches it. */
  readonly mcpUrl: string;
  /** The OpenMA environment new sessions run in. */
  readonly environmentId: string;
}

export class MatterConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid Matter configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "MatterConfigError";
  }
}

export const loadMatterConfig = (env: NodeJS.ProcessEnv): MatterConfig => {
  const problems: string[] = [];
  const required = (key: string): string => {
    const value = env[key];
    if (value === undefined || value === "") problems.push(`${key} is required`);
    return value ?? "";
  };
  const url = (key: string, fallback?: string): string => {
    const value = env[key] || fallback;
    if (value === undefined) {
      problems.push(`${key} is required`);
      return "";
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      problems.push(`${key} must be an absolute http(s) URL`);
    }
    return value.replace(/\/+$/, "");
  };
  const portRaw = env.MATTER_PORT ?? "4720";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    problems.push(`MATTER_PORT must be a port number; received ${JSON.stringify(portRaw)}`);
  }
  const host = env.MATTER_HOST || "127.0.0.1";
  const proxySecret = required("MATTER_PROXY_SECRET");
  const secretKey = required("MATTER_SECRET_KEY");
  if (secretKey !== "" && secretKey.length < 16) {
    problems.push("MATTER_SECRET_KEY must be at least 16 characters");
  }
  const config: MatterConfig = {
    host,
    port,
    dataDir: env.MATTER_DATA_DIR || "./data/matter",
    proxySecret,
    secretKey,
    omaUrl: url("OMA_URL"),
    omaApiKey: required("OMA_API_KEY"),
    omaTenantId: env.OMA_TENANT_ID || "default",
    mcpUrl: url("MATTER_MCP_URL", `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/mcp`),
    environmentId: required("OMA_ENVIRONMENT_ID"),
  };
  if (problems.length > 0) throw new MatterConfigError(problems);
  return config;
};

export interface MatterService {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly host: MatterHost;
  readonly db: MatterDatabase;
  /** What the "Connect Feishu" flow calls with a registered app. */
  readonly connectFeishu: (connection: FeishuConnection) => Promise<void>;
  close(): Promise<void>;
}

/** Everything but the listener, so tests drive it with plain Requests. */
export const createMatterService = (
  config: MatterConfig,
  overrides: Partial<Pick<MatterHostOptions, "onError">> & {
    /** Reaches the providers (Feishu); tests pass a fake. */
    readonly fetch?: typeof fetch;
    readonly createWsClient?: FeishuLongConnectionOptions["createClient"];
    readonly omaFetch?: typeof fetch;
    readonly feishuConnectFetch?: typeof fetch;
  } = {},
): MatterService => {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = openMatterDatabase({
    filename: join(config.dataDir, "matter.sqlite"),
    box: createSecretBox(config.secretKey),
  });
  const oma: OmaClient = createOmaClient({
    baseUrl: config.omaUrl,
    apiKey: config.omaApiKey,
    ...(overrides.omaFetch === undefined ? {} : { fetch: overrides.omaFetch }),
  });
  const clientFor = (tenantId: string) => (tenantId === config.omaTenantId ? oma : null);
  const bridge = new OperationCallBridge();
  const providerFetch = overrides.fetch === undefined ? {} : { fetch: overrides.fetch };
  const host = createMatterHost({
    dataDir: config.dataDir,
    db,
    bridge,
    clientFor,
    mcpServerUrl: config.mcpUrl,
    environmentId: config.environmentId,
    adapters: [
      createFeishuAdapter({
        db,
        ...providerFetch,
        ...(overrides.createWsClient === undefined ? {} : { createWsClient: overrides.createWsClient }),
      }),
    ],
    onError:
      overrides.onError ??
      ((error, key) =>
        console.error(`[matter] ${key}:`, error instanceof Error ? error.message : error)),
  });
  const connectFeishu = connectFeishuApp(host, { db, ...providerFetch });
  const proxied = trustedProxyPrincipal(config.proxySecret);
  const connect = createFeishuConnectHandler({
    service: new FeishuConnectService({
      onRegistered: connectFeishu,
      ...(overrides.feishuConnectFetch === undefined ? {} : { fetch: overrides.feishuConnectFetch }),
    }),
    // Only the workspace this service can act in may connect apps.
    authorize: async (request) => {
      const principal = await proxied(request);
      return principal?.tenantId === config.omaTenantId ? principal : null;
    },
  });
  const mcp = createMatterMcpHandler({ bridge, tokens: db.tokens });

  const fetchHandler = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return Response.json({ status: "ok", apps: host.running().length });
    }
    if (path === "/mcp") return mcp(request);
    return (await connect(request)) ?? Response.json({ error: "not found" }, { status: 404 });
  };

  return {
    fetch: fetchHandler,
    host,
    db,
    connectFeishu,
    close: async () => {
      await host.stop();
      db.close();
    },
  };
};

const toRequest = async (req: IncomingMessage, origin: string): Promise<Request> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(chunks) }),
  });
};

/** Serve a MatterService on node:http. */
export const listen = (
  service: MatterService,
  config: Pick<MatterConfig, "host" | "port">,
): Promise<Server> =>
  new Promise((resolve) => {
    const origin = `http://${config.host}:${config.port}`;
    const server = createServer((req, res) => {
      void (async () => {
        try {
          const response = await service.fetch(await toRequest(req, origin));
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          console.error("[matter] request failed:", error instanceof Error ? error.message : error);
          if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"internal_error"}');
        }
      })();
    });
    server.listen(config.port, config.host, () => resolve(server));
  });
