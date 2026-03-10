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
    }>;
    completeTestRun(testRunId: number, status?: "COMPLETED" | "CANCELLED"): Promise<unknown>;
}
