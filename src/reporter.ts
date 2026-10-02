import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { writeFileSync } from "fs";
import { relative, resolve } from "path";
import { ApiError, DEFAULT_REQUEST_TIMEOUT_MS, TestManagementClient } from "./client";
import type { TestManagementReporterConfig, TestResultPayload } from "./types";
import { extractTestCaseId, extractTestCasePublicId, mapPlaywrightStatus } from "./parser";

function getTestCaseReference(
  title: string,
  tags: string[],
  config: TestManagementReporterConfig
): Pick<TestResultPayload, "testCaseId" | "testCasePublicId"> {
  const parsedTags = config.parseTags !== false ? tags : [];
  return {
    testCaseId: extractTestCaseId(title, parsedTags, config.idPattern),
    testCasePublicId: extractTestCasePublicId(title, parsedTags, config.publicIdPattern),
  };
}

function formatReference(reference: Pick<TestResultPayload, "testCaseId" | "testCasePublicId">): string {
  if (reference.testCasePublicId) return `@TM:${reference.testCasePublicId}`;
  if (reference.testCaseId !== undefined) return `@TC-${reference.testCaseId}`;
  return "unmapped test";
}

function isMapped(payload: TestResultPayload): boolean {
  return payload.testCaseId !== undefined || payload.testCasePublicId !== undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class TestManagementReporter implements Reporter {
  private config: TestManagementReporterConfig;
  private client: TestManagementClient;
  private testRunId: number | null = null;
  private runName: string | null = null;
  private rootDir: string = process.cwd();
  private pendingResultsMap = new Map<TestCase, TestResultPayload>();
  private readonly BATCH_SIZE = 50;
  private allTests: TestCase[] = [];
  // Use test.id (stable string) instead of object reference so the check works
  // regardless of whether suite.allTests() returns the same object references
  // as those passed to onTestEnd.
  private reportedTestIds = new Set<string>();
  private screenshotResults: Array<{
    testCaseId?: number;
    testCasePublicId?: string;
    testTitle: string;
    filePath?: string;
    projectName?: string;
    durationMs: number;
    retryCount: number;
    screenshotPath: string;
    screenshotFilename: string;
    screenshotContentType: string;
    errorMessage?: string;
  }> = [];
  private testCaseIdMap = new Map<number, number>();
  private publicTestCaseResolutionMap = new Map<string, Promise<{ id: number }>>();
  // Results the server has not acknowledged. Nothing is dropped silently:
  // - pendingResultsMap keeps retryable failures for the next flush;
  // - undelivered holds results that are out of retries or permanently refused;
  // - unconfirmed holds unmapped results whose acknowledgement was lost. The
  //   server appends unmapped results, so resending them could duplicate data.
  //   (Mapped results are upserted per case and are safe to resend.)
  private undelivered: TestResultPayload[] = [];
  private unconfirmed: TestResultPayload[] = [];
  private rejectedCount = 0;
  private rejectionMessages: string[] = [];
  // The server's errors carry no index, so keep the whole batch of any
  // partially accepted request for recovery.
  private partiallyRejected: Array<{
    rejectedCount: number;
    errors: string[];
    batch: TestResultPayload[];
  }> = [];
  // Playwright does not await onTestEnd, so flushes can still be running
  // when onEnd fires; onEnd drains them before it decides the run's status.
  private activeFlushes = new Set<Promise<void>>();
  private flushThreshold = this.BATCH_SIZE;
  private screenshotErrorCount = 0;
  // Playwright does not await onBegin before firing onTestEnd, so fast tests
  // can complete before createTestRun returns. We store the creation promise
  // and await it in onTestEnd so no result is ever silently dropped.
  private runCreationPromise: Promise<void> = Promise.resolve();

  constructor(config: TestManagementReporterConfig) {
    if (!config.baseUrl) throw new Error("TestManagement reporter: baseUrl is required");
    if (!config.apiToken) throw new Error("TestManagement reporter: apiToken is required");

    this.config = {
      parseTags: true,
      idPattern: /@TC-(\d+)/,
      ...config,
    };
    this.client = new TestManagementClient(
      config.baseUrl,
      config.apiToken,
      config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    );
  }

  async onBegin(config: FullConfig, suite: Suite): Promise<void> {
    this.rootDir = config.rootDir;
    this.allTests = suite.allTests();

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const localDateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const name = this.config.runName ?? `Playwright Run - ${localDateTime}`;

    this.runCreationPromise = this.client.createTestRun({
      name,
      description: this.config.runDescription,
      source: "playwright",
      environment: this.config.environment ?? process.env.NODE_ENV ?? "development",
    }).then((run) => {
      this.testRunId = run.id;
      this.runName = run.name;
    }).catch((err) => {
      console.error("[TestManagement] Failed to create test run:", err);
    });

    await this.runCreationPromise;
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    // Wait for the run to be created before processing — Playwright does not
    // await onBegin, so fast tests can arrive here before testRunId is set.
    await this.runCreationPromise;
    if (!this.testRunId) return;

    // Use test.id (string) for stable deduplication — object references from
    // suite.allTests() vs onTestEnd may differ across Playwright versions.
    this.reportedTestIds.add(test.id);

    const tags = (test.tags ?? []).map((t: string) => t);
    const reference = getTestCaseReference(test.title, tags, this.config);

    let status = mapPlaywrightStatus(result.status);
    if (result.status === "passed" && result.retry > 0) {
      status = "FLAKY";
    }

    const payload: TestResultPayload = {
      ...reference,
      testTitle: test.title,
      filePath: test.location?.file,
      status,
      durationMs: result.duration,
      errorMessage:
        result.errors?.map((e) => e.message).join("\n") || undefined,
    };

    // Accumulate a screenshot comment for every failed/flaky attempt so that
    // each retry's failure is visible as a separate comment in the test run.
    // We no longer deduplicate by test — all retry failures are kept.
    if (status === "FAILED" || status === "FLAKY") {
      const screenshot = result.attachments?.find(
        (a) => a.contentType.startsWith("image/") && a.path
      );
      if (screenshot?.path && (reference.testCaseId !== undefined || reference.testCasePublicId !== undefined)) {
        this.screenshotResults.push({
          ...reference,
          testTitle: payload.testTitle,
          filePath: payload.filePath,
          projectName: test.parent?.project()?.name,
          durationMs: result.duration,
          retryCount: result.retry,
          screenshotPath: screenshot.path,
          screenshotFilename: screenshot.path.split("/").pop() ?? "screenshot.png",
          screenshotContentType: screenshot.contentType,
          errorMessage: payload.errorMessage,
        });
      }
    }

    // Overwrite any earlier retry result — the Map keeps only the final status
    // per test, so each test is counted exactly once.
    this.pendingResultsMap.set(test, payload);

    if (this.pendingResultsMap.size >= this.flushThreshold) {
      await this.trackFlush();
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.testRunId) return;

    for (const test of this.allTests) {
      if (!this.reportedTestIds.has(test.id)) {
        const tags = (test.tags ?? []).map((t: string) => t);
        const reference = getTestCaseReference(test.title, tags, this.config);

        this.pendingResultsMap.set(test, {
          ...reference,
          testTitle: test.title,
          filePath: test.location?.file,
          status: "SKIPPED",
        });
      }
    }

    await this.drainFlushes();
    await this.trackFlush();
    await this.drainFlushes();
    // Anything still queued after the final flush has run out of retries.
    for (const [, payload] of this.pendingResultsMap) this.undelivered.push(payload);
    this.pendingResultsMap.clear();
    const missingResults = this.undelivered.length + this.unconfirmed.length + this.rejectedCount;
    const recoveryFile = missingResults > 0 ? this.writeUnsentResults() : undefined;

    for (const { testCaseId, testCasePublicId, testTitle, filePath, projectName, durationMs, retryCount, screenshotPath, screenshotFilename, screenshotContentType, errorMessage } of this.screenshotResults) {
      const testRunCaseId = await this.resolveScreenshotTestRunCaseId({
        testCaseId,
        testCasePublicId,
      });
      if (!testRunCaseId) {
        console.warn(`[TestManagement] Could not attach screenshot for ${formatReference({ testCaseId, testCasePublicId })}: the result was not accepted or its references do not agree.`);
        continue;
      }

      try {
        const attachment = await this.client.uploadScreenshot(screenshotPath, screenshotFilename, screenshotContentType);
        const cleanError = errorMessage
          // strip ANSI escape codes (colour sequences Playwright adds to terminal output)
          ? errorMessage.replace(/\x1B\[[0-9;]*m/g, "").trim()
          : undefined;
        const durSec = (durationMs / 1000).toFixed(1);
        const meta: string[] = [];
        if (projectName) meta.push(`🌐 ${projectName}`);
        meta.push(`⏱ ${durSec}s`);
        if (retryCount > 0) meta.push(`🔁 retry ${retryCount}`);

        const lines: string[] = [`❌ ${testTitle}`];
        if (filePath) lines.push(`📄 ${relative(this.rootDir, filePath)}`);
        lines.push(meta.join(" · "));
        if (cleanError) lines.push("", cleanError);
        const content = lines.join("\n");
        await this.client.postComment(this.testRunId, testRunCaseId, content, [{
          url: attachment.url,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.sizeBytes,
        }]);
      } catch (err) {
        this.screenshotErrorCount++;
        console.error(`[TestManagement] Failed to attach screenshot for ${formatReference({ testCaseId, testCasePublicId })}:`, err);
      }
    }

    // A run with missing results must not look like a fully collected one.
    const finalStatus = missingResults > 0 ? "CANCELLED" : "COMPLETED";
    try {
      await this.client.completeTestRun(this.testRunId, finalStatus);
      console.log(
        `[TestManagement] Test run #${this.testRunId} "${this.runName}" ${finalStatus === "COMPLETED" ? "completed" : "marked CANCELLED (incomplete results)"}.`
      );
    } catch (err) {
      console.error("[TestManagement] Failed to complete test run:", err);
    }

    if (missingResults > 0) {
      console.error(
        "[TestManagement] ⚠️  REPORTING INCOMPLETE (this is a reporter problem, not a test failure): " +
        `${this.undelivered.length} result(s) could not be delivered, ` +
        `${this.unconfirmed.length} unmapped result(s) were not confirmed by the server, ` +
        `${this.rejectedCount} result(s) were rejected by the server. ` +
        "The run dashboard is missing these results." +
        (recoveryFile ? ` Unsent results saved to ${recoveryFile}.` : "")
      );
    }
    if (this.screenshotErrorCount > 0) {
      console.warn(
        `[TestManagement] ⚠️  ${this.screenshotErrorCount} screenshot attachment(s) failed — ` +
        "failure screenshots may be missing from the run."
      );
    }
  }

  private async resolveScreenshotTestRunCaseId(
    reference: Pick<TestResultPayload, "testCaseId" | "testCasePublicId">
  ): Promise<number | undefined> {
    let resolvedTestCaseId = reference.testCaseId;

    if (reference.testCasePublicId) {
      const normalizedPublicId = reference.testCasePublicId.toUpperCase();
      let resolution = this.publicTestCaseResolutionMap.get(normalizedPublicId);
      if (!resolution) {
        resolution = this.client.resolveTestCasePublicId(normalizedPublicId);
        this.publicTestCaseResolutionMap.set(normalizedPublicId, resolution);
      }

      try {
        const publicCase = await resolution;
        if (resolvedTestCaseId !== undefined && resolvedTestCaseId !== publicCase.id) {
          return undefined;
        }
        resolvedTestCaseId = publicCase.id;
      } catch {
        return undefined;
      }
    }

    return resolvedTestCaseId !== undefined
      ? this.testCaseIdMap.get(resolvedTestCaseId)
      : undefined;
  }

  // Flushes run strictly one at a time. Overlapping flushes could deliver an
  // older retained payload after a newer result for the same test, and the
  // server keeps the last result it receives.
  private flushChain: Promise<void> = Promise.resolve();
  private flushWaiting: Promise<void> | null = null;

  private trackFlush(): Promise<void> {
    // A flush that has not started yet will pick up everything queued so far.
    if (this.flushWaiting) return this.flushWaiting;
    const flush: Promise<void> = this.flushChain
      .then(() => {
        this.flushWaiting = null;
        return this.flushResults();
      })
      .finally(() => this.activeFlushes.delete(flush));
    this.flushWaiting = flush;
    this.flushChain = flush.catch(() => undefined);
    this.activeFlushes.add(flush);
    return flush;
  }

  private async drainFlushes(): Promise<void> {
    while (this.activeFlushes.size > 0) {
      await Promise.all(Array.from(this.activeFlushes));
    }
  }

  private async flushResults(): Promise<void> {
    if (!this.testRunId || this.pendingResultsMap.size === 0) return;

    // The API caps a request's size, and retained results can pile up, so
    // never send the whole queue in one request.
    const entries = Array.from(this.pendingResultsMap.entries());
    this.pendingResultsMap.clear();
    const retained: Array<[TestCase, TestResultPayload]> = [];
    let outage = false;
    for (let i = 0; i < entries.length; i += this.BATCH_SIZE) {
      const chunk = entries.slice(i, i + this.BATCH_SIZE);
      if (outage) {
        retained.push(...chunk);
        continue;
      }
      const left = await this.flushChunk(chunk);
      if (left.length > 0) {
        outage = true;
        retained.push(...left);
      }
    }

    if (retained.length === 0) {
      this.flushThreshold = this.BATCH_SIZE;
      return;
    }
    // Out of attempts for now: keep the results (a newer result for the same
    // test wins) and retry on the next flush instead of flushing every test.
    for (const [test, payload] of retained) {
      if (!this.pendingResultsMap.has(test)) this.pendingResultsMap.set(test, payload);
    }
    this.flushThreshold = this.pendingResultsMap.size + this.BATCH_SIZE;
  }

  /** Sends one chunk; returns the entries to keep for a later flush. */
  private async flushChunk(
    chunk: Array<[TestCase, TestResultPayload]>
  ): Promise<Array<[TestCase, TestResultPayload]>> {
    const maxAttempts = Math.max(1, this.config.maxBatchAttempts ?? 3);
    const baseDelay = this.config.retryBaseDelayMs ?? 500;
    let remaining = chunk;

    for (let attempt = 1; remaining.length > 0 && attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await sleep(baseDelay * 2 ** (attempt - 2));
      const batch = remaining.map(([, payload]) => payload);
      try {
        const res = await this.client.reportResults(this.testRunId!, batch);
        this.recordAcknowledgement(batch, res);
        return [];
      } catch (err) {
        const ambiguous = !(err instanceof ApiError) || err.ambiguous;
        const retryable = !(err instanceof ApiError) || err.retryable;
        console.error(
          `[TestManagement] Failed to report results (attempt ${attempt}/${maxAttempts}):`,
          err
        );
        if (ambiguous) {
          // The server may have stored the batch. Mapped results are upserts
          // and can be resent; unmapped ones are appended, so never resend.
          this.unconfirmed.push(
            ...remaining.filter(([, p]) => !isMapped(p)).map(([, p]) => p)
          );
          remaining = remaining.filter(([, p]) => isMapped(p));
        }
        if (!retryable) {
          this.undelivered.push(...remaining.map(([, p]) => p));
          return [];
        }
      }
    }
    return remaining;
  }

  private recordAcknowledgement(
    batch: TestResultPayload[],
    res: Awaited<ReturnType<TestManagementClient["reportResults"]>>
  ): void {
    const sent = batch.length;
    const errors = Array.isArray(res.errors) ? res.errors : [];
    const accepted = (res.mapped ?? 0) + (res.unmapped ?? 0);
    const rejected = Math.max(sent - accepted, errors.length > 0 ? errors.length : 0);
    console.log(
      `[TestManagement] Reported ${res.mapped} mapped, ${res.unmapped} unmapped results`
    );
    if (rejected > 0) {
      this.rejectedCount += rejected;
      this.rejectionMessages.push(...errors);
      this.partiallyRejected.push({ rejectedCount: rejected, errors, batch });
      console.warn(`[TestManagement] ${rejected} of ${sent} result(s) rejected:`, errors);
    }
    for (const { testCaseId, testRunCaseId } of res.cases ?? []) {
      this.testCaseIdMap.set(testCaseId, testRunCaseId);
    }
    if (res.mapped > 0 && !res.cases?.length) {
      console.warn("[TestManagement] Warning: server returned no case ID mappings — screenshots will not be attached. Ensure the /results endpoint returns a 'cases' array.");
    }
  }

  private writeUnsentResults(): string | undefined {
    const file = resolve(
      this.config.unsentResultsPath ?? `alpaqa-unsent-results-${this.testRunId}.json`
    );
    try {
      writeFileSync(
        file,
        JSON.stringify(
          {
            testRunId: this.testRunId,
            undelivered: this.undelivered,
            unconfirmedUnmapped: this.unconfirmed,
            rejectedCount: this.rejectedCount,
            rejectionMessages: this.rejectionMessages,
            partiallyRejectedBatches: this.partiallyRejected,
          },
          null,
          2
        )
      );
      return file;
    } catch (err) {
      console.error("[TestManagement] Failed to write unsent results file:", err);
      return undefined;
    }
  }
}
