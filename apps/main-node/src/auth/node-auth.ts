// Auth component. The control plane needs three things from an identity
// provider: a handler for /auth/*, session resolution from request headers,
// and a user lookup for membership listings. better-auth is the default
// adapter; a deployment can pass any object with this shape.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { applyBetterAuthSchema } from "@open-managed-agents/schema";
import {
  buildBetterAuth,
  ensureTenantSqlite,
  validateOidcSignInProviders,
  type OidcSignInProvider,
} from "@open-managed-agents/auth-config";
import type { SignInProviderInfo } from "@open-managed-agents/shared";
import type { EmailSender } from "@open-managed-agents/email";
import type { SqlClient } from "@open-managed-agents/sql-client";

import type { NodeConfig } from "../config.js";
import type { NodeDatabase } from "../database.js";
import { loadBetterSqlite3 } from "../lib/better-sqlite3.js";

export interface NodeAuthSession {
  userId: string;
  email: string | null;
  name: string | null;
}

/** Sign-in methods an auth component offers; /auth-info reports them. */
export interface NodeSignInMethods {
  /** Email and password sign-in and sign-up. */
  emailPassword: boolean;
  /** Deployment-configured OpenID Connect providers. */
  oidc: SignInProviderInfo[];
}

export interface NodeAuth {
  /** Shown in /health as `auth`. */
  description: string;
  /** When present, /auth-info reports these instead of the config defaults. */
  signInMethods?: NodeSignInMethods;
  /** Serves everything under /auth/*. */
  handler(request: Request): Promise<Response> | Response;
  /** The signed-in user for a request, or null. */
  resolveSession(headers: Headers): Promise<NodeAuthSession | null>;
  /** Display fields for a user id (tenant membership listings). */
  findUser(userId: string): Promise<{ name: string | null; email: string | null } | null>;
  stop?(): Promise<void>;
}

export interface BetterAuthComponentOptions {
  config: Pick<NodeConfig, "auth" | "http">;
  database: NodeDatabase;
  email: EmailSender | null;
  /** Invoked when BETTER_AUTH_SECRET is unset; the default generates a per-process secret. */
  onMissingSecret?: () => void;
  /**
   * Deployment wire point for sign-in. `oidc` adds OpenID Connect providers,
   * such as a company SSO; `emailPassword: false` leaves only OAuth and OIDC
   * sign-in. Built-in Google and GitHub still follow the config.
   */
  signIn?: {
    oidc?: readonly OidcSignInProvider[];
    emailPassword?: boolean;
  };
}

export async function createBetterAuthComponent(
  options: BetterAuthComponentOptions,
): Promise<NodeAuth> {
  const { config, database, email } = options;
  const { sql } = database;
  const oidcProviders = options.signIn?.oidc ?? [];
  const emailPassword = options.signIn?.emailPassword ?? true;
  validateOidcSignInProviders(oidcProviders);
  const secret = config.auth.secret ?? randomSecret(options.onMissingSecret);
  const shared = {
    sender: email,
    secret,
    baseURL: config.http.publicBaseUrl,
    googleClientId: config.auth.google.clientId,
    googleClientSecret: config.auth.google.clientSecret,
    githubClientId: config.auth.github.clientId,
    githubClientSecret: config.auth.github.clientSecret,
    requireEmailVerify: config.auth.requireEmailVerify,
    cookieDomain: config.auth.cookieDomain,
    oidcProviders,
    emailPassword,
    ensureTenant: (u: { id: string; name?: string | null; email?: string | null }) =>
      ensureTenantSqlite(sql, u.id, u.name, u.email),
  };

  let auth: ReturnType<typeof buildBetterAuth>;
  let stop: (() => Promise<void>) | undefined;
  const driver = database.driver;
  if (database.dialect === "postgres") {
    if (driver?.kind !== "postgres") throw missingDriver("postgres");
    const { Pool } = (await import("pg")) as typeof import("pg");
    const pool = new Pool({ connectionString: driver.connectionString });
    await applyBetterAuthSchema({ sql, dialect: "postgres" });
    auth = buildBetterAuth({ ...shared, database: pool });
    stop = async () => {
      await pool.end();
    };
  } else if (database.dialect === "mysql") {
    if (driver?.kind !== "mysql") throw missingDriver("mysql");
    await applyBetterAuthSchema({ sql, dialect: "mysql" });
    auth = buildBetterAuth({ ...shared, database: driver.pool });
  } else {
    // SQLite keeps Better Auth in its own file, separate from the main database.
    const authDbPath = config.auth.databasePath;
    mkdirSync(dirname(authDbPath), { recursive: true });
    const BetterSqlite3 = await loadBetterSqlite3();
    const authDb = new BetterSqlite3(authDbPath);
    await applyBetterAuthSchema({ sql: betterSqliteAsSqlClient(authDb), dialect: "sqlite" });
    auth = buildBetterAuth({ ...shared, database: authDb });
    stop = async () => {
      authDb.close();
    };
  }

  return {
    description: `better-auth-${database.dialect === "postgres" ? "pg" : database.dialect}`,
    signInMethods: {
      emailPassword,
      oidc: oidcProviders.map((p) => ({ id: p.id, name: p.name })),
    },
    handler: (request) => auth.handler(request),
    resolveSession: async (headers) => {
      const session = (await auth.api.getSession({ headers })) as
        | { user?: { id: string; email?: string | null; name?: string | null } }
        | null;
      if (!session?.user) return null;
      return {
        userId: session.user.id,
        email: session.user.email ?? null,
        name: session.user.name ?? null,
      };
    },
    findUser: async (userId) => {
      const user = await (await auth.$context).internalAdapter.findUserById(userId);
      return user ? { name: user.name ?? null, email: user.email ?? null } : null;
    },
    ...(stop !== undefined && { stop }),
  };
}

function missingDriver(dialect: string): Error {
  return new Error(
    `The default Better Auth adapter needs the ${dialect} driver handle from openNodeDatabase(); `
      + "pass your own NodeAuth (or auth: null) when supplying a custom NodeDatabase.",
  );
}

function randomSecret(onMissing: (() => void) | undefined): string {
  onMissing?.();
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Lightweight SqlClient shim around a better-sqlite3 Database, used only to
 * run the better-auth schema apply against the auth db (a separate
 * connection from the main SqlClient). Only .exec() is needed.
 */
function betterSqliteAsSqlClient(db: import("better-sqlite3").Database): SqlClient {
  return {
    exec: async (s: string) => {
      db.exec(s);
    },
    prepare: () => {
      throw new Error("not implemented");
    },
    batch: async () => [],
  } as SqlClient;
}
