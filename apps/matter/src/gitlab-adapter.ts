/**
 * GitLab as a Matter adapter. A connection is one GitLab instance and the
 * bot user whose token posts the replies; GitLab sends project webhooks to
 * `POST /webhooks/gitlab/<id>`, checked against the connection's own secret,
 * and the `gitlab-mention` Loop answers merge request comments that mention
 * the bot. A webhook is answered 202 only once it is in the durable inbox, so
 * GitLab retries anything that was not.
 */

import { randomBytes } from "node:crypto";
import type { ReceivedEnvelope } from "@openma/matter-host-local/runtime";
import {
  decodeGitLabHttpRequest,
  gitlabMention,
  makeGitLabIntegration,
} from "@openma/matter-gitlab/bond";
import { Effect } from "effect";
import type { MatterAdapter, MatterConnection } from "./adapter.js";
import type { FeishuConnectPrincipal } from "./feishu-connect.js";
import type { MatterHost } from "./host.js";
import type { GitLabConnectionRecord, MatterDatabase } from "./persistence.js";

export type GitLabConnection = GitLabConnectionRecord & MatterConnection;

export const GITLAB_ADAPTER_KIND = "gitlab";

const asConnection = (record: GitLabConnectionRecord): GitLabConnection => ({
  ...record,
  key: record.id,
  label: `GitLab ${record.username}@${new URL(record.baseUrl).host}`,
});

/** Accepts webhooks for the connections that are running. */
type Submit = (envelope: Omit<ReceivedEnvelope, "ack">) => Promise<boolean>;

export interface GitLabAdapter extends MatterAdapter<GitLabConnection> {
  /** Persist one webhook delivery; false when the connection is not running
   * or the inbox did not take it. */
  readonly submit: (key: string, envelope: Omit<ReceivedEnvelope, "ack">) => Promise<boolean>;
}

export const createGitLabAdapter = (options: {
  readonly db: MatterDatabase;
  readonly fetch?: typeof fetch;
}): GitLabAdapter => {
  const submitters = new Map<string, Submit>();
  return {
    kind: GITLAB_ADAPTER_KIND,
    list: () => options.db.gitlab.list().map(asConnection),
    get: (key) => {
      const record = options.db.gitlab.get(key);
      return record === undefined ? undefined : asConnection(record);
    },
    submit: async (key, envelope) => (await submitters.get(key)?.(envelope)) ?? false,
    wire: (connection) => {
      let deliver: ((envelope: ReceivedEnvelope) => Promise<void>) | undefined;
      submitters.set(connection.key, async (envelope) => {
        if (deliver === undefined) return false;
        // The runtime acknowledges only after the inbox has the envelope.
        let persisted = false;
        await deliver({
          ...envelope,
          ack: async () => {
            persisted = true;
          },
        });
        return persisted;
      });
      return {
        integrations: {
          gitlab: makeGitLabIntegration({
            credentials: { baseUrl: connection.baseUrl, token: connection.token },
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          }),
        },
        install: (application) =>
          application.loop(gitlabMention, {
            agentId: connection.agentId,
            projects: connection.projectIds.map((id) => `project:${id}`),
            username: connection.username,
          }),
        source: {
          start: async (onEnvelope) => {
            deliver = onEnvelope;
          },
          stop: async () => {
            deliver = undefined;
          },
        },
      };
    },
  };
};

const PATH = /^\/webhooks\/gitlab\/([A-Za-z0-9_-]+)$/;

/**
 * `POST /webhooks/gitlab/<id>`, called by GitLab directly (not through the
 * Console proxy). The connection's webhook secret authenticates it.
 */
export const createGitLabWebhookHandler = (adapter: GitLabAdapter) =>
  async (request: Request): Promise<Response | undefined> => {
    const match = PATH.exec(new URL(request.url).pathname.replace(/\/+$/, ""));
    if (match?.[1] === undefined) return undefined;
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const key = match[1];
    const connection = adapter.get(key);
    if (connection === undefined) return Response.json({ error: "not found" }, { status: 404 });
    const decoded = await Effect.runPromise(
      Effect.either(
        decodeGitLabHttpRequest(request, {
          webhookToken: connection.webhookSecret,
          authority: key,
        }),
      ),
    );
    if (decoded._tag === "Left") {
      return Response.json({ error: decoded.left.message }, { status: decoded.left.status });
    }
    const input = decoded.right;
    const persisted = await adapter.submit(key, {
      integrationId: "gitlab",
      idempotencyKey: `gitlab:${key}:${input.deliveryId}`,
      eventType: input.eventName,
      body: input,
    });
    return persisted
      ? new Response(null, { status: 202 })
      : Response.json({ error: "not accepting webhooks right now" }, { status: 503 });
  };

/** What `POST /connect/gitlab` returns, once: the secret is not shown again. */
export interface GitLabConnectResult {
  readonly id: string;
  readonly username: string;
  readonly projectIds: readonly number[];
  /** Absolute when `MATTER_PUBLIC_URL` is set, otherwise the path. */
  readonly webhookUrl: string;
  readonly webhookSecret: string;
}

export class GitLabConnectError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502,
  ) {
    super(message);
    this.name = "GitLabConnectError";
  }
}

const parseProjectIds = (value: unknown): number[] | undefined => {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const ids = value.map((v) => (typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v));
  return ids.every((id) => Number.isSafeInteger(id) && (id as number) > 0)
    ? [...new Set(ids as number[])]
    : undefined;
};

const parseBaseUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return undefined;
    }
    return url.href.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
};

/**
 * Connect a GitLab instance: check the bot token against `/api/v4/user`,
 * give the Agent the Matter MCP server, save the connection, and start it.
 */
export const connectGitLab =
  (
    host: MatterHost,
    options: {
      readonly db: MatterDatabase;
      readonly publicUrl?: string;
      readonly fetch?: typeof fetch;
    },
  ) =>
  async (
    principal: FeishuConnectPrincipal,
    body: unknown,
  ): Promise<GitLabConnectResult> => {
    const input =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const baseUrl = parseBaseUrl(input.baseUrl);
    if (baseUrl === undefined) {
      throw new GitLabConnectError("baseUrl must be the instance's http(s) root URL", 400);
    }
    if (typeof input.token !== "string" || input.token.trim() === "") {
      throw new GitLabConnectError("token is required", 400);
    }
    if (typeof input.agentId !== "string" || input.agentId === "") {
      throw new GitLabConnectError("agentId is required", 400);
    }
    const projectIds = parseProjectIds(input.projectIds);
    if (projectIds === undefined) {
      throw new GitLabConnectError("projectIds must be a non-empty list of project ids", 400);
    }
    const token = input.token.trim();
    const doFetch = options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/api/v4/user`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch {
      throw new GitLabConnectError("GitLab could not be reached", 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GitLabConnectError("GitLab rejected the token", 400);
    }
    const user = (await response.json().catch(() => null)) as { username?: unknown } | null;
    if (!response.ok || typeof user?.username !== "string" || user.username === "") {
      throw new GitLabConnectError("GitLab did not return the token's user", 502);
    }
    try {
      await host.prepareAgent(principal.tenantId, input.agentId);
    } catch (error) {
      if (error instanceof Error && /not found/.test(error.message)) {
        throw new GitLabConnectError(error.message, 404);
      }
      throw error;
    }
    const id = `gitlab-${randomBytes(8).toString("hex")}`;
    const record = options.db.gitlab.save({
      id,
      baseUrl,
      token,
      username: user.username,
      webhookSecret: randomBytes(24).toString("base64url"),
      projectIds,
      tenantId: principal.tenantId,
      ...(principal.userId === undefined ? {} : { userId: principal.userId }),
      agentId: input.agentId,
    });
    await host.restart(GITLAB_ADAPTER_KIND, id);
    const path = `/webhooks/gitlab/${id}`;
    return {
      id,
      username: record.username,
      projectIds: record.projectIds,
      webhookUrl: options.publicUrl === undefined ? path : `${options.publicUrl}${path}`,
      webhookSecret: record.webhookSecret,
    };
  };

/**
 * `GET /connect/gitlab` lists the tenant's connections (no secrets);
 * `POST /connect/gitlab` connects one. Behind the Console proxy.
 */
export const createGitLabConnectHandler = (options: {
  readonly connect: ReturnType<typeof connectGitLab>;
  readonly db: MatterDatabase;
  readonly authorize: (request: Request) => Promise<FeishuConnectPrincipal | null>;
}) =>
  async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path !== "/connect/gitlab") return undefined;
    const principal = await options.authorize(request);
    if (principal === null) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.method === "GET") {
      return Response.json(
        {
          data: options.db.gitlab
            .list()
            .filter((c) => c.tenantId === principal.tenantId)
            .map((c) => ({
              id: c.id,
              baseUrl: c.baseUrl,
              username: c.username,
              projectIds: c.projectIds,
              agentId: c.agentId,
              webhookPath: `/webhooks/gitlab/${c.id}`,
              connectedAt: c.connectedAt,
            })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    const body: unknown = await request.json().catch(() => ({}));
    try {
      return Response.json(await options.connect(principal, body), {
        status: 201,
        headers: { "cache-control": "no-store" },
      });
    } catch (error) {
      if (error instanceof GitLabConnectError) {
        return Response.json({ error: error.message }, { status: error.status });
      }
      throw error;
    }
  };
