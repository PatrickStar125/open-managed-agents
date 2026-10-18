/**
 * Durable state of the Matter service that OpenMatter's own stores do not
 * cover: the Feishu apps users connected (app secrets sealed), and the hashes
 * of the per-Session MCP bearers. One SQLite file (`node:sqlite`).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { FeishuBrand } from "@openma/matter-feishu/bond";
import type { FeishuConnection } from "./feishu-connect.js";
import type { SessionTokenStore } from "./session-tokens.js";

/** AES-256-GCM with a key derived from the operator's secret. The purpose is
 * bound as additional data, so a sealed value cannot be moved to another
 * column or app. */
export interface SecretBox {
  seal(plaintext: string, purpose: string): string;
  open(sealed: string, purpose: string): string;
}

export const createSecretBox = (secret: string): SecretBox => {
  if (secret.length < 16) {
    throw new Error("MATTER_SECRET_KEY must be at least 16 characters");
  }
  const key = createHash("sha256").update(`openmatter:${secret}`, "utf8").digest();
  return {
    seal: (plaintext, purpose) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(purpose, "utf8"));
      const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), data].map((p) =>
        typeof p === "string" ? p : p.toString("base64url"),
      ).join(".");
    },
    open: (sealed, purpose) => {
      const [version, iv, tag, data] = sealed.split(".");
      if (version !== "v1" || iv === undefined || tag === undefined || data === undefined) {
        throw new Error("Unrecognized sealed value");
      }
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAAD(Buffer.from(purpose, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(data, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    },
  };
};

/** A connected Feishu app with its secret opened. */
export interface FeishuAppRecord {
  readonly appId: string;
  readonly appSecret: string;
  readonly brand: FeishuBrand;
  readonly baseUrl: string;
  readonly tenantId: string;
  readonly userId?: string;
  readonly agentId: string;
  readonly botOpenId?: string;
  readonly connectedAt: string;
}

export interface MatterDatabase {
  readonly apps: {
    /** Insert or replace: connecting the same app again moves it. */
    save(
      connection: FeishuConnection & { readonly agentId: string },
      extra?: { readonly botOpenId?: string },
    ): FeishuAppRecord;
    list(): readonly FeishuAppRecord[];
    get(appId: string): FeishuAppRecord | undefined;
  };
  readonly tokens: SessionTokenStore;
  close(): void;
}

const appSecretPurpose = (appId: string) => `feishu-app-secret:${appId}`;

const tokenDigest = (token: string): Buffer =>
  createHash("sha256").update(token, "utf8").digest();

export const openMatterDatabase = (options: {
  readonly filename: string;
  readonly box: SecretBox;
  readonly now?: () => Date;
}): MatterDatabase => {
  const now = options.now ?? (() => new Date());
  const db = new DatabaseSync(options.filename);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS feishu_apps (
      app_id TEXT PRIMARY KEY,
      app_secret TEXT NOT NULL,
      brand TEXT NOT NULL,
      base_url TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT,
      agent_id TEXT NOT NULL,
      bot_open_id TEXT,
      connected_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_tokens (
      digest TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      issued_at TEXT NOT NULL
    );
  `);

  type Row = {
    app_id: string;
    app_secret: string;
    brand: string;
    base_url: string;
    tenant_id: string;
    user_id: string | null;
    agent_id: string;
    bot_open_id: string | null;
    connected_at: string;
  };
  const toRecord = (row: Row): FeishuAppRecord => ({
    appId: row.app_id,
    appSecret: options.box.open(row.app_secret, appSecretPurpose(row.app_id)),
    brand: row.brand as FeishuBrand,
    baseUrl: row.base_url,
    tenantId: row.tenant_id,
    ...(row.user_id === null ? {} : { userId: row.user_id }),
    agentId: row.agent_id,
    ...(row.bot_open_id === null ? {} : { botOpenId: row.bot_open_id }),
    connectedAt: row.connected_at,
  });

  const upsert = db.prepare(`
    INSERT INTO feishu_apps (app_id, app_secret, brand, base_url, tenant_id, user_id, agent_id, bot_open_id, connected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (app_id) DO UPDATE SET
      app_secret = excluded.app_secret, brand = excluded.brand, base_url = excluded.base_url,
      tenant_id = excluded.tenant_id, user_id = excluded.user_id, agent_id = excluded.agent_id,
      bot_open_id = excluded.bot_open_id, connected_at = excluded.connected_at
  `);
  const selectAll = db.prepare(`SELECT * FROM feishu_apps ORDER BY connected_at, app_id`);
  const selectOne = db.prepare(`SELECT * FROM feishu_apps WHERE app_id = ?`);
  const insertToken = db.prepare(
    `INSERT INTO session_tokens (digest, session_id, issued_at) VALUES (?, ?, ?)`,
  );
  const selectToken = db.prepare(`SELECT digest, session_id FROM session_tokens WHERE digest = ?`);

  return {
    apps: {
      save: (connection, extra = {}) => {
        const { app } = connection;
        upsert.run(
          app.appId,
          options.box.seal(app.appSecret, appSecretPurpose(app.appId)),
          app.brand,
          app.baseUrl,
          connection.tenantId,
          connection.userId ?? null,
          connection.agentId,
          extra.botOpenId ?? null,
          now().toISOString(),
        );
        return toRecord(selectOne.get(app.appId) as Row);
      },
      list: () => (selectAll.all() as Row[]).map(toRecord),
      get: (appId) => {
        const row = selectOne.get(appId) as Row | undefined;
        return row === undefined ? undefined : toRecord(row);
      },
    },
    tokens: {
      issue: async (sessionId) => {
        const token = `omt_${randomBytes(32).toString("base64url")}`;
        insertToken.run(tokenDigest(token).toString("hex"), sessionId, now().toISOString());
        return token;
      },
      resolve: async (token) => {
        if (token.length === 0) return null;
        const digest = tokenDigest(token);
        const row = selectToken.get(digest.toString("hex")) as
          | { digest: string; session_id: string }
          | undefined;
        return row !== undefined && timingSafeEqual(Buffer.from(row.digest, "hex"), digest)
          ? row.session_id
          : null;
      },
    },
    close: () => db.close(),
  };
};
