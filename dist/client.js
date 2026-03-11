"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestManagementClient = void 0;
const promises_1 = require("fs/promises");
const path_1 = require("path");
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
    async uploadScreenshot(filePath, filename, contentType) {
        const fileBuffer = await (0, promises_1.readFile)(filePath);
        const form = new FormData();
        form.append("file", new Blob([fileBuffer], { type: contentType }), (0, path_1.basename)(filename));
        const url = `${this.baseUrl}/api/v1/upload`;
        const res = await fetch(url, {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiToken}` },
            body: form,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`API request failed: POST /upload -> ${res.status} ${text}`);
        }
        return res.json();
    }
    async postComment(testRunId, testRunCaseId, content, attachments) {
        await this.request("POST", `/test-runs/${testRunId}/cases/${testRunCaseId}/comments`, {
            content,
            attachments,
        });
    }
    async completeTestRun(testRunId, status = "COMPLETED") {
        return this.request("POST", `/test-runs/${testRunId}/complete`, {
            status,
        });
    }
}
exports.TestManagementClient = TestManagementClient;
