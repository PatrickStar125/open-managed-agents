---
title: "Your agent's brain doesn't need to live inside your agent's computer"
description: "The harness loop, event log, and credentials are your agent's brain. The sandbox is just its hands — a replaceable execution environment. How Open Managed Agents draws that line, and what it buys you."
publishedAt: 2026-10-12
author: openma
tags: ["architecture", "sandbox", "credentials", "control-plane", "design"]
---

Ask where an agent "runs" and you usually get one answer: a container, a
VM, a cloud sandbox. But that answer conflates two jobs that have very
different failure modes and very different loyalty requirements.

An agent is really two things:

1. **A brain.** The harness loop that reads the conversation, calls the
   model, parses tool calls, and decides what happens next. The event
   log that remembers everything. The credentials that let the agent
   act as you. This state is precious — it's the accumulated context
   the whole session depends on.

2. **A pair of hands.** A Linux environment where `bash` executes and
   files get written. Real filesystem, real processes, real network
   egress. Useful, necessary — and completely replaceable.

Most agent frameworks glue these together: the loop runs inside the
same process, or the same container, that executes its tool calls. That
works until you want to move the sandbox to a different provider, kill
it on a schedule, or just have it die on a Friday night and take your
session state with it.

[Open Managed Agents](https://github.com/openma-ai/open-managed-agents)
splits them physically. The brain lives in the control plane; the hands
live behind a driver boundary.

## The control plane is the brain

On the Cloudflare host, each session is a Durable Object
(`apps/agent/src/runtime/session-do.ts`) — one single-writer object per
session that owns an append-only event log in embedded SQLite. Every
input (user message, tool result) and every output (model response,
tool call) lands in that log first.

The harness — the loop that talks to the model — is stateless. It reads
events, produces events. If the worker running it crashes mid-step, the
session object records a `session.error`, returns to idle, and the next
message spins up a fresh harness that rebuilds context from the log.
Nothing in the brain was in memory, so nothing is lost. The Node host
runs the same append-only-log model; only the storage backend changes.

Credentials and memory live on this side of the line too. Vaults hold
API keys as control-plane resources. Memory stores are durable
filesystems backed by object storage, mounted into the sandbox at
`/mnt/memory/<store>/` — the sandbox sees a mount, but the bytes belong
to the control plane.

## The sandbox is the hands

Tool calls that need a machine — `bash`, file reads and writes — are
dispatched into a per-session sandbox behind a `SandboxPort`. Which
*kind* of machine is a configuration decision, not an architecture
decision. The repo ships managed-runtime drivers for local Docker,
Cloudflare Containers, E2B, Daytona, Modal, Fly Sprites, Vercel,
Blaxel, BoxLite, BoxRun, and Superserve, plus a bridge driver that lets
a Node control plane drive Cloudflare sandboxes.

The honest record of what each driver can do is
[`MANAGED_RUNTIME_PROVIDER_CONFORMANCE`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts)
— a machine-readable table the host itself validates against. It says,
per driver, whether suspend/resume works, how workspace state persists
(`retained_runtime` vs `checkpoint_restore` strategies), and what the
sandbox port can actually deliver. Swap E2B for Docker and the session
doesn't know: the brain is untouched, the hands are new.

Two things are worth noticing in that table, because we won't
overclaim them:

- `runtimeCheckpoints` is an empty list for **every** driver.
  Process-memory checkpoint/restore doesn't exist in OpenMA today —
  durable workspace state is a filesystem property, not a
  freeze-the-process one.
- Several providers advertise their own network policies or secret
  injection (Vercel's deny-by-default firewall, Blaxel's proxy,
  Sprites' network policy). Those are provider features surfaced
  through the driver, not a universal OpenMA guarantee.

## Credentials belong to the brain, not the hands

This is the split's sharpest edge. A sandbox is, by design, a place
where model-generated code executes. Whatever secrets live inside it
are one `curl` away from a prompt injection that told the model to
exfiltrate them.

So OpenMA keeps credentials in the control plane and binds them to
egress instead of handing them over. The contract is
[`CredentialEgressPort`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/credential-egress.ts):
`prepare` a short-lived binding, `attach` it to the sandbox lease,
`revoke` and `release` when the work ends. The binding is explicitly
transient — "must never be persisted in a sandbox lease or checkpoint,"
says the type's own docstring. On the Cloudflare driver this is
`enforced` egress with live credentials over HTTP/HTTPS: the proxy
injects auth headers on matching outbound requests and the raw token
never enters the sandbox.

Here's the part where precision matters, because "credentials never
enter the sandbox" is only as strong as the enforcement behind it:

- **Cloudflare:** `enforcement: "enforced"`, `credentialMode: "live"`,
  `interceptedProtocols: ["http", "https"]` — the only driver that
  declares enforced egress today.
- **Every other managed-runtime driver** defaults its descriptor to
  `{ enforcement: "unsupported", credentialMode: "snapshot", interceptedProtocols: [] }`
  unless the operator injects a certified `CredentialEgressPort`
  implementation via driver options. Declaring a profile that
  *requires* enforced egress on such a driver fails admission loudly
  rather than silently degrading.
- **Self-host Node/Docker:** the `oma-vault` sidecar injects
  credentials through an `HTTPS_PROXY` env var — a real credential
  boundary for cooperative sandboxes, but an *advisory* one. A process
  that ignores proxy env vars walks around it.

The environment `allowed_hosts` networking limit has an even narrower
scope: it's a check inside the `web_fetch` tool —
[`assertWebFetchUrlAllowed`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/harness/web-fetch-http.ts)
suffix-matches the requested host and re-checks it on every redirect
hop — not a sandbox firewall. `bash`/`curl` inside the sandbox isn't
governed by it. A general egress allowlist proxy is on the roadmap
([issue #297](https://github.com/openma-ai/open-managed-agents/issues/297)),
not a claim.

None of that weakens the architecture. It strengthens the honest
version of it: the *interface* puts credentials on the brain's side of
the line everywhere, and enforcement depth is a per-driver fact the
system says out loud instead of pretending.

## What the split actually buys

**Provider portability.** The sandbox is swappable because nothing the
agent "knows" lives there. Managed runtimes differ in lifecycle
(suspend/resume, snapshot durability) — the conformance table makes
those differences legible instead of surprising.

**Crash recovery that's just… replay.** Sandbox dies? The event log
didn't notice — it lives in the control plane. Workspace durability is
the driver's problem (`checkpoint_restore` or `retained_runtime`), and
the worst case is a rebuilt filesystem, never a rebuilt conversation.
Harness dies? Recovering is re-reading the log, which is what the
harness does on every step anyway.

**A blast radius that ends at the hands.** Where enforcement exists
(today: Cloudflare), a compromised or simply misled agent can't leak a
credential it never possessed. Where it doesn't yet, the descriptor
says `unsupported` and you design accordingly.

**Room to grow.** Warm pools, sandbox `fork`, and a general egress
allowlist proxy are all planned work that lands *inside* the hands'
side of the boundary — the brain, the event model, and the public API
don't move.

The pattern isn't new — Anthropic's own
[Managed Agents](https://platform.claude.com/docs/en/managed-agents/tools)
separates the session resource from the
[code execution environment](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool),
and their
[memory contract](https://platform.claude.com/docs/en/managed-agents/memory)
puts durable state on the service side. Open Managed Agents is the
open-source version of that bet: your brain, your credentials, your
event log — on your infrastructure, with whichever pair of hands fits
the job this week.

The code that draws the line is in
[`packages/managed-runtime-host`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/managed-runtime-host)
and [`packages/runtime-resource-contract`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/runtime-resource-contract);
the driver-by-driver details are in the
[docs](https://docs.openma.ai). If the table and the docs ever disagree,
the table wins — it's what the runtime actually checks.
