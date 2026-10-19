/**
 * Correlates an Agent's MCP tool calls with OpenMatter operation calls.
 *
 * The OpenMA harness records every MCP tool call as a session event
 * (`agent.mcp_tool_use`, or `agent.tool_use` for `mcp_invoke` when tools are
 * deferred behind `tool_search`) before it executes the call. The connector
 * reads that event from the session event log and reports it to the kernel as
 * an operation-call callback whose id is the tool-use id. The MCP endpoint
 * receives the same call over HTTP and waits here until the kernel answers.
 *
 * Deriving the callback from the event log, rather than from the HTTP call,
 * keeps the Agent event stream deterministic: a replayed Turn produces the
 * same callbacks at the same positions.
 *
 * Calls are grouped by the OpenMatter Agent Session id, which the MCP endpoint
 * learns from the bearer it issued for that Session.
 *
 * The pairing lives in a `CallStore` (the Matter database), not in memory:
 * the replica running the Turn announces and answers calls, and the MCP
 * request may reach any other replica, which claims the call and polls for
 * its answer.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** An MCP tool name for an OpenMatter tool name (`feishu.message.reply` →
 * `feishu_message_reply`). MCP tool names allow only `[A-Za-z0-9_-]`. */
export const mcpToolName = (toolName: string): string =>
  toolName.replace(/[^A-Za-z0-9_-]/g, "_");

/** Canonical JSON with sorted object keys, used to match a call to its event. */
export const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export class ToolCallTimeoutError extends Error {
  constructor(toolName: string) {
    super(
      `No operation call was recorded for ${toolName}; the call is not part of an active Turn`,
    );
    this.name = "ToolCallTimeoutError";
  }
}

export type ToolCallOutcome =
  | { readonly ok: true; readonly result: JsonValue }
  | { readonly ok: false; readonly error: JsonValue };

/** Shared state behind the bridge. `key` is the tool name and canonical
 * arguments; a store may keep only a digest of it. */
export interface CallStore {
  setTools(sessionId: string, toolsJson: string): Promise<void>;
  tools(sessionId: string): Promise<string | undefined>;
  /** Idempotent per callback id; calls of a Session are claimed in
   * announcement order. */
  announce(sessionId: string, callbackId: string, key: string): Promise<void>;
  /** First answer wins. */
  resolve(callbackId: string, outcome: unknown): Promise<void>;
  /** Claim the oldest unclaimed call of a Session with this key. */
  claim(sessionId: string, key: string, claimer: string): Promise<string | undefined>;
  outcome(callbackId: string): Promise<unknown>;
  /** Drop a Session's calls no MCP request claimed (its Turn ended). */
  release(sessionId: string): Promise<void>;
  /** Drop one call after its answer was delivered. */
  forget(callbackId: string): Promise<void>;
}

/** A `CallStore` in process memory, for a single process and tests. */
export const memoryCallStore = (): CallStore => {
  const tools = new Map<string, string>();
  interface Row {
    readonly callbackId: string;
    readonly sessionId: string;
    readonly key: string;
    claimedBy?: string;
    outcome?: unknown;
  }
  // Insertion order is announcement order.
  const rows = new Map<string, Row>();
  return {
    setTools: async (sessionId, json) => void tools.set(sessionId, json),
    tools: async (sessionId) => tools.get(sessionId),
    announce: async (sessionId, callbackId, key) => {
      if (!rows.has(callbackId)) rows.set(callbackId, { callbackId, sessionId, key });
    },
    resolve: async (callbackId, outcome) => {
      const row = rows.get(callbackId);
      if (row !== undefined && row.outcome === undefined) row.outcome = outcome;
    },
    claim: async (sessionId, key, claimer) => {
      for (const row of rows.values()) {
        if (row.sessionId === sessionId && row.key === key && row.claimedBy === undefined) {
          row.claimedBy = claimer;
          return row.callbackId;
        }
      }
      return undefined;
    },
    outcome: async (callbackId) => rows.get(callbackId)?.outcome,
    release: async (sessionId) => {
      for (const [id, row] of rows) {
        if (row.sessionId === sessionId && row.claimedBy === undefined) rows.delete(id);
      }
    },
    forget: async (callbackId) => void rows.delete(callbackId),
  };
};

export interface OperationCallBridgeOptions {
  /** Defaults to `memoryCallStore()`: a single process. */
  readonly store?: CallStore;
  /** How long an MCP call waits for its tool-use event (default 60 s). */
  readonly matchTimeoutMs?: number;
  /** How long a matched call waits for the kernel's answer (default 10 min). */
  readonly resultTimeoutMs?: number;
  /** Polling interval of a waiting MCP call (default 200 ms). */
  readonly pollMs?: number;
}

/** An OpenMatter tool as the Matter MCP server lists it. */
export interface BridgeTool {
  /** OpenMatter tool name, `${integrationId}.${operation}`. */
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Tool call aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Tool call aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

let claimers = 0;

export class OperationCallBridge {
  private readonly store: CallStore;
  private readonly matchTimeoutMs: number;
  private readonly resultTimeoutMs: number;
  private readonly pollMs: number;
  /** Wakes a waiting call early when this process wrote what it waits for. */
  private readonly wakers = new Set<() => void>();

  constructor(options: OperationCallBridgeOptions = {}) {
    this.store = options.store ?? memoryCallStore();
    this.matchTimeoutMs = options.matchTimeoutMs ?? 60_000;
    this.resultTimeoutMs = options.resultTimeoutMs ?? 600_000;
    this.pollMs = options.pollMs ?? 200;
  }

  private static key(toolName: string, input: unknown): string {
    return `${toolName}\u0000${stableJson(input)}`;
  }

  private wake(): void {
    for (const waker of [...this.wakers]) waker();
  }

  /** Waits `pollMs`, or less when this process changed the store. */
  private async pause(signal?: AbortSignal): Promise<void> {
    const local = new AbortController();
    const waker = () => local.abort();
    this.wakers.add(waker);
    const onAbort = () => local.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await sleep(this.pollMs, local.signal).catch(() => undefined);
    } finally {
      this.wakers.delete(waker);
      signal?.removeEventListener("abort", onAbort);
    }
    if (signal?.aborted) throw signal.reason ?? new Error("Tool call aborted");
  }

  /** Connector side: the tools the latest Turn of a Session allows. Set
   * before the Turn's message is sent, so the Agent lists them. */
  async setTools(sessionId: string, tools: readonly BridgeTool[]): Promise<void> {
    await this.store.setTools(sessionId, JSON.stringify(tools));
  }

  /** MCP side: the tools to list for a Session. */
  async tools(sessionId: string): Promise<readonly BridgeTool[]> {
    const json = await this.store.tools(sessionId);
    return json === undefined ? [] : (JSON.parse(json) as BridgeTool[]);
  }

  /** Connector side: the event log shows the Agent called `toolName`. */
  async announce(
    sessionId: string,
    callbackId: string,
    toolName: string,
    input: unknown,
  ): Promise<void> {
    await this.store.announce(sessionId, callbackId, OperationCallBridge.key(toolName, input));
    this.wake();
  }

  /** Connector side: the kernel answered the callback. */
  async resolve(callbackId: string, outcome: ToolCallOutcome): Promise<void> {
    await this.store.resolve(callbackId, outcome);
    this.wake();
  }

  /** Drop calls no MCP request claimed, for example after a Turn ends. */
  async release(sessionId: string): Promise<void> {
    await this.store.release(sessionId);
  }

  /** MCP side: wait for the kernel's answer to this call. */
  async call(
    sessionId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome> {
    const key = OperationCallBridge.key(toolName, input);
    const claimer = `${process.pid}:${++claimers}`;
    const matchBy = Date.now() + this.matchTimeoutMs;
    let callbackId: string | undefined;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("Tool call aborted");
      callbackId = await this.store.claim(sessionId, key, claimer);
      if (callbackId !== undefined) break;
      if (Date.now() >= matchBy) throw new ToolCallTimeoutError(toolName);
      await this.pause(signal);
    }
    const answerBy = Date.now() + this.resultTimeoutMs;
    try {
      for (;;) {
        const outcome = await this.store.outcome(callbackId);
        if (outcome !== undefined) return outcome as ToolCallOutcome;
        if (Date.now() >= answerBy) throw new ToolCallTimeoutError(toolName);
        await this.pause(signal);
      }
    } finally {
      await this.store.forget(callbackId).catch(() => undefined);
    }
  }
}
