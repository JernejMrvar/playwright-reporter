/**
 * Extracts @TC-{id} from a test title or tags array.
 *
 * Examples:
 *   "Login flow @TC-42"        -> 42
 *   "Checkout @TC-100 works"   -> 100
 *   tags: ["@TC-55"]           -> 55
 */
export function extractTestCaseId(
  title: string,
  tags: string[],
  pattern: RegExp = /@TC-(\d+)/
): number | undefined {
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
export function mapPlaywrightStatus(
  pwStatus: string
): "PASSED" | "FAILED" | "SKIPPED" | "BLOCKED" | "FLAKY" {
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
