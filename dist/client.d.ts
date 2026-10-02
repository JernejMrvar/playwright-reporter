import type { TestResultPayload } from "./types";
export declare const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/**
 * A failed API call. `ambiguous` is true when the server may already have
 * processed the request (timeout, dropped connection, 5xx other than 503), so
 * blindly resending a non-idempotent write could duplicate data.
 */
export declare class ApiError extends Error {
    readonly status: number | undefined;
    readonly ambiguous: boolean;
    readonly retryable: boolean;
    constructor(message: string, status: number | undefined, ambiguous: boolean, retryable: boolean);
}
export declare class TestManagementClient {
    private baseUrl;
    private apiToken;
    private timeoutMs;
    constructor(baseUrl: string, apiToken: string, timeoutMs?: number);
    private send;
    private request;
    createTestRun(data: {
        name: string;
        description?: string;
        source?: string;
        environment?: string;
    }): Promise<{
        id: number;
        name: string;
        status: string;
    }>;
    reportResults(testRunId: number, results: TestResultPayload[]): Promise<{
        mapped: number;
        unmapped: number;
        errors: string[];
        cases: {
            testCaseId: number;
            testCasePublicId: string | null;
            testRunCaseId: number;
        }[];
    }>;
    resolveTestCasePublicId(publicId: string): Promise<{
        id: number;
    }>;
    uploadScreenshot(filePath: string, filename: string, contentType: string): Promise<{
        url: string;
        filename: string;
        contentType: string;
        sizeBytes: number;
    }>;
    postComment(testRunId: number, testRunCaseId: number, content: string, attachments: {
        url: string;
        filename: string;
        contentType: string;
        size: number;
    }[]): Promise<void>;
    completeTestRun(testRunId: number, status?: "COMPLETED" | "CANCELLED"): Promise<unknown>;
}
