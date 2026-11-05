# 与《Super-agent 设计探索》的对照

## 出处

DeepSeek Harness 团队，2026-10-31，[《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)，开源原型 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。

论文的四个目标：**连续、高效、主动、持久**；五个机制：Router/Worker 双层、事件驱动、异步执行、Inline/Spill 上下文、状态与执行环境解耦，外加 Watchdog。

## 定位

SuperMeta 是**独立实现**，不是移植、不是官方代码，领域也不同：论文面向通用工程任务，SuperMeta 只做开源贡献这一件事。

同一条设计思路，落到一个具体场景上，才可能被验证。论文的 demo 是「在群里发现 bug、后台复现、尝试修复」；SuperMeta 的等价物是「在 GitHub issue 上发现、判断范围、准备上下文、留下证据」。

## 逐条对照

| 论文机制 | 论文表述 | SuperMeta | 差异 | 状态 |
|---|---|---|---|---|
| Router + Worker | 调度层不做执行，执行层不做全局判断 | `src/router/router.ts` 单进程；每个任务一个 OS 进程 | Worker 是进程而非协程，隔离更硬，启动更贵 | 完成 |
| Event-Driven | 监听 GitHub / IM / 邮件 / CI | `src/events/github.ts` 轮询 issues 与 notifications，ETag + id 去重 | 无 webhook（本地工具没有公网入口），最坏延迟 = 一个轮询周期 | 完成 |
| Thread Subscription | 事件直通已负责该线程的 Worker | `tasks.thread` + `findActiveTaskByThread()` | 同样把「重复判断」变成「一次查表」 | 完成 |
| Async ReAct | 推理控制流与长任务解耦 | Router 全程不阻塞；job 内部串行 | 只做到**进程级**并发，没有工具级并发调度 | 部分 |
| Inline / Spill | 摘要进上下文，全文进外部存储，按引用恢复 | `src/router/memory.ts`，摘要 ≤400 字符 + artifact 文件 + 路径引用 | 无向量检索，recall 是显式读文件而不是相似度召回 | 简化 |
| 状态 / 环境解耦 | Router 常驻云端，Worker 用远程容器 | 状态在 SQLite；workspace 层尚未接入 | 没有远程执行环境，只有本机进程 | 部分 |
| Watchdog | 检测卡死、失败、目标偏离 | `src/watchdog/watchdog.ts`：心跳 + 杀进程 + 重试/升级 | 只检测「不推进」，没有检测「跑偏」 | 部分 |
| 常驻云端 | 跨设备持续在线 | 本地单机 daemon | 不做 | 未做 |

## 测量口径

论文报告了三个数字：任务完成时间 P50/P95、去掉订阅后 Router 决策量 +30%、批处理把分摊推理时间从 6.4s 降到 1.6s。

SuperMeta 能测的对应量：

```bash
node src/cli.ts demo                  # 开订阅
node src/cli.ts demo --no-subscription # 关订阅
```

本机实测（Windows，单机，脚本化事件流）：

| 指标 | 开订阅 | 关订阅 |
|---|---|---|
| 任务数 | 3 | 5（+67%） |
| Worker 尝试 | 4 | 6 |
| 上下文 inline | 460 字符 | 748 字符 |
| 完成 P50 / P95 | 1.8s / 4.5s | 1.8s / 4.5s |

**为什么不是 +30%：** 论文测的是 Router 的**决策量**（调度开销），这里测的是**重复任务数**（重复劳动）。两个指标不能互相印证，也不该被并列引用。如果要复现他们的口径，需要把「查表命中」和「完整评估」分别计数 —— 这是下一步。

**这些数字不能说明什么：** 样本是 3~5 个任务的剧本，不是生产负载；P50/P95 只统计任务执行时间，不含排队时间；没有任何模型调用，所以不涉及推理成本。它只证明**机制在跑**，不证明**效果好**。

## 刻意的不同

1. **人留在验收环。** 论文的终点是「人上移到决策与验收」，SuperMeta 直接把它做成产品约束：worker 产出的是 dossier 和 checklist，不是 PR。自动开 PR 在开源社区是负资产，这条不能为了「看起来更自主」而放松。
2. **不做云端常驻。** 本地 CLI 的信任成本低得多，也符合「local-first」的定位。
3. **不接模型也能跑。** `triage` 是确定性启发式。骨架先跑通，模型是可替换件 —— 否则所有指标都会被模型质量掩盖。

## 如果要和官方原型对接

SuperMeta 的 worker 侧是 job 注册表，接一个新 job 只需要实现：

```ts
interface Job {
  name: string;
  run(ctx: JobContext): Promise<JobResult>;
}
```

`JobContext` 提供 `task`、`context`（inline 摘要与 spill 引用）、`signal`、`log`。想把官方原型里的能力引进来，包一层就能挂上，不需要改 Router。
