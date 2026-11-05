import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobResult, MemoryRecord, Task } from "../types.ts";
import type { Store } from "../db.ts";
import { clamp, ensureDir, slugThread } from "../util.ts";

export interface ThreadContext {
  /** Short summaries that travel with every prompt. */
  inline: string[];
  /** Pointers into the spill store; content is fetched only when needed. */
  spillRefs: { ref: string; chars: number; label: string }[];
  inlineChars: number;
  spillChars: number;
}

/**
 * Inline / Spill memory.
 *
 * Inline records are bounded summaries (a few hundred chars) and are always
 * loaded. Everything bulky is written to a spill file and only referenced by
 * path, which keeps long-running threads from growing the working context
 * without bound.
 */
export class MemoryLayer {
  readonly store: Store;
  readonly artifactRoot: string;

  constructor(store: Store, artifactRoot: string) {
    this.store = store;
    this.artifactRoot = artifactRoot;
  }

  /** Persist the durable part of a finished task and return the char accounting. */
  remember(task: Task, result: JobResult): { inlineChars: number; spillChars: number; ref: string } {
    const dir = ensureDir(join(this.artifactRoot, slugThread(task.thread)));
    const ref = join(dir, `${task.id}.md`);
    const body = renderArtifact(task, result);
    writeFileSync(ref, body, "utf8");

    this.store.addMemory({
      thread: task.thread,
      kind: "artifact",
      level: "spill",
      content: body,
      ref,
      task_id: task.id,
    });

    const inline = clamp(result.summary, 400);
    this.store.addMemory({
      thread: task.thread,
      kind: "summary",
      level: "inline",
      content: `[${task.id}] ${inline}`,
      ref: task.id,
      task_id: task.id,
    });

    return { inlineChars: inline.length, spillChars: body.length, ref };
  }

  /** Context assembled for a worker before it starts. */
  context(thread: string, opts: { maxInline?: number } = {}): ThreadContext {
    const maxInline = opts.maxInline ?? 8;
    const inlineRows = this.store.listMemory(thread, { level: "inline" });
    const spillRows = this.store.listMemory(thread, { level: "spill" });

    const inline = inlineRows.slice(-maxInline).map((row) => row.content);
    const spillRefs = spillRows.map((row) => ({
      ref: row.ref ?? "(no ref)",
      chars: row.content.length,
      label: row.kind,
    }));

    return {
      inline,
      spillRefs,
      inlineChars: inline.reduce((total, line) => total + line.length, 0),
      spillChars: spillRefs.reduce((total, entry) => total + entry.chars, 0),
    };
  }

  history(thread: string): MemoryRecord[] {
    return this.store.listMemory(thread);
  }

  readArtifact(ref: string): string | null {
    try {
      return readFileSync(ref, "utf8");
    } catch {
      return null;
    }
  }
}

function renderArtifact(task: Task, result: JobResult): string {
  const lines = [
    `# ${task.title}`,
    "",
    `- task: ${task.id}`,
    `- thread: ${task.thread}`,
    `- repo: ${task.repo}`,
    `- state: done`,
    "",
    "## Summary",
    "",
    result.summary,
    "",
  ];
  if (result.checklist && result.checklist.length > 0) {
    lines.push("## Checklist", "");
    for (const item of result.checklist) lines.push(`- [ ] ${item}`);
    lines.push("");
  }
  if (result.artifacts && result.artifacts.length > 0) {
    for (const artifact of result.artifacts) {
      lines.push(`## ${artifact.name}`, "", artifact.content, "");
    }
  }
  return lines.join("\n");
}
