import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ensureDir } from "./util.ts";
import type { RetryPolicy } from "./retry.ts";

export interface Config {
  /** Root for all durable state. Defaults to ~/.supermeta */
  home: string;
  db_path: string;
  /** Hard ceiling on concurrently running workers. */
  max_workers: number;
  poll_interval_ms: number;
  watch: {
    /** Empty means "accept every repository that arrives through a source". */
    repos: string[];
    labels: string[];
    ignore_actors: string[];
  };
  watchdog: {
    /** A running task whose heartbeat is older than this is considered stalled. */
    stale_ms: number;
    /** Grace period for tasks that were dispatched but never produced a heartbeat. */
    grace_ms: number;
    tick_ms: number;
  };
  jobs: { default_job: string };
  /** Backoff between attempts, plus how many stalls a task may absorb. */
  retry: RetryPolicy & { max_stalls: number };
  limits: {
    /** Keep one repository from occupying every worker slot. */
    max_workers_per_repo: number;
    /** Client-side ceiling for GitHub API calls, per process. */
    github_requests_per_minute: number;
  };
  experiments: {
    /** Turn off to measure how much duplicate work thread routing prevents. */
    thread_subscription: boolean;
  };
  github: { api_base: string; token_env: string; per_page: number };
}

export const DEFAULT_CONFIG: Config = {
  home: join(homedir(), ".supermeta"),
  db_path: "",
  max_workers: 2,
  poll_interval_ms: 1500,
  watch: {
    repos: [],
    labels: ["good first issue", "help wanted", "bug"],
    ignore_actors: [],
  },
  watchdog: { stale_ms: 45_000, grace_ms: 15_000, tick_ms: 5_000 },
  jobs: { default_job: "triage" },
  retry: { base_ms: 15_000, factor: 2, max_ms: 30 * 60_000, jitter: 0.2, max_stalls: 2 },
  limits: { max_workers_per_repo: 1, github_requests_per_minute: 20 },
  experiments: { thread_subscription: true },
  github: { api_base: "https://api.github.com", token_env: "GITHUB_TOKEN", per_page: 30 },
};

export interface ResolveOptions {
  home?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

export function resolveHome(opts: ResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const raw = opts.home ?? env["SUPERMETA_HOME"] ?? DEFAULT_CONFIG.home;
  return resolve(raw);
}

export function configPath(home: string): string {
  return join(home, "config.json");
}

export function loadConfig(opts: ResolveOptions = {}): Config {
  const home = resolveHome(opts);
  const path = configPath(home);
  const base: Config = {
    ...DEFAULT_CONFIG,
    home,
    db_path: join(home, "state.db"),
    watch: { ...DEFAULT_CONFIG.watch },
    watchdog: { ...DEFAULT_CONFIG.watchdog },
    retry: { ...DEFAULT_CONFIG.retry },
    limits: { ...DEFAULT_CONFIG.limits },
  };
  if (!existsSync(path)) return base;

  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Config>;
  const rawDb = raw.db_path;
  const merged: Config = {
    ...base,
    ...raw,
    home,
    db_path: rawDb ? (isAbsolute(rawDb) ? rawDb : join(home, rawDb)) : join(home, "state.db"),
    watch: { ...base.watch, ...(raw.watch ?? {}) },
    watchdog: { ...base.watchdog, ...(raw.watchdog ?? {}) },
    jobs: { ...base.jobs, ...(raw.jobs ?? {}) },
    retry: { ...base.retry, ...(raw.retry ?? {}) },
    limits: { ...base.limits, ...(raw.limits ?? {}) },
    experiments: { ...base.experiments, ...(raw.experiments ?? {}) },
    github: { ...base.github, ...(raw.github ?? {}) },
  };
  if (process.env["SUPERMETA_DB"]) merged.db_path = resolve(process.env["SUPERMETA_DB"]);
  return merged;
}

export function writeConfig(config: Config): string {
  ensureDir(config.home);
  const path = configPath(config.home);
  const { home: _home, db_path: _db, ...rest } = config;
  writeFileSync(path, `${JSON.stringify({ ...rest, db_path: "state.db" }, null, 2)}\n`, "utf8");
  return path;
}
