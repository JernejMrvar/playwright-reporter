import { readFile } from "fs/promises";
import { basename } from "path";
import type { TestResultPayload } from "./types";

export class TestManagementClient {
  private baseUrl: string;
  private apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiToken = apiToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
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
      throw new Error(
        `API request failed: ${method} ${path} -> ${res.status} ${text}`
      );
    }

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
  ): Promise<{ mapped: number; unmapped: number; errors: string[]; cases: { testCaseId: number; testRunCaseId: number }[] }> {
    return this.request("POST", `/test-runs/${testRunId}/results`, {
      results,
    });
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
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiToken}` },
      body: form,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API request failed: POST /upload -> ${res.status} ${text}`);
    }

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
