---
title: "E2B vs Daytona vs Modal vs Fly Sprites, under OpenMA's conformance suite"
description: "A capability comparison of four sandbox providers, read straight from OpenMA's machine-readable conformance table — lifecycle, workspace durability, egress policy, and what 'supported' actually means per driver."
publishedAt: 2026-10-12
author: openma
tags: ["sandbox", "e2b", "daytona", "modal", "sprites", "conformance", "architecture"]
---

Most "E2B vs X vs Y" posts answer with benchmark charts: cold-start
milliseconds, p99 resume latency, a leaderboard. This post reads a
different artifact — the conformance profile each sandbox driver
declares to the OpenMA host, in
[`MANAGED_RUNTIME_PROVIDER_CONFORMANCE`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts).

> **Where these numbers come from.** Everything below is read from the
> conformance descriptors and the driver source in the repo — not from
> live benchmark runs. We did not measure cold-start latency, we ran no
> workloads against these providers, and we claim no pass rates. When a
> row says `supported`, it means the driver answers "supported" in code
> the host validates against, and the mechanism behind that answer is
> in the driver package. If you want latency numbers, you'll have to
> run your own suite — the table tells you *what to measure*, not how
> fast it is.

That framing matters more than it sounds. A conformance profile is the
honest interface between a control plane and a sandbox provider: the
questions a driver must answer about itself — can you suspend? does
the workspace survive? who owns the lease? — before the host will let
a session's tools touch it. OpenMA's version lives in one typed table,
and `requireManagedRuntimeProvider` refuses to silently promote a raw
sandbox adapter into a managed runtime without it.

Four providers sit in that table with full managed-runtime status:
[E2B](https://e2b.dev/docs), [Daytona](https://www.daytona.io/docs),
[Modal](https://modal.com/docs/guide/sandbox), and
[Fly Sprites](https://docs.sprites.dev/) — the four external sandbox
clouds a self-hosted OpenMA control plane can drive today. Here is
what they actually answer.

## The table, verbatim

| Capability | E2B | Daytona | Modal | Sprites |
|---|---|---|---|---|
| `driverLanes` | `ama_worker`, `openma_supervised` | same | same | same |
| `lifecycle.lease` | `host-fenced` | `host-fenced` | `host-fenced` | `host-fenced` |
| `lifecycle.suspendResume` | `supported` | `supported` | `supported` | `supported` |
| `lifecycle.hardTerminate` | `supported` | `supported` | `supported` | `supported` |
| `lifecycle.orphanReap` | `host-managed` | `host-managed` | `host-managed` | `host-managed` |
| `workspace.strategies` | `retained_runtime`, `checkpoint_restore` | `retained_runtime`, `checkpoint_restore` | `retained_runtime` | `retained_runtime` |
| `workspace.durability` | `durable` | `durable` | `durable` | `durable` |
| `outputs` | `final_collect`, `durable` | same | same | same |
| `runtimeCheckpoints` | `[]` | `[]` | `[]` | `[]` |

Read naively, that's a suspiciously uniform table — four providers,
identical rows. The interesting part is *how* each driver backs the
same answer, and that lives in `sandboxPortFacts` and the driver code.

## Same answers, different mechanisms

**E2B** (`packages/managed-runtime-e2b`, `packages/sandbox-adapter-e2b`)
runs each session as a Firecracker microVM. Its lifecycle is the most
snapshot-shaped of the four: suspend calls `sandbox.pause()`, resume
calls `sandbox.connect()`, lease renewal is `sandbox.setTimeout()`, and
the portable workspace checkpoint is `sandbox.createSnapshot()` — a
provider memory snapshot whose `checkpointId` is the snapshot ID. The
managed driver wires `retainedSuspendKind: "memory"` and
`portableCheckpointKind: "memory"`, so E2B's whole-VM snapshots double
as workspace restore points. Its sandbox facts:
`provider_suspend_resume`, `provider_memory_snapshot`, `duplex_process`.

**Daytona** (`packages/managed-runtime-daytona`) plays the
stable-identity game. Sandboxes are named `openma-<sessionId>` with
ownership labels (`openma.environment_id`, `openma.session_id`,
`openma.mode`), and the driver *refuses to attach* to a sandbox whose
labels don't match — then recovers cleanly when a concurrent create
returns 409. Suspend is a filesystem story: `stop()` retains the
filesystem, `start()` resumes it, and `createSnapshot()` produces a
portable filesystem checkpoint — the only provider here with
`portable_filesystem_snapshot` in its available facts. Lease renewal is
`refreshActivity`, piggybacking on Daytona's auto-stop timers.

**Modal** (`packages/managed-runtime-modal`) is durable by
construction rather than by snapshot. The driver mounts a pre-created
Volume v2 at `/workspace` under a per-session subpath
(`sessions/<hash>`) — it never implicitly creates the volume, because
that would weaken the durability guarantee. Suspend is `/bin/sync` plus
`detach()`; resume reattaches to the same sandbox, or — when the
sandbox hit its idle or max lifetime — recreates compute over the same
durable Volume subpath (`compute_recreate_over_durable_volume`). It's
the cleanest answer to "what survives a dead sandbox": everything,
because the filesystem was never inside the sandbox.

**Sprites** (`packages/managed-runtime-sprites`, the
[`@fly/sprites`](https://www.npmjs.com/package/@fly/sprites) SDK) gives
each session a persistent ext4 filesystem and lets the provider do the
sleeping. The driver holds a keep-alive task (`openma-runtime`) whose
expiry it renews as the lease; suspend releases the keep-alive, runs
`/bin/sync`, and drops the control connection — the Sprite auto-pauses
itself and wakes on the next exec (`automatic_pause_and_wake`).
Ownership is label-validated like Daytona's, and lifecycle calls retry
through transient provider errors.

## Egress is where the uniformity ends

The rows so far say "all four can host a session." The egress rows say
what kind of session. Every driver descriptor defaults
`credentialEgress` to
`{ enforcement: "unsupported", credentialMode: "snapshot", interceptedProtocols: [] }`
unless the operator injects a certified `CredentialEgressPort`
implementation via driver options — check the descriptor functions in
each `*/src/*.ts`. Only the Cloudflare driver declares
`enforced`/`live` credential interception today; on these four, a
profile that *requires* enforced egress fails admission loudly rather
than silently degrading.

Provider-native network policy is a separate axis, and here the four
diverge:

- **Modal** has the strongest native story: outbound domain and CIDR
  allowlists (`updateNetworkPolicy`), `blockNetwork: true` as the
  create-time default, and a belt-and-suspenders step that clamps
  egress to an empty allowlist *before* any readiness probe runs on
  attach (`fenceNetworkBeforeReadiness`). A resumed sandbox can't phone
  home before its policy is reasserted.
- **Sprites** exposes `native_network_policy` — domain allow/deny rules
  via `updateNetworkPolicy`, applied on create and resume when the
  operator configures a `networkPolicy` option.
- **Daytona** passes network controls through at create time:
  `networkBlockAll`, `networkAllowList`, `domainAllowList`, and an
  `outboundProxyUrl` for operators who want egress to flow through
  their own proxy.
- **E2B** is the honest outlier. The adapter notes that network access
  is controlled by the template image, and the managed preset supplies
  no credential-egress wire point at all "because the installed E2B SDK
  does not prove hosted egress-policy semantics" — operators bring and
  certify their own.

Note what none of this is: the environment `allowed_hosts` limit,
enforced inside the `web_fetch` tool in `apps/agent/src/harness/tools.ts`,
is a tool-level check, not a sandbox firewall — `bash`/`curl` ignore it.
A general egress allowlist proxy is planned work
([issue #297](https://github.com/openma-ai/open-managed-agents/issues/297)),
not a claim this table makes.

## What the table refuses to say

The most instructive column is the empty one. `runtimeCheckpoints` is
`[]` for every driver — all twelve providers in the table, not just
these four. Process-memory checkpoint/restore does not exist in OpenMA;
durable state is a filesystem property, full stop.

You can watch the table enforce that honesty on E2B specifically. Its
sandbox facts list `provider_memory_snapshot` as *available* — the
provider genuinely snapshots the whole microVM — but
`process_memory_checkpoint` is listed as *unavailable*, and the managed
driver's comment says why: don't advertise process checkpointing until
`RuntimeCheckpointPort` is wired into the host's restore transaction.
The provider's capability is real; OpenMA's claim about it is narrower.
The same discipline shows up in the `unavailable` lists elsewhere:
Modal and Sprites both decline `portable_workspace_checkpoint`
(retained-runtime only, `restore()` throws if you ask), and Daytona
declines `durable_output_mount`.

## Reading this when you pick a provider

All four give you the same contract — both driver lanes, host-fenced
leases, suspend/resume, hard terminate, host-managed orphan reaping,
durable workspaces. The decision lives in the mechanisms:

- **Want the snapshot model?** E2B (memory snapshots) and Daytona
  (portable filesystem snapshots) both offer `checkpoint_restore` —
  workspace state you can lift out of the runtime it was created in.
- **Want durability without snapshots?** Modal's Volume and Sprites'
  persistent ext4 keep state out of the compute entirely — suspend is
  bookkeeping, not serialization.
- **Care most about egress?** Modal's deny-by-default-then-allowlist
  flow is the tightest native fit; Daytona gives you the knobs and a
  proxy hook; Sprites gives you a policy API; E2B makes you bring your
  own.
- **Need process memory checkpoints?** Nothing here claims them — and
  any provider page that implies otherwise is describing the provider's
  feature, not what OpenMA will vouch for.

That's the point of keeping the profile machine-readable. Marketing
pages say "persistent," "fast," "secure." The conformance table says
which strategy, which mechanism, and which claims the driver is willing
to sign. The full table is in
[`packages/managed-runtime-host/src/provider-conformance.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts),
the driver sources live next door in `packages/managed-runtime-*`, and
the per-provider walkthrough is on the
[sandboxes docs page](https://docs.openma.ai/sandboxes/). When the docs
and the table ever disagree, the table wins — it's what the host
actually checks.
