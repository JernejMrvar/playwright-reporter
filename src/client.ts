import { readFile } from "fs/promises";
import { basename } from "path";
import type { TestResultPayload } from "./types";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * A failed API call. `ambiguous` is true when the server may already have
 * processed the request (timeout, dropped connection, 5xx other than 503), so
 * blindly resending a non-idempotent write could duplicate data.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly ambiguous: boolean,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function classifyStatus(status: number): { ambiguous: boolean; retryable: boolean } {
  // 429/503 are rejected before any work happens: safe to resend as-is.
  if (status === 429 || status === 503) return { ambiguous: false, retryable: true };
  if (status >= 500) return { ambiguous: true, retryable: true };
  return { ambiguous: false, retryable: false };
}

export class TestManagementClient {
  private baseUrl: string;
  private apiToken: string;
  private timeoutMs: number;

  constructor(baseUrl: string, apiToken: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiToken = apiToken;
    this.timeoutMs = timeoutMs;
  }

  private async send(url: string, label: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiError(`API request failed: ${label} -> ${reason}`, undefined, true, true);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const { ambiguous, retryable } = classifyStatus(res.status);
      throw new ApiError(
        `API request failed: ${label} -> ${res.status} ${text}`,
        res.status,
        ambiguous,
        retryable
      );
    }
    return res;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await this.send(url, `${method} ${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    return res.json() as Promise<T>;
  }

  async createTestRun(data: {
    name: string;
    description?: string;
    source?: string;
    environment?: string;
  }): Promise<{ id: number; name: string; status: string }> {
    return this.request("POST", "/test-runs", data);
  }

  async reportResults(
    testRunId: number,
    results: TestResultPayload[]
  ): Promise<{
    mapped: number;
    unmapped: number;
    errors: string[];
    cases: { testCaseId: number; testCasePublicId: string | null; testRunCaseId: number }[];
  }> {
    return this.request("POST", `/test-runs/${testRunId}/results`, {
      results,
    });
  }

  async resolveTestCasePublicId(publicId: string): Promise<{ id: number }> {
    const match = /^([A-Za-z0-9]{2,10})-(\d+)$/.exec(publicId);
    if (!match) {
      throw new Error(`Invalid test case public ID: ${publicId}`);
    }

    const [, projectCode, publicNumber] = match;
    return this.request(
      "GET",
      `/projects/by-code/${encodeURIComponent(projectCode)}/test-cases/${encodeURIComponent(publicNumber)}`
    );
  }

  async uploadScreenshot(
    filePath: string,
    filename: string,
    contentType: string
  ): Promise<{ url: string; filename: string; contentType: string; sizeBytes: number }> {
    const fileBuffer = await readFile(filePath);
    const form = new FormData();
    form.append("file", new Blob([fileBuffer], { type: contentType }), basename(filename));

    const url = `${this.baseUrl}/api/v1/upload`;
    const res = await this.send(url, "POST /upload", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: form,
    });

    return res.json() as Promise<{ url: string; filename: string; contentType: string; sizeBytes: number }>;
  }

  async postComment(
    testRunId: number,
    testRunCaseId: number,
    content: string,
    attachments: { url: string; filename: string; contentType: string; size: number }[]
  ): Promise<void> {
    await this.request("POST", `/test-runs/${testRunId}/cases/${testRunCaseId}/comments`, {
      content,
      attachments,
    });
  }

  async completeTestRun(
    testRunId: number,
    status: "COMPLETED" | "CANCELLED" = "COMPLETED"
  ): Promise<unknown> {
    return this.request("POST", `/test-runs/${testRunId}/complete`, {
      status,
    });
  }
}
