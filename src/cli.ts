import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, loadConfig, writeConfig, type Config } from "./config.ts";
import { Store } from "./db.ts";
import { MemoryLayer } from "./router/memory.ts";
import { Router } from "./router/router.ts";
import { InlineLauncher, ProcessLauncher } from "./router/launchers.ts";
import { DemoSource, demoScript } from "./events/demo.ts";
import { GitHubSource } from "./events/github.ts";
import { runTask } from "./worker/worker.ts";
import { sweep } from "./watchdog/watchdog.ts";
import { listJobs } from "./worker/jobs.ts";
import * as ui from "./ui.ts";
import { duration, iso, percentile } from "./util.ts";
import { describeDelay } from "./retry.ts";
import type { Task, TaskState } from "./types.ts";

const ENTRY = fileURLToPath(import.meta.url);
const VERSION = "0.1.0";

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq > 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      flags.set(body, next);
      index += 1;
    } else {
      flags.set(body, true);
    }
  }
  return { positional, flags };
}

function str(flags: Map<string, string | true>, name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function has(flags: Map<string, string | true>, name: string): boolean {
  return flags.has(name);
}

function workspace(flags: Map<string, string | true>): {
  config: Config;
  store: Store;
  memory: MemoryLayer;
} {
  const config = loadConfig({ home: str(flags, "home") });
  const store = new Store(config.db_path);
  const memory = new MemoryLayer(store, join(config.home, "artifacts"));
  return { config, store, memory };
}

export async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, sub] = positional;

  switch (command) {
    case undefined:
    case "help":
      printHelp();
      return 0;
    case "version":
      process.stdout.write(`supermeta ${VERSION}\n`);
      return 0;
    case "init":
      return cmdInit(flags, positional.slice(1));
    case "demo":
      return cmdDemo(flags);
    case "router":
      return cmdRouter(sub, flags);
    case "worker":
      return cmdWorker(sub, flags);
    case "tasks":
      return cmdTasks(flags);
    case "task":
      return cmdTask(sub, flags);
    case "events":
      return cmdEvents(flags);
    case "memory":
      return cmdMemory(sub, flags);
    case "report":
      return cmdReport(flags);
    case "watchdog":
      return cmdWatchdog(flags);
    case "doctor":
      return cmdDoctor(flags);
    default:
      process.stderr.write(`unknown command: ${command}\n\n`);
      printHelp();
      return 2;
  }
}

// ------------------------------------------------------------------ init

function cmdInit(flags: Map<string, string | true>, repos: string[]): number {
  const config: Config = {
    ...DEFAULT_CONFIG,
    home: resolve(str(flags, "home") ?? DEFAULT_CONFIG.home),
    db_path: "",
    watch: { ...DEFAULT_CONFIG.watch, repos },
    experiments: { ...DEFAULT_CONFIG.experiments },
    jobs: { ...DEFAULT_CONFIG.jobs },
    watchdog: { ...DEFAULT_CONFIG.watchdog },
    github: { ...DEFAULT_CONFIG.github },
  };
  config.db_path = join(config.home, "state.db");
  const path = writeConfig(config);
  process.stdout.write(`wrote ${path}\n`);
  process.stdout.write(`state  ${config.db_path}\n`);
  process.stdout.write("\nnext:\n  supermeta doctor\n  supermeta router run\n");
  return 0;
}

// ------------------------------------------------------------------ demo

async function cmdDemo(flags: Map<string, string | true>): Promise<number> {
  const home = resolve(str(flags, "home") ?? ".supermeta-demo");
  rmSync(home, { recursive: true, force: true });

  const config: Config = {
    home,
    db_path: join(home, "state.db"),
    max_workers: 2,
    poll_interval_ms: 200,
    watch: {
      repos: ["acme/widget", "acme/gadget"],
      labels: ["good first issue", "help wanted", "bug"],
      ignore_actors: [],
    },
    watchdog: { stale_ms: 2200, grace_ms: 2000, tick_ms: 250 },
    jobs: { default_job: "demo" },
    retry: { base_ms: 500, factor: 2, max_ms: 4_000, jitter: 0.1, max_stalls: 2 },
    limits: { max_workers_per_repo: 1, github_requests_per_minute: 60 },
    experiments: { thread_subscription: !has(flags, "no-subscription") },
    github: { ...DEFAULT_CONFIG.github },
  };

  const store = new Store(config.db_path);
  const memory = new MemoryLayer(store, join(home, "artifacts"));
  writeConfig(config);
  const source = new DemoSource(demoScript({ faults: !has(flags, "inline") }));
  const launcher = has(flags, "inline")
    ? new InlineLauncher({ store, config, memory, log: (line) => ui.log("worker", line) })
    : new ProcessLauncher({ entry: ENTRY, home, logDir: join(home, "logs") });

  const router = new Router({
    store,
    config,
    source,
    launcher,
    memory,
    log: (line) => ui.log("router", line),
  });

  process.stdout.write(
    [
      ui.bold("SuperMeta demo"),
      ui.dim("6 events -> 1 router -> N workers -> watchdog"),
      ui.dim(`state: ${home}`),
      ui.dim(`launcher: ${launcher.name}   thread subscription: ${config.experiments.thread_subscription ? "on" : "off"}`),
      "",
    ].join("\n"),
  );

  const startedAt = Date.now();
  const deadline = startedAt + 60_000;
  while (Date.now() < deadline) {
    await router.tick();
    if (source.exhausted() && store.countActive() === 0) break;
    await sleep(180);
  }

  await router.drain();
  const tidy = await router.waitForIdle(5_000);
  printReport(store, config);

  if (!tidy) {
    process.stderr.write(ui.red("\nwarning: some tasks never reached a terminal state\n"));
  }
  const metrics = store.metrics();
  return metrics.tasks_failed > 0 ? 1 : 0;
}

// ---------------------------------------------------------------- router

async function cmdRouter(sub: string | undefined, flags: Map<string, string | true>): Promise<number> {
  const { config, store, memory } = workspace(flags);
  try {
    if (sub === "status") {
      printStatus(store, config);
      return 0;
    }

    const source = has(flags, "source") && str(flags, "source") === "demo" ? new DemoSource(demoScript()) : new GitHubSource(config);
    const launcher = new ProcessLauncher({
      entry: ENTRY,
      home: config.home,
      logDir: join(config.home, "logs"),
    });
    const router = new Router({
      store,
      config,
      source,
      launcher,
      memory,
      log: (line) => ui.log("router", line),
    });

    if (sub === "once") {
      const summary = await router.tick();
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      return 0;
    }

    process.stdout.write(
      `${ui.bold("supermeta router")} ${ui.dim(`source=${source.name} workers=${config.max_workers} poll=${config.poll_interval_ms}ms`)}\n`,
    );

    let stopping = false;
    process.once("SIGINT", () => {
      stopping = true;
      process.stdout.write(ui.dim("\nstopping after this tick\n"));
    });

    while (!stopping) {
      const summary = await router.tick();
      if (summary.ingested > 0 || summary.dispatched > 0 || summary.recovered > 0) {
        process.stdout.write(
          ui.dim(
            `tick events=${summary.ingested} created=${summary.created} routed=${summary.routed} ignored=${summary.ignored} dispatched=${summary.dispatched} recovered=${summary.recovered}\n`,
          ),
        );
      }
      await sleep(config.poll_interval_ms);
    }
    return 0;
  } finally {
    store.close();
  }
}

function printStatus(store: Store, config: Config): void {
  const metrics = store.metrics();
  const workers = store.listWorkers().filter((worker) => worker.state === "alive");
  process.stdout.write(
    [
      `${ui.bold("router")}  db=${config.db_path}`,
      `        max_workers=${config.max_workers} stale=${config.watchdog.stale_ms}ms`,
      `        events=${metrics.events} decisions=${metrics.decisions}`,
      `        queued=${metrics.tasks_queued} running=${metrics.tasks_running} done=${metrics.tasks_done} failed=${metrics.tasks_failed}`,
      `        workers_alive=${workers.length}`,
    ].join("\n") + "\n",
  );
  if (workers.length > 0) {
    process.stdout.write(
      ui.table(
        ["worker", "task", "pid", "heartbeat"],
        workers.map((worker) => [worker.id, worker.task_id, String(worker.pid ?? "-"), iso(worker.heartbeat_at)]),
      ) + "\n",
    );
  }
}

// ---------------------------------------------------------------- worker

async function cmdWorker(sub: string | undefined, flags: Map<string, string | true>): Promise<number> {
  if (sub !== "run") {
    process.stderr.write("usage: supermeta worker run --task <id>\n");
    return 2;
  }
  const taskId = str(flags, "task");
  if (!taskId) {
    process.stderr.write("missing --task <id>\n");
    return 2;
  }
  const { config, store, memory } = workspace(flags);
  try {
    const result = await runTask({
      store,
      config,
      memory,
      taskId,
      log: (line) => (has(flags, "quiet") ? undefined : ui.log("worker", line)),
    });
    return result.ok ? 0 : 1;
  } finally {
    store.close();
  }
}

// ----------------------------------------------------------------- state

function cmdTasks(flags: Map<string, string | true>): number {
  const { store } = workspace(flags);
  try {
    const stateFilter = str(flags, "state") as TaskState | undefined;
    const tasks = store.listTasks({ state: stateFilter, limit: Number(str(flags, "limit") ?? 20) });
    if (tasks.length === 0) {
      process.stdout.write("no tasks\n");
      return 0;
    }
    process.stdout.write(
      ui.table(
        ["id", "thread", "state", "att", "when", "summary"],
        tasks.map((task) => [
          task.id,
          task.thread,
          ui.state(task.state),
          `${task.attempts}/${task.max_attempts}`,
          taskWhen(task),
          (task.summary ?? task.last_error ?? "").slice(0, 64),
        ]),
      ) + "\n",
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdTask(taskId: string | undefined, flags: Map<string, string | true>): number {
  if (!taskId) {
    process.stderr.write("usage: supermeta task <id>\n");
    return 2;
  }
  const { store } = workspace(flags);
  try {
    const task = store.getTask(taskId);
    if (!task) {
      process.stderr.write(`no such task: ${taskId}\n`);
      return 1;
    }
    process.stdout.write(
      [
        `${ui.bold(task.id)}  ${ui.state(task.state)}  ${task.thread}`,
        `  repo      ${task.repo}`,
        `  title     ${task.title}`,
        `  job       ${task.job}`,
        `  attempts  ${task.attempts}/${task.max_attempts}`,
        `  stalls    ${task.stalls}`,
        `  created   ${iso(task.created_at)}`,
        `  started   ${iso(task.started_at)}`,
        `  finished  ${iso(task.finished_at)}`,
        `  next try  ${task.state === "queued" && task.next_attempt_at > Date.now() ? iso(task.next_attempt_at) : "-"}`,
        `  worker    ${task.worker_id ?? "-"}`,
        `  summary   ${task.summary ?? "-"}`,
        `  error     ${task.last_error ?? "-"}`,
      ].join("\n") + "\n",
    );

    const runs = store.listRuns(task.id);
    if (runs.length > 0) {
      process.stdout.write("\n" + ui.table(
        ["attempt", "worker", "pid", "exit", "took", "note"],
        runs.map((run) => [
          String(run.attempt),
          run.worker_id,
          String(run.pid ?? "-"),
          String(run.exit_code ?? "-"),
          run.finished_at ? duration(run.finished_at - run.started_at) : "open",
          (run.note ?? "").slice(0, 56),
        ]),
      ) + "\n");
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdEvents(flags: Map<string, string | true>): number {
  const { store } = workspace(flags);
  try {
    const events = store.listEvents(Number(str(flags, "limit") ?? 20)).reverse();
    if (events.length === 0) {
      process.stdout.write("no events\n");
      return 0;
    }
    process.stdout.write(
      ui.table(
        ["seq", "kind", "thread", "actor", "status", "title"],
        events.map((event) => [
          String(event.seq),
          event.kind,
          event.thread,
          event.actor,
          event.status,
          event.title.slice(0, 48),
        ]),
      ) + "\n",
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdMemory(thread: string | undefined, flags: Map<string, string | true>): number {
  if (!thread) {
    process.stderr.write("usage: supermeta memory <owner/name#n>\n");
    return 2;
  }
  const { store, memory } = workspace(flags);
  try {
    const records = memory.history(thread);
    if (records.length === 0) {
      process.stdout.write(`no memory for ${thread}\n`);
      return 0;
    }
    for (const record of records) {
      const where = record.level === "spill" ? ui.dim(`spill ${record.ref ?? ""}`) : ui.dim("inline");
      process.stdout.write(`${ui.dim(iso(record.created_at))} ${where} ${record.content.slice(0, 160).replace(/\n/g, " ")}\n`);
    }
    const chars = store.contextChars(thread);
    process.stdout.write(
      `\n${ui.bold("context")} inline=${chars.inline} chars   spill=${chars.spill} chars (not loaded)\n`,
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdReport(flags: Map<string, string | true>): number {
  const { config, store } = workspace(flags);
  try {
    printReport(store, config);
    return 0;
  } finally {
    store.close();
  }
}

function cmdWatchdog(flags: Map<string, string | true>): number {
  const { config, store } = workspace(flags);
  try {
    const incidents = sweep({ store, config, signal: !has(flags, "dry-run") });
    if (incidents.length === 0) {
      process.stdout.write("no stalled tasks\n");
      return 0;
    }
    process.stdout.write(
      ui.table(
        ["task", "thread", "action", "detail"],
        incidents.map((incident) => [incident.task_id, incident.thread, incident.action, incident.detail]),
      ) + "\n",
    );
    return 0;
  } finally {
    store.close();
  }
}

function cmdDoctor(flags: Map<string, string | true>): number {
  const { config } = workspace(flags);
  const checks: [string, boolean, string][] = [];
  checks.push(["node", Number(process.versions.node.split(".")[0]) >= 22, process.versions.node]);
  checks.push(["config", existsSync(join(config.home, "config.json")), join(config.home, "config.json")]);
  checks.push(["state dir", existsSync(config.home), config.home]);
  checks.push(["jobs", listJobs().length > 0, listJobs().map((job) => job.name).join(", ")]);
  const token = process.env[config.github.token_env];
  checks.push([
    "github token",
    Boolean(token) || config.watch.repos.length > 0,
    token ? `set via ${config.github.token_env}` : config.watch.repos.length > 0 ? "not set (public repo polling only)" : "missing",
  ]);
  checks.push(["watch repos", config.watch.repos.length > 0, config.watch.repos.join(", ") || "(notifications mode)"]);

  process.stdout.write(
    ui.table(
      ["check", "ok", "detail"],
      checks.map(([name, ok, detail]) => [name, ok ? ui.green("yes") : ui.yellow("no"), detail]),
    ) + "\n",
  );
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

// ---------------------------------------------------------------- report

function printReport(store: Store, config: Config): void {
  const metrics = store.metrics();

  ui.section("Route trace");
  const decisions = store.listDecisions(20).reverse();
  process.stdout.write(
    ui.table(
      ["event", "thread", "action", "reason"],
      decisions.map((decision) => [
        decision.event_id.replace(/^demo:/, ""),
        decision.thread,
        decision.action,
        decision.reason.slice(0, 48),
      ]),
    ) + "\n",
  );

  ui.section("Tasks");
  const tasks = [...store.listTasks({ limit: 50 })].sort((a, b) => a.created_at - b.created_at);
  process.stdout.write(
    ui.table(
      ["id", "thread", "state", "att", "took", "summary"],
      tasks.map((task) => [
        task.id,
        task.thread,
        ui.state(task.state),
        `${task.attempts}/${task.max_attempts}`,
        task.started_at && task.finished_at ? duration(task.finished_at - task.started_at) : "-",
        (task.summary ?? task.last_error ?? "").slice(0, 70),
      ]),
    ) + "\n",
  );

  ui.section("Metrics");
  const p50 = percentile(metrics.durations_ms, 50);
  const p95 = percentile(metrics.durations_ms, 95);
  const rows: [string, string][] = [
    ["events", `${metrics.events}  (routed ${metrics.events_routed}, ignored ${metrics.events_ignored})`],
    ["router decisions", String(metrics.decisions)],
    ["tasks", `${metrics.tasks}  (done ${metrics.tasks_done}, failed ${metrics.tasks_failed}, dead ${metrics.tasks_dead})`],
    ["worker attempts", String(metrics.attempts)],
    ["worker retries", String(metrics.retries)],
    ["stalls recovered", String(metrics.stalls)],
    ["watchdog recoveries", String(metrics.recoveries)],
    ["task p50 / p95", `${duration(p50)} / ${duration(p95)}`],
    ["workers", `ceiling ${config.max_workers}, per repo ${config.limits.max_workers_per_repo}`],
    [
      "context",
      `inline ${metrics.inline_chars} chars vs spill ${metrics.spill_chars} chars kept out of context`,
    ],
  ];
  for (const [key, value] of rows) {
    process.stdout.write(`  ${ui.dim(key.padEnd(20))} ${value}\n`);
  }
  process.stdout.write("\n");
}

function printHelp(): void {
  process.stdout.write(
    [
      `${ui.bold("supermeta")} ${VERSION} - router/worker super-agent harness for open-source work`,
      "",
      ui.bold("usage"),
      "  supermeta <command> [options]",
      "",
      ui.bold("commands"),
      "  init [repos...]           write a config (default ~/.supermeta/config.json)",
      "  demo                      run the scripted 6-event demo end to end",
      "  router run                long-running routing loop",
      "  router once               one tick, prints a JSON summary",
      "  router status             counters and live workers",
      "  worker run --task <id>    execute one task (spawned by the router)",
      "  tasks [--state s]         list tasks",
      "  task <id>                 task detail with every attempt",
      "  events                    ingested events",
      "  memory <thread>           inline summaries + spill references",
      "  watchdog [--dry-run]      sweep stalled tasks once",
      "  report                    metrics for the current state",
      "  doctor                    environment checks",
      "",
      ui.bold("common flags"),
      "  --home <dir>              override state root",
      "  --no-subscription         demo only: disable thread routing (A/B)",
      "  --inline                  demo only: run workers in-process",
      "",
    ].join("\n"),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compact "when" cell: took X, waiting Y for a retry, or a dash. */
function taskWhen(task: Task): string {
  if (task.state === "queued") {
    const wait = task.next_attempt_at - Date.now();
    return wait > 0 ? `in ${describeDelay(wait)}` : "ready";
  }
  if (task.started_at && task.finished_at) return duration(task.finished_at - task.started_at);
  return "-";
}

const isEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase();

if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${ui.red("fatal:")} ${String(error)}\n`);
      process.exitCode = 1;
    });
}
