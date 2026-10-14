---
title: "凭证永远不该进入沙箱"
description: "一个能读到 API token 的沙箱就是一颗提示注入定时炸弹。解法是出站凭证代理：在网络层注入凭证——以及 OpenMA 对「哪里强制、哪里只是建议、哪里还没有」的诚实交代。"
publishedAt: 2026-10-12
author: openma
tags: ["security", "credentials", "sandbox", "egress", "architecture"]
---

每个智能体沙箱都在运行模型生成的代码，而代码处理的输入并不是模型自己选的：它抓取的网页、读过的 issue、总结过的邮件。Anthropic 自己的文档把这叫做[间接提示注入](https://docs.anthropic.com/en/docs/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)——藏在第三方内容里的对抗性指令——他们的 computer-use 指南对后果说得很直白：[让 Claude 与敏感数据和操作隔离](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/computer-use-tool)，以规避提示注入风险。

再看看大多数智能体技术栈是怎么发凭证的：环境变量里的 `GITHUB_TOKEN`、写着活 registry key 的 `.npmrc`、挂载进去的 `~/.aws/credentials`。每一种都是在赌——赌模型加上它读过的每一字节不可信内容，永远不会决定去执行 `env | grep TOKEN` 再 `curl` 到别处。这不是威胁模型，这是倒计时。

## 这个模式：沙箱拿到的是句柄，不是秘密

替代方案是出站凭证代理（egress credential proxy），形态很简单：

1. 凭证保存在控制面的 vault 里，沙箱没有任何读取路径。
2. 沙箱的出站流量必须经过一道它绕不开的解析器。
3. 解析器按请求的主机名匹配凭证，剥掉沙箱自己附带的任何 `Authorization` 头，注入真正的凭证，然后转发。
4. 沙箱内部无秘可偷——`env` 是干净的，不存在任何凭证文件，手工塞一个 `Authorization: Bearer hunter2` 也会在出站途中被删掉。

注意这带来了哪些替代方案给不了的东西。环境变量和挂载的密钥文件对沙箱里的*任何*进程都可读；SDK 封装只在模型肯用它时才有用。但每一条外泄路径——`curl`、`git push`、恶意包的 install 脚本——都必须穿过网络。把凭证边界放在那里，就只有一扇门，门口有守卫。

## 契约：绑定，而不是 token

在 OpenMA 里，这套机制的接口是
[`CredentialEgressPort`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/credential-egress.ts)。
生命周期是 `prepare` → `attach` → `revoke` → `release`，而在这些调用之间流转的是一个 `CredentialEgressBinding`：一个不透明的、非秘密的 id，它自己的文档注释写着「绝不能被持久化到沙箱租约或检查点里」。

一个绑定的作用域比「这个沙箱可以用 GitHub token」窄得多。它对照一个
[`RuntimeResourceScope`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/scope.ts)
来解析——workspace、environment、session、work item——外加一个携带 `ownerId` 和单调递增 `generation` 的
[fence](https://github.com/openma-ai/open-managed-agents/blob/main/packages/runtime-resource-contract/src/fence.ts)，
所以绑定不可能活得比它为之准备的工作更久。`revoke` 带一个原因（`completed`、`failed`、`lease_lost`）；`release` 是其后的幂等清理。

这个端口还会通过 `capabilities()` 事先声明自己的强度：`enforcement` 等级（`enforced` / `advisory` / `unsupported`）、`credentialMode`（`live` / `snapshot`），以及它实际覆盖的 `interceptedProtocols`（`http` / `https` / `tcp`）。

## OpenMA 今天到底在哪里强制

大多数项目会跳过这部分，我们不跳：「凭证从不进入沙箱」这句话的强度取决于背后的执行力度，而执行力度是逐驱动的事实。

**Enforced——仅 Cloudflare。**
[`managed-runtime-cloudflare`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-cloudflare/src/cloudflare.ts)
驱动是唯一声明了 `enforcement: "enforced"`、`credentialMode: "live"`、`interceptedProtocols: ["http", "https"]` 的。机制是具体的：`OmaSandbox`
（[`apps/agent/src/oma-sandbox.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/oma-sandbox.ts)）
设置了 `interceptHttps = true` 和 `enableInternet = false`——代码注释值得原文引用：「Every HTTP(S) request must traverse a registered handler. This blocks a compromised harness from bypassing Vault through a direct socket.」（每一个 HTTP(S) 请求都必须经过已注册的 handler，这阻止被攻陷的 harness 通过裸 socket 绕过 Vault。）每个会话由 `setOutboundContext` 绑定 tenant/session/fence；出站 handler 随后在请求时刻通过 RPC 回到 main worker 解析凭证（`MAIN_MCP.lookupGithubCredential`、`lookupOutboundCredential`）。当绑定为 `required` 时，handler 会先删掉沙箱自带的 `authorization` 头再注入——携带无效运行时绑定的请求得到的是 403，而不是凭证。`live` 就是字面意义上的实时：token 按请求获取，从不快照进容器作用域。这套代码在这个问题上甚至比你预期更较真——早期设计曾把 vault 凭证快照进一个 agent worker 可读的 KV blob，后来[被整个拆掉](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/outbound.ts)，因为明文出现在 harness worker 的作用域里仍然违反「凭证永不离开 main worker」。

**Advisory——自托管 Node/Docker。**
[`oma-vault`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/oma-vault/src/index.ts)
边车是一个 mockttp HTTPS 代理，配每次安装重新生成的 CA；沙箱拿到 `HTTPS_PROXY` 和 `NODE_EXTRA_CA_CERTS`，请求按主机名匹配、注入认证头、转发。共享的认证头构造逻辑在
[`packages/vault-forward`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/vault-forward/src/index.ts)。
对合作的进程来说这是一道真实的凭证边界——而对任何无视代理环境变量的进程来说它可以被绕过。我们叫它 advisory（建议性），因为它就是。

**Unsupported——其他所有驱动的默认值。** 其他每个 managed-runtime 驱动的描述符默认都是 `{ enforcement: "unsupported", credentialMode: "snapshot", interceptedProtocols: [] }`，除非运维者通过驱动 options 注入一个经过认证的 `CredentialEgressPort` 实现。关键在于，注册表会[让准入大声失败](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-driver-registry.ts)——一个*要求* enforced 出站的 profile 落在 unsupported 驱动上会抛 `ManagedRuntimeCapabilityError`，而且创建之后还会重新校验实际端口的 capabilities。你会在部署时发现问题，而不是在事故之后。

## 两个值得点名的邻近陷阱

环境的 `allowed_hosts` 限制不是这个特性。它只是 `web_fetch` 工具内部的一次检查——
[`assertWebFetchUrlAllowed`](https://github.com/openma-ai/open-managed-agents/blob/main/apps/agent/src/harness/web-fetch-http.ts)
对请求的主机名做后缀匹配，并在每一次重定向跳转上重新检查——不是沙箱防火墙。`bash`、`curl` 和 MCP 流量都不受它约束。通用的出站白名单代理是计划中的工作（[issue #297](https://github.com/openma-ai/open-managed-agents/issues/297)），不是你应该从今天文档里读出来的既成事实。

还有一个合理的问题：advisory 既然能被绕过，为什么还要发布它？因为真实世界里的泄露大多数不是高明的攻击者——是事故和偷懒的外泄：一个往家里打电话的 install 脚本、一个原样照做注入文本里最显眼那条 `curl` 命令的模型。而 `curl` 遵守 `HTTPS_PROXY`。Advisory 能挡住这整整一类；`enforced` 挡的是更高的一类——一个主动想逃出去的沙箱进程。这套系统诚实的版本不是「我们很安全」，而是一张逐驱动告诉你「你拥有的是哪一类」的描述符——用的是运行时会去校验的措辞。

## 更重要的一点

这个模式不依赖 OpenMA。Anthropic 的
[Managed Agents](https://platform.claude.com/docs/en/managed-agents/tools)
画的是同一条线——会话状态和凭证在服务端，一个可替换的
[code execution 环境](https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool)
在另一边。一旦线画好了，沙箱可以被换掉、被杀掉、被快照、被攻陷，而里面最危险的东西仍然只是代码。

想要这篇文章的接口级版本，文档页是
[egress and credentials](https://docs.openma.ai/concepts/egress-and-credentials/)。
画这条线的代码在
[`packages/runtime-resource-contract`](https://github.com/openma-ai/open-managed-agents/tree/main/packages/runtime-resource-contract)
和 [`apps/oma-vault`](https://github.com/openma-ai/open-managed-agents/tree/main/apps/oma-vault)——文档和代码不一致的地方，以代码为准。
