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
