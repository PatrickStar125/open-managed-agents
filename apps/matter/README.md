# @open-managed-agents/matter

The OpenMatter host for OpenMA, as its own process. It runs OpenMatter
(Bond, Loops, provider connections such as Feishu) next to an OpenMA
deployment and drives OpenMA Agents only through the public OpenMA API. Nothing
in `apps/main`, `apps/main-node` or `packages/control-plane-node` depends on it.

This package currently contains the Agent side:

- `createOmaClient`: a small client for the public sessions API (create, find
  by title, archive, send events, stream events with `Last-Event-ID` replay).
- `createOpenMAConnector`: an `OpenMAAgentConnector` for
  `makeConnectorAgentDriver` from `@openma/matter/agent`. One OpenMatter Agent
  Session is one OpenMA session, created idempotently (the title carries the
  idempotency key). One Turn is one `user.message` and ends at the next
  terminal status.
- `OperationCallBridge`: correlates the Agent's calls to the Matter MCP server
  with OpenMatter operation calls.

## Operation calls over MCP

The Agent reaches OpenMatter operations, such as the Feishu reply tool, through
an ordinary MCP server configured on the Agent. Because they are ordinary MCP
tools, OpenMA's `tool_search` can defer them like any other MCP tool.

The harness records each MCP call as a session event before running it:
`agent.mcp_tool_use`, or `agent.tool_use` for `mcp_invoke` when the tool was
found through `tool_search`. The connector reads that event from the event log
and reports it to the kernel as an `openmatter/operation` callback whose id is
the tool-use id. The MCP endpoint receives the same call over HTTP and waits on
the bridge until the kernel answers, matching by tool name and arguments.
Deriving the callback from the log keeps a replayed Turn identical to the
original.

MCP tool names are the OpenMatter tool names with characters outside
`[A-Za-z0-9_-]` replaced by `_` (`feishu.message.reply` →
`feishu_message_reply`).

## Tests

```bash
pnpm --filter @open-managed-agents/matter test
pnpm --filter @open-managed-agents/matter typecheck
```

The tests run the connector against an in-memory stand-in for the public API
(`test/fake-oma.ts`).
