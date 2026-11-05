# SuperMeta

**一个 Router / Worker 双层、事件驱动、带看门狗的开源贡献 Super-agent 实现。**

6 个事件 → 1 个 Router → N 个 Worker → 看门狗兜底，每一步都留在 SQLite 里可查。

```
$ node src/cli.ts demo

[router] task   t_cac9ba6d30 acme/widget#101 priority=70 :: labels: bug, good first issue
[router] launch t_cac9ba6d30 on process pid=18452
[router] route  acme/widget#101 -> t_cac9ba6d30 (issue_commented)
[router] ignore acme/widget#102 :: no interest signal (labels/mention)
[router] route  acme/gadget#55 -> t_61ce58c905 (ci_failed)
[router] watchdog killed t_cf96c33b76 :: no heartbeat for 2335ms (attempt 1/3)
[router] watchdog requeued t_cf96c33b76 :: no heartbeat for 2335ms (attempt 1/3)

Route trace
event          thread           action         reason
-------------  ---------------  -------------  -----------------------------------
issue:101      acme/widget#101  create_task    labels: bug, good first issue
comment:101:2  acme/widget#101  route_to_task  thread subscription -> t_cac9ba6d30
review:55      acme/gadget#55   create_task    direct: review_requested
issue:102      acme/widget#102  ignore         no interest signal (labels/mention)
ci:55:1        acme/gadget#55   route_to_task  thread subscription -> t_61ce58c905
issue:103      acme/widget#103  create_task    labels: bug

Metrics
  events               6  (routed 5, ignored 1)
  router decisions     6
  tasks                3  (done 3, failed 0)
  worker attempts      4
  watchdog recoveries  1
  task p50 / p95       1.8s / 4.5s
  context              inline 460 chars vs spill 1828 chars kept out of context
```

---

## 为什么不是又一个「issue 推荐器」

开源贡献最耗时间的从来不是写代码，而是：判断这件事值不值得做、这个仓库从哪下手、上次做到哪了、卡住了谁管。

现在市面上的工具基本是**被动**的：你点一下，它跑一次，返回结果。但真实的工作日是并发的 —— issue 在开、PR 在 review、CI 在挂、评论在追加。人被降级成了调度器。

SuperMeta 想把这个位置换过来：**系统负责发现、派单、盯进度，人只负责决策和验收。**

## 它由六个机制组成

| 机制 | 实现 | 一句话 |
|---|---|---|
| **Router / Worker 双层** | `src/router/router.ts` + 每个任务一个独立 OS 进程 | Router 只做判断，从不执行；Worker 只执行，不决策 |
| **事件驱动** | `src/events/github.ts`（issues / notifications 轮询 + ETag + 去重） | 没有「发起」这个动作，只有事件到达 |
| **Thread Subscription** | `tasks.thread` + `findActiveTaskByThread` | 一条线程已经有活的 task，后续事件直接进它，不重新判断 |
| **Inline / Spill 上下文** | `src/router/memory.ts` + `artifacts/` 文件 | 摘要进上下文（几百字符），全文落盘，只传引用 |
| **状态 / 执行解耦** | 状态全在 SQLite，进程随任务生死 | 换机器、崩溃重启都不丢进度 |
| **Watchdog** | `src/watchdog/watchdog.ts` | 心跳冷了 → 杀进程 → 重试或升级，不靠人盯 |

## 快速开始

需要 Node >= 22.18（原生跑 TypeScript，无需构建）。

```bash
npm install          # 只装 tsc 做类型检查；运行时零依赖
node src/cli.ts demo # 30 秒看完整个闭环
```

`demo` 会用一个可复现的 6 事件剧本跑完整流程，包括故意让第三个任务在第一次执行时把事件循环锁死，好让看门狗真的有活干。

其它命令：

```bash
node src/cli.ts router run              # 常驻路由循环（真实 GitHub）
node src/cli.ts router once             # 跑一个 tick，输出 JSON 汇总
node src/cli.ts router status           # 计数器 + 存活 worker
node src/cli.ts tasks [--state running] # 任务列表
node src/cli.ts task <id>               # 单任务详情 + 每次 attempt
node src/cli.ts memory <owner/repo#123> # 该线程的 inline 摘要与 spill 引用
node src/cli.ts watchdog --dry-run      # 只报告卡住的任务，不动手
node src/cli.ts report                  # 指标
```

## 在真实仓库上跑

```bash
node src/cli.ts init oven-sh/bun
node src/cli.ts router once
sleep 3
node src/cli.ts tasks
```

实测（未登录，公开 API）：

```
[router] ignore oven-sh/bun#47953 :: no interest signal (labels/mention)
[router] task   t_45f15f49c5 oven-sh/bun#47956 priority=55 :: labels: bug
[router] task   t_bfea8ab66d oven-sh/bun#47955 priority=55 :: labels: bug
{"polled":4,"ingested":4,"ignored":2,"created":2,"dispatched":2,"recovered":0,"decisions":4}

id            thread             state  att  dur    summary
------------  -----------------  -----  ---  -----  --------------------------------------------
t_bfea8ab66d  oven-sh/bun#47955  done   1/3  705ms  oven-sh/bun#47955 bun build --compile --aot: ...
t_45f15f49c5  oven-sh/bun#47956  done   1/3  687ms  oven-sh/bun#47956 Playwright hangs forever ...
```

发布到 watch 列表里的每个 issue 都会走一遍：抓取 → 判断范围 → 命中候选文件 → 给复现命令 → 生成 checklist → 存成 artifact。

## 实测数字

单机、脚本化事件流，`node src/cli.ts demo`：

| 指标 | 值 |
|---|---|
| 事件 / 决策 | 6 / 6（每条事件一条可审计决策） |
| 任务 | 3（其中 2 条事件被线程订阅吸收） |
| Worker 尝试 | 4（1 次 hangs → 看门狗重派） |
| 任务完成 P50 / P95 | 1.8s / 4.5s |
| 上下文占用 | inline 460 字符，spill 1828 字符留在磁盘 |
| 看门狗恢复 | 1 |

**A/B（`--no-subscription`）**：把线程订阅关掉，同样的 6 个事件产生 **5 个任务、6 次尝试**（+67% 重复任务），而不是 3 个任务、4 次尝试。

> 这不是 DeepSeek 论文里那个「Router 决策量 +30%」，因为两者测的不是同一个东西：他们测调度开销，我测重复劳动。口径不同，别混着引用。

## 与《Super-agent 设计探索》的对照

DeepSeek Harness 团队在 2026-10-31 发了 [《Super-agent 设计探索：迈向更自主的 Agent 系统》](https://mp.weixin.qq.com/s/zoS7GlReWPhfCjENGxXCdg)，开源原型在 [dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)。

SuperMeta 是**独立的实现**，不是官方代码，领域也换成开源贡献而不是通用工程。逐条对照：

| 论文里的机制 | SuperMeta | 状态 |
|---|---|---|
| Router + Worker 双层 | Router 单进程 + 每任务一个 worker 进程 | ✅ |
| Event-Driven | GitHub 轮询 + 去重 + ETag | ✅（无 webhook，本地起不了公网端口） |
| Thread Subscription | `thread` 作为路由键 | ✅ |
| Async ReAct | Router 全程不阻塞；工具调用在 worker 内 | ⚠️ 只做到进程级，未做工具级并发 |
| Inline / Spill | 摘要 + artifact 文件 + 引用链 | ✅ 简化版（无向量检索） |
| 状态 / 环境解耦 | 状态在 SQLite，工作区尚未接 | ⚠️ 缺 workspace 层 |
| Watchdog | 心跳 + 杀进程 + 重试/升级 | ✅ |
| 常驻云端 | 本地单机 daemon | ❌ 不做 |

细节和测量方法见 [docs/super-agent.md](docs/super-agent.md)，架构见 [docs/architecture.md](docs/architecture.md)。

## 设计取舍

**SQLite 是唯一的 IPC。** Router 和 Worker 之间没有管道、没有 RPC，只共享一个数据库。好处是任意一方崩溃都不影响另一方，`tasks` / `runs` / `decisions` 天然就是审计日志；坏处是延迟以毫秒计，不适合高频消息。这个项目要的是**可恢复**，不是低延迟。

**Worker 必须是独立进程。** 任务里有用户代码、有网络、有跑飞的循环。进程隔离让看门狗有一个明确的动作可做（kill），而不是在同一个事件循环里干等。

**Router 的决策跑在模型调用之前。** `policy.ts` 是纯函数，只吃标签、事件类型、线程状态。这样被忽略的事件成本为零，而每条决策都留下了理由，事后能解释「为什么没管这个 issue」。

**人留在验收环节。** 这是刻意的，也是与论文一致的地方：Router 负责发现和准备，Worker 负责执行，人负责决定这个 PR 要不要发。自动开 PR 在开源社区是负资产。

## 现在还没做的

- **patch / PR 生成**：当前 job 只有 `triage` 和 `demo`。接 patch 生成是下一步，可以直接把 [openmeta-cli](https://github.com/NianJiuZst/openmeta-cli) 的 `contribution-pr` 包成一个 job。
- **workspace 层**：clone、分支、跑测试命令还没接进 worker。
- **LLM**：`triage` 是确定性的，不调用任何模型。这是故意的 —— 先把骨架跑通，模型是可替换件。
- **多机**：目前假设单机、单 Router。

## 目录

```
src/
  cli.ts                 命令入口
  db.ts                  schema + 所有查询（唯一的状态真相）
  router/router.ts       tick：拉事件 → 决策 → 派单 → 监督
  router/policy.ts       纯函数决策门
  router/memory.ts       inline / spill
  router/launchers.ts    进程启动器 / 测试内联启动器
  worker/worker.ts       单任务生命周期 + 心跳
  worker/jobs.ts         job 注册表（triage / demo / sleep）
  watchdog/watchdog.ts   停滞检测与恢复
  events/github.ts       GitHub 事件源
  events/demo.ts         剧本事件源
docs/
  architecture.md        状态机与调用序列
  super-agent.md         与论文的逐条对照 + 测量口径
test/                    20 个测试，node --test
```

```bash
npm test         # 20 passed
npm run typecheck
```

## English

**SuperMeta is a Router/Worker super-agent harness for open-source work.** One router process ingests events, writes exactly one auditable decision per event, keeps concurrency under a ceiling, and never executes anything itself. Every task runs in its own OS process with an independent heartbeat, so a wedged worker is killed and requeued instead of silently blocking the queue. Durable state lives in SQLite; the router and workers share nothing else.

Runtime has zero dependencies — Node >= 22.18 runs the TypeScript directly, `node:sqlite` is the store.

```bash
node src/cli.ts demo     # 6-event end-to-end trace, ~9s
node src/cli.ts init <owner/repo> && node src/cli.ts router run
```

Independent implementation inspired by DeepSeek Harness Team's *Super-agent* design note. Not affiliated, not a port. See [docs/super-agent.md](docs/super-agent.md) for the honest per-mechanism mapping.

MIT.
