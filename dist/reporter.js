"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestManagementReporter = void 0;
const path_1 = require("path");
const client_1 = require("./client");
const parser_1 = require("./parser");
class TestManagementReporter {
    constructor(config) {
        this.testRunId = null;
        this.rootDir = process.cwd();
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
    async onBegin(config, suite) {
        this.rootDir = config.rootDir;
        this.allTests = suite.allTests();
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const localDateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const name = this.config.runName ?? `Playwright Run - ${localDateTime}`;
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
                testTitle: payload.testTitle,
                filePath: payload.filePath,
                projectName: test.parent?.project()?.name,
                durationMs: result.duration,
                retryCount: result.retry,
                screenshotPath: screenshot.path,
                screenshotFilename: screenshot.path.split("/").pop() ?? "screenshot.png",
                screenshotContentType: screenshot.contentType,
                errorMessage: payload.errorMessage,
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
        for (const { testCaseId, testTitle, filePath, projectName, durationMs, retryCount, screenshotPath, screenshotFilename, screenshotContentType, errorMessage } of this.screenshotResults) {
            const testRunCaseId = this.testCaseIdMap.get(testCaseId);
            if (!testRunCaseId) {
                console.warn(`[TestManagement] Could not attach screenshot for @TC-${testCaseId}: testRunCaseId not found in server response.`);
                continue;
            }
            try {
                const attachment = await this.client.uploadScreenshot(screenshotPath, screenshotFilename, screenshotContentType);
                const cleanError = errorMessage
                    // strip ANSI escape codes (colour sequences Playwright adds to terminal output)
                    ? errorMessage.replace(/\x1B\[[0-9;]*m/g, "").trim()
                    : undefined;
                const durSec = (durationMs / 1000).toFixed(1);
                const meta = [];
                if (projectName)
                    meta.push(`🌐 ${projectName}`);
                meta.push(`⏱ ${durSec}s`);
                if (retryCount > 0)
                    meta.push(`🔁 ${retryCount} ${retryCount === 1 ? "retry" : "retries"}`);
                const lines = [`❌ ${testTitle}`];
                if (filePath)
                    lines.push(`📄 ${(0, path_1.relative)(this.rootDir, filePath)}`);
                lines.push(meta.join(" · "));
                if (cleanError)
                    lines.push("", cleanError);
                const content = lines.join("\n");
                await this.client.postComment(this.testRunId, testRunCaseId, content, [{
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
            for (const { testCaseId, testRunCaseId } of res.cases ?? []) {
                this.testCaseIdMap.set(testCaseId, testRunCaseId);
            }
            if (res.mapped > 0 && !res.cases?.length) {
                console.warn("[TestManagement] Warning: server returned no case ID mappings — screenshots will not be attached. Ensure the /results endpoint returns a 'cases' array.");
            }
        }
        catch (err) {
            console.error("[TestManagement] Failed to report results:", err);
        }
    }
}
exports.TestManagementReporter = TestManagementReporter;
