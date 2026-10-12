---
title: "E2B vs Daytona vs Modal vs Fly Sprites:OpenMA 一致性套件下的四方对比"
description: "一次直接读自 OpenMA 机器可读一致性表的能力对比——生命周期、工作区持久性、出口策略,以及每个驱动里「supported」到底意味着什么。"
publishedAt: 2026-10-12
author: openma
tags: ["sandbox", "e2b", "daytona", "modal", "sprites", "conformance", "architecture"]
---

大多数「E2B vs X vs Y」文章都用基准测试图表作答:冷启动毫秒数、p99 恢复延迟、一张排行榜。这篇文章读的是另一份工件——每个沙箱驱动向 OpenMA 宿主申报的一致性 profile,即
[`MANAGED_RUNTIME_PROVIDER_CONFORMANCE`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts)。

> **这些数字从哪来。** 下文的一切都是从仓库里的一致性描述符和驱动源码里读出来的——不是实测跑出来的。我们没有测量冷启动延迟,没有对这些服务商跑任何工作负载,也不宣称任何通过率。当表里某一栏写着 `supported`,意思是驱动在代码里回答了「supported」,而宿主会拿这份代码来校验;这个答案背后的机制就在对应的驱动包里。如果你想要延迟数字,得自己跑一套测试——这张表告诉你*该测什么*,而不是它有多快。

这个框架比听起来更重要。一致性 profile 是控制面和沙箱服务商之间诚实的接口:在宿主允许会话的工具碰到它之前,驱动必须回答关于自身的一组问题——你能 suspend 吗?工作区能活下来吗?lease 归谁所有?OpenMA 的版本就是一张带类型的表,而 `requireManagedRuntimeProvider` 拒绝把一个裸的沙箱适配器悄悄提升为 managed runtime——没有这张表就不行。

表里有四家服务商拿到了完整的 managed-runtime 资格:[E2B](https://e2b.dev/docs)、[Daytona](https://www.daytona.io/docs)、[Modal](https://modal.com/docs/guide/sandbox) 和 [Fly Sprites](https://docs.sprites.dev/)——目前一个自托管的 OpenMA 控制面能驱动的四个外部沙箱云。下面是它们各自的真实回答。

## 表格原文

| 能力 | E2B | Daytona | Modal | Sprites |
|---|---|---|---|---|
| `driverLanes` | `ama_worker`、`openma_supervised` | 同左 | 同左 | 同左 |
| `lifecycle.lease` | `host-fenced` | `host-fenced` | `host-fenced` | `host-fenced` |
| `lifecycle.suspendResume` | `supported` | `supported` | `supported` | `supported` |
| `lifecycle.hardTerminate` | `supported` | `supported` | `supported` | `supported` |
| `lifecycle.orphanReap` | `host-managed` | `host-managed` | `host-managed` | `host-managed` |
| `workspace.strategies` | `retained_runtime`、`checkpoint_restore` | `retained_runtime`、`checkpoint_restore` | `retained_runtime` | `retained_runtime` |
| `workspace.durability` | `durable` | `durable` | `durable` | `durable` |
| `outputs` | `final_collect`、`durable` | 同左 | 同左 | 同左 |
| `runtimeCheckpoints` | `[]` | `[]` | `[]` | `[]` |

粗看这张表整齐得可疑——四家服务商,一模一样的行。有意思的部分在于每个驱动*用什么机制*撑起了同样的答案,而这藏在 `sandboxPortFacts` 和驱动代码里。

## 同样的答案,不同的机制

**E2B**(`packages/managed-runtime-e2b`、`packages/sandbox-adapter-e2b`)把每个会话跑成一个 Firecracker microVM。它的生命周期是四家中最「快照型」的:suspend 调用 `sandbox.pause()`,resume 调用 `sandbox.connect()`,lease 续期是 `sandbox.setTimeout()`,可移植工作区检查点是 `sandbox.createSnapshot()` ——一个 provider 内存快照,返回的 snapshot ID 就是 `checkpointId`。managed 驱动配置了 `retainedSuspendKind: "memory"` 和 `portableCheckpointKind: "memory"`,于是 E2B 的整 VM 快照直接兼任工作区恢复点。它的沙箱事实:`provider_suspend_resume`、`provider_memory_snapshot`、`duplex_process`。

**Daytona**(`packages/managed-runtime-daytona`)玩的是稳定身份这一套。沙箱命名为 `openma-<sessionId>`,带 ownership label(`openma.environment_id`、`openma.session_id`、`openma.mode`),驱动会*拒绝挂接*label 不匹配的任何沙箱——然后在并发 create 返回 409 时干净地恢复。Suspend 是一个文件系统故事:`stop()` 保留文件系统,`start()` 恢复它,`createSnapshot()` 产出可移植的文件系统检查点——四家中唯一在可用事实里列出 `portable_filesystem_snapshot` 的服务商。Lease 续期是 `refreshActivity`,搭的是 Daytona 自动停止计时器的便车。

**Modal**(`packages/managed-runtime-modal`)是「构造上即持久」,而不是靠快照。驱动把一个预先创建好的 Volume v2 挂载到 `/workspace` 下的按会话划分的子路径(`sessions/<hash>`)——它从不隐式创建这个 volume,因为那会削弱持久性保证。Suspend 是 `/bin/sync` 加 `detach()`;resume 重新挂接同一个沙箱,或者——当沙箱到达 idle 或最长生命周期时——在同一个持久 Volume 子路径上重建计算(`compute_recreate_over_durable_volume`)。对「沙箱死了什么还活着」这个问题,这是最干净的回答:一切,因为文件系统从来就不在沙箱里。

**Sprites**(`packages/managed-runtime-sprites`,[`@fly/sprites`](https://www.npmjs.com/package/@fly/sprites) SDK)给每个会话一个持久的 ext4 文件系统,让服务商自己负责休眠。驱动持有一个保活任务(`openma-runtime`),它的过期时间就是 lease 要续的东西;suspend 释放保活、执行 `/bin/sync`、断开控制连接——Sprite 自己 auto-pause,在下一次 exec 时醒来(`automatic_pause_and_wake`)。Ownership 像 Daytona 一样做 label 校验,生命周期调用还会对瞬时服务商错误做重试。

## 出口策略是整齐划一终结的地方

到目前这些行说的都是「四家都能托管一个会话」。出口相关的行说的是能托管*什么样的*会话。每个驱动的描述符都把 `credentialEgress` 默认成
`{ enforcement: "unsupported", credentialMode: "snapshot", interceptedProtocols: [] }`,
除非运营者通过驱动 options 注入一个经过认证的 `CredentialEgressPort` 实现——去各 `*/src/*.ts` 的 descriptor 函数里查。今天只有 Cloudflare 驱动声明了 `enforced`/`live` 的凭证拦截;在这四家上,一个*要求*强制出口的 profile 会在准入时响亮地失败,而不是悄悄降级。

Provider 原生的网络策略是另一条轴,而这四家在这里分道扬镳:

- **Modal** 的原生故事最硬:出站 domain 和 CIDR 白名单(`updateNetworkPolicy`),创建时默认 `blockNetwork: true`,还有一道双保险——在任何 readiness 探针运行之前,先把出口收紧到空白名单(`fenceNetworkBeforeReadiness`)。一个被 resume 的沙箱在它的策略被重新断言之前,没法向外打电话。
- **Sprites** 暴露了 `native_network_policy` ——通过 `updateNetworkPolicy` 配置 domain 级别的 allow/deny 规则,当运营者配置了 `networkPolicy` 选项时,在 create 和 resume 时应用。
- **Daytona** 在创建时透传网络控制:`networkBlockAll`、`networkAllowList`、`domainAllowList`,以及一个 `outboundProxyUrl`,给想让出口流经自己代理的运营者用。
- **E2B** 是诚实的例外。适配器注明网络访问由模板镜像控制,而 managed preset 干脆不提供凭证出口的接点,「因为已安装的 E2B SDK 证明不了托管侧的出口策略语义」——运营者自己带来并认证自己的方案。

注意这一切*都不是*什么:环境的 `allowed_hosts` 限制——`apps/agent/src/harness/web-fetch-http.ts` 里的 `assertWebFetchUrlAllowed`,在 `web_fetch` 工具内部做后缀匹配、每次重定向跳转都重新检查——是工具级检查,不是沙箱防火墙。`bash`/`curl` 不受它约束。一个通用的出口白名单代理是计划中的工作([issue #297](https://github.com/openma-ai/open-managed-agents/issues/297)),不是这张表做出的宣称。

## 这张表拒绝说什么

最有教益的是那个空列。`runtimeCheckpoints` 对每一个驱动都是 `[]` ——表里全部十二家服务商,不只是这四家。OpenMA 里不存在进程内存级的检查点/恢复;可持久状态是文件系统属性,句号。

你能看到这张表在 E2B 身上强制执行这种诚实。它的沙箱事实把 `provider_memory_snapshot` 列为*可用*——服务商确实对整个 microVM 做快照——但 `process_memory_checkpoint` 被列为*不可用*,managed 驱动的注释说了原因:在 `RuntimeCheckpointPort` 接入宿主的恢复事务之前,不要宣称进程检查点。服务商的能力是真的;OpenMA 关于它的宣称更窄。同样的克制也出现在别处的 `unavailable` 列表里:Modal 和 Sprites 都拒绝了 `portable_workspace_checkpoint`(仅 retained-runtime,你要求 `restore()` 它就抛异常),Daytona 拒绝了 `durable_output_mount`。

## 选服务商时怎么读这张表

四家给你的是同一份契约——两条驱动通道、host-fenced 的 lease、suspend/resume、强制终止、宿主托管的孤儿回收、持久工作区。决策藏在机制里:

- **想要快照模型?** E2B(内存快照)和 Daytona(可移植文件系统快照)都提供 `checkpoint_restore` ——可以把工作区状态从产生它的运行时里拿出来。
- **想要不靠快照的持久性?** Modal 的 Volume 和 Sprites 的持久 ext4 让状态完全置身计算之外——suspend 只是记账,不是序列化。
- **最关心出口?** Modal 的「默认拒绝再加白名单」流程是最贴合的原生方案;Daytona 给你旋钮和一个代理钩子;Sprites 给你一个策略 API;E2B 让你自带。
- **需要进程内存检查点?** 这里没有任何一家宣称它——任何暗示了这点的服务商页面,描述的都是服务商的特性,不是 OpenMA 愿意背书的东西。

这就是把 profile 保持为机器可读的意义。营销页面说的是「持久」「快速」「安全」。一致性表说的是哪种策略、哪种机制、以及驱动愿意为哪些宣称签字。完整的表在
[`packages/managed-runtime-host/src/provider-conformance.ts`](https://github.com/openma-ai/open-managed-agents/blob/main/packages/managed-runtime-host/src/provider-conformance.ts),
驱动源码就在隔壁的 `packages/managed-runtime-*`,逐服务商的详解在
[沙箱文档页](https://docs.openma.ai/sandboxes/)。当文档和表不一致时,以表为准——那才是宿主真正校验的东西。
