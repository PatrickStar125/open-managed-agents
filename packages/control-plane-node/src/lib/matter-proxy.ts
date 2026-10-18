import { Hono } from "hono";

/**
 * `/matter/*` → the OpenMatter service (apps/matter), for the Console.
 *
 * The control plane authenticates the user first; the proxy then drops the
 * user's own credentials and tells Matter who is asking through headers
 * Matter trusts only alongside the shared secret (`trustedProxyPrincipal`
 * in apps/matter). Header names must match `MATTER_PROXY_HEADERS` there.
 */
export const MATTER_PROXY_HEADERS = {
  secret: "x-matter-proxy-secret",
  tenant: "x-oma-tenant-id",
  user: "x-oma-user-id",
} as const;

/** Never forwarded: the caller's credentials, hop-by-hop headers, and any
 * identity headers a caller may try to set itself. */
const DROPPED_REQUEST_HEADERS = new Set<string>([
  "cookie",
  "authorization",
  "x-api-key",
  "x-active-tenant",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "content-length",
  ...Object.values(MATTER_PROXY_HEADERS),
]);

const DROPPED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

export interface MatterProxyOptions {
  /** Matter's origin (and optional base path), without a trailing slash. */
  readonly url: string;
  readonly proxySecret: string;
  readonly fetcher?: typeof fetch;
}

export function buildMatterProxyRoutes(options: MatterProxyOptions) {
  const fetcher = options.fetcher ?? fetch;
  const routes = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  routes.all("/*", async (c) => {
    const incoming = new URL(c.req.url);
    const rest = incoming.pathname.replace(/^\/matter(?=\/|$)/, "") || "/";
    const target = `${options.url}${rest}${incoming.search}`;

    const headers = new Headers();
    c.req.raw.headers.forEach((value, name) => {
      if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
    });
    headers.set(MATTER_PROXY_HEADERS.secret, options.proxySecret);
    headers.set(MATTER_PROXY_HEADERS.tenant, c.var.tenant_id);
    const userId = c.var.user_id;
    if (userId) headers.set(MATTER_PROXY_HEADERS.user, userId);

    const method = c.req.method.toUpperCase();
    let upstream: Response;
    try {
      upstream = await fetcher(target, {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : await c.req.raw.arrayBuffer(),
        redirect: "manual",
      });
    } catch {
      return c.json({ error: "matter_unavailable" }, 502);
    }
    const out = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out.set(name, value);
    });
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });
  return routes;
}
