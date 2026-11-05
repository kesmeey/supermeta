import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { EventSource } from "../events/source.ts";
import type { SourcedEvent, Task, TickSummary } from "../types.ts";
import { shortId, parseJson } from "../util.ts";
import { MemoryLayer } from "./memory.ts";
import { decide, parseLabels } from "./policy.ts";
import { sweep } from "../watchdog/watchdog.ts";

export interface LaunchHandle {
  worker_id: string;
  pid: number | null;
  done?: Promise<unknown>;
}

export interface Launcher {
  readonly name: string;
  launch(task: Task): LaunchHandle;
}

export interface RouterOptions {
  store: Store;
  config: Config;
  source: EventSource;
  launcher: Launcher;
  memory: MemoryLayer;
  log: (line: string) => void;
}

/**
 * The Router never executes work. It ingests events, makes one auditable
 * decision per event, keeps concurrency under a ceiling, and supervises.
 */
export class Router {
  readonly store: Store;
  readonly config: Config;
  readonly source: EventSource;
  readonly launcher: Launcher;
  readonly memory: MemoryLayer;
  readonly log: (line: string) => void;
  #inflight: Promise<unknown>[] = [];

  constructor(options: RouterOptions) {
    this.store = options.store;
    this.config = options.config;
    this.source = options.source;
    this.launcher = options.launcher;
    this.memory = options.memory;
    this.log = options.log;
  }

  async tick(): Promise<TickSummary> {
    const summary: TickSummary = {
      polled: 0,
      ingested: 0,
      ignored: 0,
      routed: 0,
      created: 0,
      dispatched: 0,
      recovered: 0,
      decisions: 0,
    };

    let events: SourcedEvent[] = [];
    try {
      events = await this.source.poll();
    } catch (error) {
      this.log(`source error: ${(error as Error).message}`);
    }
    summary.polled = events.length;

    for (const event of events) {
      if (!this.store.ingestEvent(event)) continue;
      summary.ingested += 1;

      const row = this.store.getEventById(event.id);
      if (!row) continue;

      const active = this.store.findActiveTaskByThread(row.thread);
      const verdict = decide(row, this.config, active);
      this.store.recordDecision({
        event_seq: row.seq,
        event_id: row.id,
        thread: row.thread,
        action: verdict.action,
        reason: verdict.reason,
        task_id: active?.id ?? null,
      });
      summary.decisions += 1;

      if (verdict.action === "ignore") {
        this.store.setEventStatus(row.seq, "ignored");
        summary.ignored += 1;
        this.log(`ignore ${row.thread} :: ${verdict.reason}`);
        continue;
      }

      if (verdict.action === "route_to_task" && active) {
        this.store.setEventStatus(row.seq, "routed");
        this.store.addMemory({
          thread: row.thread,
          kind: "event",
          level: "inline",
          content: `[event] ${row.kind}: ${row.title}`,
          ref: row.id,
          task_id: active.id,
        });
        summary.routed += 1;
        this.log(`route  ${row.thread} -> ${active.id} (${row.kind})`);
        continue;
      }

      const task = this.store.createTask({
        thread: row.thread,
        repo: row.repo,
        title: row.title,
        kind: row.kind,
        job: this.config.jobs.default_job,
        payload: {
          repo: row.repo,
          number: Number(row.thread.split("#")[1] ?? 0),
          title: row.title,
          body: row.body ?? "",
          url: row.url,
          labels: parseLabels(row.labels),
          ...parseJson<Record<string, unknown>>(row.meta, {}),
        },
        priority: verdict.priority,
        max_attempts: 3,
        origin_event: row.id,
      });
      this.store.setEventStatus(row.seq, "routed");
      summary.created += 1;
      this.log(`task   ${task.id} ${row.thread} priority=${task.priority} :: ${verdict.reason}`);
    }

    summary.dispatched = this.#dispatch();
    summary.recovered = this.#supervise();
    return summary;
  }

  #dispatch(): number {
    const free = Math.max(0, this.config.max_workers - this.store.countRunning());
    if (free === 0) return 0;

    let dispatched = 0;
    for (const task of this.store.listRunnable(free)) {
      const claimed = this.store.beginDispatch(task.id, shortId("w"));
      if (!claimed) continue;
      try {
        const handle = this.launcher.launch(claimed);
        this.store.attachWorker(claimed.id, handle.pid);
        if (handle.done) this.#inflight.push(handle.done.catch(() => undefined));
        dispatched += 1;
        this.log(`launch ${claimed.id} on ${this.launcher.name}${handle.pid ? ` pid=${handle.pid}` : ""}`);
      } catch (error) {
        this.store.requeueTask(claimed.id, `launch failed: ${(error as Error).message}`);
        this.log(`launch failed ${claimed.id}: ${(error as Error).message}`);
      }
    }
    return dispatched;
  }

  #supervise(): number {
    const incidents = sweep({ store: this.store, config: this.config });
    for (const incident of incidents) {
      this.log(`watchdog ${incident.action} ${incident.task_id} :: ${incident.detail}`);
    }
    return incidents.length;
  }

  /** Wait for in-process launchers (tests) to settle. */
  async drain(): Promise<void> {
    const pending = this.#inflight;
    this.#inflight = [];
    await Promise.allSettled(pending);
  }

  async waitForIdle(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sourceDone = this.source.exhausted?.() ?? true;
      if (sourceDone && this.store.countActive() === 0 && this.#inflight.length === 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    return false;
  }
}
