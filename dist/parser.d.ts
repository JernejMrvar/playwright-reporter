/**
 * Extracts @TC-{id} from a test title or tags array.
 *
 * Examples:
 *   "Login flow @TC-42"        -> 42
 *   "Checkout @TC-100 works"   -> 100
 *   tags: ["@TC-55"]           -> 55
 */
export declare function extractTestCaseId(title: string, tags: string[], pattern?: RegExp): number | undefined;
/**
 * Extracts a project-scoped public test-case reference.
 *
 * The default annotation is deliberately distinct from @TC-{id}: a public
 * reference remains unambiguous even when a project code is also a legacy
 * numeric-ID prefix.
 */
export declare function extractTestCasePublicId(title: string, tags: string[], pattern?: RegExp): string | undefined;
/**
 * Maps Playwright test status to TestRunCaseStatus.
 */
export declare function mapPlaywrightStatus(pwStatus: string): "PASSED" | "FAILED" | "SKIPPED" | "BLOCKED" | "FLAKY";
