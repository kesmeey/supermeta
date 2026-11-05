import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { sweep } from "../src/watchdog/watchdog.ts";
import { makeHome, testConfig } from "./helpers.ts";

function seed(home: string, maxAttempts: number) {
  const store = new Store(join(home, "state.db"));
  const config = testConfig(home, {
    watchdog: { stale_ms: 1_000, grace_ms: 1_000, tick_ms: 100 },
  });
  const task = store.createTask({
    thread: "acme/widget#9",
    repo: "acme/widget",
    title: "wedged task",
    kind: "issue_opened",
    job: "sleep",
    payload: { ms: 5_000 },
    priority: 50,
    max_attempts: maxAttempts,
    origin_event: "e9",
  });
  store.beginDispatch(task.id, "w_seed");
  store.markRunning(task.id, "w_seed");
  // Pretend the worker went silent a full minute ago.
  store.db
    .prepare("update tasks set heartbeat_at = ?, updated_at = ? where id = ?")
    .run(Date.now() - 60_000, Date.now() - 60_000, task.id);
  return { store, config, task };
}

test("a stalled task is requeued once its heartbeat goes cold", (t) => {
  const home = makeHome();
  const { store, config, task } = seed(home, 3);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const incidents = sweep({ store, config, signal: false });
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]?.action, "requeued");
  assert.equal(store.getTask(task.id)?.state, "queued");
  assert.match(store.getTask(task.id)?.last_error ?? "", /watchdog: no heartbeat/);
});

test("a stalled task fails once attempts are exhausted", (t) => {
  const home = makeHome();
  const { store, config, task } = seed(home, 1);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const incidents = sweep({ store, config, signal: false });
  assert.equal(incidents[0]?.action, "failed");
  assert.equal(store.getTask(task.id)?.state, "failed");
});

test("a healthy task is left alone", (t) => {
  const home = makeHome();
  const { store, config, task } = seed(home, 3);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  store.db.prepare("update tasks set heartbeat_at = ? where id = ?").run(Date.now(), task.id);
  const incidents = sweep({ store, config, signal: false });
  assert.equal(incidents.length, 0);
  assert.equal(store.getTask(task.id)?.state, "running");
});

test("an abandoned attempt is closed instead of staying open forever", (t) => {
  const home = makeHome();
  const { store, config, task } = seed(home, 3);
  t.after(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const runSeq = store.startRun(task.id, "w_seed", 1, null);
  sweep({ store, config, signal: false });
  const run = store.listRuns(task.id).find((candidate) => candidate.seq === runSeq);
  assert.ok(run?.finished_at);
  assert.match(run?.note ?? "", /stale/);
});
