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
        this.screenshotResults = [];
        this.testCaseIdMap = new Map();
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
        const screenshot = (status === "FAILED" || status === "FLAKY")
            ? result.attachments?.find((a) => a.contentType.startsWith("image/") && a.path)
            : undefined;
        console.log(`[TestManagement][debug] "${test.title}" status=${status} testCaseId=${testCaseId} attachments=${JSON.stringify(result.attachments?.map(a => ({ name: a.name, contentType: a.contentType, hasPath: !!a.path })))}`);
        console.log(`[TestManagement][debug] screenshot found: ${JSON.stringify(screenshot ? { path: screenshot.path, contentType: screenshot.contentType } : null)}`);
        const payload = {
            testCaseId,
            testTitle: test.title,
            filePath: test.location?.file,
            status,
            durationMs: result.duration,
            errorMessage: result.errors?.map((e) => e.message).join("\n") || undefined,
            screenshotPath: screenshot?.path,
        };
        if (screenshot?.path && testCaseId !== undefined) {
            this.screenshotResults.push({
                testCaseId,
                screenshotPath: screenshot.path,
                screenshotFilename: screenshot.path.split("/").pop() ?? "screenshot.png",
                screenshotContentType: screenshot.contentType,
            });
        }
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
        console.log(`[TestManagement][debug] screenshotResults: ${JSON.stringify(this.screenshotResults)}`);
        console.log(`[TestManagement][debug] testCaseIdMap: ${JSON.stringify(Object.fromEntries(this.testCaseIdMap))}`);
        for (const { testCaseId, screenshotPath, screenshotFilename, screenshotContentType } of this.screenshotResults) {
            const testRunCaseId = this.testCaseIdMap.get(testCaseId);
            console.log(`[TestManagement][debug] processing screenshot for testCaseId=${testCaseId} -> testRunCaseId=${testRunCaseId}`);
            if (!testRunCaseId)
                continue;
            try {
                const attachment = await this.client.uploadScreenshot(screenshotPath, screenshotFilename, screenshotContentType);
                await this.client.postComment(this.testRunId, testRunCaseId, "❌ Test failed", [{
                        url: attachment.url,
                        filename: attachment.filename,
                        contentType: attachment.contentType,
                        size: attachment.sizeBytes,
                    }]);
            }
            catch (err) {
                console.error(`[TestManagement] Failed to attach screenshot for case #${testCaseId}:`, err);
            }
        }
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
            console.log(`[TestManagement][debug] cases returned: ${JSON.stringify(res.cases ?? [])}`);
            for (const { testCaseId, testRunCaseId } of res.cases ?? []) {
                this.testCaseIdMap.set(testCaseId, testRunCaseId);
            }
        }
        catch (err) {
            console.error("[TestManagement] Failed to report results:", err);
        }
    }
}
exports.TestManagementReporter = TestManagementReporter;
