import { test } from "node:test";
import assert from "node:assert/strict";
import { backoffDelay, describeDelay, type RetryPolicy } from "../src/retry.ts";

const policy: RetryPolicy = { base_ms: 1_000, factor: 2, max_ms: 10_000, jitter: 0 };
const noJitter = () => 0.5;

test("delay grows exponentially from the base", () => {
  assert.equal(backoffDelay(1, policy, noJitter), 1_000);
  assert.equal(backoffDelay(2, policy, noJitter), 2_000);
  assert.equal(backoffDelay(3, policy, noJitter), 4_000);
});

test("delay never exceeds the ceiling", () => {
  assert.equal(backoffDelay(20, policy, noJitter), 10_000);
});

test("jitter stays inside the configured band", () => {
  const jittered: RetryPolicy = { ...policy, jitter: 0.2 };
  assert.equal(backoffDelay(2, jittered, () => 0), 1_600);
  assert.equal(backoffDelay(2, jittered, () => 1), 2_400);
  assert.equal(backoffDelay(2, jittered, () => 0.5), 2_000);
});

test("a zero attempt is treated as the first retry", () => {
  assert.equal(backoffDelay(0, policy, noJitter), 1_000);
});

test("delay is rendered for humans", () => {
  assert.equal(describeDelay(0), "now");
  assert.equal(describeDelay(42_000), "42s");
  assert.equal(describeDelay(600_000), "10m");
});
