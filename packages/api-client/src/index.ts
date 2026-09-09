import {
  reportDraftSchema, reportLifecycleEventSchema, type ReportDraft, type ReportLifecycleEvent,
  type ReportLifecycleEventType, type ScreenshotRecord, type ScreenshotType,
} from "@tention/report-schema";
import { z } from "zod";

export interface HealthResponse { ok: true }
export type ReportMutationEvent = Exclude<ReportLifecycleEventType, "REPORT_CREATED">;

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    async health(): Promise<HealthResponse> {
      const response = await request(`${baseUrl}/api/v1/health`);
      if (!response.ok) throw new Error(`Health check failed with status ${response.status}`);
      const data: unknown = await response.json();
      if (!isHealthResponse(data)) throw new Error("Health check returned an invalid response");
      return data;
    },
    async getReportDraft(id: string): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}`));
    },
    async getReportHistory(id: string): Promise<ReportLifecycleEvent[]> {
      return z.array(reportLifecycleEventSchema).parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/history`));
    },
    async upsertScreenshot(id: string, type: ScreenshotType, expectedVersion: number, screenshot: ScreenshotRecord): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/screenshots/${type}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion, screenshot }),
      }));
    },
    async applyEvent(id: string, event: ReportMutationEvent, expectedVersion: number): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/events`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion, event }),
      }));
    },
  };
}

function isHealthResponse(value: unknown): value is HealthResponse {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

async function requestJson(request: typeof globalThis.fetch, url: string, init?: RequestInit): Promise<unknown> {
  const response = await request(url, init);
  if (!response.ok) throw new Error(`API request failed with status ${response.status}`);
  return response.json();
}
