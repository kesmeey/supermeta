import type { Config } from "../config.ts";
import type { DecisionAction, EventRow, Task } from "../types.ts";

export interface Verdict {
  action: DecisionAction;
  reason: string;
  priority: number;
}

const KIND_PRIORITY: Record<EventRow["kind"], number> = {
  mentioned: 90,
  review_requested: 70,
  ci_failed: 65,
  issue_opened: 50,
  issue_commented: 40,
};

const LABEL_BONUS: Record<string, number> = {
  "good first issue": 15,
  "help wanted": 10,
  bug: 5,
};

/**
 * The Router's cheap, deterministic gate. It runs before any model call, so
 * every ignored event costs nothing and every routed event keeps a reason we
 * can audit later.
 */
export function decide(
  event: EventRow,
  config: Config,
  activeTask: Task | null,
): Verdict {
  const actor = event.actor.toLowerCase();
  const ignoredActors = config.watch.ignore_actors.map((entry) => entry.toLowerCase());

  if (actor.endsWith("[bot]") || ignoredActors.includes(actor)) {
    return { action: "ignore", reason: `bot actor: ${event.actor}`, priority: 0 };
  }

  if (config.watch.repos.length > 0 && !config.watch.repos.includes(event.repo)) {
    return { action: "ignore", reason: `repo not watched: ${event.repo}`, priority: 0 };
  }

  // Thread subscription: a live task already owns this conversation, so the
  // event is appended to that task instead of spawning a new one. This is the
  // mechanism that keeps Router decision volume flat as a thread gets noisy.
  if (activeTask && config.experiments.thread_subscription) {
    return {
      action: "route_to_task",
      reason: `thread subscription -> ${activeTask.id}`,
      priority: activeTask.priority,
    };
  }

  const labels = parseLabels(event.labels);
  const matched = labels.filter((label) => config.watch.labels.includes(label));
  const selfEvident = event.kind === "mentioned" || event.kind === "review_requested" || event.kind === "ci_failed";

  if (!selfEvident && matched.length === 0) {
    return { action: "ignore", reason: "no interest signal (labels/mention)", priority: 0 };
  }

  const bonus = matched.reduce((total, label) => total + (LABEL_BONUS[label] ?? 0), 0);
  return {
    action: "create_task",
    reason: matched.length > 0 ? `labels: ${matched.join(", ")}` : `direct: ${event.kind}`,
    priority: (KIND_PRIORITY[event.kind] ?? 10) + bonus,
  };
}

export function parseLabels(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((value) => String(value)) : [];
  } catch {
    return [];
  }
}
