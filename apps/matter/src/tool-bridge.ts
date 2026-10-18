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

interface Entry {
  readonly callbackId: string;
  readonly key: string;
  claimed: boolean;
  outcome?: ToolCallOutcome;
  deliver?: (outcome: ToolCallOutcome) => void;
}

interface Waiter {
  readonly key: string;
  readonly attach: (entry: Entry) => void;
}

export interface OperationCallBridgeOptions {
  /** How long an MCP call waits for its tool-use event (default 60 s). */
  readonly matchTimeoutMs?: number;
  /** How long a matched call waits for the kernel's answer (default 10 min). */
  readonly resultTimeoutMs?: number;
}

export class OperationCallBridge {
  private readonly entries = new Map<string, Entry[]>();
  private readonly byCallback = new Map<string, Entry>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly matchTimeoutMs: number;
  private readonly resultTimeoutMs: number;

  constructor(options: OperationCallBridgeOptions = {}) {
    this.matchTimeoutMs = options.matchTimeoutMs ?? 60_000;
    this.resultTimeoutMs = options.resultTimeoutMs ?? 600_000;
  }

  private static key(toolName: string, input: unknown): string {
    return `${toolName}\u0000${stableJson(input)}`;
  }

  /** Connector side: the event log shows the Agent called `toolName`. */
  announce(
    sessionId: string,
    callbackId: string,
    toolName: string,
    input: unknown,
  ): void {
    if (this.byCallback.has(callbackId)) return;
    const entry: Entry = {
      callbackId,
      key: OperationCallBridge.key(toolName, input),
      claimed: false,
    };
    this.byCallback.set(callbackId, entry);
    const waiters = this.waiters.get(sessionId) ?? [];
    const index = waiters.findIndex((waiter) => waiter.key === entry.key);
    if (index !== -1) {
      const [waiter] = waiters.splice(index, 1);
      waiter?.attach(entry);
      return;
    }
    const list = this.entries.get(sessionId) ?? [];
    list.push(entry);
    this.entries.set(sessionId, list);
  }

  /** Connector side: the kernel answered the callback. */
  resolve(callbackId: string, outcome: ToolCallOutcome): void {
    const entry = this.byCallback.get(callbackId);
    if (entry === undefined || entry.outcome !== undefined) return;
    entry.outcome = outcome;
    if (entry.deliver !== undefined) {
      entry.deliver(outcome);
      this.forget(entry);
    }
  }

  /** Drop entries no MCP call claimed, for example after a Turn ends. */
  release(sessionId: string): void {
    for (const entry of this.entries.get(sessionId) ?? []) {
      if (!entry.claimed) this.byCallback.delete(entry.callbackId);
    }
    this.entries.delete(sessionId);
  }

  /** MCP side: wait for the kernel's answer to this call. */
  call(
    sessionId: string,
    toolName: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ToolCallOutcome> {
    const key = OperationCallBridge.key(toolName, input);
    return new Promise<ToolCallOutcome>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const attach = (entry: Entry) => {
        entry.claimed = true;
        if (entry.outcome !== undefined) {
          cleanup();
          this.forget(entry);
          resolve(entry.outcome);
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          entry.deliver = undefined;
          reject(new ToolCallTimeoutError(toolName));
        }, this.resultTimeoutMs);
        entry.deliver = (outcome) => {
          cleanup();
          resolve(outcome);
        };
      };
      const waiter: Waiter = { key, attach };
      const onAbort = () => {
        cleanup();
        this.dropWaiter(sessionId, waiter);
        reject(signal?.reason ?? new Error("Tool call aborted"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      const list = this.entries.get(sessionId) ?? [];
      const index = list.findIndex(
        (entry) => !entry.claimed && entry.key === key,
      );
      if (index !== -1) {
        const [entry] = list.splice(index, 1);
        if (entry !== undefined) {
          attach(entry);
          return;
        }
      }
      const waiters = this.waiters.get(sessionId) ?? [];
      waiters.push(waiter);
      this.waiters.set(sessionId, waiters);
      timer = setTimeout(() => {
        cleanup();
        this.dropWaiter(sessionId, waiter);
        reject(new ToolCallTimeoutError(toolName));
      }, this.matchTimeoutMs);
    });
  }

  private dropWaiter(sessionId: string, waiter: Waiter): void {
    const waiters = this.waiters.get(sessionId);
    if (waiters === undefined) return;
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    if (waiters.length === 0) this.waiters.delete(sessionId);
  }

  private forget(entry: Entry): void {
    this.byCallback.delete(entry.callbackId);
  }
}
