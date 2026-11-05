import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type Config } from "../src/config.ts";
import type { EventSource } from "../src/events/source.ts";
import type { SourcedEvent } from "../src/types.ts";

export function makeHome(): string {
  const root = join(process.cwd(), "test", ".tmp");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, "run-"));
}

export function testConfig(home: string, overrides: Partial<Config> = {}): Config {
  return {
    home,
    db_path: join(home, "state.db"),
    max_workers: 2,
    poll_interval_ms: 10,
    watch: { repos: [], labels: ["bug"], ignore_actors: [] },
    watchdog: { stale_ms: 60_000, grace_ms: 5_000, tick_ms: 100 },
    jobs: { default_job: "sleep" },
    experiments: { thread_subscription: true },
    github: { ...DEFAULT_CONFIG.github },
    ...overrides,
  };
}

export class FakeSource implements EventSource {
  readonly name = "fake";
  #batch: SourcedEvent[];

  constructor(events: SourcedEvent[]) {
    this.#batch = events;
  }

  async poll(): Promise<SourcedEvent[]> {
    const out = this.#batch;
    this.#batch = [];
    return out;
  }

  exhausted(): boolean {
    return this.#batch.length === 0;
  }
}

export function event(overrides: Partial<SourcedEvent> = {}): SourcedEvent {
  return {
    id: "e1",
    source: "fake",
    kind: "issue_opened",
    repo: "acme/widget",
    thread: "acme/widget#1",
    actor: "mira",
    title: "Crash on empty config",
    body: "repro in `src/config/parse.ts`",
    labels: ["bug"],
    at: Date.now(),
    ...overrides,
  };
}
