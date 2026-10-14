---
title: "Credentials should never enter the sandbox"
description: "A sandbox that can read your API tokens is a prompt-injection time-bomb. The fix is an egress proxy that injects credentials at the network layer — and an honest account of where OpenMA enforces it, where it's advisory, and where it isn't there yet."
publishedAt: 2026-10-12
author: openma
tags: ["security", "credentials", "sandbox", "egress", "architecture"]
---

Every agent sandbox runs model-generated code on inputs the model
didn't choose: web pages it fetched, issues it read, emails it
summarized. Anthropic's own docs call this
[indirect prompt injection](https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)
— adversarial instructions riding inside third-party content — and
their computer-use guidance is blunt about the consequence:
[isolate Claude from sensitive data and actions](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool)
to avoid prompt-injection risk.

Now look at how most agent stacks hand out credentials. `GITHUB_TOKEN`
in the environment. A `.npmrc` with a live registry key. A mounted
`~/.aws/credentials`. Each one is a bet that the model — plus every
byte of untrusted content it ever reads — will never decide to run
`env | grep TOKEN` and `curl` the result somewhere. That's not a
threat model; that's a countdown.

## The pattern: the sandbox gets a handle, not a secret

The alternative is an egress credential proxy, and the shape is
simple:

1. Credentials live in the control plane, in a vault the sandbox has
   no read path to.
2. Outbound traffic from the sandbox crosses a resolver it cannot
   bypass.
3. The resolver matches the request's host to a credential, strips
   whatever `Authorization` header the sandbox attached, injects the
   real one, and forwards.
4. Inside the sandbox there is nothing to steal — `env` is clean, no
   credential files exist, and a hand-rolled `Authorization: Bearer
   hunter2` gets deleted on the way out.

Notice what this buys that the alternatives can't. Env vars and
mounted secret files are readable by *any* process in the box. SDK
wrappers only help if the model uses them. But every exfiltration path
— `curl`, `git push`, a malicious package's install script — has to
cross the network. Put the credential boundary there and there's
exactly one door, with a guard on it.

## The contract: a binding, not a token

In OpenMA the interface for this is
[`CredentialEgressPort`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/credential-egress.ts).
The lifecycle is `prepare` → `attach` → `revoke` → `release`, and what
moves between those calls is a `CredentialEgressBinding`: an opaque,
non-secret id whose own docstring says it "must never be persisted in
a sandbox lease or checkpoint."

A binding is scoped tighter than "this sandbox may use the GitHub
token." It resolves against a
[`RuntimeResourceScope`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/scope.ts)
— workspace, environment, session, work item — plus a
[fence](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/fence.ts)
carrying `ownerId` and a monotonic `generation`, so a binding can't
outlive the work it was prepared for. `revoke` takes a reason
(`completed`, `failed`, `lease_lost`); `release` is the idempotent
cleanup after it.

The port also declares its own strength up front via `capabilities()`:
an `enforcement` tier (`enforced` / `advisory` / `unsupported`), a
`credentialMode` (`live` / `snapshot`), and the
`interceptedProtocols` it actually covers (`http` / `https` / `tcp`).

## Where OpenMA actually enforces it today

Here is the part most projects skip, so we won't: "credentials never
enter the sandbox" is only as strong as the enforcement behind it, and
enforcement is a per-driver fact.

**Enforced — Cloudflare only.** The
[`managed-runtime-cloudflare`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-cloudflare/src/cloudflare.ts)
driver is the one that declares `enforcement: "enforced"`,
`credentialMode: "live"`, `interceptedProtocols: ["http", "https"]`.
The mechanism is concrete. `OmaSandbox`
([`apps/agent/src/oma-sandbox.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/oma-sandbox.ts))
sets `interceptHttps = true` and `enableInternet = false` — the code
comment is worth quoting: "Every HTTP(S) request must traverse a
registered handler. This blocks a compromised harness from bypassing
Vault through a direct socket." Per session, `setOutboundContext`
binds the tenant/session/fence; outbound handlers then resolve
credentials at request time through an RPC back to the main worker
(`MAIN_MCP.lookupGithubCredential`, `lookupOutboundCredential`). When
a binding is `required`, the handler deletes the sandbox's own
`authorization` header before injecting — and a request with an
invalid runtime binding gets a 403, not a credential. `live` means
literally live: the token is fetched per request, never snapshotted
into the container's scope. The codebase was even stricter about this
than you'd expect — an earlier design snapshotted vault credentials
into a KV blob readable by the agent worker, and it was
[ripped out](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/outbound.ts)
because plaintext in the harness worker's scope still violated
"credentials never leave the main worker."

**Advisory — self-host Node/Docker.** The
[`oma-vault`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/oma-vault/src/index.ts)
sidecar is a mockttp HTTPS proxy with a per-install CA; sandboxes get
`HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS`, requests are matched on
hostname, auth headers injected, forwarded. Shared header-building
logic lives in
[`packages/vault-forward`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/vault-forward/src/index.ts).
This is a real credential boundary for cooperative processes — and it
is bypassable by any process that ignores proxy env vars. We call it
advisory because that's what it is.

**Unsupported — everywhere else, by default.** Every other
managed-runtime driver defaults its descriptor to `{ enforcement:
"unsupported", credentialMode: "snapshot", interceptedProtocols: [] }`
unless the operator injects a certified `CredentialEgressPort`
implementation via driver options. Crucially, the registry
[fails admission loudly](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-driver-registry.ts)
— a profile that *requires* enforced egress on an unsupported driver
throws `ManagedRuntimeCapabilityError`, and the live port's
capabilities are re-verified after creation. You find out at deploy
time, not after an incident.

## Two adjacent traps worth naming

The environment `allowed_hosts` limit is not this feature. It's a
check inside the `web_fetch` tool —
[`assertWebFetchUrlAllowed`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/harness/web-fetch-http.ts)
suffix-matches the request's hostname and re-checks it on every
redirect hop — not a sandbox firewall. `bash`, `curl`, and MCP traffic
aren't governed by it. A general egress allowlist proxy is planned
work
([issue #297](https://github.com/openma-ai/open-managed-agents/issues/297)),
not a claim you should read into today's docs.

And a fair question: if advisory is bypassable, why ship it? Because
most real-world leaks aren't sophisticated adversaries — they're
accidents and lazy exfiltration: an install script that phones home,
a model that does exactly what the injected text says via the most
obvious `curl`. `curl` honors `HTTPS_PROXY`. Advisory stops that whole
class. `enforced` stops the class above it — a sandbox process that is
actively trying to get out. The honest version of the system isn't
"we're secure"; it's a descriptor that tells you which of those two
you have, per driver, in words the runtime checks.

## The bigger point

The pattern doesn't depend on OpenMA. Anthropic's
[Managed Agents](https://platform.claude.com/docs/en/managed-agents/tools)
draw the same line — session state and credentials on the service
side, a replaceable
[code execution environment](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)
on the other. Once you've drawn it, the sandbox can be swapped,
killed, snapshotted, or compromised, and the worst thing inside it is
still just code.

If you want the interface-level version of this post, the docs page is
[egress and credentials](https://docs.openma.ai/concepts/egress-and-credentials/).
The code that draws the line is in
[`packages/runtime-resource-contract`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/runtime-resource-contract)
and [`apps/oma-vault`](https://github.com/openma-ai/open-managed-agents/tree/main/apps/oma-vault)
— and where the docs and the code disagree, the code wins.
