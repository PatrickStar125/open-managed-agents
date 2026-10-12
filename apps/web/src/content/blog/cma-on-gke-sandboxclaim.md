---
title: "Claude Managed Agents on GKE: one Work item, one SandboxClaim"
description: "How OpenMA's GKE dispatch port turns a reserved-but-unacknowledged Work item into a bound warm pod: SandboxClaim get-or-create, stale-claim reaping, bounded redispatch, and why the in-pod worker owns the ACK."
publishedAt: 2026-10-12
author: openma
tags: ["kubernetes", "gke", "sandbox", "claude-managed-agents", "dispatch", "control-plane"]
draft: false
---

An Environment in the Claude Managed Agents protocol is a Work queue. Sessions
produce Work; something has to turn each Work item into a running sandbox. On
most providers that "something" is an SDK call — `Sandbox.create()` on E2B,
`modal.Sandbox.from_name` on Modal. On Kubernetes the honest answer is weirder
and better: you don't create a pod, you create a **claim** against a pool of
pods that are already warm.

This post walks the GKE binding in
[`packages/environment-dispatch-gke`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/environment-dispatch-gke/src/index.ts)
— 183 lines, one exported factory — and the protocol boundary that lets the
same OpenMA control plane run sessions on GKE without a bespoke sandbox SDK.

## The strategy: poll, don't ACK

Anthropic's
[self-hosted sandbox contract](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
says a worker may poll Work continuously or wake on a webhook. The GKE binding
implements a sharper variant, declared in its descriptor as
`strategy: "poll_unacked_then_dispatch"`.

The dispatcher — `createDispatchedManagedEnvironmentWorker` in
[`packages/managed-runtime-host`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/dispatched-environment-worker.ts)
— polls Work with `block_ms: null`. That poll *reserves* the Work for delivery
but deliberately does **not** ACK it. If dispatch fails, the code's own comment
states the rule: *"Do not ACK or stop. The server-side reservation timeout is
the authority that makes this Work available to a replacement."*

The ACK belongs to the sandbox. Once the dispatcher hands the Work identity to
a pod, the in-pod `ant beta:worker run` owns ACK, heartbeat, and stop — the
official lease is established by the worker inside the sandbox, not by the
control loop outside it. That's the whole worker-protocol boundary, and it's
what makes the control plane provider-agnostic: the dispatcher's job ends at
delivering `sessionId` + `workId` to a `dispatchUrl`.

## The port shape

`createManagedEnvironmentWorkDispatchPort(factoryOptions)` returns a
`ManagedEnvironmentWorkDispatchPort` — a two-method object (`descriptor()`,
`dispatch()`) — and takes these options:

- **`controlPlane`** — a `GkeSandboxClaimControlPlanePort`: four methods
  (`listSessionClaims`, `deleteClaim`, `createClaim`, `postSession`). This is a
  structural boundary. The file's docstring is explicit: it can be *"a
  Kubernetes SDK adapter or an OpenMA-owned in-cluster driver service. No
  Kubernetes dependency leaks here."* The package itself imports no client-go,
  no `@kubernetes/client-node` — nothing.
- **`workControl`** — one method, `stop({environmentId, workId, force})`. Used
  for exactly one thing: killing poison Work.
- **`namespace`, `template`, `warmPool`** — the Kubernetes namespace, the
  `SandboxTemplate` name, and the `SandboxWarmPool` name the claim binds to.
- **`readyTimeoutMs`** (default `120_000`) — how long `createClaim` waits for
  the bound pod to report a `dispatchUrl`.
- **`maxRedispatch`** (default `3`) — the retry budget per Work item, counted
  through claim labels.

`createManagedEnvironmentWorkerInstallation({mode: "provider_dispatch", ...})`
in
[`environment-worker-installation.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/environment-worker-installation.ts)
dynamically imports this adapter, checks the descriptor's strategy matches
`poll_unacked_then_dispatch`, and wraps it in the poll/webhook drain loop.
Provider specifics stay inside `factoryOptions`; the port shape doesn't bend
for GKE.

## What `dispatch()` actually does

Given a reserved Work item, the body of `dispatch()` is a five-step pipeline:

**1. Session-only gate.** `work.data.type !== "session"` throws. (The drain
loop upstream already force-stops non-Session Work; this is defense in depth.)

**2. Reap stale claims.** `listSessionClaims({namespace, environmentId,
sessionId})` returns every `SandboxClaim` this session left behind. Each claim
carries a `dispatchCount`. A claim whose `workId` matches the *current* Work is
a survivor — a previous dispatch attempt that may still be alive — so it's kept
and its count is remembered. Every other claim belongs to dead Work and is
deleted. A claim with a non-integer `dispatchCount` fails the whole dispatch:
corrupt bookkeeping is worse than a retry.

**3. Compute the generation.** `dispatchCount = survivingDispatchCount ??
previousDispatchCount + 1`. Re-dispatching the same Work reuses its surviving
claim's generation; dispatching after failure increments. If the result
exceeds `maxRedispatch`, the Work is poison — `workControl.stop({force: true})`
kills it and no claim is created. Bounded redispatch is a label-math decision,
not a timer.

**4. Get-or-create the claim.** `createClaim` is called with
`idempotencyKey: "${work.id}:${dispatchCount}"`, the template and warm pool
names, and four labels:

```ts
labels: {
  "openma.environment-id": input.work.environment_id,
  "openma.session-id": sessionId,
  "openma.work-id": input.work.id,
  "openma.dispatch-count": String(dispatchCount),
}
```

The contract on the port says the call *must atomically get-or-create one
SandboxClaim for this key*. Two dispatchers racing the same reservation land
on the same claim instead of double-booking a warm pod. The labels are also
the reaper's index in step 2 — everything the dispatcher needs to know about a
claim later, it writes on the claim now.

**5. Post the identity.** `postSession({dispatchUrl, sessionId, workId})` sends
the bound pod exactly two identifiers. Not the Work object, not the
environment key — the test suite names its fixture key `"must-not-enter-claim"`
to pin that down. The pod's worker uses the Work protocol to claim its own
lease from there.

If `postSession` fails, cleanup is conditional on `bound.created`: a claim this
call created gets deleted (best-effort); a claim returned by idempotent replay
is left alone — deleting another dispatcher's live binding is worse than
leaking a retry.

## The warm pool is real — and it's Kubernetes's

`SandboxClaim` comes from
[`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox),
the Kubernetes SIG's sandbox controller: a `SandboxWarmPool` pre-warms pods
from a `SandboxTemplate`, and a `SandboxClaim` adopts one out of the pool. The
`warmPool` option in `factoryOptions` is a literal binding to that feature —
the claim checks out a gVisor-isolated pod that is already running, which is
why `readyTimeoutMs` is measured in seconds rather than the minutes a cold
image pull would cost.

One honest scoping note: this is agent-sandbox's warm pool, not a general
OpenMA warm-pool abstraction. A provider-neutral pooling API is still planned
work; what's merged is the GKE-specific binding, and the option name doesn't
pretend otherwise.

## What the provider owns

Per the
[provider audit](https://github.com/openma-ai/open-managed-agents/blob/main/docs/claude-managed-agents-sandbox-provider-audit.md),
the GKE topology gives you an ephemeral workspace with an output-only GCS FUSE
mount, default-deny `NetworkPolicy`/FQDN egress rules, and Secret Manager for
credentials. Those are provider features delivered through the claim path —
the same caveat that applies everywhere in the conformance table applies here:
capabilities a driver doesn't declare (enforced credential egress,
process-memory checkpoint/restore) are not claimed, and `runtimeCheckpoints`
is empty for every driver including this one. Work recovery rides on the
reservation timeout and the `dispatch-count` label, not on pod snapshots.

## Why the boundary matters

The interesting part isn't that Kubernetes can run agent sandboxes — it's how
little the control plane had to learn. The CMA worker protocol already has the
right seams: a reservation poll that isn't an ACK, a `dispatchUrl` that
carries identity instead of state, and an in-pod worker that owns the lease
from first heartbeat to stop. The GKE dispatcher slots into those seams with
one new verb — claim instead of create — and the same code that drains Work
for Cloudflare's dispatch port drains it for GKE, because both answer to
`ManagedEnvironmentWorkDispatchPort`.

The code is small enough to read in one sitting:
[`packages/environment-dispatch-gke`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/environment-dispatch-gke)
for the claim lifecycle,
[`dispatched-environment-worker.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/dispatched-environment-worker.ts)
for the drain loop, and the
[managed-runtime-host docs](https://docs.openma.ai/self-host/managed-runtime-host/)
for how the installation modes compose. The reference topology this mirrors —
dispatcher, `SandboxClaim`, bound warm pod — is Google's
[anthropic-agent-sandbox sample](https://github.com/GoogleCloudPlatform/kubernetes-engine-samples/tree/8708c6c6bd28dc5d8e3b642642e62115c049d6fd/ai-ml/anthropic-agent-sandbox),
audited at a pinned commit in the provider audit.
