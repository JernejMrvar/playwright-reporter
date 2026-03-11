import type { TestResultPayload } from "./types";
export declare class TestManagementClient {
    private baseUrl;
    private apiToken;
    constructor(baseUrl: string, apiToken: string);
    private request;
    createTestRun(data: {
        name: string;
        description?: string;
        source?: string;
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
            testRunCaseId: number;
        }[];
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
