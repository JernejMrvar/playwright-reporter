"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractTestCaseId = extractTestCaseId;
exports.extractTestCasePublicId = extractTestCasePublicId;
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
 * Extracts a project-scoped public test-case reference.
 *
 * The default annotation is deliberately distinct from @TC-{id}: a public
 * reference remains unambiguous even when a project code is also a legacy
 * numeric-ID prefix.
 */
function extractTestCasePublicId(title, tags, pattern = /@TM:([A-Za-z0-9]{2,10}-\d+)/) {
    const titleMatch = title.match(pattern);
    if (titleMatch?.[1]) {
        return titleMatch[1].toUpperCase();
    }
    for (const tag of tags) {
        const tagMatch = tag.match(pattern);
        if (tagMatch?.[1]) {
            return tagMatch[1].toUpperCase();
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
