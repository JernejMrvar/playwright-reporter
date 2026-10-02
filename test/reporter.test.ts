import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApiError } from "../src/client";
import { TestManagementReporter } from "../src/reporter";
import type { TestResultPayload } from "../src/types";

type Ack = { mapped: number; unmapped: number; errors: string[]; cases: never[] };
type Step = Ack | Error;

function setup(steps: Step[]) {
  const dir = mkdtempSync(join(tmpdir(), "alpaqa-reporter-"));
  const unsentResultsPath = join(dir, "unsent.json");
  const reporter = new TestManagementReporter({
    baseUrl: "http://localhost",
    apiToken: "tm_x",
    retryBaseDelayMs: 0,
    unsentResultsPath,
  });
  const sent: TestResultPayload[][] = [];
  let completed: string | undefined;
  const queue = [...steps];
  const ok = (results: TestResultPayload[]): Ack => ({
    mapped: results.filter((r) => r.testCaseId !== undefined).length,
    unmapped: results.filter((r) => r.testCaseId === undefined).length,
    errors: [],
    cases: [],
  });
  const client = {
    reportResults: async (_id: number, results: TestResultPayload[]) => {
      sent.push(results);
      const step = queue.shift();
      if (step instanceof Error) throw step;
      return step ?? ok(results);
    },
    completeTestRun: async (_id: number, status: string) => {
      completed = status;
    },
  };
  Object.assign(reporter, { client, testRunId: 1, runName: "r" });
  return { reporter, sent, unsentResultsPath, status: () => completed };
}

function fakeTest(id: string, title: string) {
  return { id, title, tags: [], location: { file: "/a.spec.ts" } } as never;
}
const passed = { status: "passed", retry: 0, duration: 1, errors: [], attachments: [] } as never;

async function run(reporter: TestManagementReporter, titles: string[]) {
  const tests = titles.map((t, i) => fakeTest(String(i), t));
  Object.assign(reporter, { allTests: tests });
  for (const t of tests) await reporter.onTestEnd(t, passed);
  await reporter.onEnd({ status: "passed" } as never);
}

const transient = () => new ApiError("503", 503, false, true);
const lostAck = () => new ApiError("timeout", undefined, true, true);
const permanent = () => new ApiError("400", 400, false, false);

test("transient error: batch is retained and delivered on retry, run completes", async () => {
  const { reporter, sent, status } = setup([transient()]);
  await run(reporter, ["a @TC-1", "plain"]);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], sent[0]);
  assert.equal(status(), "COMPLETED");
});

test("exhausted retries: results are retained, saved for recovery and the run is not COMPLETED", async () => {
  const { reporter, unsentResultsPath, status } = setup([transient(), transient(), transient(), transient(), transient(), transient()]);
  await run(reporter, ["a @TC-1"]);
  assert.equal(status(), "CANCELLED");
  const saved = JSON.parse(readFileSync(unsentResultsPath, "utf8"));
  assert.equal(saved.undelivered.length, 1);
  assert.equal(saved.undelivered[0].testCaseId, 1);
});

test("permanent rejection: not retried, saved, run not COMPLETED", async () => {
  const { reporter, sent, unsentResultsPath, status } = setup([permanent()]);
  await run(reporter, ["a @TC-1"]);
  assert.equal(sent.length, 1);
  assert.equal(status(), "CANCELLED");
  assert.equal(JSON.parse(readFileSync(unsentResultsPath, "utf8")).undelivered.length, 1);
});

test("lost acknowledgement: mapped is resent, unmapped is never resent", async () => {
  const { reporter, sent, unsentResultsPath, status } = setup([lostAck()]);
  await run(reporter, ["a @TC-1", "plain"]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].length, 1);
  assert.equal(sent[1][0].testCaseId, 1);
  assert.equal(sent.flat().filter((r) => r.testCaseId === undefined).length, 1);
  assert.equal(status(), "CANCELLED");
  const saved = JSON.parse(readFileSync(unsentResultsPath, "utf8"));
  assert.equal(saved.unconfirmedUnmapped.length, 1);
});

test("partial acceptance: rejections are counted and the run is not COMPLETED", async () => {
  const { reporter, unsentResultsPath, status } = setup([
    { mapped: 1, unmapped: 0, errors: ["Test case @TC-2 was deleted"], cases: [] },
  ]);
  await run(reporter, ["a @TC-1", "b @TC-2"]);
  assert.equal(status(), "CANCELLED");
  const saved = JSON.parse(readFileSync(unsentResultsPath, "utf8"));
  assert.equal(saved.rejectedCount, 1);
  assert.deepEqual(saved.rejectionMessages, ["Test case @TC-2 was deleted"]);
});

test("full acknowledgement: run COMPLETED and no recovery file", async () => {
  const { reporter, unsentResultsPath, status } = setup([]);
  await run(reporter, ["a @TC-1", "plain"]);
  assert.equal(status(), "COMPLETED");
  assert.equal(existsSync(unsentResultsPath), false);
});
