import { closeSync, openSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { Task } from "../types.ts";
import { ensureDir } from "../util.ts";
import type { LaunchHandle, Launcher } from "./router.ts";
import type { MemoryLayer } from "./memory.ts";
import { runTask } from "../worker/worker.ts";

/**
 * Production launcher: one detached OS process per task.
 *
 * Workers never talk to the Router over a pipe. All coordination goes through
 * the store, which is why a worker crash cannot take the Router down and why a
 * worker can be replaced without restarting anything else.
 */
export class ProcessLauncher implements Launcher {
  readonly name = "process";
  readonly #entry: string;
  readonly #home: string;
  readonly #logDir: string;

  constructor(options: { entry: string; home: string; logDir: string }) {
    this.#entry = options.entry;
    this.#home = options.home;
    this.#logDir = options.logDir;
  }

  launch(task: Task): LaunchHandle {
    ensureDir(this.#logDir);
    const logPath = join(this.#logDir, `${task.id}.log`);
    const fd = openSync(logPath, "a");
    try {
      const child = spawn(
        process.execPath,
        ["--no-warnings", this.#entry, "worker", "run", "--task", task.id, "--home", this.#home],
        { detached: true, stdio: ["ignore", fd, fd], windowsHide: true },
      );
      child.unref();
      return { worker_id: task.worker_id ?? "unknown", pid: child.pid ?? null };
    } finally {
      closeSync(fd);
    }
  }
}

/** Test launcher: runs the worker in-process so tests stay deterministic. */
export class InlineLauncher implements Launcher {
  readonly name = "inline";
  readonly #store: Store;
  readonly #config: Config;
  readonly #memory: MemoryLayer;
  readonly #log: (line: string) => void;

  constructor(options: {
    store: Store;
    config: Config;
    memory: MemoryLayer;
    log: (line: string) => void;
  }) {
    this.#store = options.store;
    this.#config = options.config;
    this.#memory = options.memory;
    this.#log = options.log;
  }

  launch(task: Task): LaunchHandle {
    const done = runTask({
      store: this.#store,
      config: this.#config,
      memory: this.#memory,
      taskId: task.id,
      log: (line) => this.#log(`  [worker ${task.id}] ${line}`),
    });
    return { worker_id: task.worker_id ?? "inline", pid: null, done };
  }
}
