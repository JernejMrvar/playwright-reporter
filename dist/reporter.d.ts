import type { FullConfig, FullResult, Reporter, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import type { TestManagementReporterConfig } from "./types";
export declare class TestManagementReporter implements Reporter {
    private config;
    private client;
    private testRunId;
    private runName;
    private rootDir;
    private pendingResultsMap;
    private readonly BATCH_SIZE;
    private allTests;
    private reportedTestIds;
    private screenshotResults;
    private testCaseIdMap;
    private publicTestCaseResolutionMap;
    private undelivered;
    private unconfirmed;
    private rejectedCount;
    private rejectionMessages;
    private partiallyRejected;
    private activeFlushes;
    private flushThreshold;
    private screenshotErrorCount;
    private runCreationPromise;
    constructor(config: TestManagementReporterConfig);
    onBegin(config: FullConfig, suite: Suite): Promise<void>;
    onTestEnd(test: TestCase, result: TestResult): Promise<void>;
    onEnd(_result: FullResult): Promise<void>;
    private resolveScreenshotTestRunCaseId;
    private trackFlush;
    private drainFlushes;
    private flushResults;
    /** Sends one chunk; returns the entries to keep for a later flush. */
    private flushChunk;
    private recordAcknowledgement;
    private writeUnsentResults;
}
