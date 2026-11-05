import type { Config } from "../config.ts";
import type { JobContext, JobResult } from "../types.ts";
import { fetchIssue } from "../events/github.ts";
import { parseJson } from "../util.ts";

export interface Job {
  name: string;
  description: string;
  run(ctx: JobContext, deps: { config: Config }): Promise<JobResult>;
}

const demoJob: Job = {
  name: "demo",
  description: "Scripted multi-phase task used by `supermeta demo`",
  async run(ctx): Promise<JobResult> {
    const payload = parseJson<Record<string, unknown>>(ctx.task.payload, {});
    const steps = Number(payload["steps"] ?? 5);
    const stepMs = Number(payload["stepMs"] ?? 350);

    if (payload["hang"] === true && ctx.task.attempts === 1) {
      ctx.log("tool call wedged; blocking the event loop (heartbeat will stop)");
      // Simulates a hard hang: the event loop is blocked, so the heartbeat
      // timer never fires and the process looks dead to the watchdog.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
    }

    for (let step = 1; step <= steps; step += 1) {
      await delay(stepMs, ctx.signal);
      ctx.log(`phase ${step}/${steps}`);
    }

    const item = ctx.task.title.toLowerCase().includes("flaky") ? "flaky test" : "issue";
    return {
      summary: `Triaged ${item} "${ctx.task.title}" in ${ctx.task.repo}: reproduced locally, isolated the failure to one module, drafted a minimal fix plan.`,
      checklist: [
        "Reproduce with the command quoted in the issue",
        "Confirm the smallest failing case",
        "Patch and keep the diff under ~40 lines",
        "Add a regression test that fails before the patch",
        "Open the PR with why / what / risk",
      ],
      artifacts: [{ name: "notes.md", content: `# Working notes\n\n- thread: ${ctx.task.thread}\n- attempt: ${ctx.task.attempts}\n` }],
    };
  },
};

const triageJob: Job = {
  name: "triage",
  description: "Fetch the issue, assess scope, and produce a deterministic work plan",
  async run(ctx, deps): Promise<JobResult> {
    const payload = parseJson<Record<string, unknown>>(ctx.task.payload, {});
    const repo = String(payload["repo"] ?? ctx.task.repo);
    const number = Number(payload["number"] ?? 0);
    let title = String(payload["title"] ?? ctx.task.title);
    let body = String(payload["body"] ?? "");

    if (number > 0) {
      try {
        const issue = await fetchIssue(deps.config, repo, number);
        if (issue) {
          title = issue.title;
          body = issue.body ?? "";
          ctx.log(`issue ${repo}#${number}: ${issue.comments} comments, state=${issue.state}`);
        }
      } catch (error) {
        ctx.log(`issue fetch failed, using event payload: ${(error as Error).message}`);
      }
    }

    const paths = extractPaths(`${title}\n${body}`);
    const command = extractCommand(body);
    const scope = paths.length > 2 ? "likely multi-file" : paths.length > 0 ? "likely single-file" : "unknown until reproduced";

    return {
      summary: `${repo}#${number || "?"} ${title} — ${scope}; ${paths.length} candidate file(s); ${command ? `repro: ${command}` : "no repro command found"}`,
      checklist: [
        command ? `Run the quoted repro: ${command}` : "Reproduce the report before touching code",
        paths.length > 0 ? `Start reading at ${paths.slice(0, 3).join(", ")}` : "Locate the owning module from the stack trace or blame",
        "Write the smallest failing test first",
        "Keep the patch reviewable: one concern per PR",
        "Draft why / what / risk for the PR description",
      ],
      artifacts: paths.length > 0 ? [{ name: "candidate-files.md", content: paths.map((path) => `- ${path}`).join("\n") }] : [],
    };
  },
};

const sleepJob: Job = {
  name: "sleep",
  description: "Deterministic delay; used by tests to hold a worker slot",
  async run(ctx): Promise<JobResult> {
    const payload = parseJson<Record<string, unknown>>(ctx.task.payload, {});
    await delay(Number(payload["ms"] ?? 100), ctx.signal);
    return { summary: `slept ${payload["ms"] ?? 100}ms on ${ctx.task.thread}` };
  },
};

const registry = new Map<string, Job>([
  [demoJob.name, demoJob],
  [triageJob.name, triageJob],
  [sleepJob.name, sleepJob],
]);

export function getJob(name: string): Job {
  const job = registry.get(name);
  if (!job) {
    throw new Error(`unknown job "${name}" (known: ${[...registry.keys()].join(", ")})`);
  }
  return job;
}

export function listJobs(): Job[] {
  return [...registry.values()];
}

export function extractPaths(text: string): string[] {
  const found = new Set<string>();
  const pattern = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|md|json|ya?ml))`/g;
  for (const match of text.matchAll(pattern)) {
    const path = match[1];
    if (path && !path.includes("://")) found.add(path);
  }
  return [...found].slice(0, 8);
}

export function extractCommand(body: string): string | null {
  const pattern = /(?:^|\n)\s*(?:\$ )?((?:bun|npm|pnpm|yarn|cargo|go|pytest|python -m pytest|make)\s+[\w:@./ -]{2,80})/;
  const match = pattern.exec(body);
  return match?.[1]?.trim() ?? null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
