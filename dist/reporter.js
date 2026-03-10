"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestManagementReporter = void 0;
const client_1 = require("./client");
const parser_1 = require("./parser");
class TestManagementReporter {
    constructor(config) {
        this.testRunId = null;
        this.pendingResults = [];
        this.BATCH_SIZE = 50;
        this.allTests = [];
        this.reportedTests = new Set();
        if (!config.baseUrl)
            throw new Error("TestManagement reporter: baseUrl is required");
        if (!config.apiToken)
            throw new Error("TestManagement reporter: apiToken is required");
        this.config = {
            parseTags: true,
            idPattern: /@TC-(\d+)/,
            ...config,
        };
        this.client = new client_1.TestManagementClient(config.baseUrl, config.apiToken);
    }
    async onBegin(_config, suite) {
        this.allTests = suite.allTests();
        const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
        const name = this.config.runName ?? `Playwright Run - ${timestamp}`;
        try {
            const run = await this.client.createTestRun({
                name,
                description: this.config.runDescription,
                source: "playwright",
            });
            this.testRunId = run.id;
            console.log(`[TestManagement] Created test run #${run.id}: "${run.name}"`);
        }
        catch (err) {
            console.error("[TestManagement] Failed to create test run:", err);
        }
    }
    async onTestEnd(test, result) {
        if (!this.testRunId)
            return;
        this.reportedTests.add(test);
        const tags = (test.tags ?? []).map((t) => t);
        const testCaseId = this.config.parseTags !== false
            ? (0, parser_1.extractTestCaseId)(test.title, tags, this.config.idPattern)
            : (0, parser_1.extractTestCaseId)(test.title, [], this.config.idPattern);
        let status = (0, parser_1.mapPlaywrightStatus)(result.status);
        if (result.status === "passed" && result.retry > 0) {
            status = "FLAKY";
        }
        const payload = {
            testCaseId,
            testTitle: test.title,
            filePath: test.location?.file,
            status,
            durationMs: result.duration,
            errorMessage: result.errors?.map((e) => e.message).join("\n") || undefined,
        };
        this.pendingResults.push(payload);
        if (this.pendingResults.length >= this.BATCH_SIZE) {
            await this.flushResults();
        }
    }
    async onEnd(_result) {
        if (!this.testRunId)
            return;
        for (const test of this.allTests) {
            if (!this.reportedTests.has(test)) {
                const tags = (test.tags ?? []).map((t) => t);
                const testCaseId = this.config.parseTags !== false
                    ? (0, parser_1.extractTestCaseId)(test.title, tags, this.config.idPattern)
                    : (0, parser_1.extractTestCaseId)(test.title, [], this.config.idPattern);
                this.pendingResults.push({
                    testCaseId,
                    testTitle: test.title,
                    filePath: test.location?.file,
                    status: "SKIPPED",
                });
            }
        }
        await this.flushResults();
        try {
            await this.client.completeTestRun(this.testRunId, "COMPLETED");
            console.log(`[TestManagement] Test run #${this.testRunId} completed.`);
        }
        catch (err) {
            console.error("[TestManagement] Failed to complete test run:", err);
        }
    }
    async flushResults() {
        if (!this.testRunId || this.pendingResults.length === 0)
            return;
        const batch = this.pendingResults.splice(0, this.pendingResults.length);
        try {
            const res = await this.client.reportResults(this.testRunId, batch);
            console.log(`[TestManagement] Reported ${res.mapped} mapped, ${res.unmapped} unmapped results`);
            if (res.errors.length > 0) {
                console.warn("[TestManagement] Errors:", res.errors);
            }
        }
        catch (err) {
            console.error("[TestManagement] Failed to report results:", err);
        }
    }
}
exports.TestManagementReporter = TestManagementReporter;
