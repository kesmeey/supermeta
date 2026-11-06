import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { WatchdogIncident } from "../types.ts";
import { backoffDelay, describeDelay } from "../retry.ts";

export interface SweepOptions {
  store: Store;
  config: Config;
  /** Set false in tests to avoid signalling unrelated pids. */
  signal?: boolean;
}

/**
 * Independent supervision. The watchdog never trusts a task's own claim that it
 * is running: it compares the wall clock against the last heartbeat, kills the
 * leftover process when there is one, and decides between retry and give-up.
 */
export function sweep(options: SweepOptions): WatchdogIncident[] {
  const { store, config } = options;
  const signal = options.signal ?? true;
  const now = Date.now();
  const incidents: WatchdogIncident[] = [];

  for (const task of store.listStale(now, config.watchdog.stale_ms, config.watchdog.grace_ms)) {
    const silentFor = now - (task.heartbeat_at ?? task.updated_at);
    const detail = `no heartbeat for ${silentFor}ms (attempt ${task.attempts}/${task.max_attempts})`;

    if (signal && task.pid) {
      const alive = isAlive(task.pid);
      if (alive) {
        try {
          process.kill(task.pid, "SIGKILL");
          incidents.push({ task_id: task.id, thread: task.thread, action: "killed", detail, at: now });
        } catch {
          // already gone between the check and the signal
        }
      }
    }

    for (const run of store.listOpenRuns(task.id)) {
      store.closeRunStale(run.seq, `stale: ${detail}`);
    }

    // A stall is not the same failure as a bad result: BullMQ keeps a separate
    // `maxStalledCount` so a task that keeps wedging its worker cannot loop
    // forever on the retry budget alone.
    const stalls = store.recordStall(task.id);
    if (stalls > config.retry.max_stalls) {
      store.markDead(task.id, `watchdog: stalled ${stalls} times (${detail})`);
      incidents.push({ task_id: task.id, thread: task.thread, action: "dead", detail, at: now });
    } else if (task.attempts >= task.max_attempts) {
      store.finishTask(task.id, { state: "failed", error: `watchdog: ${detail}` });
      incidents.push({ task_id: task.id, thread: task.thread, action: "failed", detail, at: now });
    } else {
      const delay = backoffDelay(task.attempts, config.retry);
      store.requeueTask(task.id, `watchdog: ${detail}`, now + delay);
      incidents.push({
        task_id: task.id,
        thread: task.thread,
        action: "requeued",
        detail: `${detail}; retry in ${describeDelay(delay)}`,
        at: now,
      });
    }
  }

  for (const incident of incidents) {
    store.addMemory({
      thread: incident.thread,
      kind: "event",
      level: "inline",
      content: `[watchdog] ${incident.action} ${incident.task_id}: ${incident.detail}`,
      task_id: incident.task_id,
    });
  }

  return incidents;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
