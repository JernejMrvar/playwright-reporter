"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestManagementClient = void 0;
class TestManagementClient {
    constructor(baseUrl, apiToken) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.apiToken = apiToken;
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}/api/v1${path}`;
        const res = await fetch(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiToken}`,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`API request failed: ${method} ${path} -> ${res.status} ${text}`);
        }
        return res.json();
    }
    async createTestRun(data) {
        return this.request("POST", "/test-runs", data);
    }
    async reportResults(testRunId, results) {
        return this.request("POST", `/test-runs/${testRunId}/results`, {
            results,
        });
    }
    async completeTestRun(testRunId, status = "COMPLETED") {
        return this.request("POST", `/test-runs/${testRunId}/complete`, {
            status,
        });
    }
}
exports.TestManagementClient = TestManagementClient;
