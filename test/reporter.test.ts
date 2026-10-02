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

const transient = () => new ApiError("429", 429, false, true);
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

test("partial acceptance: rejections are recorded but do not cancel the run", async () => {
  const { reporter, unsentResultsPath, status } = setup([
    { mapped: 1, unmapped: 0, errors: ["Test case @TC-2 was deleted"], cases: [] },
  ]);
  await run(reporter, ["a @TC-1", "b @TC-2"]);
  assert.equal(status(), "COMPLETED");
  const saved = JSON.parse(readFileSync(unsentResultsPath, "utf8"));
  assert.equal(saved.rejectedCount, 1);
  assert.deepEqual(saved.rejectionMessages, ["Test case @TC-2 was deleted"]);
  assert.equal(saved.partiallyRejectedBatches[0].batch.length, 2);
});

test("full acknowledgement: run COMPLETED and no recovery file", async () => {
  const { reporter, unsentResultsPath, status } = setup([]);
  await run(reporter, ["a @TC-1", "plain"]);
  assert.equal(status(), "COMPLETED");
  assert.equal(existsSync(unsentResultsPath), false);
});

test("onEnd waits for an in-flight flush and sees its failure", async () => {
  const { reporter, unsentResultsPath, status } = setup([]);
  const titles = Array.from({ length: 50 }, (_, i) => `t${i} @TC-${i + 1}`);
  const tests = titles.map((t, i) => fakeTest(String(i), t));
  Object.assign(reporter, { allTests: tests });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  Object.assign((reporter as unknown as { client: object }).client, {
    reportResults: async () => {
      await gate;
      throw new ApiError("400", 400, false, false);
    },
  });
  // Not awaited, like Playwright: the 50th result starts a flush.
  for (const t of tests) void reporter.onTestEnd(t, passed);
  await new Promise((r) => setImmediate(r));
  const ending = reporter.onEnd({ status: "passed" } as never);
  release();
  await ending;
  assert.equal(status(), "CANCELLED");
  assert.equal(JSON.parse(readFileSync(unsentResultsPath, "utf8")).undelivered.length, 50);
});

test("retained results are resent in bounded batches", async () => {
  const fails = Array.from({ length: 30 }, () => transient());
  const { reporter, sent, status } = setup(fails);
  const tests = Array.from({ length: 550 }, (_, i) => fakeTest(String(i), `t${i} @TC-${i + 1}`));
  Object.assign(reporter, { allTests: tests });
  for (const t of tests) await reporter.onTestEnd(t, passed);
  await reporter.onEnd({ status: "passed" } as never);
  assert.ok(Math.max(...sent.map((b) => b.length)) <= 50);
  assert.equal(status(), "COMPLETED");
});

test("flushes are serialized: an older retried payload never overwrites a newer result", async () => {
  const { reporter, sent, status } = setup([]);
  const t = fakeTest("0", "a @TC-1");
  const filler = Array.from({ length: 49 }, (_, i) => fakeTest(String(i + 1), `f${i} @TC-${i + 2}`));
  Object.assign(reporter, { allTests: [t, ...filler] });
  let calls = 0;
  let releaseFirst!: () => void;
  const gate = new Promise<void>((r) => (releaseFirst = r));
  const applied = new Map<number, string>();
  Object.assign((reporter as unknown as { client: object }).client, {
    reportResults: async (_id: number, results: TestResultPayload[]) => {
      sent.push(results);
      if (calls++ === 0) {
        await gate;
        throw transient();
      }
      for (const r of results) applied.set(r.testCaseId!, r.status);
      return { mapped: results.length, unmapped: 0, errors: [], cases: [] };
    },
  });
  const failed = { status: "failed", retry: 0, duration: 1, errors: [], attachments: [] } as never;
  const flaky = { status: "passed", retry: 1, duration: 1, errors: [], attachments: [] } as never;
  const first = (async () => {
    await reporter.onTestEnd(t, failed);
    for (const f of filler) await reporter.onTestEnd(f, passed); // 50th result starts flush 1
  })();
  await new Promise((r) => setImmediate(r));
  const second = reporter.onTestEnd(t, flaky); // newer result for the same test
  releaseFirst();
  await Promise.all([first, second]);
  await reporter.onEnd({ status: "passed" } as never);
  assert.equal(applied.get(1), "FLAKY");
  assert.equal(status(), "COMPLETED");
});

test("ambiguous 503 does not resend unmapped results", async () => {
  const { reporter, sent } = setup([new ApiError("503", 503, true, true)]);
  await run(reporter, ["a @TC-1", "plain"]);
  assert.equal(sent.flat().filter((r) => r.testCaseId === undefined).length, 1);
});

test("malformed 200 body is not treated as a failed send", async () => {
  const { reporter, sent, status } = setup([
    { mapped: 1, unmapped: 1, errors: [], cases: "oops" } as never,
  ]);
  await run(reporter, ["a @TC-1", "plain"]);
  assert.equal(sent.length, 1);
  assert.equal(status(), "COMPLETED");
});
