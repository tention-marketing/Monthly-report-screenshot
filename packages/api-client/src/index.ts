import {
  reportDraftSchema, reportLifecycleEventSchema, type ReportDraft, type ReportLifecycleEvent,
  type ReportLifecycleEventType, type ScreenshotRecord, type ScreenshotType,
} from "@tention/report-schema";
import { z } from "zod";

export interface HealthResponse { ok: true }
export type ReportMutationEvent = Exclude<ReportLifecycleEventType, "REPORT_CREATED">;
export interface CreateReportDraftRequest {
  client: { id: string; name: string; timezone: string };
  reportMonth: { year: number; month: number };
  sections: Record<string, "required" | "optional" | "disabled">;
}
export interface ReportDraftFilters { clientId?: string; year?: number; month?: number }
export type ApiErrorCode =
  | "NETWORK_ERROR" | "REPORT_NOT_FOUND" | "REPORT_VERSION_CONFLICT"
  | "REPORT_DRAFT_ALREADY_EXISTS" | "INVALID_REQUEST" | "REPORT_VALIDATION_FAILED"
  | "ILLEGAL_REPORT_TRANSITION" | "UNKNOWN_API_ERROR" | string;

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number | null,
    public readonly details?: unknown,
  ) { super(message); this.name = "ApiError"; }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return {
    async health(): Promise<HealthResponse> {
      const data = await requestJson(request, `${baseUrl}/api/v1/health`);
      if (!isHealthResponse(data)) throw new ApiError("UNKNOWN_API_ERROR", "Health check returned an invalid response.", 200, data);
      return data;
    },
    async createReportDraft(input: CreateReportDraftRequest): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts`, jsonRequest("POST", input)));
    },
    async getReportDraft(id: string): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}`));
    },
    async listReportDrafts(filters: ReportDraftFilters = {}): Promise<ReportDraft[]> {
      const query = new URLSearchParams();
      if (filters.clientId !== undefined) query.set("clientId", filters.clientId);
      if (filters.year !== undefined) query.set("year", String(filters.year));
      if (filters.month !== undefined) query.set("month", String(filters.month));
      const suffix = query.size ? `?${query.toString()}` : "";
      return z.array(reportDraftSchema).parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts${suffix}`));
    },
    async validateReportDraft(id: string): Promise<ReportDraft["validation"]> {
      const data = await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/validate`, jsonRequest("POST", {}));
      return reportDraftSchema.shape.validation.parse(data);
    },
    async getReportHistory(id: string): Promise<ReportLifecycleEvent[]> {
      return z.array(reportLifecycleEventSchema).parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/history`));
    },
    async upsertScreenshot(id: string, type: ScreenshotType, expectedVersion: number, screenshot: ScreenshotRecord): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/screenshots/${type}`, jsonRequest("PUT", { expectedVersion, screenshot })));
    },
    async applyEvent(id: string, event: ReportMutationEvent, expectedVersion: number): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/events`, jsonRequest("POST", { expectedVersion, event })));
    },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;

function isHealthResponse(value: unknown): value is HealthResponse {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

async function requestJson(request: typeof globalThis.fetch, url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await request(url, init); }
  catch (error) { throw new ApiError("NETWORK_ERROR", "The API could not be reached.", null, error); }
  const data = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  if (!response.ok) {
    const code = typeof data?.error === "string" ? data.error : "UNKNOWN_API_ERROR";
    const message = typeof data?.message === "string" ? data.message : `API request failed with status ${response.status}.`;
    throw new ApiError(code, message, response.status, data);
  }
  return data;
}

function jsonRequest(method: "POST" | "PUT", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
