---
title: "Claude Managed Agents 跑在 GKE 上:一个 Work 条目,一个 SandboxClaim"
description: "OpenMA 的 GKE dispatch port 如何把一条「已预留但未 ACK」的 Work 变成一只绑定好的热备 pod:SandboxClaim 的 get-or-create、过期 claim 回收、有界重派发,以及为什么 ACK 由 pod 内的 worker 拥有。"
publishedAt: 2026-10-12
author: openma
tags: ["kubernetes", "gke", "sandbox", "claude-managed-agents", "dispatch", "control-plane"]
draft: false
---

在 Claude Managed Agents 协议里,Environment 就是一个 Work 队列。Session 产生 Work,总得有什么东西把每条 Work 变成一个正在运行的沙箱。在大多数服务商那里,这个「东西」是一次 SDK 调用——E2B 上是 `Sandbox.create()`,Modal 上是 `modal.Sandbox.from_name`。而在 Kubernetes 上,诚实一点的答案更奇怪、也更好:你不是创建一个 pod,而是向一个已经预热好的 pod 池提交一份**认领(claim)**。

这篇文章走一遍
[`packages/environment-dispatch-gke`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/environment-dispatch-gke/src/index.ts)
里的 GKE 绑定——183 行,一个工厂函数——以及让同一个 OpenMA 控制面不需要定制沙箱 SDK 就能把会话跑在 GKE 上的那条协议边界。

## 策略:poll,但不 ACK

Anthropic 的
[自托管沙箱契约](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
说,worker 可以持续轮询 Work,也可以由 webhook 唤醒。GKE 绑定实现的是一个更锐利的变体,在它的 descriptor 里声明为
`strategy: "poll_unacked_then_dispatch"`。

Dispatcher——
[`packages/managed-runtime-host`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/dispatched-environment-worker.ts)
里的 `createDispatchedManagedEnvironmentWorker`——以 `block_ms: null` 轮询 Work。这个 poll 为交付*预留*了 Work,但刻意**不** ACK。如果 dispatch 失败,代码自己的注释写明了规则:*「不 ACK,也不 stop。服务端预留超时是让这条 Work 能被继任者拿到的权威机制。」*

ACK 属于沙箱。一旦 dispatcher 把 Work 身份交给 pod,pod 内的 `ant beta:worker run` 就接管 ACK、heartbeat 和 stop——正式租约由沙箱内部的 worker 建立,而不是由沙箱外部的控制循环。这就是 worker 协议边界的全部内容,也是让控制面与服务商无关的原因:dispatcher 的职责到把 `sessionId` + `workId` 送达一个 `dispatchUrl` 为止。

## Port 的形状

`createManagedEnvironmentWorkDispatchPort(factoryOptions)` 返回一个 `ManagedEnvironmentWorkDispatchPort`——只有两个方法的对象(`descriptor()`、`dispatch()`)——接受这些选项:

- **`controlPlane`** —— 一个 `GkeSandboxClaimControlPlanePort`:四个方法(`listSessionClaims`、`deleteClaim`、`createClaim`、`postSession`)。这是一个结构性边界。文件的 docstring 写得很明确:它可以是*「一个 Kubernetes SDK 适配器,或者一个 OpenMA 自有的集群内 driver 服务。这里不泄漏任何 Kubernetes 依赖。」* 这个包本身不引入 client-go、不引入 `@kubernetes/client-node`——什么都不引入。
- **`workControl`** —— 一个方法,`stop({environmentId, workId, force})`。只用于一件事:杀死中毒的 Work。
- **`namespace`、`template`、`warmPool`** —— Kubernetes namespace、`SandboxTemplate` 名,以及 claim 绑定的 `SandboxWarmPool` 名。
- **`readyTimeoutMs`**(默认 `120_000`)—— `createClaim` 等待绑定 pod 上报 `dispatchUrl` 的时长。
- **`maxRedispatch`**(默认 `3`)—— 每条 Work 的重试预算,通过 claim 的 label 计数。

[`environment-worker-installation.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/environment-worker-installation.ts)
里的 `createManagedEnvironmentWorkerInstallation({mode: "provider_dispatch", ...})` 动态 import 这个适配器,校验 descriptor 的 strategy 确实是 `poll_unacked_then_dispatch`,再把它包进 poll/webhook 的 drain 循环。服务商特定的字段留在 `factoryOptions` 里;port 的形状不为 GKE 折弯。

## `dispatch()` 实际做了什么

拿到一条预留的 Work 后,`dispatch()` 的函数体是一条五步流水线:

**1. 只收 Session 的门禁。** `work.data.type !== "session"` 直接抛错。(上游的 drain 循环已经会强制 stop 非 Session 的 Work;这是纵深防御。)

**2. 回收过期 claim。** `listSessionClaims({namespace, environmentId, sessionId})` 返回这个 session 留下的所有 `SandboxClaim`。每个 claim 携带一个 `dispatchCount`。`workId` 与*当前* Work 相同的 claim 是幸存者——上一次 dispatch 尝试可能还活着——所以保留它并记住它的计数。其余所有 claim 都属于已死的 Work,删除。`dispatchCount` 不是整数的 claim 会让整个 dispatch 失败:账目腐败比一次重试更糟糕。

**3. 计算代数。** `dispatchCount = survivingDispatchCount ?? previousDispatchCount + 1`。重派发同一条 Work 复用它幸存 claim 的代数;失败后派发则递增。如果结果超过 `maxRedispatch`,这条 Work 就是毒丸——`workControl.stop({force: true})` 杀掉它,不再创建 claim。有界重派发是一个 label 算术决定,不是一个定时器。

**4. get-or-create claim。** 调用 `createClaim`,`idempotencyKey: "${work.id}:${dispatchCount}"`,加上 template、warm pool 名和四个 label:

```ts
labels: {
  "openma.environment-id": input.work.environment_id,
  "openma.session-id": sessionId,
  "openma.work-id": input.work.id,
  "openma.dispatch-count": String(dispatchCount),
}
```

port 上的契约要求这次调用*必须原子地按这个 key get-or-create 一个 SandboxClaim*。两个争抢同一条预留的 dispatcher 落在同一个 claim 上,而不是重复预订一只热备 pod。这些 label 同时也是第 2 步里回收器的索引——dispatcher 以后需要知道的关于 claim 的一切,现在就写在 claim 上。

**5. 递交身份。** `postSession({dispatchUrl, sessionId, workId})` 只把两个标识发给绑定 pod。不是整个 Work 对象,也不是 environment key——测试套件专门把 fixture key 命名为 `"must-not-enter-claim"` 来钉死这一点。Pod 里的 worker 接着用 Work 协议自己去申领正式租约。

如果 `postSession` 失败,清理取决于 `bound.created`:这次调用创建的 claim 会被删除(尽力而为);幂等重放返回的既有 claim 则原样保留——删掉别的 dispatcher 的活绑定,比留下一次重试更糟糕。

## warm pool 是真的——而且是 Kubernetes 的

`SandboxClaim` 来自
[`kubernetes-sigs/agent-sandbox`](https://github.com/kubernetes-sigs/agent-sandbox)——Kubernetes
SIG 的沙箱控制器:`SandboxWarmPool` 按 `SandboxTemplate` 预热 pod,`SandboxClaim` 从池子里领养一只。`factoryOptions` 里的 `warmPool` 选项就是对那个特性的字面绑定——claim 从池中领出一只 gVisor 隔离的、已经在运行的 pod,这也是为什么 `readyTimeoutMs` 以秒计,而不是冷启动拉镜像所需的分钟数。

一句诚实的边界说明:这是 agent-sandbox 的 warm pool,不是一个普适的 OpenMA warm-pool 抽象。服务商中立的池化 API 仍是计划中的工作;已合并的是这个 GKE 专属绑定,选项名没有假装成别的什么。

## 服务商拥有什么

按
[服务商审计](https://github.com/openma-ai/open-managed-agents/blob/main/docs/claude-managed-agents-sandbox-provider-audit.md),
GKE 拓扑给你的是临时工作区加一个只写出的 GCS FUSE 挂载、default-deny 的 `NetworkPolicy`/FQDN 出站规则,以及凭证走 Secret Manager。这些是通过 claim 路径交付的服务商特性——conformance 表里到处适用的那条告诫在这里同样适用:驱动没声明的能力(enforced 凭证出站、进程内存 checkpoint/restore)就是没有,`runtimeCheckpoints` 对包括本驱动在内的每个驱动都是空的。Work 的恢复依赖预留超时和 `dispatch-count` label,不依赖 pod 快照。

## 这条边界为什么重要

有意思的不是 Kubernetes 能跑智能体沙箱,而是控制面需要新学的东西少得可怜。CMA worker 协议本来就有对的接缝:一个不等于 ACK 的预留 poll、一个只运身份不运状态的 `dispatchUrl`,以及一个从首次 heartbeat 到 stop 都拥有租约的 pod 内 worker。GKE dispatcher 卡进这些接缝,只引入一个新动词——claim,而不是 create——同一段为 Cloudflare dispatch port 排空 Work 的代码也为 GKE 排空,因为两者都响应同一个 `ManagedEnvironmentWorkDispatchPort`。

代码小到可以坐下来一次读完:
[`packages/environment-dispatch-gke`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/environment-dispatch-gke)
讲 claim 生命周期,
[`dispatched-environment-worker.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/dispatched-environment-worker.ts)
讲 drain 循环,
[managed-runtime-host 文档](https://docs.openma.ai/self-host/managed-runtime-host/)
讲各安装模式怎么组装。这套设计镜像的参考拓扑——dispatcher、`SandboxClaim`、绑定热备 pod——是 Google 的
[anthropic-agent-sandbox 示例](https://github.com/GoogleCloudPlatform/kubernetes-engine-samples/tree/8708c6c6bd28dc5d8e3b642642e62115c049d6fd/ai-ml/anthropic-agent-sandbox),
在服务商审计里以固定 commit 记录。
