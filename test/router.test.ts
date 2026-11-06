import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { MemoryLayer } from "../src/router/memory.ts";
import { Router } from "../src/router/router.ts";
import { InlineLauncher } from "../src/router/launchers.ts";
import { FakeSource, event, makeHome, testConfig } from "./helpers.ts";
import type { SourcedEvent } from "../src/types.ts";

function build(home: string, events: SourcedEvent[], overrides: Parameters<typeof testConfig>[1] = {}) {
  const store = new Store(join(home, "state.db"));
  const config = testConfig(home, overrides);
  const memory = new MemoryLayer(store, join(home, "artifacts"));
  const source = new FakeSource(events);
  const launcher = new InlineLauncher({ store, config, memory, log: () => undefined });
  const router = new Router({ store, config, source, launcher, memory, log: () => undefined });
  return { store, config, memory, source, router };
}

test("a follow-up event joins the live task instead of creating a second one", async (t) => {
  const home = makeHome();
  const { store, router } = build(home, [
    event({ id: "e1", kind: "issue_opened" }),
    event({ id: "e2", kind: "issue_commented", title: "Re: Crash on empty config" }),
  ]);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const summary = await router.tick();
  assert.equal(summary.ingested, 2);
  assert.equal(summary.created, 1);
  assert.equal(summary.routed, 1);
  assert.equal(summary.decisions, 2);

  await router.drain();

  const tasks = store.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.state, "done");

  const decisions = store.listDecisions(10);
  assert.equal(decisions.filter((decision) => decision.action === "route_to_task").length, 1);
  assert.equal(decisions.filter((decision) => decision.action === "create_task").length, 1);
});

test("duplicate events from overlapping polls are ingested once", async (t) => {
  const home = makeHome();
  const once = event({ id: "same-id" });
  const { store, router } = build(home, [once]);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  assert.equal(store.ingestEvent(once), true);
  assert.equal(store.ingestEvent(once), false);

  const summary = await router.tick();
  assert.equal(summary.ingested, 0);
  await router.drain();
});

test("the router never runs more workers than the ceiling", async (t) => {
  const home = makeHome();
  const events = [1, 2, 3, 4].map((index) =>
    event({ id: `e${index}`, thread: `acme/widget#${index}` }),
  );
  const { store, router } = build(home, events, { max_workers: 2 });
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const summary = await router.tick();
  assert.equal(summary.created, 4);
  assert.equal(summary.dispatched, 2);
  assert.equal(store.countRunning(), 2);

  await router.drain();
  assert.equal(store.metrics().tasks_done, 2);
});

test("a finished task leaves an inline summary and a spill artifact", async (t) => {
  const home = makeHome();
  const { store, router, memory } = build(home, [event({ id: "e1" })]);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  await router.tick();
  await router.drain();

  const context = memory.context("acme/widget#1");
  assert.equal(context.inline.length, 1);
  assert.equal(context.spillRefs.length, 1);
  assert.ok(context.spillChars > 0);
  assert.ok(context.inlineChars < context.spillChars);
  assert.match(context.inline[0] ?? "", /^\[t_/);
});

test("one repository cannot occupy every worker slot", async (t) => {
  const home = makeHome();
  const events = [
    event({ id: "a1", repo: "acme/widget", thread: "acme/widget#1" }),
    event({ id: "a2", repo: "acme/widget", thread: "acme/widget#2" }),
    event({ id: "b1", repo: "acme/gadget", thread: "acme/gadget#1" }),
    event({ id: "b2", repo: "acme/gadget", thread: "acme/gadget#2" }),
  ];
  const { store, router } = build(home, events, {
    max_workers: 4,
    limits: { max_workers_per_repo: 1, github_requests_per_minute: 0 },
  });
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const summary = await router.tick();
  assert.equal(summary.created, 4);
  assert.equal(summary.dispatched, 2, "one per repository");

  const running = store.listTasks().filter((task) => task.state !== "queued");
  assert.deepEqual([...new Set(running.map((task) => task.repo))].sort(), ["acme/gadget", "acme/widget"]);

  await router.drain();
});

test("a task is not dispatched before its backoff elapses", async (t) => {
  const home = makeHome();
  const { store, router } = build(home, []);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const task = store.createTask({
    thread: "acme/widget#9",
    repo: "acme/widget",
    title: "retry me later",
    kind: "issue_opened",
    job: "sleep",
    payload: { ms: 5 },
    priority: 10,
    max_attempts: 3,
    origin_event: "e9",
  });
  store.requeueTask(task.id, "transient", Date.now() + 60_000);

  assert.equal((await router.tick()).dispatched, 0);

  store.db.prepare("update tasks set next_attempt_at = 0 where id = ?").run(task.id);
  assert.equal((await router.tick()).dispatched, 1);
  await router.drain();
  assert.equal(store.getTask(task.id)?.state, "done");
});
