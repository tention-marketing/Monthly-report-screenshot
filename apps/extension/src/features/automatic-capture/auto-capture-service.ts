import type { ReportPeriod, ScreenshotType } from "@tention/report-schema";
import type { CaptureFailureCode, CapturedImage } from "../screenshot-capture/capture-service.js";
import type { ExecutiveSummaryTargetBounds, KlaviyoAutomationFailureCode } from "../klaviyo-navigation/executive-summary-adapter.js";
import type { ToolbarInvocationDiagnostics } from "../klaviyo-navigation/active-tab-grant.js";
import type { CampaignsSourceInspectionResult } from "../klaviyo-navigation/campaigns-source-inspector.js";
import type { BusinessReviewFailureCode, BusinessReviewTargetBounds } from "../klaviyo-navigation/business-review-capture.js";
import type { DashboardFailureCode, DashboardTargetBounds } from "../klaviyo-navigation/dashboard-capture.js";
import type { CampaignsEvidence, CampaignsFailureCode, CampaignTargetBounds } from "../klaviyo-navigation/campaigns-capture.js";
import type { BusinessReviewDiscoveryFailure, BusinessReviewDiscoveryRequest, BusinessReviewDiscoveryResult } from "../klaviyo-navigation/business-review-discovery.js";

export type AutoCaptureStage = "preparing" | "capturing" | "review_ready" | "failed";

export interface ExecutiveSummaryAutoCaptureRequest {
  reportId: string;
  screenshotType: ScreenshotType;
  accountUrl: string | null;
  period: ReportPeriod;
  /** These are report configuration, never provider credentials or IDs. */
  clientName?: string;
  clientTimezone?: string;
  conversionMetric?: string;
  desiredCampaignCount?: number;
}

export interface AutoCapturePendingState {
  request: ExecutiveSummaryAutoCaptureRequest;
  stage: "preparing" | "capturing";
}

export interface AutoCaptureReviewState {
  request: ExecutiveSummaryAutoCaptureRequest;
  stage: "review_ready";
  sourceTabId: number;
  detectedPeriod: string;
  periodEvidence?: { startDate: string; endDate: string; comparisonStartDate?: string; comparisonEndDate?: string };
  target: ExecutiveSummaryTargetBounds | BusinessReviewTargetBounds | DashboardTargetBounds | CampaignTargetBounds;
  campaignsEvidence?: CampaignsEvidence;
  captured: CapturedImage;
}

export interface AutoCaptureFailureState {
  request: ExecutiveSummaryAutoCaptureRequest;
  stage: "failed";
  code: KlaviyoAutomationFailureCode | BusinessReviewFailureCode | DashboardFailureCode | CampaignsFailureCode | CaptureFailureCode | "CAPTURE_FAILED" | "BUSINESS_REVIEW_URL_REQUIRED" | "BUSINESS_REVIEW_NAVIGATION_FAILED" | "SCRIPT_RESULT_EMPTY" | "SCRIPT_RESULT_UNDEFINED" | "SCRIPT_RESULT_INVALID";
  message: string;
  diagnostics?: Record<string, unknown>;
  viewportScreenshot?: CapturedImage | null;
}

export type AutoCaptureState = AutoCapturePendingState | AutoCaptureReviewState | AutoCaptureFailureState;

export type AutoCaptureMessage =
  | { type: "DISCOVER_BUSINESS_REVIEW"; request: BusinessReviewDiscoveryRequest }
  | { type: "START_KLAVIYO_AUTO_CAPTURE"; request: ExecutiveSummaryAutoCaptureRequest }
  | { type: "GET_KLAVIYO_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "CLEAR_KLAVIYO_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "START_BUSINESS_REVIEW_AUTO_CAPTURE"; request: ExecutiveSummaryAutoCaptureRequest }
  | { type: "GET_BUSINESS_REVIEW_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "CLEAR_BUSINESS_REVIEW_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "START_EXECUTIVE_SUMMARY_AUTO_CAPTURE"; request: ExecutiveSummaryAutoCaptureRequest }
  | { type: "GET_EXECUTIVE_SUMMARY_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "CLEAR_EXECUTIVE_SUMMARY_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "GET_KLAVIYO_TOOLBAR_DIAGNOSTICS" }
  | { type: "INSPECT_KLAVIYO_CAMPAIGNS_SOURCE" }
  | { type: "GET_EXTENSION_BUILD" };

export type { BusinessReviewDiscoveryFailure, BusinessReviewDiscoveryResult };

export async function discoverBusinessReview(input: BusinessReviewDiscoveryRequest): Promise<BusinessReviewDiscoveryResult> {
  const chromeApi = (globalThis as typeof globalThis & { chrome?: { runtime?: { sendMessage(message: AutoCaptureMessage): Promise<unknown> } } }).chrome;
  if (!chromeApi?.runtime) return { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Business Review discovery requires the Tention Chrome extension." };
  const response = await chromeApi.runtime.sendMessage({ type: "DISCOVER_BUSINESS_REVIEW", request: input });
  if (isBusinessReviewDiscoveryResult(response)) return response;
  return { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "The extension could not verify a Business Review dashboard." };
}

export interface AutoCaptureService {
  start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState>;
  get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null>;
  clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void>;
  getToolbarDiagnostics?(): Promise<ToolbarInvocationDiagnostics | null>;
  inspectCampaignsSource?(): Promise<CampaignsSourceInspectionResult | null>;
  /** The build the service worker is actually executing; null when it cannot say. */
  getExtensionBuild?(): Promise<string | null>;
}

interface ChromeRuntimeApi {
  sendMessage(message: AutoCaptureMessage): Promise<unknown>;
}

interface ChromeApi { runtime?: ChromeRuntimeApi }

/** UI client only sends messages; the service worker owns the Chrome automation. */
export class ChromeAutoCaptureService implements AutoCaptureService {
  constructor(private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome) {}

  async start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState> {
    const state = await this.send({ type: "START_KLAVIYO_AUTO_CAPTURE", request }) as AutoCaptureState | null;
    if (!state) throw new Error("Automatic capture could not be started by the extension service worker.");
    return state;
  }

  async get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null> {
    return await this.send({ type: "GET_KLAVIYO_AUTO_CAPTURE", request }) as AutoCaptureState | null;
  }

  async clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void> {
    await this.send({ type: "CLEAR_KLAVIYO_AUTO_CAPTURE", request });
  }

  async getToolbarDiagnostics(): Promise<ToolbarInvocationDiagnostics | null> {
    const response = await this.send({ type: "GET_KLAVIYO_TOOLBAR_DIAGNOSTICS" });
    return isToolbarInvocationDiagnostics(response) ? response : null;
  }

  async inspectCampaignsSource(): Promise<CampaignsSourceInspectionResult | null> {
    const response = await this.send({ type: "INSPECT_KLAVIYO_CAMPAIGNS_SOURCE" });
    return isCampaignsSourceInspectionResult(response) ? response : null;
  }

  async getExtensionBuild(): Promise<string | null> {
    const response = await this.send({ type: "GET_EXTENSION_BUILD" });
    return typeof response === "string" ? response : null;
  }

  private async send(message: AutoCaptureMessage): Promise<unknown> {
    if (!this.chromeApi?.runtime) throw new Error("Extension service-worker automation is unavailable in this environment.");
    return await this.chromeApi.runtime.sendMessage(message) ?? null;
  }
}

export const unavailableAutoCaptureService: AutoCaptureService = {
  async start() { throw new Error("Extension service-worker automation is unavailable in this environment."); },
  async get() { return null; },
  async clear() {},
};

export function autoCaptureKey(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): string {
  return `tention.business-review-auto-capture.${request.reportId}.${request.screenshotType}`;
}

function isToolbarInvocationDiagnostics(value: unknown): value is ToolbarInvocationDiagnostics {
  if (typeof value !== "object" || value === null) return false;
  const diagnostics = value as Partial<ToolbarInvocationDiagnostics>;
  return (diagnostics.grantedTabId === null || typeof diagnostics.grantedTabId === "number")
    && (diagnostics.currentActiveTabId === null || typeof diagnostics.currentActiveTabId === "number")
    && typeof diagnostics.routeMatched === "boolean"
    && (diagnostics.actionInvocation === null || typeof diagnostics.actionInvocation === "object");
}

function isCampaignsSourceInspectionResult(value: unknown): value is CampaignsSourceInspectionResult {
  if (!value || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string";
  return "sourceUrl" in value && typeof value.sourceUrl === "string" && "sourceTabId" in value && typeof value.sourceTabId === "number"
    && "pageRendered" in value && typeof value.pageRendered === "boolean" && "tableHeaders" in value && Array.isArray(value.tableHeaders)
    && "visibleRows" in value && Array.isArray(value.visibleRows);
}

function isBusinessReviewDiscoveryResult(value: unknown): value is BusinessReviewDiscoveryResult {
  if (!value || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return "code" in value && typeof value.code === "string" && "message" in value && typeof value.message === "string";
  return "dashboardUrl" in value && typeof value.dashboardUrl === "string" && "accountLabel" in value && typeof value.accountLabel === "string"
    && ("evidence" in value || ("verification" in value && value.verification === "saved_target_account"));
}
