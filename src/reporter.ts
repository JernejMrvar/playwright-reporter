import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { relative } from "path";
import { TestManagementClient } from "./client";
import type { TestManagementReporterConfig, TestResultPayload } from "./types";
import { extractTestCaseId, mapPlaywrightStatus } from "./parser";

export class TestManagementReporter implements Reporter {
  private config: TestManagementReporterConfig;
  private client: TestManagementClient;
  private testRunId: number | null = null;
  private rootDir: string = process.cwd();
  private pendingResultsMap = new Map<TestCase, TestResultPayload>();
  private readonly BATCH_SIZE = 50;
  private allTests: TestCase[] = [];
  // Use test.id (stable string) instead of object reference so the check works
  // regardless of whether suite.allTests() returns the same object references
  // as those passed to onTestEnd.
  private reportedTestIds = new Set<string>();
  private screenshotResults: Array<{
    testCaseId: number;
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
  private hadFlushError = false;
  private screenshotErrorCount = 0;

  constructor(config: TestManagementReporterConfig) {
    if (!config.baseUrl) throw new Error("TestManagement reporter: baseUrl is required");
    if (!config.apiToken) throw new Error("TestManagement reporter: apiToken is required");

    this.config = {
      parseTags: true,
      idPattern: /@TC-(\d+)/,
      ...config,
    };
    this.client = new TestManagementClient(config.baseUrl, config.apiToken);
  }

  async onBegin(config: FullConfig, suite: Suite): Promise<void> {
    this.rootDir = config.rootDir;
    this.allTests = suite.allTests();

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const localDateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const name = this.config.runName ?? `Playwright Run - ${localDateTime}`;

    try {
      const run = await this.client.createTestRun({
        name,
        description: this.config.runDescription,
        source: "playwright",
        environment: this.config.environment ?? process.env.NODE_ENV ?? "development",
      });
      this.testRunId = run.id;
      console.log(
        `[TestManagement] Created test run #${run.id}: "${run.name}"`
      );
    } catch (err) {
      console.error("[TestManagement] Failed to create test run:", err);
    }
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    if (!this.testRunId) return;

    // Use test.id (string) for stable deduplication — object references from
    // suite.allTests() vs onTestEnd may differ across Playwright versions.
    this.reportedTestIds.add(test.id);

    const tags = (test.tags ?? []).map((t: string) => t);
    const testCaseId = this.config.parseTags !== false
      ? extractTestCaseId(test.title, tags, this.config.idPattern)
      : extractTestCaseId(test.title, [], this.config.idPattern);

    let status = mapPlaywrightStatus(result.status);
    if (result.status === "passed" && result.retry > 0) {
      status = "FLAKY";
    }

    const payload: TestResultPayload = {
      testCaseId,
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
      if (screenshot?.path && testCaseId !== undefined) {
        this.screenshotResults.push({
          testCaseId,
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

    if (this.pendingResultsMap.size >= this.BATCH_SIZE) {
      await this.flushResults();
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.testRunId) return;

    for (const test of this.allTests) {
      if (!this.reportedTestIds.has(test.id)) {
        const tags = (test.tags ?? []).map((t: string) => t);
        const testCaseId = this.config.parseTags !== false
          ? extractTestCaseId(test.title, tags, this.config.idPattern)
          : extractTestCaseId(test.title, [], this.config.idPattern);

        this.pendingResultsMap.set(test, {
          testCaseId,
          testTitle: test.title,
          filePath: test.location?.file,
          status: "SKIPPED",
        });
      }
    }

    await this.flushResults();

    for (const { testCaseId, testTitle, filePath, projectName, durationMs, retryCount, screenshotPath, screenshotFilename, screenshotContentType, errorMessage } of this.screenshotResults) {
      const testRunCaseId = this.testCaseIdMap.get(testCaseId);
      if (!testRunCaseId) {
        console.warn(`[TestManagement] Could not attach screenshot for @TC-${testCaseId}: testRunCaseId not found in server response.`);
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
        console.error(`[TestManagement] Failed to attach screenshot for case #${testCaseId}:`, err);
      }
    }

    try {
      await this.client.completeTestRun(this.testRunId, "COMPLETED");
      console.log(`[TestManagement] Test run #${this.testRunId} completed.`);
    } catch (err) {
      console.error("[TestManagement] Failed to complete test run:", err);
    }

    if (this.hadFlushError) {
      console.error(
        "[TestManagement] ⚠️  One or more result batches failed to submit — " +
        "some test cases may show as NOT_RUN in the dashboard. " +
        "Check the errors above for details."
      );
    }
    if (this.screenshotErrorCount > 0) {
      console.warn(
        `[TestManagement] ⚠️  ${this.screenshotErrorCount} screenshot attachment(s) failed — ` +
        "failure screenshots may be missing from the run."
      );
    }
  }

  private async flushResults(): Promise<void> {
    if (!this.testRunId || this.pendingResultsMap.size === 0) return;

    const batch = Array.from(this.pendingResultsMap.values());
    this.pendingResultsMap.clear();
    try {
      const res = await this.client.reportResults(this.testRunId, batch);
      console.log(
        `[TestManagement] Reported ${res.mapped} mapped, ${res.unmapped} unmapped results`
      );
      if (res.errors.length > 0) {
        console.warn("[TestManagement] Errors:", res.errors);
      }
      for (const { testCaseId, testRunCaseId } of res.cases ?? []) {
        this.testCaseIdMap.set(testCaseId, testRunCaseId);
      }
      if (res.mapped > 0 && !res.cases?.length) {
        console.warn("[TestManagement] Warning: server returned no case ID mappings — screenshots will not be attached. Ensure the /results endpoint returns a 'cases' array.");
      }
    } catch (err) {
      this.hadFlushError = true;
      console.error("[TestManagement] Failed to report results:", err);
    }
  }
}
