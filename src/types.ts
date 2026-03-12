export interface TestManagementReporterConfig {
  /** Base URL of the test management app (e.g. "https://app.example.com") */
  baseUrl: string;
  /** API token (starts with "tm_") */
  apiToken: string;
  /** Name for the auto-created test run. Defaults to "Playwright Run - {timestamp}" */
  runName?: string;
  /** Description for the test run */
  runDescription?: string;
  /** Pattern for extracting test case IDs. Default: /@TC-(\d+)/ */
  idPattern?: RegExp;
  /** Also check Playwright tags for test case IDs. Default: true */
  parseTags?: boolean;
  /** Environment for the test run (e.g. "Production", "Staging") */
  environment?: string;
}

export interface TestResultPayload {
  testCaseId?: number;
  testTitle: string;
  filePath?: string;
  status: "PASSED" | "FAILED" | "BLOCKED" | "SKIPPED" | "FLAKY";
  durationMs?: number;
  errorMessage?: string;
  notes?: string;
  screenshotPath?: string;
}
