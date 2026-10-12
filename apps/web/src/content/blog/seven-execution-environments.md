---
title: "The seven classes of agent execution environment in 2026"
description: "Local Docker, hosted microVMs, sandbox services, serverless compute, agent platforms, edge containers, and Kubernetes claims — what each class of agent sandbox actually gives you, mapped to OpenMA's managed-runtime drivers and their conformance table."
publishedAt: 2026-10-12
author: openma
tags: ["sandbox", "execution-environment", "providers", "architecture", "survey"]
draft: false
---

Every agent that runs code needs somewhere to run it. In 2026 that
"somewhere" has split into at least seven distinct classes of execution
environment — different security boundaries, different lifecycles, different
answers to *who operates the control plane*.

This is a survey, not a ranking. For each class we name real providers,
what the environment gains and gives up, and which Open Managed Agents
driver maps to it. The claims about OpenMA drivers come from
[`MANAGED_RUNTIME_PROVIDER_CONFORMANCE`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts)
— a machine-readable table the host validates against, not a marketing
page — and the provider selection map in
[`apps/main-node/src/sandbox-provider.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/main-node/src/sandbox-provider.ts).
Where the table says a capability is absent, we say so.

## 1. Local process / Docker container

**Providers:** your own Docker host; embedded runtimes like
[BoxLite](https://docs.boxlite.ai/) that run microVMs as a library on your
machine.

The zero-dependency option: a container (shared-kernel isolation) or an
embedded microVM (own kernel) on hardware you already own. OpenMA's
`node-docker` driver is this class. Per the conformance table its
`suspendResume` is `unsupported` — containers don't freeze — but its
workspace durability is `durable` through a `checkpoint_restore`
strategy: the host snapshots the filesystem around the container rather
than relying on the container to persist itself. The `litebox` driver
also lives here: an embedded BoxLite microVM with `suspendResume`
`supported` and host-local `retained_runtime` workspace at `best_effort`
durability — retained boxes are continuable but not advertised as
portable checkpoints.

You run the control plane. You also own the blast radius: a container
shares your kernel, so this class trades isolation strength for
operational simplicity.

## 2. MicroVM dev boxes

**Providers:** [E2B](https://e2b.dev/docs) — whose
[open-source runtime](https://github.com/e2b-dev/runtime) puts one
[Firecracker](https://firecracker-microvm.github.io/) microVM per
sandbox — and [BoxRun](https://docs.boxlite.ai/), the REST/CLI
management layer over BoxLite.

Hardware-virtualized isolation fast enough to treat as a dev box. E2B
sandboxes are resumed snapshots — pause diffs memory and disk to object
storage, resume restores on page fault. OpenMA's `e2b` driver reports
`suspendResume: "supported"` plus `provider_suspend_resume` and
`provider_memory_snapshot` facts; workspace is `durable` via
`retained_runtime` + `checkpoint_restore`. `boxrun` reaches the same
microVM substrate through the official REST client: `suspendResume`
supported, workspace `best_effort` — retained storage stays
provider-local unless an external checkpoint Port is added.

The provider runs the control plane (or you self-host it); you get real
VM isolation without owning hypervisors.

## 3. Sandbox-as-a-service

**Providers:** [Daytona](https://www.daytona.io/docs),
[Superserve](https://docs.superserve.ai/quickstart).

API-first services whose product *is* the sandbox: stable identities,
ownership labels, stop/start, snapshots, retention. OpenMA's `daytona`
driver follows that lifecycle — stable-name get-or-create, portable
filesystem snapshots, activity-renewed leases — with `suspendResume`
supported and `durable` workspace. `superserve` goes further on
lifecycle: pause/resume preserves *processes and files*, with a
deny-by-default network policy and a provider-side secret proxy that
audits egress.

Control plane: the provider's. What you give up is depth of control —
retention semantics are theirs. The conformance table records this
honestly: provider retention is not promoted to a portable OpenMA
checkpoint.

## 4. Serverless / ephemeral compute sandboxes

**Providers:** [Modal](https://modal.com/docs/guide/sandbox),
[Fly Sprites](https://docs.sprites.dev/),
[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox).

Compute that materializes per workload and dissolves — but with durable
state underneath, which is what separates 2026's ephemeral sandboxes
from 2020's. Modal's driver mounts a pre-created Volume v2 Session
subpath at `/workspace` and recreates expired compute *over* that
durable volume. Sprites keeps a persistent ext4 filesystem with
automatic pause/wake on traffic. Vercel keeps a persistent named
sandbox with automatic filesystem snapshot restore behind a
deny-by-default firewall — but offers no streaming stdin and runs the
`ama_worker` lane only. All three report `suspendResume: "supported"`.

The provider runs everything; you trade always-on availability for
scale-to-zero economics and genuinely durable workspaces.

## 5. Full-stack agent platforms with sandboxes

**Providers:** [Blaxel](https://docs.blaxel.ai/Sandboxes/Overview).

Here the sandbox is one feature of a platform that also hosts agents,
MCP servers, and model gateways. Blaxel's perpetual sandboxes archive
and unarchive a retained filesystem, expose named full-duplex
processes, and ship a native proxy firewall with secret injection plus
an optional persistent volume. OpenMA's `blaxel` driver maps all of it
— `suspendResume` supported — but rates workspace durability
`best_effort`: the archive/unarchive lifecycle is provider retention,
not a portable checkpoint.

The platform runs the control plane *and* wants to run your agent too.
The gain is integration; the give-up is that the sandbox boundary is
now a platform boundary.

## 6. Edge containers

**Providers:** [Cloudflare Workers
Containers](https://developers.cloudflare.com/containers/) via the
Sandbox SDK; the `cloudflare-bridge` driver for reaching them from a
Node control plane.

Containers scheduled onto an edge network, driven by Durable Objects.
Container isolation (shared kernel), not microVM — and
`suspendResume: "unsupported"` on both `cloudflare` and
`cloudflare-bridge`. Workspace is `durable` via `checkpoint_restore`
(snapshot/restore backup, R2 output mounts). Two caveats the
conformance table makes explicit: the bridge is `ama_worker`-lane only,
and the Node-side driver reaches an operator-deployed official bridge —
OpenMA retains Work and fencing authority.

One thing this class does that no other driver does today: **enforced
credential egress**. The `cloudflare` driver declares
`enforcement: "enforced"`, `credentialMode: "live"` over HTTP/HTTPS in
its
[`CredentialEgressPort`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/credential-egress.ts)
— the only driver that does. Every other managed-runtime driver
defaults its descriptor to `enforcement: "unsupported"` unless the
operator injects a certified implementation.

## 7. Kubernetes-native claims

**Providers:** the [Kubernetes agent-sandbox
project](https://github.com/kubernetes-sigs/agent-sandbox) (SIG Apps) —
`Sandbox` CRD, `SandboxTemplate`, `SandboxClaim`, `SandboxWarmPool` —
with OpenMA's
[`environment-dispatch-gke`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/environment-dispatch-gke/src/index.ts)
binding on GKE.

Not an API call to a sandbox service — a declarative claim on cluster
state. The GKE dispatch port reaps stale `SandboxClaim`s for the
session, idempotently get-or-creates one bound to a named `warmPool`
and `template`, then posts only the session/work ids to the bound pod's
dispatch URL; the in-pod worker owns ACK, heartbeat, and stop.
`maxRedispatch` force-stops Work that churns claims.

This is the one place a **warm pool is real config today** — the
`warmPool` option is required and binds to an actual K8s
`SandboxWarmPool`. It is also deliberately *not* in the conformance
registry: it's a work-dispatch port, not a managed-runtime driver.
Your cluster, your control plane, your CRDs.

## The honest ledger

| Driver | Lanes | suspendResume | Workspace durability |
|---|---|---|---|
| node-docker | `ama_worker`, `openma_supervised` | unsupported | durable (`checkpoint_restore`) |
| cloudflare | `ama_worker`, `openma_supervised` | unsupported | durable (`checkpoint_restore`) |
| cloudflare-bridge | `ama_worker` only | unsupported | durable (`checkpoint_restore`) |
| e2b | `ama_worker`, `openma_supervised` | supported | durable |
| daytona | `ama_worker`, `openma_supervised` | supported | durable |
| litebox | `ama_worker`, `openma_supervised` | supported | best_effort |
| boxrun | `ama_worker`, `openma_supervised` | supported | best_effort |
| blaxel | `ama_worker`, `openma_supervised` | supported | best_effort |
| sprites | `ama_worker`, `openma_supervised` | supported | durable |
| vercel | `ama_worker` only | supported | durable |
| modal | `ama_worker`, `openma_supervised` | supported | durable |
| superserve | `ama_worker`, `openma_supervised` | supported | durable |

Three facts that belong in every survey and get left out of most:

- `runtimeCheckpoints` is an empty list for **every** driver. No
  process-memory checkpoint/restore exists in OpenMA today — durable
  state is a filesystem property everywhere.
- `enforcement: "enforced"` credential egress exists only on the
  Cloudflare driver. On Node/Docker the `oma-vault` env proxy is
  advisory — real for cooperative processes, bypassable by one that
  ignores proxy env vars.
- Environment `allowed_hosts` is a check inside the `web_fetch` tool —
  [`assertWebFetchUrlAllowed`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/harness/web-fetch-http.ts)
  suffix-matches the requested host and re-checks it on every redirect
  hop — not a sandbox firewall. `bash`/`curl`, `web_search`, and MCP
  calls are not governed by it; a general egress allowlist proxy is
  tracked as planned work
  ([issue #297](https://github.com/openma-ai/open-managed-agents/issues/297)).

## What a warm pool or fork would add

General OpenMA-level warm pools and sandbox `fork` are planned, not
shipped — the GKE `warmPool` binding above is the exception that
exists. Both land on the same side of the architecture: pre-warmed or
branched *execution* behind the driver boundary, while the session's
event log, credentials, and fencing stay in the control plane. That is
the point of keeping the conformance table machine-readable: when a
class of hands grows a new trick, the row for that driver changes — the
brain doesn't move.

The full per-driver contract is in the [managed-runtime
docs](https://docs.openma.ai/self-host/managed-runtime-host/); the
adapter contract is in [sandbox
backend](https://docs.openma.ai/self-host/sandbox-backend/). Pick the
class that matches your threat model first, and the provider second.
