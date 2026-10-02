export interface TestManagementReporterConfig {
    /** Base URL of the test management app (e.g. "https://app.example.com") */
    baseUrl: string;
    /** API token (starts with "tm_") */
    apiToken: string;
    /** Name for the auto-created test run. Defaults to "Playwright Run - {timestamp}" */
    runName?: string;
    /** Description for the test run */
    runDescription?: string;
    /** Pattern for extracting legacy internal test case IDs. Default: /@TC-(\d+)/ */
    idPattern?: RegExp;
    /** Pattern for extracting public test case IDs. Default: /@TM:([A-Za-z0-9]{2,10}-\d+)/ */
    publicIdPattern?: RegExp;
    /** Also check Playwright tags for test case IDs. Default: true */
    parseTags?: boolean;
    /** Environment for the test run (e.g. "Production", "Staging") */
    environment?: string;
    /** Per-request timeout in milliseconds. Default: 30000 */
    requestTimeoutMs?: number;
    /** Attempts per result batch before it is retained for the next flush. Default: 3 */
    maxBatchAttempts?: number;
    /** Base delay for exponential backoff between batch attempts. Default: 500 */
    retryBaseDelayMs?: number;
    /**
     * Where results that could not be delivered are written. Default:
     * ./test-results/alpaqa-unsent-results-<runId>.json (relative to the current
     * directory, not Playwright's configured outputDir). Playwright empties its
     * outputDir at the start of the next run, so copy the file (CI: save it as an
     * artifact) or point this at a folder outside outputDir to keep it.
     */
    unsentResultsPath?: string;
}
export interface TestResultPayload {
    testCaseId?: number;
    testCasePublicId?: string;
    testTitle: string;
    filePath?: string;
    status: "PASSED" | "FAILED" | "BLOCKED" | "SKIPPED" | "FLAKY";
    durationMs?: number;
    errorMessage?: string;
    notes?: string;
    screenshotPath?: string;
}
