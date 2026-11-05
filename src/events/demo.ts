import type { SourcedEvent } from "../types.ts";
import type { EventSource } from "./source.ts";

export interface ScriptedStep {
  delayMs: number;
  event: SourcedEvent;
}

/**
 * A deterministic event stream used by `supermeta demo` and by tests.
 * Events are released by wall-clock delay so the routing trace reads like a
 * real working day instead of a bulk import.
 */
export class DemoSource implements EventSource {
  readonly name = "demo";
  #script: ScriptedStep[];
  #index = 0;
  #startedAt = Date.now();

  constructor(script: ScriptedStep[]) {
    this.#script = script;
  }

  get pending(): number {
    return this.#script.length - this.#index;
  }

  exhausted(): boolean {
    return this.#index >= this.#script.length;
  }

  async poll(): Promise<SourcedEvent[]> {
    const elapsed = Date.now() - this.#startedAt;
    const out: SourcedEvent[] = [];
    while (this.#index < this.#script.length) {
      const step = this.#script[this.#index];
      if (!step || step.delayMs > elapsed) break;
      out.push(step.event);
      this.#index += 1;
      break; // one event per ticket: the demo is a trace, not a load test
    }
    return out;
  }
}

const T0 = Date.now();

function at(offsetMs: number): number {
  return T0 + offsetMs;
}

export function demoScript(options: { faults?: boolean } = {}): ScriptedStep[] {
  const faults = options.faults ?? true;
  const steps: ScriptedStep[] = [
    {
      delayMs: 200,
      event: {
        id: "demo:issue:101",
        source: "demo",
        kind: "issue_opened",
        repo: "acme/widget",
        thread: "acme/widget#101",
        actor: "mira",
        title: "Crash when config string is empty",
        body: "Calling `parseConfig(\"\")` throws a TypeError. Expected an empty defaults object.\n\nRepro: `bun test test/config.test.ts`",
        url: "https://github.com/acme/widget/issues/101",
        labels: ["bug", "good first issue"],
        at: at(200),
      },
    },
    {
      delayMs: 1100,
      event: {
        id: "demo:comment:101:2",
        source: "demo",
        kind: "issue_commented",
        repo: "acme/widget",
        thread: "acme/widget#101",
        actor: "devon",
        title: "Re: Crash when config string is empty",
        body: "Reproduced on 2.1.0 as well. The guard is missing in `src/config/parse.ts`.",
        url: "https://github.com/acme/widget/issues/101#issuecomment-2",
        labels: ["bug", "good first issue"],
        at: at(1100),
      },
    },
    {
      delayMs: 1700,
      event: {
        id: "demo:review:55",
        source: "demo",
        kind: "review_requested",
        repo: "acme/gadget",
        thread: "acme/gadget#55",
        actor: "lin",
        title: "Refactor the retry loop in client.ts",
        body: "Opening a PR that splits the retry loop into its own module. Please review the backoff maths.",
        url: "https://github.com/acme/gadget/pull/55",
        labels: [],
        at: at(1700),
      },
    },
    {
      delayMs: 2300,
      event: {
        id: "demo:issue:102",
        source: "demo",
        kind: "issue_opened",
        repo: "acme/widget",
        thread: "acme/widget#102",
        actor: "growthhacker",
        title: "Earn $5000/week from home with this one trick",
        body: "no code, no repro",
        labels: [],
        at: at(2300),
      },
    },
    {
      delayMs: 3000,
      event: {
        id: "demo:ci:55:1",
        source: "demo",
        kind: "ci_failed",
        repo: "acme/gadget",
        thread: "acme/gadget#55",
        actor: "buildkite-ci",
        title: "checks failed: unit",
        body: "2 failing tests in test/client.test.ts",
        labels: [],
        at: at(3000),
      },
    },
    {
      delayMs: 3600,
      event: {
        id: "demo:issue:103",
        source: "demo",
        kind: "issue_opened",
        repo: "acme/widget",
        thread: "acme/widget#103",
        actor: "sam",
        title: "Flaky test: ttl expiry races the clock",
        body: "`test/ttl.test.ts` fails ~1 in 20 runs on CI.",
        labels: ["bug"],
        meta: { hang: true },
        at: at(3600),
      },
    },
  ];
  if (!faults) {
    for (const step of steps) delete step.event.meta;
  }
  return steps;
}
