/**
 * "Connect Feishu": one-click creation of a customer self-built Feishu (or
 * Lark) app for the `feishu-agent` Loop. The page shows a QR code; the user
 * scans it in Feishu and confirms an app pre-configured with the scopes and
 * events the Loop needs. The service polls in the background, hands the new
 * app's credentials to the host, and checks the app's setup.
 *
 * The registration's device code and the app secret never reach the browser.
 */

import { randomBytes } from "node:crypto";
import {
  beginFeishuAppRegistration,
  checkFeishuAppSetup,
  feishuAgentSetup,
  pollFeishuAppRegistration,
  type FeishuAppSetupReport,
  type FeishuBrand,
  type Fetch,
} from "@openma/matter-feishu/bond";
import { Effect } from "effect";
import QRCode from "qrcode";

export interface RegisteredFeishuApp {
  readonly appId: string;
  readonly appSecret: string;
  readonly brand: FeishuBrand;
  /** Open origin of the brand, the Bond ProviderApp `baseUrl`. */
  readonly baseUrl: string;
  /** The confirming user's `open_id` in the new app, when returned. */
  readonly openId?: string;
}

export type FeishuConnectStatus =
  | { readonly status: "pending"; readonly url: string; readonly qrSvg: string; readonly expiresAt: string }
  | { readonly status: "expired" }
  | { readonly status: "denied" }
  | { readonly status: "failed"; readonly reason: string }
  | {
      readonly status: "registered";
      readonly appId: string;
      readonly brand: FeishuBrand;
      /** Undefined while the setup check runs. */
      readonly setup?: FeishuAppSetupReport;
      /** The setup check could not run; the app itself was saved. */
      readonly setupUnavailable?: true;
    };

export interface FeishuConnectOptions {
  /** Store the new app (seal the secret). Called once per registration. */
  readonly onRegistered: (app: RegisteredFeishuApp) => Promise<void>;
  /** Pre-filled app name and description on the confirmation page. */
  readonly appName?: string;
  readonly appDescription?: string;
  /** Also read every group message; the tenant administrator must approve. */
  readonly allGroupMessages?: boolean;
  readonly fetch?: Fetch;
  /** Run `task` after `ms`; defaults to an unref'd `setTimeout`. */
  readonly schedule?: (task: () => void, ms: number) => void;
  readonly now?: () => number;
  /** How long a finished registration stays readable (default 1 h). */
  readonly retainMs?: number;
}

const openOrigin = (brand: FeishuBrand) =>
  brand === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";

interface Registration {
  status: FeishuConnectStatus;
  readonly deviceCode: string;
  readonly expiresAtMs: number;
  interval: number;
  brand: FeishuBrand;
  finishedAtMs?: number;
}

const defaultSchedule = (task: () => void, ms: number) => {
  const timer = setTimeout(task, ms);
  timer.unref?.();
};

export class FeishuConnectService {
  private readonly registrations = new Map<string, Registration>();
  private readonly schedule: (task: () => void, ms: number) => void;
  private readonly now: () => number;
  private readonly setup: ReturnType<typeof feishuAgentSetup>;

  constructor(private readonly options: FeishuConnectOptions) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.setup = feishuAgentSetup({
      allGroupMessages: options.allGroupMessages === true,
    });
  }

  /** Start a registration; poll it in the background. */
  async begin(): Promise<{ readonly id: string; readonly status: FeishuConnectStatus }> {
    this.prune();
    const registration = await Effect.runPromise(
      beginFeishuAppRegistration({
        name: this.options.appName ?? "OpenMA Agent",
        ...(this.options.appDescription === undefined
          ? {}
          : { description: this.options.appDescription }),
        addons: this.setup.addons,
        createOnly: true,
        source: "openma",
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      }),
    );
    const id = randomBytes(16).toString("base64url");
    const entry: Registration = {
      status: {
        status: "pending",
        url: registration.url,
        qrSvg: await QRCode.toString(registration.url, { type: "svg", margin: 1 }),
        expiresAt: registration.expiresAt,
      },
      deviceCode: registration.deviceCode,
      expiresAtMs: Date.parse(registration.expiresAt),
      interval: registration.interval,
      brand: registration.brand,
    };
    this.registrations.set(id, entry);
    this.schedule(() => void this.poll(id), entry.interval * 1000);
    return { id, status: entry.status };
  }

  status(id: string): FeishuConnectStatus | undefined {
    return this.registrations.get(id)?.status;
  }

  /** One poll; reschedules itself while the registration is pending. */
  async poll(id: string): Promise<void> {
    const entry = this.registrations.get(id);
    if (entry === undefined || entry.status.status !== "pending") return;
    if (this.now() >= entry.expiresAtMs) {
      this.finish(entry, { status: "expired" });
      return;
    }
    let result;
    try {
      result = await Effect.runPromise(
        pollFeishuAppRegistration({
          deviceCode: entry.deviceCode,
          interval: entry.interval,
          brand: entry.brand,
          ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        }),
      );
    } catch {
      // A transient platform error: keep polling until the code expires.
      this.schedule(() => void this.poll(id), entry.interval * 1000);
      return;
    }
    switch (result.status) {
      case "pending":
      case "slow_down":
        entry.interval = result.interval;
        entry.brand = result.brand;
        this.schedule(() => void this.poll(id), entry.interval * 1000);
        return;
      case "expired":
      case "denied":
        this.finish(entry, { status: result.status });
        return;
      case "registered": {
        const app: RegisteredFeishuApp = {
          appId: result.appId,
          appSecret: result.appSecret,
          brand: result.brand,
          baseUrl: openOrigin(result.brand),
          ...(result.openId === undefined ? {} : { openId: result.openId }),
        };
        try {
          await this.options.onRegistered(app);
        } catch {
          this.finish(entry, {
            status: "failed",
            reason: "The app was created but could not be saved. Connect again.",
          });
          return;
        }
        this.finish(entry, { status: "registered", appId: app.appId, brand: app.brand });
        void this.check(entry, app);
        return;
      }
    }
  }

  private async check(entry: Registration, app: RegisteredFeishuApp): Promise<void> {
    try {
      const setup = await Effect.runPromise(
        checkFeishuAppSetup(
          {
            baseUrl: app.baseUrl,
            appId: app.appId,
            appSecret: app.appSecret,
            ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
          },
          this.setup.requirements,
        ),
      );
      if (entry.status.status === "registered") {
        entry.status = { ...entry.status, setup };
      }
    } catch {
      if (entry.status.status === "registered") {
        entry.status = { ...entry.status, setupUnavailable: true };
      }
    }
  }

  private finish(entry: Registration, status: FeishuConnectStatus): void {
    entry.status = status;
    entry.finishedAtMs = this.now();
  }

  private prune(): void {
    const retain = this.options.retainMs ?? 3_600_000;
    for (const [id, entry] of this.registrations) {
      const end = entry.finishedAtMs ?? entry.expiresAtMs;
      if (this.now() - end > retain) this.registrations.delete(id);
    }
  }
}

export interface FeishuConnectHandlerOptions {
  readonly service: FeishuConnectService;
  /** Who may connect an app, for example an OpenMA session or API key check.
   * Requests it rejects get 401. */
  readonly authorize: (request: Request) => Promise<boolean>;
  /** Path the handler is mounted at (default `/connect/feishu`). */
  readonly basePath?: string;
}

/**
 * `GET {base}` serves the page, `POST {base}/registrations` starts a
 * registration and `GET {base}/registrations/:id` reports its status.
 */
export const createFeishuConnectHandler = (options: FeishuConnectHandlerOptions) => {
  const base = (options.basePath ?? "/connect/feishu").replace(/\/+$/, "");
  return async (request: Request): Promise<Response | undefined> => {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    if (path !== base && !path.startsWith(`${base}/`)) return undefined;
    if (!(await options.authorize(request))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const rest = path.slice(base.length);
    if (rest === "" && request.method === "GET") {
      return new Response(connectPage(base, pickLocale(request.headers.get("accept-language"))), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy":
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'",
        },
      });
    }
    if (rest === "/registrations" && request.method === "POST") {
      try {
        return Response.json(await options.service.begin(), { status: 201 });
      } catch {
        return Response.json(
          { error: "Feishu did not start the registration. Try again." },
          { status: 502 },
        );
      }
    }
    const match = /^\/registrations\/([A-Za-z0-9_-]+)$/.exec(rest);
    if (match?.[1] !== undefined && request.method === "GET") {
      const status = options.service.status(match[1]);
      return status === undefined
        ? Response.json({ error: "not found" }, { status: 404 })
        : Response.json(status, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  };
};

const MESSAGES = {
  "zh-CN": {
    title: "连接飞书",
    intro: "用飞书扫码，确认创建一个企业自建应用。应用已预先配置好机器人收发消息所需的权限和事件，Agent 会以这个应用的机器人身份回复。",
    start: "生成二维码",
    starting: "正在生成…",
    openIn: "或在飞书中打开：",
    waiting: "等待确认…",
    created: "已创建应用",
    checking: "正在检查应用配置…",
    checkUnavailable: "暂时无法检查应用配置，可以先在飞书里 @机器人 试试。",
    ready: "配置检查通过，可以在飞书里 @机器人 了。",
    fixes: "还差几步：",
    expired: "二维码已过期，请重新生成。",
    denied: "已在飞书中取消。",
    failed: "连接失败。",
    statusFailed: "查询状态失败。",
    startFailed: "生成失败。",
  },
  en: {
    title: "Connect Feishu",
    intro: "Scan with Feishu and confirm to create a self-built app. The app comes pre-configured with the scopes and events the bot needs to read and send messages; the Agent replies as this app's bot.",
    start: "Show QR code",
    starting: "Starting…",
    openIn: "Or open in Feishu: ",
    waiting: "Waiting for confirmation…",
    created: "Created app",
    checking: "Checking the app's setup…",
    checkUnavailable: "The app's setup could not be checked right now. Try mentioning the bot in Feishu.",
    ready: "Setup check passed. Mention the bot in Feishu to start.",
    fixes: "A few steps remain:",
    expired: "The QR code expired. Show a new one.",
    denied: "Cancelled in Feishu.",
    failed: "Connecting failed.",
    statusFailed: "Could not read the status.",
    startFailed: "Could not start.",
  },
} as const;

type Locale = keyof typeof MESSAGES;

/** `zh*` in Accept-Language selects Chinese; anything else English. */
const pickLocale = (acceptLanguage: string | null): Locale => {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("zh") ? "zh-CN" : "en";
};

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const connectPage = (base: string, locale: Locale) => {
  const m = MESSAGES[locale];
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(m.title)}</title>
<style>
  body { font: 15px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; padding: 0 1rem; color: #1f2329; }
  h1 { font-size: 1.4rem; }
  button { font: inherit; padding: .5rem 1.2rem; border-radius: 6px; border: 0; background: #3370ff; color: #fff; cursor: pointer; }
  button[disabled] { opacity: .5; cursor: default; }
  #qr svg { width: 220px; height: 220px; }
  .muted { color: #646a73; }
  .ok { color: #2ea121; } .warn { color: #d83931; }
  li { margin: .25rem 0; }
</style>
</head>
<body>
<h1>${escapeHtml(m.title)}</h1>
<p class="muted">${escapeHtml(m.intro)}</p>
<p><button id="start">${escapeHtml(m.start)}</button></p>
<div id="panel"></div>
<script>
const base = ${JSON.stringify(base)};
const m = ${JSON.stringify(m)};
const panel = document.getElementById("panel");
const start = document.getElementById("start");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
let timer;
function render(s) {
  if (s.status === "pending") {
    panel.innerHTML = '<div id="qr">' + s.qrSvg + '</div><p>' + esc(m.openIn) + '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.url) + '</a></p><p class="muted">' + esc(m.waiting) + '</p>';
  } else if (s.status === "registered") {
    let html = '<p class="ok">' + esc(m.created) + ' <code>' + esc(s.appId) + '</code> (' + esc(s.brand) + ')</p>';
    if (s.setupUnavailable) html += '<p class="muted">' + esc(m.checkUnavailable) + '</p>';
    else if (!s.setup) html += '<p class="muted">' + esc(m.checking) + '</p>';
    else if (s.setup.ready) html += '<p class="ok">' + esc(m.ready) + '</p>';
    else html += '<p class="warn">' + esc(m.fixes) + '</p><ul>' + s.setup.problems.map((p) => '<li>' + esc(p) + '</li>').join("") + '</ul>';
    panel.innerHTML = html;
  } else {
    const text = s.status === "failed" ? (s.reason || m.failed) : (m[s.status] || m.failed);
    panel.innerHTML = '<p class="warn">' + esc(text) + '</p>';
  }
}
async function poll(id) {
  const response = await fetch(base + "/registrations/" + encodeURIComponent(id), { credentials: "same-origin" });
  if (!response.ok) { panel.innerHTML = '<p class="warn">' + esc(m.statusFailed) + '</p>'; start.disabled = false; return; }
  const s = await response.json();
  render(s);
  const done = s.status !== "pending" && !(s.status === "registered" && !s.setup && !s.setupUnavailable);
  if (done) { start.disabled = false; return; }
  timer = setTimeout(() => poll(id), 3000);
}
start.addEventListener("click", async () => {
  clearTimeout(timer);
  start.disabled = true;
  panel.innerHTML = '<p class="muted">' + esc(m.starting) + '</p>';
  const response = await fetch(base + "/registrations", { method: "POST", credentials: "same-origin" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { panel.innerHTML = '<p class="warn">' + esc(body.error || m.startFailed) + '</p>'; start.disabled = false; return; }
  render(body.status);
  timer = setTimeout(() => poll(body.id), 3000);
});
</script>
</body>
</html>
`;
};
