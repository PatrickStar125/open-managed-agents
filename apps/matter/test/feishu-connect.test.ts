import { feishuAgentSetup } from "@openma/matter-feishu/bond";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createFeishuConnectHandler,
  FeishuConnectService,
  type RegisteredFeishuApp,
} from "../src/feishu-connect.js";

/** A stand-in for accounts.feishu.cn and open.feishu.cn. */
class FakeFeishu {
  polls: { status: number; body: unknown }[] = [];
  beginStatus = 200;
  granted: readonly string[] = feishuAgentSetup().requirements.scopes;
  readonly calls: string[] = [];

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    this.calls.push(`${url.host}${url.pathname}`);
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/oauth/v1/app/registration") {
      const action = new URLSearchParams(String(init?.body)).get("action");
      if (action === "begin") {
        return reply(this.beginStatus, {
          device_code: "dc-secret",
          user_code: "UC-1",
          verification_uri: "https://open.feishu.cn/page/launcher",
          verification_uri_complete: "https://open.feishu.cn/page/launcher?user_code=UC-1",
          expires_in: 300,
          interval: 3,
        });
      }
      const next = this.polls.shift() ?? { status: 400, body: { error: "authorization_pending" } };
      return reply(next.status, next.body);
    }
    if (url.pathname === "/open-apis/auth/v3/tenant_access_token/internal") {
      return reply(200, { code: 0, tenant_access_token: "t-test", expire: 7200 });
    }
    if (url.pathname === "/open-apis/application/v6/scopes") {
      return reply(200, {
        code: 0,
        data: { scopes: this.granted.map((scope_name) => ({ scope_name, grant_status: 1 })) },
      });
    }
    if (url.pathname === "/open-apis/application/v6/applications/cli_new") {
      return reply(200, { code: 0, data: { app: { app_id: "cli_new", online_version_id: "oav_1" } } });
    }
    if (url.pathname === "/open-apis/application/v6/applications/cli_new/app_versions/oav_1") {
      return reply(200, {
        code: 0,
        data: {
          app_version: {
            events: feishuAgentSetup().requirements.events,
            ability: { bot: {} },
          },
        },
      });
    }
    if (url.pathname === "/open-apis/bot/v3/info") {
      return reply(200, { code: 0, bot: { open_id: "ou_bot" } });
    }
    return reply(404, {});
  }) as typeof fetch;
}

const REGISTERED = {
  status: 200,
  body: {
    client_id: "cli_new",
    client_secret: "app-secret",
    user_info: { open_id: "ou_confirmer", tenant_brand: "feishu" },
  },
};

let feishu: FakeFeishu;
let scheduled: { task: () => void; ms: number }[];
let saved: RegisteredFeishuApp[];
let clock: number;

const service = (options: { onRegistered?: (app: RegisteredFeishuApp) => Promise<void> } = {}) =>
  new FeishuConnectService({
    onRegistered:
      options.onRegistered ??
      (async (app) => {
        saved.push(app);
      }),
    fetch: feishu.fetch,
    schedule: (task, ms) => scheduled.push({ task, ms }),
    now: () => clock,
  });

/** Run the next scheduled poll and wait for it and any follow-up check. */
const tick = async (svc: FeishuConnectService, id: string) => {
  const next = scheduled.shift();
  expect(next).toBeDefined();
  await svc.poll(id);
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  feishu = new FakeFeishu();
  scheduled = [];
  saved = [];
  clock = Date.now();
});

describe("FeishuConnectService", () => {
  it("shows a QR code, polls in the background and saves the new app", async () => {
    const svc = service();
    const { id, status } = await svc.begin();
    expect(status).toMatchObject({
      status: "pending",
      url: expect.stringContaining("user_code=UC-1"),
    });
    expect(status.status === "pending" && status.qrSvg.startsWith("<svg")).toBe(true);
    expect(JSON.stringify(status)).not.toContain("dc-secret");
    expect(scheduled.map((s) => s.ms)).toEqual([3000]);

    feishu.polls = [
      { status: 400, body: { error: "slow_down" } },
      REGISTERED,
    ];
    await tick(svc, id);
    expect(svc.status(id)?.status).toBe("pending");
    expect(scheduled.map((s) => s.ms)).toEqual([8000]);

    await tick(svc, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toEqual([
      {
        appId: "cli_new",
        appSecret: "app-secret",
        brand: "feishu",
        baseUrl: "https://open.feishu.cn",
        openId: "ou_confirmer",
      },
    ]);
    const done = svc.status(id);
    expect(done).toMatchObject({
      status: "registered",
      appId: "cli_new",
      brand: "feishu",
      setup: { ready: true, problems: [] },
    });
    expect(JSON.stringify(done)).not.toContain("app-secret");
    expect(scheduled).toHaveLength(0);
  });

  it("asks the platform for the agent preset and a new app only", async () => {
    const svc = service();
    const { status } = await svc.begin();
    const url = new URL(status.status === "pending" ? status.url : "");
    expect(url.searchParams.get("createOnly")).toBe("true");
    expect(url.searchParams.get("source")).toBe("openmatter/openma");
    expect(url.searchParams.get("name")).toBe("OpenMA Agent");
    expect(url.searchParams.get("addons")).toBeTruthy();
  });

  it("reports missing setup as fixes", async () => {
    feishu.granted = [];
    const svc = service();
    const { id } = await svc.begin();
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const status = svc.status(id);
    expect(status?.status === "registered" && status.setup?.ready).toBe(false);
    expect(status?.status === "registered" && status.setup?.missingScopes.length).toBeGreaterThan(0);
  });

  it("ends on denial and on expiry without saving", async () => {
    const svc = service();
    const denied = await svc.begin();
    feishu.polls = [{ status: 400, body: { error: "access_denied" } }];
    await tick(svc, denied.id);
    expect(svc.status(denied.id)).toEqual({ status: "denied" });

    const expired = await svc.begin();
    clock += 301_000;
    await tick(svc, expired.id);
    expect(svc.status(expired.id)).toEqual({ status: "expired" });
    expect(saved).toEqual([]);
    expect(scheduled).toHaveLength(0);
  });

  it("keeps polling after a transient platform error", async () => {
    const svc = service();
    const { id } = await svc.begin();
    feishu.polls = [{ status: 500, body: {} }, REGISTERED];
    await tick(svc, id);
    expect(svc.status(id)?.status).toBe("pending");
    expect(scheduled).toHaveLength(1);
    await tick(svc, id);
    expect(svc.status(id)?.status).toBe("registered");
  });

  it("reports a failure when the host cannot save the app", async () => {
    const svc = service({
      onRegistered: async () => {
        throw new Error("disk full");
      },
    });
    const { id } = await svc.begin();
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    expect(svc.status(id)).toMatchObject({ status: "failed" });
    expect(JSON.stringify(svc.status(id))).not.toContain("disk full");
  });

  it("marks the setup check unavailable when it cannot run", async () => {
    // Registration works; every Open Platform call afterwards fails.
    const offline = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/open-apis/")
        ? Promise.reject(new Error("offline"))
        : feishu.fetch(input, init)) as typeof fetch;
    const svc = new FeishuConnectService({
      onRegistered: async (app) => {
        saved.push(app);
      },
      fetch: offline,
      schedule: (task, ms) => scheduled.push({ task, ms }),
      now: () => clock,
    });
    const { id } = await svc.begin();
    feishu.polls = [REGISTERED];
    await tick(svc, id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toHaveLength(1);
    expect(svc.status(id)).toMatchObject({ status: "registered", setupUnavailable: true });
  });
});

describe("createFeishuConnectHandler", () => {
  const request = (path: string, init?: RequestInit) =>
    new Request(`https://matter.test${path}`, init);

  it("serves the page, starts a registration and reports its status", async () => {
    const svc = service();
    const handler = createFeishuConnectHandler({ service: svc, authorize: async () => true });
    const page = await handler(request("/connect/feishu"));
    expect(page?.status).toBe(200);
    expect(page?.headers.get("content-type")).toContain("text/html");
    expect(page?.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = (await page?.text()) ?? "";
    expect(html).toContain('const base = "/connect/feishu"');
    expect(html).toContain('<html lang="en">');
    const zh = await handler(
      request("/connect/feishu", { headers: { "accept-language": "zh-CN,zh;q=0.9,en;q=0.8" } }),
    );
    const zhHtml = (await zh?.text()) ?? "";
    expect(zhHtml).toContain('<html lang="zh-CN">');
    expect(zhHtml).toContain("连接飞书");

    const started = await handler(request("/connect/feishu/registrations", { method: "POST" }));
    expect(started?.status).toBe(201);
    const body = (await started?.json()) as { id: string; status: { status: string } };
    expect(body.status.status).toBe("pending");

    const status = await handler(request(`/connect/feishu/registrations/${body.id}`));
    expect(((await status?.json()) as { status: string }).status).toBe("pending");
    expect((await handler(request("/connect/feishu/registrations/nope")))?.status).toBe(404);
  });

  it("refuses unauthorized callers and ignores other paths", async () => {
    const handler = createFeishuConnectHandler({ service: service(), authorize: async () => false });
    expect((await handler(request("/connect/feishu")))?.status).toBe(401);
    expect((await handler(request("/connect/feishu/registrations", { method: "POST" })))?.status).toBe(401);
    expect(await handler(request("/mcp"))).toBeUndefined();
    expect(await handler(request("/connect/feishuX"))).toBeUndefined();
  });

  it("reports a failed start as a bad gateway", async () => {
    feishu.beginStatus = 500;
    const handler = createFeishuConnectHandler({ service: service(), authorize: async () => true });
    const response = await handler(request("/connect/feishu/registrations", { method: "POST" }));
    expect(response?.status).toBe(502);
  });
});
