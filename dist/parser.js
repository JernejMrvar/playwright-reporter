"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTestCaseId = extractTestCaseId;
exports.mapPlaywrightStatus = mapPlaywrightStatus;
/**
 * Extracts @TC-{id} from a test title or tags array.
 *
 * Examples:
 *   "Login flow @TC-42"        -> 42
 *   "Checkout @TC-100 works"   -> 100
 *   tags: ["@TC-55"]           -> 55
 */
function extractTestCaseId(title, tags, pattern = /@TC-(\d+)/) {
    const titleMatch = title.match(pattern);
    if (titleMatch?.[1]) {
        return parseInt(titleMatch[1], 10);
    }
    for (const tag of tags) {
        const tagMatch = tag.match(pattern);
        if (tagMatch?.[1]) {
            return parseInt(tagMatch[1], 10);
        }
    }
    return undefined;
}
/**
 * Maps Playwright test status to TestRunCaseStatus.
 */
function mapPlaywrightStatus(pwStatus) {
    switch (pwStatus) {
        case "passed":
            return "PASSED";
        case "failed":
            return "FAILED";
        case "timedOut":
            return "FAILED";
        case "skipped":
            return "SKIPPED";
        case "interrupted":
            return "BLOCKED";
        default:
            return "FAILED";
    }
}
