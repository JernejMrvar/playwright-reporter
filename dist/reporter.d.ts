import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import type { TestManagementReporterConfig } from "./types";
export declare class TestManagementReporter implements Reporter {
    private config;
    private client;
    private testRunId;
    private rootDir;
    private pendingResults;
    private readonly BATCH_SIZE;
    private allTests;
    private reportedTests;
    private screenshotResults;
    private testCaseIdMap;
    constructor(config: TestManagementReporterConfig);
    onBegin(config: FullConfig, suite: Suite): Promise<void>;
    onTestEnd(test: TestCase, result: TestResult): Promise<void>;
    onEnd(_result: FullResult): Promise<void>;
    private flushResults;
}
