import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { MemoryLayer } from "../router/memory.ts";
import type { Task } from "../types.ts";
import { shortId } from "../util.ts";
import { getJob } from "./jobs.ts";

export interface RunTaskOptions {
  store: Store;
  config: Config;
  memory: MemoryLayer;
  taskId: string;
  log?: (message: string) => void;
}

export interface RunTaskResult {
  ok: boolean;
  state: Task["state"];
  error?: string;
}

/**
 * One worker process owns exactly one task. It reports liveness on a timer that
 * is independent of the job itself, which is what makes stalls observable.
 */
export async function runTask(options: RunTaskOptions): Promise<RunTaskResult> {
  const { store, config, memory, taskId } = options;
  const log = options.log ?? ((): void => {});

  const initial = store.getTask(taskId);
  if (!initial) return { ok: false, state: "failed", error: "task not found" };
  if (!["queued", "dispatching", "running"].includes(initial.state)) {
    return { ok: true, state: initial.state };
  }

  const workerId = shortId("w");
  if (!store.markRunning(taskId, workerId)) {
    return { ok: false, state: "failed", error: "claim lost to another worker" };
  }
  const task = store.getTask(taskId);
  if (!task) return { ok: false, state: "failed", error: "task vanished" };

  const pid = process.pid;
  const runSeq = store.startRun(task.id, workerId, task.attempts, pid);
  store.registerWorker({
    id: workerId,
    task_id: task.id,
    pid,
    started_at: Date.now(),
    heartbeat_at: Date.now(),
    state: "alive",
  });

  const heartbeatMs = Math.max(150, Math.floor(config.watchdog.stale_ms / 5));
  const timer = setInterval(() => {
    try {
      store.heartbeat(task.id);
      store.touchWorker(workerId);
    } catch {
      // the store is gone; nothing useful left to do here
    }
  }, heartbeatMs);

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const context = memory.context(task.thread);
  log(`thread=${task.thread} attempts=${task.attempts}/${task.max_attempts} inline=${context.inline.length} spill=${context.spillRefs.length}`);

  try {
    const job = getJob(task.job);
    const result = await job.run({ task, signal: controller.signal, log, context }, { config });
    const recorded = memory.remember(task, result);

    store.finishTask(task.id, { state: "done", summary: result.summary });
    store.finishRun(runSeq, {
      exit_code: 0,
      note: "ok",
      inline_chars: recorded.inlineChars,
      spill_chars: recorded.spillChars,
    });
    log(`done: ${result.summary.slice(0, 80)}`);
    return { ok: true, state: "done" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = task.attempts >= task.max_attempts;
    if (exhausted) {
      store.finishTask(task.id, { state: "failed", error: message });
      store.finishRun(runSeq, { exit_code: 1, note: `failed: ${message}`, inline_chars: 0, spill_chars: 0 });
      log(`failed after ${task.attempts} attempt(s): ${message}`);
      return { ok: false, state: "failed", error: message };
    }
    store.requeueTask(task.id, message);
    store.finishRun(runSeq, { exit_code: 1, note: `retry: ${message}`, inline_chars: 0, spill_chars: 0 });
    log(`retrying (${task.attempts}/${task.max_attempts}): ${message}`);
    return { ok: false, state: "queued", error: message };
  } finally {
    clearInterval(timer);
    store.closeWorker(workerId, "exited");
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
