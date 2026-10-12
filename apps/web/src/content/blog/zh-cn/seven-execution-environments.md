---
title: "2026 年智能体执行环境的七个类别"
description: "本地 Docker、托管 microVM、沙箱服务、Serverless 计算、智能体平台、边缘容器和 Kubernetes claim——每类智能体沙箱到底给你什么,对照 OpenMA 的 managed-runtime 驱动及其 conformance 表逐一说清。"
publishedAt: 2026-10-12
author: openma
tags: ["sandbox", "execution-environment", "providers", "architecture", "survey"]
draft: false
---

每个要跑代码的智能体都需要一个「跑代码的地方」。到 2026 年,这个「地方」已经分化成至少七个截然不同的执行环境类别——安全边界不同、生命周期不同、对「谁在运营控制面」的回答也不同。

这是一篇综述,不是排行榜。每个类别我们都会点出真实的服务商、这种环境换来和放弃了什么,以及对应 Open Managed Agents 的哪个驱动。关于 OpenMA 驱动的论断全部出自
[`MANAGED_RUNTIME_PROVIDER_CONFORMANCE`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts)——一张机器可读、宿主运行时会真正校验的表,不是营销文案——以及
[`apps/main-node/src/sandbox-provider.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/main-node/src/sandbox-provider.ts)
里的服务商选择映射。表里说没有的能力,我们就说没有。

## 1. 本地进程 / Docker 容器

**服务商:** 你自己的 Docker 主机;以及像 [BoxLite](https://docs.boxlite.ai/) 这样以库的形式在你机器上跑 microVM 的嵌入式运行时。

零外部依赖的选项:一个容器(共享内核的隔离),或者一个嵌入式 microVM(独立内核),跑在你已有的硬件上。OpenMA 的 `node-docker` 驱动就属于这一类。conformance 表显示它的 `suspendResume` 为 `unsupported`——容器没法冻结——但它的工作区持久性是 `durable`,走的是 `checkpoint_restore` 策略:由宿主在容器之外做文件系统快照,而不是指望容器自己持久化。`litebox` 驱动也在这一类:嵌入式 BoxLite microVM,`suspendResume` 为 `supported`,工作区是宿主机本地的 `retained_runtime`、持久性 `best_effort`——保留的 box 可以继续用,但不会被宣传成可移植的检查点。

控制面归你,爆炸半径也归你:容器共享你的内核,所以这一类是用隔离强度换运维简单。

## 2. MicroVM 开发机

**服务商:** [E2B](https://e2b.dev/docs)——其[开源运行时](https://github.com/e2b-dev/runtime)给每个沙箱一个 [Firecracker](https://firecracker-microvm.github.io/) microVM——以及 [BoxRun](https://docs.boxlite.ai/),BoxLite 之上的 REST/CLI 管理层。

硬件虚拟化级别的隔离,启动快到可以当开发机用。E2B 的沙箱是从快照恢复的:暂停时把内存和磁盘的增量写入对象存储,恢复时按需取页。OpenMA 的 `e2b` 驱动报告 `suspendResume: "supported"`,并带有 `provider_suspend_resume` 和 `provider_memory_snapshot` 能力;工作区为 `durable`,走 `retained_runtime` + `checkpoint_restore`。`boxrun` 通过官方 REST 客户端接入同一套 microVM 底座:`suspendResume` 支持,工作区 `best_effort`——保留的存储留在服务商侧,除非额外接一个外部 checkpoint Port。

控制面由服务商运营(或你自托管);你得到真正的 VM 隔离,却不必自己养 hypervisor。

## 3. 沙箱即服务

**服务商:** [Daytona](https://www.daytona.io/docs)、[Superserve](https://docs.superserve.ai/quickstart)。

以 API 为先的服务,产品本身就是沙箱:稳定身份、ownership 标签、stop/start、快照、保留策略。OpenMA 的 `daytona` 驱动完整跟随这套生命周期——stable-name get-or-create、可移植的文件系统快照、按活动续约的租约——`suspendResume` 支持,工作区 `durable`。`superserve` 在生命周期上走得更远:pause/resume 同时保留*进程和文件*,带 deny-by-default 网络策略和服务商侧的 secret 代理,出口流量有审计。

控制面是服务商的。你放弃的是控制深度——保留语义由对方定义。conformance 表对此如实记录:服务商侧的保留状态不会被升格为可移植的 OpenMA checkpoint。

## 4. Serverless / 临时计算沙箱

**服务商:** [Modal](https://modal.com/docs/guide/sandbox)、[Fly Sprites](https://docs.sprites.dev/)、[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox)。

随工作负载出现、用完即散的计算——但底下垫着持久状态,这正是 2026 年的临时沙箱和 2020 年那批的区别。Modal 驱动把一个预先建好的 Volume v2 Session 子路径挂到 `/workspace`,计算过期后在这块持久卷上重建。Sprites 保留持久 ext4 文件系统,有流量时自动 pause/wake。Vercel 保留持久命名沙箱,带自动文件系统快照恢复,前面立着 deny-by-default 防火墙——但没有流式 stdin,且只跑 `ama_worker` 通道。三者都报告 `suspendResume: "supported"`。

一切由服务商运营;你用常驻可用性换来 scale-to-zero 的经济性和真正持久的工作区。

## 5. 自带沙箱的全栈智能体平台

**服务商:** [Blaxel](https://docs.blaxel.ai/Sandboxes/Overview)。

这里沙箱只是平台的一项功能——平台还托管智能体、MCP server 和模型网关。Blaxel 的 perpetual sandbox 可以对保留文件系统做 archive/unarchive,暴露命名的全双工进程,自带 proxy 防火墙、secret 注入和可选持久卷。OpenMA 的 `blaxel` 驱动把这些都映射了——`suspendResume` 支持——但工作区持久性只评 `best_effort`:archive/unarchive 生命周期是服务商侧保留,不是可移植检查点。

平台运营控制面,而且想连你的智能体一起运营。换来的是开箱即成的整合;放弃的是:沙箱边界从此等于平台边界。

## 6. 边缘容器

**服务商:** [Cloudflare Workers Containers](https://developers.cloudflare.com/containers/)(经 Sandbox SDK);以及让 Node 控制面连过去的 `cloudflare-bridge` 驱动。

调度到边缘网络上的容器,由 Durable Object 驱动。容器级隔离(共享内核),不是 microVM——`cloudflare` 和 `cloudflare-bridge` 的 `suspendResume` 都是 `unsupported`。工作区 `durable`,走 `checkpoint_restore`(备份快照/恢复,R2 输出挂载)。conformance 表写明两条限制:bridge 只跑 `ama_worker` 通道;Node 侧驱动连接的是由运维方部署的官方 bridge——OpenMA 保留 Work 和 fencing 权限。

这一类有一样今天其他驱动都没有的东西:**强制执行的凭证出口**。`cloudflare` 驱动在其
[`CredentialEgressPort`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/credential-egress.ts)
中声明 `enforcement: "enforced"`、`credentialMode: "live"`、覆盖 HTTP/HTTPS——这是唯一一个。其余所有 managed-runtime 驱动的描述符默认都是 `enforcement: "unsupported"`,除非运维方通过 driver options 注入经过认证的实现。

## 7. Kubernetes 原生 claim

**服务商:** [Kubernetes agent-sandbox 项目](https://github.com/kubernetes-sigs/agent-sandbox)(SIG Apps)——`Sandbox` CRD、`SandboxTemplate`、`SandboxClaim`、`SandboxWarmPool`——OpenMA 在 GKE 上的绑定是
[`environment-dispatch-gke`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/environment-dispatch-gke/src/index.ts)。

不是对沙箱服务的一次 API 调用,而是对集群状态的一份声明式 claim。GKE dispatch port 会先清掉该 session 的陈旧 `SandboxClaim`,再以幂等方式 get-or-create 一个 claim,绑定到指定的 `warmPool` 和 `template`,然后只把 session/work id POST 到绑定 pod 的 dispatch URL;ACK、心跳和停止由 pod 内的 worker 负责。churn 超过 `maxRedispatch` 的 Work 会被强制停止。

这是**今天唯一一个 warm pool 作为真实配置存在的地方**——`warmPool` 是必填项,绑定到真实的 K8s `SandboxWarmPool`。它也被刻意留在 conformance 注册表之外:它是 work-dispatch port,不是 managed-runtime 驱动。你的集群、你的控制面、你的 CRD。

## 诚实的账本

| 驱动 | 通道 | suspendResume | 工作区持久性 |
|---|---|---|---|
| node-docker | `ama_worker`, `openma_supervised` | unsupported | durable(`checkpoint_restore`) |
| cloudflare | `ama_worker`, `openma_supervised` | unsupported | durable(`checkpoint_restore`) |
| cloudflare-bridge | 仅 `ama_worker` | unsupported | durable(`checkpoint_restore`) |
| e2b | `ama_worker`, `openma_supervised` | supported | durable |
| daytona | `ama_worker`, `openma_supervised` | supported | durable |
| litebox | `ama_worker`, `openma_supervised` | supported | best_effort |
| boxrun | `ama_worker`, `openma_supervised` | supported | best_effort |
| blaxel | `ama_worker`, `openma_supervised` | supported | best_effort |
| sprites | `ama_worker`, `openma_supervised` | supported | durable |
| vercel | 仅 `ama_worker` | supported | durable |
| modal | `ama_worker`, `openma_supervised` | supported | durable |
| superserve | `ama_worker`, `openma_supervised` | supported | durable |

三个每篇综述都该写、却常被漏掉的事实:

- `runtimeCheckpoints` 对**每个**驱动都是空列表。OpenMA 今天不存在任何进程内存 checkpoint/restore——持久状态在哪里都是文件系统属性。
- `enforcement: "enforced"` 的凭证出口只存在于 Cloudflare 驱动。在 Node/Docker 上,`oma-vault` 环境变量代理是 advisory 级别——对守规矩的进程是真的边界,对无视 proxy 环境变量的进程则可以绕行。
- 环境 `allowed_hosts` 是 `web_fetch` 工具内部的一个检查——[`assertWebFetchUrlAllowed`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/harness/web-fetch-http.ts) 对请求的主机做后缀匹配,并在每次重定向跳转时重新检查——它不是沙箱防火墙。`bash`/`curl`、`web_search` 和 MCP 调用都不受它约束;通用出口 allowlist 代理仍在规划中([issue #297](https://github.com/openma-ai/open-managed-agents/issues/297))。

## warm pool 或 fork 能补上什么

OpenMA 层面的通用 warm pool 和沙箱 `fork` 在规划里,还没发布——上面 GKE 的 `warmPool` 绑定是现存的那个例外。两者都落在架构的同一侧:驱动边界后面预热或分叉出来的*执行环境*;而会话的事件日志、凭证和 fencing 留在控制面。这正是把 conformance 表做成机器可读的意义:当某一类「双手」学会新把戏时,改的是那个驱动对应的行——大脑不需要动。

每个驱动的完整契约见 [managed-runtime 文档](https://docs.openma.ai/self-host/managed-runtime-host/);adapter 契约见 [sandbox backend](https://docs.openma.ai/self-host/sandbox-backend/)。先按威胁模型选类别,再选服务商。
