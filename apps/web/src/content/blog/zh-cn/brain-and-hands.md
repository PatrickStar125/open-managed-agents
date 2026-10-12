---
title: "智能体的「大脑」不必住在它的「电脑」里"
description: "Harness 循环、事件日志和凭证是智能体的大脑；沙箱只是它的双手——一个可以替换的执行环境。Open Managed Agents 如何划这条线，以及它带来了什么。"
publishedAt: 2026-10-12
author: openma
tags: ["architecture", "sandbox", "credentials", "control-plane", "design"]
---

当你问一个智能体「跑在哪里」，通常得到的答案只有一个：某个容器、某台虚拟机、某个云端沙箱。但这个答案把两份性质迥异的工作混在了一起——它们的故障模式和归属需求完全不同。

一个智能体其实是两样东西：

1. **一个大脑。** Harness 循环：读取对话、调用模型、解析工具调用、决定下一步做什么。记录一切的事件日志。让智能体能代表你行事的凭证。这些状态是宝贵的——它是整个会话赖以存在的累积上下文。

2. **一双手。** 一个 Linux 环境：`bash` 在这里执行、文件在这里写入。真实的文件系统、真实的进程、真实的网络出口。有用，必要——而且完全可以替换。

大多数智能体框架把这两者粘在一起：运行循环的进程（或容器）和执行工具调用的是同一个。这能跑，直到有一天你想把沙箱迁到别的服务商、定时回收它，或者它在某个周五晚上挂掉、连累会话状态一起陪葬。

[Open Managed Agents](https://github.com/openma-ai/open-managed-agents) 在物理上把两者拆开：大脑住在控制面，双手藏在驱动边界后面。

## 控制面就是大脑

在 Cloudflare 宿主上，每个会话是一个 Durable Object(`apps/agent/src/runtime/session-do.ts`)——每个会话一个单写入者对象，在内嵌的 SQLite 里持有一份只追加的事件日志。每一条输入（用户消息、工具结果）和输出（模型响应、工具调用）都先落进这份日志。

Harness——和模型对话的那个循环——是无状态的。它读事件，产出事件。如果运行它的 worker 在步骤中途崩溃，会话对象会记录一个 `session.error`、回到 idle，下一条消息会拉起一个全新的 harness，从日志重建上下文。大脑里没有任何东西只存在于内存，所以没有任何东西丢失。Node 宿主跑的是同一套只追加日志模型，只是换了存储后端。

凭证和记忆也住在线的这一侧。Vault 以控制面资源的形式保存 API 密钥；Memory store 是由对象存储支撑的持久文件系统，挂载进沙箱的 `/mnt/memory/<store>/` ——沙箱看到的是一个挂载点，但字节属于控制面。

## 沙箱就是双手

需要一台机器的工具调用——`bash`、文件读写——会被派发进一个 `SandboxPort` 后面的、每个会话专属的沙箱。用**哪种**机器是一个配置决定，而不是架构决定。仓库为本地 Docker、Cloudflare Containers、E2B、Daytona、Modal、Fly Sprites、Vercel、Blaxel、BoxLite、BoxRun 和 Superserve 提供了 managed-runtime 驱动，外加一个让 Node 控制面驱动 Cloudflare 沙箱的 bridge 驱动。

每个驱动能做什么，权威的记录是
[`MANAGED_RUNTIME_PROVIDER_CONFORMANCE`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts)
——一张宿主本身会拿去校验的机器可读表。它按驱动逐项说明：suspend/resume 是否可用、工作区状态如何持久(`retained_runtime` 还是 `checkpoint_restore` 策略)、沙箱端口实际能交付什么。把 E2B 换成 Docker，会话毫无察觉：大脑原封不动，只是换了双手。

表里有两点值得注意，因为我们不会夸大它们：

- `runtimeCheckpoints` 对**每一个**驱动都是空列表。OpenMA 今天没有进程内存级的检查点/恢复——可持久的工作区状态是文件系统属性，不是「冻结进程」那种东西。
- 有几个服务商宣称了自己的网络策略或密钥注入能力（Vercel 默认拒绝的防火墙、Blaxel 的代理、Sprites 的网络策略）。那些是通过驱动透出的服务商特性，不是 OpenMA 的普适保证。

## 凭证属于大脑，不属于双手

这是这条分界线最锋利的一面。沙箱按设计就是执行模型生成的代码的地方。住在里面的任何密钥，距离被一次提示注入骗到 `curl` 出去只差一步。

所以 OpenMA 把凭证留在控制面，并把它们绑定到出站流量上，而不是交出去。契约是
[`CredentialEgressPort`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/credential-egress.ts):
`prepare` 一个短生命周期的绑定，`attach` 到沙箱租约，工作结束时 `revoke` 再 `release`。绑定被明确设计为瞬态——这个类型的文档注释写道：「绝不能被持久化到沙箱租约或检查点里」。在 Cloudflare 驱动上，这是对 HTTP/HTTPS 的 `enforced` 出站、使用实时凭证：代理在匹配的出站请求上注入认证头，原始令牌从不进入沙箱。

接下来这部分必须说得精确，因为「凭证从不进入沙箱」这句话的强度，取决于背后的执行力度：

- **Cloudflare:**`enforcement: "enforced"`、`credentialMode: "live"`、`interceptedProtocols: ["http", "https"]` ——今天唯一声明了 enforced 出站的驱动。
- **其他所有 managed-runtime 驱动**，其描述符默认是
  `{ enforcement: "unsupported", credentialMode: "snapshot", interceptedProtocols: [] }`,
  除非运维者通过驱动 options 注入一个经过认证的 `CredentialEgressPort` 实现。如果某个 profile *要求* enforced 出站却落在这种驱动上，准入会大声失败，而不是悄悄降级。
- **自托管 Node/Docker:**`oma-vault` 边车通过一个 `HTTPS_PROXY` 环境变量注入凭证——对合作的沙箱来说这是一道真实的凭证边界，但它是*建议性*的。一个无视代理环境变量的进程可以绕过它。

环境 `allowed_hosts` 网络限制的范围还要更窄：它只是 `web_fetch` 工具内部的一次检查——[`assertWebFetchUrlAllowed`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/harness/web-fetch-http.ts) 对请求主机名做后缀匹配，并在每一次重定向跳转上重新检查——不是沙箱防火墙。沙箱里的 `bash`/`curl` 不受它约束。通用的出站白名单代理在路线图上（[issue #297](https://github.com/openma-ai/open-managed-agents/issues/297)），是计划中的工作，不是既成事实。

这些并不削弱这套架构，反而让它的诚实版本更有力：*接口*在任何地方都把凭证放在大脑这一侧，而执行深度是逐驱动的事实——系统把它大声说出来，而不是装作没有。

## 这条分界线真正换来了什么

**服务商可移植性。** 沙箱可换，因为智能体「知道」的东西一样都不在里面。Managed runtime 在生命周期上各有差异（suspend/resume、快照持久化）——一致性表让这些差异可读，而不是变成意外。

**恢复崩溃就是重放。** 沙箱死了？事件日志根本没注意到——它住在控制面。工作区持久化是驱动的问题(`checkpoint_restore` 或 `retained_runtime`)，最坏情况只是重建文件系统，永远轮不到重建对话。Harness 死了？恢复就是重读日志——这本来就是 harness 每一步都在做的事。

**爆炸半径止步于双手。** 在有强制执行的地方（今天是 Cloudflare），一个被攻破或者仅仅是被骗到的智能体，也无法泄露一个它从未持有过的凭证。在还没有强制执行的地方，描述符写着 `unsupported`，你按此设计。

**增长的空间。** 沙箱预热池（warm pool）、`fork`，以及通用出站白名单代理，都是计划中的工作，落在双手这一侧的边界*之内*——大脑、事件模型和公开 API 都不用动。

这个模式并不新——Anthropic 自己的
[Managed Agents](https://platform.claude.com/docs/en/managed-agents/tools)
就把 session 资源和
[代码执行环境](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/code-execution-tool)
分开，他们的
[memory 契约](https://platform.claude.com/docs/en/managed-agents/memory)
把持久状态放在服务侧。Open Managed Agents 是这个赌注的开源版本：你的大脑、你的凭证、你的事件日志——在你自己的基础设施上，配上这周最适合这活儿的那双手。

画出这条线的代码在
[`packages/managed-runtime-host`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/managed-runtime-host)
和
[`packages/runtime-resource-contract`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/runtime-resource-contract);
逐驱动的细节在[文档站]（https://docs.openma.ai）上。如果一致性表和文档不一致，以表为准——那才是运行时真正校验的东西。
