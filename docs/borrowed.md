# 借鉴了什么，为什么

SuperMeta 的骨架是 DeepSeek Harness 那篇《Super-agent 设计探索》。但「长期运行的调度系统」这件事，队列和 CI 领域已经做了十几年，踩过的坑写在别人的源码和文档里。这份文档记录每个机制从哪来、怎么落地的、对应哪条测试。

原则：**只借机制，不借复杂度。** 没有 Redis、没有消息中间件、没有分布式锁 —— 本项目仍然是单机 + SQLite。

## 1. 指数退避 + 抖动

| | |
|---|---|
| 来源 | BullMQ 的 `backoff: { type: "exponential", delay }`（[文档](https://docs.bullmq.io/guide/retrying-failing-jobs)）、Sidekiq 的 `sidekiq_retry_in`、Temporal 的 `RetryPolicy`（`initial_interval` / `backoff_coefficient` / `maximum_interval`，[文档](https://docs.temporal.io/develop/ruby/activities/timeouts)） |
| 问题 | 任务失败后立刻回队列 = 热循环。上游一挂，所有 worker 在同一时刻重试，把对方再打死一次。 |
| 做法 | `min(max_ms, base_ms * factor^(n-1))`，再叠加 ±jitter 的随机量；结果写进 `tasks.next_attempt_at`，Router 只派发 `next_attempt_at <= now` 的任务。 |
| 代码 | `src/retry.ts`、`src/router/router.ts`（`#pickTasks` → `listRunnable(limit, now)`） |
| 测试 | `test/retry.test.ts`、`test/router.test.ts`「a task is not dispatched before its backoff elapses」 |

抖动默认 20%。不抖动的话，N 个 worker 的重试时间会完全重合。

## 2. 停滞预算与失败预算分开

| | |
|---|---|
| 来源 | BullMQ 的 `maxStalledCount`、Sidekiq 的 orphan reaper |
| 问题 | 原实现只有一个 `attempts` 计数。一个任务反复把 worker 卡死，会一直消耗重试预算；而「跑挂了」和「把进程卡死」是两种不同的故障，混在一个计数器里，无法单独收紧任意一边。 |
| 做法 | 新增 `tasks.stalls`，看门狗每次判定停滞就 +1；`stalls > max_stalls` 直接进死信，不再占用 `attempts`。 |
| 代码 | `src/db.ts`（`recordStall` / `markDead`）、`src/watchdog/watchdog.ts` |
| 测试 | `test/watchdog.test.ts`「a task that keeps wedging its worker lands in the dead letter state」 |

## 3. 死信状态（dead letter）

| | |
|---|---|
| 来源 | Sidekiq 的 dead set、BullMQ 的 failed set |
| 问题 | 原实现失败即 `failed`，但「重试预算用尽」和「确定没救了」应该可区分，否则无法做人工兜底和统计。 |
| 做法 | 新增 `dead` 状态：只由看门狗在停滞预算耗尽时写入，带 `last_error`，不再自动重试。 |
| 代码 | `src/db.ts`（`markDead`）、`src/types.ts` |
| 测试 | 同上 |

## 4. 单仓库并发上限 + 轮转派发

| | |
|---|---|
| 来源 | Renovate 的 `prConcurrentLimit` / `prHourlyLimit`（[配置文档](https://docs.renovatebot.com/configuration-options/)）、Dependabot 的按仓库限速 |
| 问题 | 原实现按 `priority desc, created_at asc` 取任务。一个仓库一次灌进 50 个 issue，就会占满所有 worker 槽，其它仓库永远排队 —— 对「帮人做开源贡献」这种天然多仓库的场景是致命的。 |
| 做法 | `limits.max_workers_per_repo` 限制单仓库占用的槽位；派发时按仓库名排序后轮转取任务，保证每个仓库至少轮到一次。 |
| 代码 | `src/router/router.ts`（`#pickTasks`）、`src/db.ts`（`countActiveByRepo`） |
| 测试 | `test/router.test.ts`「one repository cannot occupy every worker slot」 |

## 5. 客户端限流 + 尊重 Retry-After

| | |
|---|---|
| 来源 | Octokit 的 throttling 插件、Renovate 的 `hostRules` |
| 问题 | GitHub 未登录 60 次/小时。原实现只在拿到 403 之后才知道超限，且没有退避。 |
| 做法 | 每个 host 一个令牌桶（`perMinute` 可配）；遇到 429 或 `x-ratelimit-remaining: 0` 的 403，读 `retry-after` / `x-ratelimit-reset` 等待后重试一次（上限 60s，防止坏 header 卡死）。 |
| 代码 | `src/net.ts` |
| 测试 | 无单测（时间相关，靠手工 smoke），见「没做的」 |

## 6. 心跳超时

| | |
|---|---|
| 来源 | Temporal 的 `heartbeat_timeout` |
| 做法 | 已有：worker 独立心跳，看门狗按 `stale_ms` 判定。这一条在写 SuperMeta 时就有了，但设计确实来自 Temporal。 |
| 代码 | `src/worker/worker.ts`、`src/watchdog/watchdog.ts` |

## 7. 幂等：事件去重

| | |
|---|---|
| 来源 | Temporal 的 workflow ID、GitHub Actions 的 concurrency group |
| 做法 | `events.id` 唯一约束；重复投递（轮询重叠、重放）直接丢弃。 |
| 代码 | `src/db.ts`（`ingestEvent`） |
| 测试 | `test/router.test.ts`「duplicate events from overlapping polls are ingested once」 |

## 没做的，以及为什么

- **分布式锁 / 多机**：单机 SQLite + WAL 已经够用；引入 Redis 或 etcd 会让「`git clone` 就能跑」这个特性消失。
- **优先级老化（aging）**：目前是静态 priority + 轮转。真正需要时再加，先不引入无测试的复杂度。
- **限流单测**：令牌桶依赖真实时间。要测得可靠需要注入时钟，暂时用手工 smoke 覆盖；这是已知缺口。
- **重试的 dead-letter 重放命令**：`dead` 任务目前只能看不能重放，缺一个 `supermeta retry <id>`。
