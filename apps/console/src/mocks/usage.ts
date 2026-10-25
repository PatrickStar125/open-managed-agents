import { http, HttpResponse, type HttpHandler } from "msw";

/**
 * Demo dataset for the Usage page (`?mocks=1` in dev — see the bootstrap
 * in main.tsx). Serves enough of the console's read surface to browse the
 * workspace without a live backend: a better-auth session, the tenant
 * list, /v1/stats, and the /v1/oma/usage rollup the page consumes.
 *
 * Data is deterministic: every value derives from a small FNV-1a hash of
 * the date/agent/model string run through an LCG, so reloads and
 * screenshots are stable — no Math.random(), no flaky visual tests.
 *
 * Metric magnitudes follow what the platform actually records: cached
 * reads dominate input on cache-friendly harnesses, output lags input,
 * sandbox minutes scale with session count.
 */

// ── Deterministic pseudo-randomness ────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function lcg(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rand = (key: string) => lcg(fnv1a(key));

/** value in [lo, hi] with one draw from the seeded stream */
function between(key: string, lo: number, hi: number): number {
  const r = rand(key)();
  return Math.round(lo + r * (hi - lo));
}

/** Fractional value in [lo, hi] — unlike `between`, no rounding. Use
 * for multipliers (jitter factors); the integer rounding in `between`
 * collapses sub-1.0 factors to 0 or 1. */
function frac(key: string, lo: number, hi: number): number {
  return lo + rand(key)() * (hi - lo);
}

// ── Demo entities ──────────────────────────────────────────────────────────

const MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-7",
  "gpt-5",
  "deepseek-v4-flash",
] as const;

const AGENTS = [
  { id: "agent_research", name: "Research Agent" },
  { id: "agent_reviewer", name: "Code Reviewer" },
  { id: "agent_pipeline", name: "Data Pipeliner" },
  { id: "agent_docs", name: "Docs Writer" },
] as const;

// Sandbox runtimes the platform can route to; the default dominates a
// typical deployment, long-tail providers carry the rest.
const SANDBOXES = [
  { id: "cloudflare-sandbox", name: "Cloudflare Sandbox" },
  { id: "litebox", name: "LiteBox" },
  { id: "e2b", name: "E2B" },
  { id: "daytona", name: "Daytona" },
  { id: "local-subprocess", name: "Local subprocess" },
] as const;

function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// ── Usage rollup ───────────────────────────────────────────────────────────

interface UsageDay {
  date: string;
  sessions: number;
  model_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_read_tokens: number;
  sandbox_minutes: number;
}

/** Day-level quantities shared by the rollup and the ledger generator —
 * the ledger's per-day totals derive from the same seeds, so the
 * dashboard and the itemized ledger tell one story (distribution
 * rounding apart). Weekends run quieter so the charts read like real
 * traffic instead of noise. */
function dayQuantities(date: string) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  const weekend = dow === 0 || dow === 6 ? 0.35 : 1;
  const sessions = Math.max(
    0,
    Math.round(between(`s:${date}`, 2, 18) * weekend),
  );
  const input = Math.round(
    between(`in:${date}`, 18_000, 210_000) * weekend,
  );
  return {
    sessions,
    modelCalls: Math.round(sessions * between(`mc:${date}`, 6, 22)),
    input,
    output: Math.round(between(`out:${date}`, 6_000, 64_000) * weekend),
    cached: Math.round(input * between(`ca:${date}`, 2.4, 7.1)),
    sandboxMin: Math.round(between(`sb:${date}`, 25, 340) * weekend),
  };
}

function buildUsage(days: number, fromISO?: string, toISO?: string) {
  // Resolve the inclusive window. from/to win when present (the page's
  // date-range mode); days falls back to "last N days ending today".
  let startISO: string;
  let endISO: string;
  if (fromISO && toISO && fromISO <= toISO) {
    startISO = fromISO;
    endISO = toISO;
  } else {
    startISO = isoDaysAgo(days - 1);
    endISO = isoDaysAgo(0);
  }

  const dayGen = (date: string): UsageDay => {
    const q = dayQuantities(date);
    return {
      date,
      sessions: q.sessions,
      model_calls: q.modelCalls,
      input_tokens: q.input,
      output_tokens: q.output,
      cached_read_tokens: q.cached,
      sandbox_minutes: q.sandboxMin,
    };
  };

  const daily: UsageDay[] = [];
  // Cap 180 = 2 × MAX_SPAN_DAYS: the page fetches the display window
  // PLUS an equal previous-period head, so a 90-day range requests 180
  // days. Capping at 90 truncated the display window itself.
  for (
    let d = new Date(`${startISO}T00:00:00Z`);
    d <= new Date(`${endISO}T00:00:00Z`) && daily.length < 180;
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    daily.push(dayGen(d.toISOString().slice(0, 10)));
  }

  const totals = daily.reduce(
    (acc, d) => ({
      sessions: acc.sessions + d.sessions,
      model_calls: acc.model_calls + d.model_calls,
      input_tokens: acc.input_tokens + d.input_tokens,
      output_tokens: acc.output_tokens + d.output_tokens,
      cached_read_tokens: acc.cached_read_tokens + d.cached_read_tokens,
      sandbox_minutes: acc.sandbox_minutes + d.sandbox_minutes,
    }),
    {
      sessions: 0,
      model_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_read_tokens: 0,
      sandbox_minutes: 0,
    },
  );

  // Split the totals across models/agents with seeded weights that sum
  // to ~1 so the breakdowns stay consistent with the headline numbers.
  const by_model = MODELS.map((model_id) => {
    const w = between(`mw:${model_id}`, 5, 30) / 100;
    return {
      model_id,
      model_calls: Math.round(totals.model_calls * w),
      input_tokens: Math.round(totals.input_tokens * w),
      output_tokens: Math.round(totals.output_tokens * w),
      cached_read_tokens: Math.round(totals.cached_read_tokens * w),
    };
  });

  const by_agent = AGENTS.map(({ id, name }) => {
    const w = between(`aw:${id}`, 5, 30) / 100;
    return {
      agent_id: id,
      agent_name: name,
      sessions: Math.round(totals.sessions * w),
      input_tokens: Math.round(totals.input_tokens * w),
      output_tokens: Math.round(totals.output_tokens * w),
      sandbox_minutes: Math.round(totals.sandbox_minutes * w),
    };
  });

  const by_sandbox = SANDBOXES.map(({ id, name }) => {
    const w = between(`sw:${id}`, 5, 30) / 100;
    return {
      runtime_id: id,
      name,
      sessions: Math.round(totals.sessions * w),
      sandbox_minutes: Math.round(totals.sandbox_minutes * w),
    };
  });

  return {
    range: {
      from: daily[0].date,
      to: daily[daily.length - 1].date,
      days: daily.length,
    },
    totals,
    daily,
    by_model,
    by_agent,
    by_sandbox,
  };
}

// ── Handlers ───────────────────────────────────────────────────────────────

// ── Itemized ledger demo data ─────────────────────────────────────────────
// The 流水 the design note (docs/usage-ledger-design.md) promises: one
// row per consumption fact. Deterministic from the same seed family;
// per-day totals derive from dayQuantities so the rollup and the ledger
// agree up to distribution rounding.

const TOOL_NAMES = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "web_fetch",
] as const;

export interface DemoLedgerRow {
  id: number;
  ts: string;
  /** Idempotency anchor — the field the contract exists to guarantee. */
  correlation_id: string;
  /** Interval window for the *_seconds family; knowable only at emit
   * time (the reason v3 ships the column at all). */
  interval?: { startMs: number; endMs: number };
  session_id: string;
  agent_id: string;
  agent_name: string;
  /** Row semantics follow billing, not measurement shape: a model_call
   * row carries the call's full token economics (input / cached-read /
   * output — three provider prices); session_alive is unbilled activity
   * and groups apart from the billed sandbox seconds. */
  kind:
    | "model_call"
    | "sandbox_active_seconds"
    | "session_alive_seconds"
    | "tool_use";
  value: number;
  unit: "s" | "call";
  input_tokens?: number;
  cached_read_tokens?: number;
  output_tokens?: number;
  model_id?: string;
  tool_name?: string;
  runtime_id?: string;
}

/** Deterministic hex id fragment from a seed key. */
function hexFrom(key: string, len: number): string {
  let h = fnv1a(key);
  let out = "";
  while (out.length < len) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, len);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function buildLedger(fromISO: string, toISO: string): DemoLedgerRow[] {
  const rows: DemoLedgerRow[] = [];
  let id = 0;
  const push = (r: Omit<DemoLedgerRow, "id">) => {
    rows.push({ id: ++id, ...r });
  };
  for (
    let d = new Date(`${fromISO}T00:00:00Z`);
    d <= new Date(`${toISO}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1)
  ) {
    const date = d.toISOString().slice(0, 10);
    const q = dayQuantities(date);
    // Rows are emitted per session, then sorted by timestamp within the
    // day so "newest first" paging reads chronologically rather than in
    // emission order.
    const dayRows: Array<Omit<DemoLedgerRow, "id">> = [];
    const emit = (r: Omit<DemoLedgerRow, "id">) => dayRows.push(r);
    let callsLeft = q.modelCalls;
    for (let s = 0; s < q.sessions; s++) {
      const sk = `${date}:${s}`;
      const agent = AGENTS[between(`ag:${sk}`, 0, AGENTS.length - 1)];
      const runtime = SANDBOXES[between(`rt:${sk}`, 0, SANDBOXES.length - 1)];
      const session_id = `sess_${hexFrom(`sid:${sk}`, 8)}`;
      const tsFor = (key: string) =>
        `${date}T${pad2(between(`h:${key}`, 0, 23))}:${pad2(between(`m:${key}`, 0, 59))}:${pad2(between(`sec:${key}`, 0, 59))}Z`;
      const tsSa = tsFor(`sa:${sk}`);
      const aliveSecs = between(`sav:${sk}`, 120, 5400);
      emit({
        ts: tsSa,
        correlation_id: `corr_${hexFrom(`c:alive:${sk}`, 16)}`,
        interval: {
          startMs: Date.parse(tsSa),
          endMs: Date.parse(tsSa) + aliveSecs * 1000,
        },
        session_id,
        agent_id: agent.id,
        agent_name: agent.name,
        kind: "session_alive_seconds",
        value: aliveSecs,
        unit: "s",
      });
      const tsSb = tsFor(`sb:${sk}`);
      const sandboxSecs = between(`sbv:${sk}`, 30, 1200);
      emit({
        ts: tsSb,
        correlation_id: `corr_${hexFrom(`c:sandbox:${sk}`, 16)}`,
        interval: {
          startMs: Date.parse(tsSb),
          endMs: Date.parse(tsSb) + sandboxSecs * 1000,
        },
        session_id,
        agent_id: agent.id,
        agent_name: agent.name,
        kind: "sandbox_active_seconds",
        value: sandboxSecs,
        unit: "s",
        runtime_id: runtime.id,
      });
      // Distribute the day's model calls across its sessions; the last
      // session absorbs the remainder so the counts sum exactly.
      const calls =
        s === q.sessions - 1
          ? callsLeft
          : Math.floor(q.modelCalls / q.sessions) +
            (s < q.modelCalls % q.sessions ? 1 : 0);
      callsLeft -= calls;
      for (let c = 0; c < calls; c++) {
        const ck = `${sk}:${c}`;
        const model = MODELS[between(`mo:${ck}`, 0, MODELS.length - 1)];
        // Day-level denominator: the day's token totals spread across
        // the day's TOTAL calls, so the ledger sums reconcile with the
        // dashboard rollup. (A per-session denominator inflated the
        // day total by ~sessions×.)
        const share = 1 / Math.max(q.modelCalls, 1);
        const ts = tsFor(`mc:${ck}`);
        emit({
          ts,
          correlation_id: `corr_${hexFrom(`c:call:${ck}`, 16)}`,
          session_id,
          agent_id: agent.id,
          agent_name: agent.name,
          kind: "model_call",
          value: 1,
          unit: "call",
          input_tokens: Math.round(q.input * share * frac(`ji:${ck}`, 0.4, 1.6)),
          cached_read_tokens: Math.round(q.cached * share * frac(`jc:${ck}`, 0.4, 1.6)),
          output_tokens: Math.round(q.output * share * frac(`jo:${ck}`, 0.4, 1.6)),
          model_id: model,
        });
        const tools = between(`tc:${ck}`, 0, 2);
        for (let ti = 0; ti < tools; ti++) {
          emit({
            ts: tsFor(`t:${ck}:${ti}`),
            correlation_id: `corr_${hexFrom(`c:tool:${ck}:${ti}`, 16)}`,
            session_id,
            agent_id: agent.id,
            agent_name: agent.name,
            kind: "tool_use",
            value: 1,
            unit: "call",
            tool_name:
              TOOL_NAMES[between(`tn:${ck}:${ti}`, 0, TOOL_NAMES.length - 1)],
          });
        }
      }
    }
    dayRows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    for (const r of dayRows) push(r);
  }
  return rows; // ascending id == chronological (and intra-day ts-ordered)
}

// The page's data source. Kept separate from the environment handlers
// below so the shared test server only inherits this endpoint.
export const usageDemoHandlers: HttpHandler[] = [
  // Accepts `from`/`to` (YYYY-MM-DD, inclusive, the date-range mode) or
  // the legacy `days=1..90`. Both resolve to the same deterministic
  // seeds, so a given date renders identically no matter which window
  // asked for it.
  http.get("/v1/oma/usage", ({ request }) => {
    const sp = new URL(request.url).searchParams;
    const rawDays = Number(sp.get("days") ?? 14);
    const days = Math.min(
      Math.max(Number.isFinite(rawDays) ? rawDays : 14, 1),
      90,
    );
    return HttpResponse.json(
      buildUsage(days, sp.get("from") ?? undefined, sp.get("to") ?? undefined),
    );
  }),

  // Itemized ledger: cursor pagination (newest first), exact-kind and
  // free-text filters. Mirrors the LedgerRow shape from
  // docs/usage-ledger-design.md; the transport intentionally reuses
  // the console's OMA cursor envelope (see UsageLedger.tsx).
  http.get("/v1/oma/usage/ledger", ({ request }) => {
    const sp = new URL(request.url).searchParams;
    const to = sp.get("to") ?? isoDaysAgo(0);
    let from = sp.get("from") ?? isoDaysAgo(13);
    // Clamp the window to 180 days, aligned with the rollup handler —
    // without it a multi-year range regenerates ~10^6 rows per request.
    // An invalid `to` would poison minFrom below (Invalid Date); answer
    // an empty page instead of throwing.
    const toDate = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(toDate.getTime())) {
      return HttpResponse.json({ data: [], next_cursor: null, total: 0 });
    }
    const minFrom = toDate;
    minFrom.setUTCDate(minFrom.getUTCDate() - 179);
    const minFromISO = minFrom.toISOString().slice(0, 10);
    if (from < minFromISO) from = minFromISO;
    let rows = buildLedger(from, to).reverse(); // newest first
    // Exact-kind match, as LedgerQuery.kind defines — the UI maps its
    // group tabs to kind values (each group is 1:1 with one kind).
    const kind = sp.get("kind");
    if (kind) rows = rows.filter((r) => r.kind === kind);
    // Structured dimension filters (the console drives these from
    // data-driven selects) plus a session-id text search.
    const agentId = sp.get("agent_id");
    if (agentId) rows = rows.filter((r) => r.agent_id === agentId);
    const modelId = sp.get("model_id");
    if (modelId) rows = rows.filter((r) => r.model_id === modelId);
    const runtimeId = sp.get("runtime_id");
    if (runtimeId) rows = rows.filter((r) => r.runtime_id === runtimeId);
    const sessionId = sp.get("session_id");
    if (sessionId) rows = rows.filter((r) => r.session_id === sessionId);
    const q = (sp.get("q") ?? "").trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.session_id.toLowerCase().includes(q));
    const rawLimit = Number(sp.get("limit") ?? 25);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 25, 1), 5000);
    const cursor = Number(sp.get("cursor") ?? 0);
    const after = cursor > 0 ? rows.filter((r) => r.id < cursor) : rows;
    const page = after.slice(0, limit);
    return HttpResponse.json({
      data: page,
      next_cursor: after.length > limit ? String(page[page.length - 1].id) : null,
      total: rows.length,
    });
  }),
];

// Backendless-console environment handlers (?mocks=1 dev runs only —
// NOT spread into the shared test server: a global /auth/get-session
// would hand every future test a phantom signed-in user).
export const demoEnvironmentHandlers: HttpHandler[] = [
  // Fake a signed-in session so AuthProvider lets us past the Layout
  // redirect. better-auth's useSession() reads { session, user }.
  http.get("/auth/get-session", () =>
    HttpResponse.json({
      session: {
        id: "sess_demo_000000",
        userId: "user_demo",
        token: "demo-token",
        expiresAt: "2027-01-01T00:00:00.000Z",
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        ipAddress: null,
        userAgent: null,
      },
      user: {
        id: "user_demo",
        name: "Demo User",
        email: "demo@openma.local",
        emailVerified: true,
        image: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    }),
  ),

  http.get("/v1/oma/me/tenants", () =>
    HttpResponse.json({
      data: [
        {
          id: "tenant_demo",
          name: "Demo Workspace",
          role: "owner",
          created_at: "2026-10-01T00:00:00.000Z",
        },
      ],
    }),
  ),

  // Dashboard's headline counts — keep the home page intact under mocks.
  // (Dashboard requests /v1/oma/stats, not /v1/stats.)
  http.get("/v1/oma/stats", () =>
    HttpResponse.json({
      agents: 4,
      sessions: 187,
      environments: 2,
      vaults: 3,
      skills: 6,
      model_cards: 4,
      api_keys: 2,
    }),
  ),
];
