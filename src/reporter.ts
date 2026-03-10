import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { TestManagementClient } from "./client";
import type { TestManagementReporterConfig, TestResultPayload } from "./types";
import { extractTestCaseId, mapPlaywrightStatus } from "./parser";

export class TestManagementReporter implements Reporter {
  private config: TestManagementReporterConfig;
  private client: TestManagementClient;
  private testRunId: number | null = null;
  private pendingResults: TestResultPayload[] = [];
  private readonly BATCH_SIZE = 50;

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

  async onBegin(_config: FullConfig, _suite: Suite): Promise<void> {
    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const name = this.config.runName ?? `Playwright Run - ${timestamp}`;

    try {
      const run = await this.client.createTestRun({
        name,
        description: this.config.runDescription,
        source: "playwright",
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

    this.pendingResults.push(payload);

    if (this.pendingResults.length >= this.BATCH_SIZE) {
      await this.flushResults();
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (!this.testRunId) return;

    await this.flushResults();

    try {
      await this.client.completeTestRun(this.testRunId, "COMPLETED");
      console.log(`[TestManagement] Test run #${this.testRunId} completed.`);
    } catch (err) {
      console.error("[TestManagement] Failed to complete test run:", err);
    }
  }

  private async flushResults(): Promise<void> {
    if (!this.testRunId || this.pendingResults.length === 0) return;

    const batch = this.pendingResults.splice(0, this.pendingResults.length);
    try {
      const res = await this.client.reportResults(this.testRunId, batch);
      console.log(
        `[TestManagement] Reported ${res.mapped} mapped, ${res.unmapped} unmapped results`
      );
      if (res.errors.length > 0) {
        console.warn("[TestManagement] Errors:", res.errors);
      }
    } catch (err) {
      console.error("[TestManagement] Failed to report results:", err);
    }
  }
}
