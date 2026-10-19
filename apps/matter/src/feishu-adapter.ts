/**
 * Feishu as a Matter adapter: each connected app has a long connection to
 * Feishu and runs the `feishu-agent` Loop bound to the OpenMA Agent the user
 * chose. The app id is the connection key and the OpenMatter authority.
 */

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
import { Effect } from "effect";
import type { MatterAdapter, MatterConnection } from "./adapter.js";
import type { FeishuConnection } from "./feishu-connect.js";
import type { MatterHost } from "./host.js";
import type { FeishuAppRecord, MatterDatabase } from "./persistence.js";

export type FeishuAppConnection = FeishuAppRecord & MatterConnection;

export interface FeishuAdapterOptions {
  readonly db: MatterDatabase;
  readonly fetch?: typeof fetch;
  /** Builds the Feishu WebSocket client; tests pass a fake. */
  readonly createWsClient?: FeishuLongConnectionOptions["createClient"];
}

const asConnection = (app: FeishuAppRecord): FeishuAppConnection => ({
  ...app,
  key: app.appId,
  label: `Feishu app ${app.appId}`,
});

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

export const FEISHU_ADAPTER_KIND = "feishu";

export const createFeishuAdapter = (
  options: FeishuAdapterOptions,
): MatterAdapter<FeishuAppConnection> => ({
  kind: FEISHU_ADAPTER_KIND,
  list: () => options.db.apps.list().map(asConnection),
  get: (key) => {
    const app = options.db.apps.get(key);
    return app === undefined ? undefined : asConnection(app);
  },
  wire: (app, report) => {
    const credentials = tenantTokens(app, options.fetch);
    return {
      integrations: {
        feishu: makeFeishuIntegration({
          // Every event of this application carries this app as authority.
          credentials: () => credentials(),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }),
      },
      install: (application) => application.loop(feishuAgent, { agentId: app.agentId }),
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
          if (state.state === "failed") report(state.error);
        },
      }),
    };
  },
});

/**
 * `onRegistered` for `FeishuConnectService`: give the Agent the Matter MCP
 * server, store the app, and start answering.
 */
export const connectFeishuApp =
  (host: MatterHost, options: Pick<FeishuAdapterOptions, "db" | "fetch">) =>
  async (connection: FeishuConnection): Promise<void> => {
    if (connection.agentId === undefined) {
      throw new Error("Choose an Agent to answer in Feishu");
    }
    await host.prepareAgent(connection.tenantId, connection.agentId);
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
    await host.restart(FEISHU_ADAPTER_KIND, record.appId);
  };
