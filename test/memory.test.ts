import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { MemoryLayer } from "../src/router/memory.ts";
import { makeHome } from "./helpers.ts";

test("inline memory stays small while the full record is spilt to disk", (t) => {
  const home = makeHome();
  const store = new Store(join(home, "state.db"));
  const memory = new MemoryLayer(store, join(home, "artifacts"));
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const task = store.createTask({
    thread: "acme/widget#1",
    repo: "acme/widget",
    title: "Crash on empty config",
    kind: "issue_opened",
    job: "sleep",
    payload: {},
    priority: 50,
    max_attempts: 1,
    origin_event: "e1",
  });

  const summary = "s".repeat(5_000);
  const recorded = memory.remember(task, {
    summary,
    artifacts: [{ name: "notes.md", content: "n".repeat(3_000) }],
  });

  assert.ok(recorded.inlineChars <= 400, `inline was ${recorded.inlineChars}`);
  assert.ok(recorded.spillChars > 5_000);

  const context = memory.context(task.thread);
  assert.equal(context.inline.length, 1);
  assert.ok(context.inlineChars <= 400);
  assert.ok(context.spillChars > 5_000);
  assert.ok(context.spillRefs[0]?.ref.includes(task.id));

  const artifact = memory.readArtifact(context.spillRefs[0]?.ref ?? "");
  assert.ok(artifact?.includes("Crash on empty config"));
});

test("context only carries the most recent inline records", (t) => {
  const home = makeHome();
  const store = new Store(join(home, "state.db"));
  const memory = new MemoryLayer(store, join(home, "artifacts"));
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  for (let index = 0; index < 12; index += 1) {
    store.addMemory({
      thread: "acme/widget#1",
      kind: "summary",
      level: "inline",
      content: `[t_${index}] summary ${index}`,
    });
  }

  const context = memory.context("acme/widget#1", { maxInline: 5 });
  assert.equal(context.inline.length, 5);
  assert.match(context.inline[4] ?? "", /t_11/);
});
