"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestManagementClient = exports.ApiError = exports.DEFAULT_REQUEST_TIMEOUT_MS = void 0;
const promises_1 = require("fs/promises");
const path_1 = require("path");
exports.DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/**
 * A failed API call. `ambiguous` is true when the server may already have
 * processed the request (timeout, dropped connection, 5xx other than 503), so
 * blindly resending a non-idempotent write could duplicate data.
 */
class ApiError extends Error {
    constructor(message, status, ambiguous, retryable) {
        super(message);
        this.status = status;
        this.ambiguous = ambiguous;
        this.retryable = retryable;
        this.name = "ApiError";
    }
}
exports.ApiError = ApiError;
function classifyStatus(status) {
    // 429/503 are rejected before any work happens: safe to resend as-is.
    if (status === 429 || status === 503)
        return { ambiguous: false, retryable: true };
    if (status >= 500)
        return { ambiguous: true, retryable: true };
    return { ambiguous: false, retryable: false };
}
class TestManagementClient {
    constructor(baseUrl, apiToken, timeoutMs = exports.DEFAULT_REQUEST_TIMEOUT_MS) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.apiToken = apiToken;
        this.timeoutMs = timeoutMs;
    }
    async send(url, label, init) {
        let res;
        try {
            res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new ApiError(`API request failed: ${label} -> ${reason}`, undefined, true, true);
        }
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            const { ambiguous, retryable } = classifyStatus(res.status);
            throw new ApiError(`API request failed: ${label} -> ${res.status} ${text}`, res.status, ambiguous, retryable);
        }
        return res;
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}/api/v1${path}`;
        const res = await this.send(url, `${method} ${path}`, {
            method,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiToken}`,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
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
    async resolveTestCasePublicId(publicId) {
        const match = /^([A-Za-z0-9]{2,10})-(\d+)$/.exec(publicId);
        if (!match) {
            throw new Error(`Invalid test case public ID: ${publicId}`);
        }
        const [, projectCode, publicNumber] = match;
        return this.request("GET", `/projects/by-code/${encodeURIComponent(projectCode)}/test-cases/${encodeURIComponent(publicNumber)}`);
    }
    async uploadScreenshot(filePath, filename, contentType) {
        const fileBuffer = await (0, promises_1.readFile)(filePath);
        const form = new FormData();
        form.append("file", new Blob([fileBuffer], { type: contentType }), (0, path_1.basename)(filename));
        const url = `${this.baseUrl}/api/v1/upload`;
        const res = await this.send(url, "POST /upload", {
            method: "POST",
            headers: { Authorization: `Bearer ${this.apiToken}` },
            body: form,
        });
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
