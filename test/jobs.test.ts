import { test } from "node:test";
import assert from "node:assert/strict";
import { extractCommand, extractPaths, getJob, listJobs } from "../src/worker/jobs.ts";

test("candidate files are pulled out of inline code spans", () => {
  const paths = extractPaths("fails in `src/config/parse.ts` and `test/config.test.ts`");
  assert.deepEqual(paths.sort(), ["src/config/parse.ts", "test/config.test.ts"]);
});

test("urls are not mistaken for files", () => {
  const paths = extractPaths("see `https://example.com/a.ts`");
  assert.deepEqual(paths, []);
});

test("a repro command is detected from the issue body", () => {
  assert.equal(extractCommand("Repro:\n\n$ bun test test/config.test.ts"), "bun test test/config.test.ts");
  assert.equal(extractCommand("nothing to run here"), null);
});

test("jobs are addressable by name and unknown names fail loudly", () => {
  assert.equal(getJob("triage").name, "triage");
  assert.throws(() => getJob("nope"), /unknown job/);
  assert.ok(listJobs().length >= 3);
});
