import { test } from "node:test";
import assert from "node:assert/strict";
import { decide } from "../src/router/policy.ts";
import { testConfig } from "./helpers.ts";
import type { EventRow, Task } from "../src/types.ts";

function row(overrides: Partial<EventRow> = {}): EventRow {
  return {
    seq: 1,
    id: "e1",
    source: "fake",
    kind: "issue_opened",
    repo: "acme/widget",
    thread: "acme/widget#1",
    actor: "mira",
    title: "Crash on empty config",
    body: "",
    url: null,
    labels: JSON.stringify(["bug"]),
    meta: "{}",
    at: Date.now(),
    ingested_at: Date.now(),
    status: "new",
    ...overrides,
  };
}

const task = { id: "t_1", priority: 70, thread: "acme/widget#1" } as Task;

test("labels in the watch list create a task", () => {
  const verdict = decide(row(), testConfig("/tmp/x"), null);
  assert.equal(verdict.action, "create_task");
  assert.match(verdict.reason, /labels: bug/);
});

test("events without an interest signal are ignored", () => {
  const verdict = decide(row({ labels: "[]", kind: "issue_opened" }), testConfig("/tmp/x"), null);
  assert.equal(verdict.action, "ignore");
});

test("bot actors never create work", () => {
  const verdict = decide(row({ actor: "ci[bot]" }), testConfig("/tmp/x"), null);
  assert.equal(verdict.action, "ignore");
  assert.match(verdict.reason, /bot actor/);
});

test("repositories outside the watch list are ignored", () => {
  const config = testConfig("/tmp/x", { watch: { repos: ["other/repo"], labels: ["bug"], ignore_actors: [] } });
  const verdict = decide(row(), config, null);
  assert.equal(verdict.action, "ignore");
  assert.match(verdict.reason, /repo not watched/);
});

test("a live task on the same thread takes the event instead of a new task", () => {
  const verdict = decide(row({ kind: "issue_commented" }), testConfig("/tmp/x"), task);
  assert.equal(verdict.action, "route_to_task");
  assert.match(verdict.reason, /thread subscription -> t_1/);
});

test("disabling the experiment brings the duplicate task back", () => {
  const config = testConfig("/tmp/x", { experiments: { thread_subscription: false } });
  const verdict = decide(row({ kind: "issue_commented" }), config, task);
  assert.equal(verdict.action, "create_task");
});
