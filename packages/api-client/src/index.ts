import {
  automaticCaptureTypesForSections, matchesReportCaptureSpec, reportDraftSchema, screenshotSourceProofSchema, reportGenerationResultSchema, reportLifecycleEventSchema, reportPdfArtifactSchema, screenshotUploadAcknowledgementSchema, type ReportDraft, type ReportGenerationResult, type ReportLifecycleEvent, type ReportPdfArtifact, type ScreenshotUploadAcknowledgement,
  clientReportTargetsInputSchema, clientReportTargetsSchema, reportReadinessSchema, type ClientReportTargets, type ClientReportTargetsInput, type ReportLifecycleEventType, type ReportReadiness, type ScreenshotType, type ScreenshotSourceProof, type SectionConfiguration,
} from "@tention/report-schema";
import { z } from "zod";

export interface HealthResponse { ok: true }
export interface DevelopmentReviewPdfStatus {
  reportId: string;
  reportVersion: number;
  fileName: string;
  byteSize: number;
  sha256: string;
  physicalPageCount: number;
  developmentOnly: true;
}
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
  | "REPORT_DELETE_FAILED"
  | "ILLEGAL_REPORT_TRANSITION" | "SCREENSHOT_TOO_LARGE" | "INVALID_SCREENSHOT_TYPE"
  | "INVALID_SCREENSHOT_CONTENT" | "SCREENSHOT_NOT_FOUND" | "STORAGE_ERROR" | "UNKNOWN_API_ERROR" | string;

export interface UploadScreenshotImageRequest {
  expectedVersion: number;
  periodConfirmed: true;
  sourceUrl: string | null;
  sourceProof: ScreenshotSourceProof;
  image: Blob;
}
export interface AutomaticCaptureRunIdentity {
  runId: string; reportId: string; clientId: string; reportMonth: { year: number; month: number }; startedAt: string; extensionBuild?: string;
  /** "resume" captures only `plannedSections` (missing/stale ones) and keeps the report's other valid captures. */
  mode?: "full" | "resume"; plannedSections?: ScreenshotType[];
}
export interface AutomaticCaptureSectionResult {
  status: "running" | "pass" | "fail"; attemptNumber: number; startedAt: string; finishedAt: string | null; durationMs: number | null;
  expectedUrl: string | null; observedUrl: string | null; expectedSourceIdentity: string | null; observedSourceIdentity: string | null; expectedPeriod: Record<string, string> | null; observedPeriod: string | null;
  expectedSemanticCard: string | null; expectedView: string | null; visibleControls: Record<string, unknown>[]; usableRowCount: number | null;
  screenshotResult: string | null; sourceProofResult: string | null; sha256: string | null; errorCode: string | null; errorMessage: string | null; diagnostics: Record<string, unknown> | null;
}
export interface AutomaticCaptureRunStatus { status: "completed" | "failed"; finishedAt: string; durationMs: number }

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
    /** Local development: explicitly adds Section 10 (Subscriber Growth) to an existing draft. */
    async enableSubscriberGrowthSection(id: string, expectedVersion: number): Promise<ReportDraft> {
      const report = reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/dev/report-drafts/${encodeURIComponent(id)}/sections/email_subscriber_growth/enable`, jsonRequest("POST", { expectedVersion })));
      if (report.id !== id || report.sections.email_subscriber_growth !== "required") throw new ApiError("SUBSCRIBER_GROWTH_ENABLE_ACK_MISMATCH", "The backend did not confirm Section 10 on this report.", 200);
      return report;
    },
    /** Clients with a saved one-time profile (name, timezone, account, sources). */
    async listClientConfigurations(): Promise<ClientReportTargets[]> {
      return z.array(clientReportTargetsSchema).parse(await requestJson(request, `${baseUrl}/api/v1/clients`));
    },
    async getClientReportTargets(clientId: string): Promise<ClientReportTargets> {
      return clientReportTargetsSchema.parse(await requestJson(request, `${baseUrl}/api/v1/clients/${encodeURIComponent(clientId)}/report-targets`));
    },
    async saveClientReportTargets(clientId: string, input: ClientReportTargetsInput): Promise<ClientReportTargets> {
      const payload = clientReportTargetsInputSchema.parse(input);
      return clientReportTargetsSchema.parse(await requestJson(request, `${baseUrl}/api/v1/clients/${encodeURIComponent(clientId)}/report-targets`, jsonRequest("PUT", payload)));
    },
    async getReportReadiness(clientId: string, sections: SectionConfiguration): Promise<ReportReadiness> {
      return reportReadinessSchema.parse(await requestJson(request, `${baseUrl}/api/v1/clients/${encodeURIComponent(clientId)}/report-readiness`, jsonRequest("POST", { sections })));
    },
    async deleteReportDraft(id: string, expectedVersion: number): Promise<void> {
      await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}`, jsonRequest("DELETE", { expectedVersion }));
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
    async uploadScreenshotImage(id: string, type: ScreenshotType, input: UploadScreenshotImageRequest): Promise<ReportDraft> {
      // Persistence is confirmed by comparing proof JSON text, so send the exact
      // schema-normalized form the API stores. Proof that fails the shared
      // contract is rejected here instead of as an opaque 400.
      const parsedProof = screenshotSourceProofSchema.safeParse(input.sourceProof);
      if (!parsedProof.success) throw new ApiError("SCREENSHOT_SOURCE_PROOF_INVALID", "The capture proof does not match the capture proof contract.", null, parsedProof.error.issues);
      const sourceProof = parsedProof.data;
      const response = await requestResponse(request, `${baseUrl}/api/v1/report-drafts/${encodeURIComponent(id)}/screenshots/${type}/image`, {
        method: "PUT",
        headers: {
          "content-type": "image/png",
          "x-expected-version": String(input.expectedVersion),
          "x-period-confirmed": "true",
          "x-capture-proof": asciiJson(sourceProof),
          ...(input.sourceUrl ? { "x-source-url": input.sourceUrl } : {}),
        },
        body: input.image,
      });
      if (!response.ok) throw await toApiError(response);
      if (response.status !== 200) throw new ApiError("SCREENSHOT_UPLOAD_HTTP_STATUS_UNEXPECTED", "Screenshot upload returned an unexpected success status.", response.status);
      let acknowledgement: ScreenshotUploadAcknowledgement;
      try { acknowledgement = screenshotUploadAcknowledgementSchema.parse(await response.json()); }
      catch (error) { throw new ApiError("SCREENSHOT_UPLOAD_ACK_INVALID", "The API response did not confirm screenshot persistence.", response.status, error); }
      const record = acknowledgement.report.screenshots.find((screenshot) => screenshot.type === type);
      if (acknowledgement.reportId !== id || acknowledgement.report.id !== id || acknowledgement.screenshotType !== type
        || acknowledgement.approvalStatus !== "approved" || acknowledgement.sourceProofAccepted !== true
        || acknowledgement.report.version <= input.expectedVersion || !record
        || record.id !== acknowledgement.screenshotRecordId || record.clientId !== acknowledgement.report.client.id
        || record.reportMonth.year !== acknowledgement.report.reportMonth.year || record.reportMonth.month !== acknowledgement.report.reportMonth.month
        || !record.approved || !record.approvedAt || !record.periodConfirmed || record.sha256 !== acknowledgement.sha256
        || !record.sourceProof || !matchesReportCaptureSpec(type, record.sourceProof)
        || JSON.stringify(record.sourceProof) !== JSON.stringify(sourceProof)) {
        throw new ApiError("SCREENSHOT_UPLOAD_ACK_MISMATCH", "The API acknowledgement did not match the approved screenshot and source proof.", response.status);
      }
      const localSha256 = await sha256(input.image);
      if (localSha256 !== acknowledgement.sha256) {
        throw new ApiError("SCREENSHOT_SHA256_MISMATCH", "The stored screenshot hash did not match the uploaded PNG bytes.", response.status);
      }
      let canonical: ReportDraft;
      try {
        const canonicalResponse = await requestResponse(request, `${baseUrl}/api/v1/report-drafts/${encodeURIComponent(id)}`);
        if (!canonicalResponse.ok) throw await toApiError(canonicalResponse);
        if (canonicalResponse.status !== 200) throw new ApiError("CANONICAL_DRAFT_HTTP_STATUS_UNEXPECTED", "Canonical report reload returned an unexpected success status.", canonicalResponse.status);
        canonical = reportDraftSchema.parse(await canonicalResponse.json());
      }
      catch (error) {
        const apiError = error instanceof ApiError ? error : null;
        throw new ApiError("CANONICAL_DRAFT_RELOAD_FAILED", "Upload was acknowledged, but the canonical report could not be reloaded to confirm persistence.", apiError?.status ?? null, { causeCode: apiError?.code ?? "UNKNOWN_API_ERROR" });
      }
      const persisted = canonical.screenshots.find((screenshot) => screenshot.type === type);
      if (canonical.id !== id || canonical.client.id !== acknowledgement.report.client.id
        || canonical.reportMonth.year !== acknowledgement.report.reportMonth.year || canonical.reportMonth.month !== acknowledgement.report.reportMonth.month
        || canonical.version < acknowledgement.report.version || !persisted
        || persisted.id !== acknowledgement.screenshotRecordId || persisted.id !== record.id
        || persisted.sha256 !== acknowledgement.sha256 || !persisted.approved || !persisted.approvedAt || !persisted.periodConfirmed
        || !persisted.sourceProof || JSON.stringify(persisted.sourceProof) !== JSON.stringify(sourceProof)) {
        throw new ApiError("SCREENSHOT_PERSISTENCE_NOT_CONFIRMED", "The canonical report reload did not contain the acknowledged approved screenshot.", response.status);
      }
      return canonical;
    },
    async getScreenshotImage(id: string, type: ScreenshotType): Promise<Blob> {
      const response = await requestResponse(request, `${baseUrl}/api/v1/report-drafts/${id}/screenshots/${type}/image`);
      if (!response.ok) throw await toApiError(response);
      if (!response.headers.get("content-type")?.startsWith("image/png")) {
        throw new ApiError("INVALID_SCREENSHOT_CONTENT", "Screenshot image response was not PNG.", response.status);
      }
      return response.blob();
    },
    async getPendingImportedScreenshotImage(id: string, type: ScreenshotType, expectedSha256: string): Promise<Blob> {
      const response = await requestResponse(request, `${baseUrl}/api/v1/dev/report-drafts/${encodeURIComponent(id)}/screenshots/${type}/pending-image`);
      if (!response.ok) throw await toApiError(response);
      if (response.headers.get("x-report-id") !== id || response.headers.get("x-screenshot-type") !== type || response.headers.get("x-screenshot-sha256") !== expectedSha256
        || !response.headers.get("content-type")?.startsWith("image/png")) throw new ApiError("IMPORTED_REVIEW_IMAGE_ACK_MISMATCH", "The pending review image did not match the selected report capture.", response.status);
      return response.blob();
    },
    async startLocalAutomaticCaptureRun(input: AutomaticCaptureRunIdentity): Promise<void> {
      const acknowledgement = asRecord(await requestJson(request, `${baseUrl}/api/v1/dev/automatic-capture-runs`, jsonRequest("POST", input)));
      if (acknowledgement.runId !== input.runId || acknowledgement.reportId !== input.reportId || acknowledgement.clientId !== input.clientId || acknowledgement.status !== "running") throw new ApiError("AUTOMATIC_RUN_START_ACK_MISMATCH", "The backend did not confirm a diagnostic run for this report.", 201);
    },
    async saveLocalAutomaticCaptureSection(runId: string, section: ScreenshotType, input: AutomaticCaptureSectionResult): Promise<void> {
      const acknowledgement = asRecord(await requestJson(request, `${baseUrl}/api/v1/dev/automatic-capture-runs/${encodeURIComponent(runId)}/sections/${encodeURIComponent(section)}`, jsonRequest("POST", input)));
      if (acknowledgement.runId !== runId || acknowledgement.section !== section || acknowledgement.status !== input.status || acknowledgement.attemptNumber !== input.attemptNumber) throw new ApiError("AUTOMATIC_RUN_SECTION_ACK_MISMATCH", "The backend did not confirm this section attempt diagnostic.", 200);
    },
    async saveLocalAutomaticCaptureEvidence(runId: string, section: ScreenshotType, kind: "capture" | "viewport", image: Blob, attemptNumber = 1): Promise<{ sha256: string; byteSize: number }> {
      const response = await requestResponse(request, `${baseUrl}/api/v1/dev/automatic-capture-runs/${encodeURIComponent(runId)}/sections/${encodeURIComponent(section)}/evidence/${kind}?attempt=${attemptNumber}`, { method: "PUT", headers: { "content-type": "image/png" }, body: image });
      if (!response.ok) throw await toApiError(response);
      const body = asRecord(await response.json());
      const sha256 = typeof body.sha256 === "string" ? body.sha256 : "";
      const byteSize = Number(body.byteSize);
      if (body.runId !== runId || body.section !== section || body.kind !== kind || !/^[a-f0-9]{64}$/.test(sha256) || byteSize !== image.size) throw new ApiError("AUTOMATIC_RUN_EVIDENCE_ACK_MISMATCH", "Local diagnostic storage did not confirm the screenshot bytes.", response.status);
      return { sha256, byteSize };
    },
    async finishLocalAutomaticCaptureRun(runId: string, input: AutomaticCaptureRunStatus): Promise<void> {
      const acknowledgement = asRecord(await requestJson(request, `${baseUrl}/api/v1/dev/automatic-capture-runs/${encodeURIComponent(runId)}/finish`, jsonRequest("POST", input)));
      if (acknowledgement.runId !== runId || acknowledgement.status !== input.status || acknowledgement.durationMs !== input.durationMs) throw new ApiError("AUTOMATIC_RUN_FINISH_ACK_MISMATCH", "The backend did not confirm completion of the diagnostic run.", 200);
    },
    async getLocalAutomaticCaptureRun(runId: string): Promise<unknown> {
      return await requestJson(request, `${baseUrl}/api/v1/dev/automatic-capture-runs/${encodeURIComponent(runId)}`);
    },
    async importLocalAutomaticCaptureRun(runId: string, report: Pick<ReportDraft, "id" | "client" | "reportMonth" | "sections">, importedTypes?: readonly ScreenshotType[]): Promise<ReportDraft> {
      const raw = asRecord(await requestJson(request, `${baseUrl}/api/v1/dev/automatic-capture-runs/${encodeURIComponent(runId)}/import`, jsonRequest("POST", {})));
      const captures = z.array(z.object({ type: z.string(), screenshotRecordId: z.string().uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/), reviewStatus: z.enum(["approved", "pending_review"]), captureOrigin: z.literal("live_acceptance_import") })).parse(raw.captures);
      // The nine core sections, plus Section 10 only when this report includes it.
      const automaticTypes = automaticCaptureTypesForSections(report.sections);
      // A resume imports only its planned sections; the report must still hold every automatic section afterwards.
      const imported = importedTypes ?? automaticTypes;
      if (raw.runId !== runId || raw.reportId !== report.id || raw.clientId !== report.client.id || raw.capturedCount !== automaticTypes.length || raw.missingAutomaticCount !== 0 || captures.length !== imported.length) throw new ApiError("AUTOMATIC_RUN_IMPORT_ACK_MISMATCH", `The backend did not confirm all ${automaticTypes.length} captures on the canonical report.`, 200);
      const canonical = await requestJson(request, `${baseUrl}/api/v1/report-drafts/${encodeURIComponent(raw.reportId)}`).then((data) => reportDraftSchema.parse(data));
      if (automaticTypes.some((type) => !canonical.screenshots.some((item) => item.type === type))) throw new ApiError("AUTOMATIC_RUN_IMPORT_RELOAD_MISMATCH", "The reloaded report is missing an automatic capture.", 200);
      const expected = new Set<string>(imported);
      for (const capture of captures) {
        const persisted = canonical.screenshots.find((item) => item.type === capture.type);
        if (!expected.has(capture.type) || !persisted || persisted.id !== capture.screenshotRecordId || persisted.sha256 !== capture.sha256 || persisted.captureOrigin !== "live_acceptance_import" || persisted.approved !== (capture.reviewStatus === "approved")) throw new ApiError("AUTOMATIC_RUN_IMPORT_RELOAD_MISMATCH", "The canonical report reload did not contain the imported capture acknowledgement.", 200);
        expected.delete(capture.type);
      }
      // Review counts cover every automatic capture on the reloaded report (a resume imports only some of them).
      const automaticRecords = canonical.screenshots.filter((item) => automaticTypes.includes(item.type));
      const pendingReviewCount = automaticRecords.filter((item) => !item.approved).length;
      const approvedCount = automaticRecords.filter((item) => item.approved).length;
      if (expected.size || raw.pendingReviewCount !== pendingReviewCount || raw.approvedCount !== approvedCount
        || canonical.id !== raw.reportId || canonical.version < Number(raw.reportVersion)
        || canonical.client.id !== report.client.id || canonical.client.name !== report.client.name || canonical.client.timezone !== report.client.timezone
        || canonical.reportMonth.year !== report.reportMonth.year || canonical.reportMonth.month !== report.reportMonth.month) throw new ApiError("AUTOMATIC_RUN_IMPORT_RELOAD_MISMATCH", "The reloaded report identity or imported capture set did not match the completed run.", 200);
      return canonical;
    },
    async approveImportedScreenshot(id: string, type: ScreenshotType, input: { expectedVersion: number; expectedSha256: string }): Promise<ReportDraft> {
      const acknowledgement = screenshotUploadAcknowledgementSchema.parse(await requestJson(request,
        `${baseUrl}/api/v1/dev/report-drafts/${encodeURIComponent(id)}/screenshots/${type}/review`,
        jsonRequest("POST", input)));
      const acknowledged = acknowledgement.report.screenshots.find((screenshot) => screenshot.type === type);
      if (acknowledgement.reportId !== id || acknowledgement.report.id !== id || acknowledgement.screenshotType !== type
        || acknowledgement.approvalStatus !== "approved" || acknowledgement.sourceProofAccepted !== true
        || acknowledgement.sha256 !== input.expectedSha256 || !acknowledged || acknowledged.id !== acknowledgement.screenshotRecordId
        || !acknowledged.approved || acknowledged.captureOrigin !== "live_acceptance_import" || acknowledged.sha256 !== input.expectedSha256
        || acknowledgement.report.version <= input.expectedVersion) throw new ApiError("IMPORTED_REVIEW_ACK_MISMATCH", "The review acknowledgement did not match the selected imported screenshot.", 200);
      const canonical = reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${encodeURIComponent(id)}`));
      const persisted = canonical.screenshots.find((screenshot) => screenshot.type === type);
      if (canonical.version < acknowledgement.report.version || !persisted || persisted.id !== acknowledgement.screenshotRecordId
        || !persisted.approved || persisted.captureOrigin !== "live_acceptance_import" || persisted.sha256 !== input.expectedSha256
        || JSON.stringify(persisted.sourceProof) !== JSON.stringify(acknowledged.sourceProof)) throw new ApiError("IMPORTED_REVIEW_PERSISTENCE_NOT_CONFIRMED", "The canonical report reload did not confirm the reviewed screenshot.", 200);
      return canonical;
    },
    async applyEvent(id: string, event: ReportMutationEvent, expectedVersion: number): Promise<ReportDraft> {
      return reportDraftSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/events`, jsonRequest("POST", { expectedVersion, event })));
    },
    async generatePdf(id: string, expectedVersion: number): Promise<ReportGenerationResult> {
      return reportGenerationResultSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/generate`, jsonRequest("POST", { expectedVersion })));
    },
    async getCurrentPdfArtifact(id: string): Promise<ReportPdfArtifact> {
      return reportPdfArtifactSchema.parse(await requestJson(request, `${baseUrl}/api/v1/report-drafts/${id}/pdf-artifact`));
    },
    async generateDevelopmentReviewPdf(id: string, expectedReportVersion?: number): Promise<DevelopmentReviewPdfStatus> {
      const data = await requestJson(request, `${baseUrl}/api/v1/dev/report-drafts/${encodeURIComponent(id)}/partial-review`, jsonRequest("POST", {}));
      return parseDevelopmentReviewPdfStatus(data, id, expectedReportVersion);
    },
    async getDevelopmentReviewPdfStatus(id: string, expectedReportVersion?: number): Promise<DevelopmentReviewPdfStatus> {
      const data = await requestJson(request, `${baseUrl}/api/v1/dev/report-drafts/${encodeURIComponent(id)}/partial-review/status`);
      return parseDevelopmentReviewPdfStatus(data, id, expectedReportVersion);
    },
    reportPreviewUrl(id: string): string { return `${baseUrl}/api/v1/report-drafts/${encodeURIComponent(id)}/preview`; },
    reportPdfUrl(id: string, download = false): string { return `${baseUrl}/api/v1/report-drafts/${encodeURIComponent(id)}/pdf${download ? "?download=1" : ""}`; },
    developmentReviewPdfUrl(id: string, download = false): string { return `${baseUrl}/api/v1/dev/report-drafts/${encodeURIComponent(id)}/partial-review/pdf${download ? "?download=1" : ""}`; },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;

function isHealthResponse(value: unknown): value is HealthResponse {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === true;
}

function parseDevelopmentReviewPdfStatus(value: unknown, expectedReportId: string, expectedReportVersion?: number): DevelopmentReviewPdfStatus {
  const root = asRecord(value);
  const reportId = typeof root.reportId === "string" ? root.reportId : typeof root.canonicalReportId === "string" ? root.canonicalReportId : "";
  const lifecycle = asRecord(root.reportLifecycle);
  const pdf = asRecord(root.pdf);
  const reportVersion = typeof root.reportVersion === "number" ? root.reportVersion : lifecycle.version;
  const fileName = typeof root.fileName === "string" ? root.fileName : "Performance-Review.pdf";
  const status = {
    reportId, reportVersion: Number(reportVersion), fileName,
    byteSize: Number(pdf.byteSize ?? root.byteSize),
    sha256: String(pdf.sha256 ?? root.sha256 ?? ""),
    physicalPageCount: Number(pdf.physicalPageCount ?? root.physicalPageCount),
  };
  if (reportId !== expectedReportId || (typeof lifecycle.status === "string" && lifecycle.status !== "draft")
    || !Number.isSafeInteger(status.reportVersion) || status.reportVersion < 1
    || (expectedReportVersion !== undefined && status.reportVersion !== expectedReportVersion)
    || !Number.isSafeInteger(status.byteSize) || status.byteSize <= 0
    || !/^[a-f0-9]{64}$/.test(status.sha256)
    || !Number.isSafeInteger(status.physicalPageCount) || status.physicalPageCount <= 0
    || root.developmentOnly !== true) {
    throw new ApiError("PARTIAL_REVIEW_ACK_INVALID", "The API did not confirm a current development review PDF for this report.", 200);
  }
  return { ...status, developmentOnly: true };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function requestJson(request: typeof globalThis.fetch, url: string, init?: RequestInit): Promise<unknown> {
  const response = await requestResponse(request, url, init);
  if (!response.ok) throw await toApiError(response);
  return response.json();
}

async function requestResponse(request: typeof globalThis.fetch, url: string, init?: RequestInit): Promise<Response> {
  try { return await request(url, init); }
  catch (error) { throw new ApiError("NETWORK_ERROR", "The API could not be reached.", null, error); }
}

async function toApiError(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => null) as { error?: unknown; message?: unknown } | null;
  const code = typeof data?.error === "string" ? data.error : "UNKNOWN_API_ERROR";
  const message = typeof data?.message === "string" ? data.message : `API request failed with status ${response.status}.`;
  return new ApiError(code, message, response.status, data);
}

async function sha256(blob: Blob): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ApiError("SCREENSHOT_HASH_UNAVAILABLE", "This browser cannot verify the screenshot SHA-256.", null);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** HTTP header values must be Latin-1; JSON \u escapes keep campaign names
 * with dashes or emoji intact, and the API's JSON.parse restores them. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function jsonRequest(method: "POST" | "PUT" | "DELETE", body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
