"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TestManagementReporter = void 0;
const fs_1 = require("fs");
const path_1 = require("path");
const client_1 = require("./client");
const parser_1 = require("./parser");
function getTestCaseReference(title, tags, config) {
    const parsedTags = config.parseTags !== false ? tags : [];
    return {
        testCaseId: (0, parser_1.extractTestCaseId)(title, parsedTags, config.idPattern),
        testCasePublicId: (0, parser_1.extractTestCasePublicId)(title, parsedTags, config.publicIdPattern),
    };
}
function formatReference(reference) {
    if (reference.testCasePublicId)
        return `@TM:${reference.testCasePublicId}`;
    if (reference.testCaseId !== undefined)
        return `@TC-${reference.testCaseId}`;
    return "unmapped test";
}
function isMapped(payload) {
    return payload.testCaseId !== undefined || payload.testCasePublicId !== undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class TestManagementReporter {
    constructor(config) {
        this.testRunId = null;
        this.runName = null;
        this.rootDir = process.cwd();
        this.pendingResultsMap = new Map();
        this.BATCH_SIZE = 50;
        this.allTests = [];
        // Use test.id (stable string) instead of object reference so the check works
        // regardless of whether suite.allTests() returns the same object references
        // as those passed to onTestEnd.
        this.reportedTestIds = new Set();
        this.screenshotResults = [];
        this.testCaseIdMap = new Map();
        this.publicTestCaseResolutionMap = new Map();
        // Results the server has not acknowledged. Nothing is dropped silently:
        // - pendingResultsMap keeps retryable failures for the next flush;
        // - undelivered holds results that are out of retries or permanently refused;
        // - unconfirmed holds unmapped results whose acknowledgement was lost. The
        //   server appends unmapped results, so resending them could duplicate data.
        //   (Mapped results are upserted per case and are safe to resend.)
        this.undelivered = [];
        this.unconfirmed = [];
        this.rejectedCount = 0;
        this.rejectionMessages = [];
        // The server's errors carry no index, so keep the whole batch of any
        // partially accepted request for recovery.
        this.partiallyRejected = [];
        // Playwright does not await onTestEnd, so flushes can still be running
        // when onEnd fires; onEnd drains them before it decides the run's status.
        this.activeFlushes = new Set();
        this.flushThreshold = this.BATCH_SIZE;
        this.screenshotErrorCount = 0;
        // Playwright does not await onBegin before firing onTestEnd, so fast tests
        // can complete before createTestRun returns. We store the creation promise
        // and await it in onTestEnd so no result is ever silently dropped.
        this.runCreationPromise = Promise.resolve();
        if (!config.baseUrl)
            throw new Error("TestManagement reporter: baseUrl is required");
        if (!config.apiToken)
            throw new Error("TestManagement reporter: apiToken is required");
        this.config = {
            parseTags: true,
            idPattern: /@TC-(\d+)/,
            ...config,
        };
        this.client = new client_1.TestManagementClient(config.baseUrl, config.apiToken, config.requestTimeoutMs ?? client_1.DEFAULT_REQUEST_TIMEOUT_MS);
    }
    async onBegin(config, suite) {
        this.rootDir = config.rootDir;
        this.allTests = suite.allTests();
        const now = new Date();
        const pad = (n) => String(n).padStart(2, "0");
        const localDateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
        const name = this.config.runName ?? `Playwright Run - ${localDateTime}`;
        this.runCreationPromise = this.client.createTestRun({
            name,
            description: this.config.runDescription,
            source: "playwright",
            environment: this.config.environment ?? process.env.NODE_ENV ?? "development",
        }).then((run) => {
            this.testRunId = run.id;
            this.runName = run.name;
        }).catch((err) => {
            console.error("[TestManagement] Failed to create test run:", err);
        });
        await this.runCreationPromise;
    }
    async onTestEnd(test, result) {
        // Wait for the run to be created before processing — Playwright does not
        // await onBegin, so fast tests can arrive here before testRunId is set.
        await this.runCreationPromise;
        if (!this.testRunId)
            return;
        // Use test.id (string) for stable deduplication — object references from
        // suite.allTests() vs onTestEnd may differ across Playwright versions.
        this.reportedTestIds.add(test.id);
        const tags = (test.tags ?? []).map((t) => t);
        const reference = getTestCaseReference(test.title, tags, this.config);
        let status = (0, parser_1.mapPlaywrightStatus)(result.status);
        if (result.status === "passed" && result.retry > 0) {
            status = "FLAKY";
        }
        const payload = {
            ...reference,
            testTitle: test.title,
            filePath: test.location?.file,
            status,
            durationMs: result.duration,
            errorMessage: result.errors?.map((e) => e.message).join("\n") || undefined,
        };
        // Accumulate a screenshot comment for every failed/flaky attempt so that
        // each retry's failure is visible as a separate comment in the test run.
        // We no longer deduplicate by test — all retry failures are kept.
        if (status === "FAILED" || status === "FLAKY") {
            const screenshot = result.attachments?.find((a) => a.contentType.startsWith("image/") && a.path);
            if (screenshot?.path && (reference.testCaseId !== undefined || reference.testCasePublicId !== undefined)) {
                this.screenshotResults.push({
                    ...reference,
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
        }
        // Overwrite any earlier retry result — the Map keeps only the final status
        // per test, so each test is counted exactly once.
        this.pendingResultsMap.set(test, payload);
        if (this.pendingResultsMap.size >= this.flushThreshold) {
            await this.trackFlush();
        }
    }
    async onEnd(_result) {
        if (!this.testRunId)
            return;
        for (const test of this.allTests) {
            if (!this.reportedTestIds.has(test.id)) {
                const tags = (test.tags ?? []).map((t) => t);
                const reference = getTestCaseReference(test.title, tags, this.config);
                this.pendingResultsMap.set(test, {
                    ...reference,
                    testTitle: test.title,
                    filePath: test.location?.file,
                    status: "SKIPPED",
                });
            }
        }
        await this.drainFlushes();
        await this.trackFlush();
        await this.drainFlushes();
        // Anything still queued after the final flush has run out of retries.
        for (const [, payload] of this.pendingResultsMap)
            this.undelivered.push(payload);
        this.pendingResultsMap.clear();
        const missingResults = this.undelivered.length + this.unconfirmed.length + this.rejectedCount;
        const recoveryFile = missingResults > 0 ? this.writeUnsentResults() : undefined;
        for (const { testCaseId, testCasePublicId, testTitle, filePath, projectName, durationMs, retryCount, screenshotPath, screenshotFilename, screenshotContentType, errorMessage } of this.screenshotResults) {
            const testRunCaseId = await this.resolveScreenshotTestRunCaseId({
                testCaseId,
                testCasePublicId,
            });
            if (!testRunCaseId) {
                console.warn(`[TestManagement] Could not attach screenshot for ${formatReference({ testCaseId, testCasePublicId })}: the result was not accepted or its references do not agree.`);
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
                    meta.push(`🔁 retry ${retryCount}`);
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
                this.screenshotErrorCount++;
                console.error(`[TestManagement] Failed to attach screenshot for ${formatReference({ testCaseId, testCasePublicId })}:`, err);
            }
        }
        // A run with missing results must not look like a fully collected one.
        const finalStatus = missingResults > 0 ? "CANCELLED" : "COMPLETED";
        try {
            await this.client.completeTestRun(this.testRunId, finalStatus);
            console.log(`[TestManagement] Test run #${this.testRunId} "${this.runName}" ${finalStatus === "COMPLETED" ? "completed" : "marked CANCELLED (incomplete results)"}.`);
        }
        catch (err) {
            console.error("[TestManagement] Failed to complete test run:", err);
        }
        if (missingResults > 0) {
            console.error("[TestManagement] ⚠️  REPORTING INCOMPLETE (this is a reporter problem, not a test failure): " +
                `${this.undelivered.length} result(s) could not be delivered, ` +
                `${this.unconfirmed.length} unmapped result(s) were not confirmed by the server, ` +
                `${this.rejectedCount} result(s) were rejected by the server. ` +
                "The run dashboard is missing these results." +
                (recoveryFile ? ` Unsent results saved to ${recoveryFile}.` : ""));
        }
        if (this.screenshotErrorCount > 0) {
            console.warn(`[TestManagement] ⚠️  ${this.screenshotErrorCount} screenshot attachment(s) failed — ` +
                "failure screenshots may be missing from the run.");
        }
    }
    async resolveScreenshotTestRunCaseId(reference) {
        let resolvedTestCaseId = reference.testCaseId;
        if (reference.testCasePublicId) {
            const normalizedPublicId = reference.testCasePublicId.toUpperCase();
            let resolution = this.publicTestCaseResolutionMap.get(normalizedPublicId);
            if (!resolution) {
                resolution = this.client.resolveTestCasePublicId(normalizedPublicId);
                this.publicTestCaseResolutionMap.set(normalizedPublicId, resolution);
            }
            try {
                const publicCase = await resolution;
                if (resolvedTestCaseId !== undefined && resolvedTestCaseId !== publicCase.id) {
                    return undefined;
                }
                resolvedTestCaseId = publicCase.id;
            }
            catch {
                return undefined;
            }
        }
        return resolvedTestCaseId !== undefined
            ? this.testCaseIdMap.get(resolvedTestCaseId)
            : undefined;
    }
    trackFlush() {
        const flush = this.flushResults().finally(() => this.activeFlushes.delete(flush));
        this.activeFlushes.add(flush);
        return flush;
    }
    async drainFlushes() {
        while (this.activeFlushes.size > 0) {
            await Promise.all(Array.from(this.activeFlushes));
        }
    }
    async flushResults() {
        if (!this.testRunId || this.pendingResultsMap.size === 0)
            return;
        // The API caps a request's size, and retained results can pile up, so
        // never send the whole queue in one request.
        const entries = Array.from(this.pendingResultsMap.entries());
        this.pendingResultsMap.clear();
        const retained = [];
        let outage = false;
        for (let i = 0; i < entries.length; i += this.BATCH_SIZE) {
            const chunk = entries.slice(i, i + this.BATCH_SIZE);
            if (outage) {
                retained.push(...chunk);
                continue;
            }
            const left = await this.flushChunk(chunk);
            if (left.length > 0) {
                outage = true;
                retained.push(...left);
            }
        }
        if (retained.length === 0) {
            this.flushThreshold = this.BATCH_SIZE;
            return;
        }
        // Out of attempts for now: keep the results (a newer result for the same
        // test wins) and retry on the next flush instead of flushing every test.
        for (const [test, payload] of retained) {
            if (!this.pendingResultsMap.has(test))
                this.pendingResultsMap.set(test, payload);
        }
        this.flushThreshold = this.pendingResultsMap.size + this.BATCH_SIZE;
    }
    /** Sends one chunk; returns the entries to keep for a later flush. */
    async flushChunk(chunk) {
        const maxAttempts = Math.max(1, this.config.maxBatchAttempts ?? 3);
        const baseDelay = this.config.retryBaseDelayMs ?? 500;
        let remaining = chunk;
        for (let attempt = 1; remaining.length > 0 && attempt <= maxAttempts; attempt++) {
            if (attempt > 1)
                await sleep(baseDelay * 2 ** (attempt - 2));
            const batch = remaining.map(([, payload]) => payload);
            try {
                const res = await this.client.reportResults(this.testRunId, batch);
                this.recordAcknowledgement(batch, res);
                return [];
            }
            catch (err) {
                const ambiguous = !(err instanceof client_1.ApiError) || err.ambiguous;
                const retryable = !(err instanceof client_1.ApiError) || err.retryable;
                console.error(`[TestManagement] Failed to report results (attempt ${attempt}/${maxAttempts}):`, err);
                if (ambiguous) {
                    // The server may have stored the batch. Mapped results are upserts
                    // and can be resent; unmapped ones are appended, so never resend.
                    this.unconfirmed.push(...remaining.filter(([, p]) => !isMapped(p)).map(([, p]) => p));
                    remaining = remaining.filter(([, p]) => isMapped(p));
                }
                if (!retryable) {
                    this.undelivered.push(...remaining.map(([, p]) => p));
                    return [];
                }
            }
        }
        return remaining;
    }
    recordAcknowledgement(batch, res) {
        const sent = batch.length;
        const errors = Array.isArray(res.errors) ? res.errors : [];
        const accepted = (res.mapped ?? 0) + (res.unmapped ?? 0);
        const rejected = Math.max(sent - accepted, errors.length > 0 ? errors.length : 0);
        console.log(`[TestManagement] Reported ${res.mapped} mapped, ${res.unmapped} unmapped results`);
        if (rejected > 0) {
            this.rejectedCount += rejected;
            this.rejectionMessages.push(...errors);
            this.partiallyRejected.push({ rejectedCount: rejected, errors, batch });
            console.warn(`[TestManagement] ${rejected} of ${sent} result(s) rejected:`, errors);
        }
        for (const { testCaseId, testRunCaseId } of res.cases ?? []) {
            this.testCaseIdMap.set(testCaseId, testRunCaseId);
        }
        if (res.mapped > 0 && !res.cases?.length) {
            console.warn("[TestManagement] Warning: server returned no case ID mappings — screenshots will not be attached. Ensure the /results endpoint returns a 'cases' array.");
        }
    }
    writeUnsentResults() {
        const file = (0, path_1.resolve)(this.config.unsentResultsPath ?? `alpaqa-unsent-results-${this.testRunId}.json`);
        try {
            (0, fs_1.writeFileSync)(file, JSON.stringify({
                testRunId: this.testRunId,
                undelivered: this.undelivered,
                unconfirmedUnmapped: this.unconfirmed,
                rejectedCount: this.rejectedCount,
                rejectionMessages: this.rejectionMessages,
                partiallyRejectedBatches: this.partiallyRejected,
            }, null, 2));
            return file;
        }
        catch (err) {
            console.error("[TestManagement] Failed to write unsent results file:", err);
            return undefined;
        }
    }
}
exports.TestManagementReporter = TestManagementReporter;
