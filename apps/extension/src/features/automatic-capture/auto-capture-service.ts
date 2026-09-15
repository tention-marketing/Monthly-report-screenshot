import type { ReportPeriod, ScreenshotType } from "@tention/report-schema";
import type { CaptureFailureCode, CapturedImage } from "../screenshot-capture/capture-service.js";
import type { ExecutiveSummaryTargetBounds, KlaviyoAutomationFailureCode } from "../klaviyo-navigation/executive-summary-adapter.js";
import type { ToolbarInvocationDiagnostics } from "../klaviyo-navigation/active-tab-grant.js";

export type AutoCaptureStage = "preparing" | "capturing" | "review_ready" | "failed";

export interface ExecutiveSummaryAutoCaptureRequest {
  reportId: string;
  screenshotType: Extract<ScreenshotType, "overview">;
  accountUrl: string | null;
  period: ReportPeriod;
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
  target: ExecutiveSummaryTargetBounds;
  captured: CapturedImage;
}

export interface AutoCaptureFailureState {
  request: ExecutiveSummaryAutoCaptureRequest;
  stage: "failed";
  code: KlaviyoAutomationFailureCode | CaptureFailureCode | "CAPTURE_FAILED";
  message: string;
}

export type AutoCaptureState = AutoCapturePendingState | AutoCaptureReviewState | AutoCaptureFailureState;

export type AutoCaptureMessage =
  | { type: "START_EXECUTIVE_SUMMARY_AUTO_CAPTURE"; request: ExecutiveSummaryAutoCaptureRequest }
  | { type: "GET_EXECUTIVE_SUMMARY_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "CLEAR_EXECUTIVE_SUMMARY_AUTO_CAPTURE"; request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType"> }
  | { type: "GET_KLAVIYO_TOOLBAR_DIAGNOSTICS" };

export interface AutoCaptureService {
  start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState>;
  get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null>;
  clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void>;
  getToolbarDiagnostics?(): Promise<ToolbarInvocationDiagnostics | null>;
}

interface ChromeRuntimeApi {
  sendMessage(message: AutoCaptureMessage): Promise<unknown>;
}

interface ChromeApi { runtime?: ChromeRuntimeApi }

/** UI client only sends messages; the service worker owns the Chrome automation. */
export class ChromeAutoCaptureService implements AutoCaptureService {
  constructor(private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome) {}

  async start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState> {
    const state = await this.send({ type: "START_EXECUTIVE_SUMMARY_AUTO_CAPTURE", request }) as AutoCaptureState | null;
    if (!state) throw new Error("Automatic capture could not be started by the extension service worker.");
    return state;
  }

  async get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null> {
    return await this.send({ type: "GET_EXECUTIVE_SUMMARY_AUTO_CAPTURE", request }) as AutoCaptureState | null;
  }

  async clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void> {
    await this.send({ type: "CLEAR_EXECUTIVE_SUMMARY_AUTO_CAPTURE", request });
  }

  async getToolbarDiagnostics(): Promise<ToolbarInvocationDiagnostics | null> {
    const response = await this.send({ type: "GET_KLAVIYO_TOOLBAR_DIAGNOSTICS" });
    return isToolbarInvocationDiagnostics(response) ? response : null;
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
  return `tention.executive-summary-auto-capture.${request.reportId}.${request.screenshotType}`;
}

function isToolbarInvocationDiagnostics(value: unknown): value is ToolbarInvocationDiagnostics {
  if (typeof value !== "object" || value === null) return false;
  const diagnostics = value as Partial<ToolbarInvocationDiagnostics>;
  return (diagnostics.grantedTabId === null || typeof diagnostics.grantedTabId === "number")
    && (diagnostics.currentActiveTabId === null || typeof diagnostics.currentActiveTabId === "number")
    && typeof diagnostics.routeMatched === "boolean"
    && (diagnostics.actionInvocation === null || typeof diagnostics.actionInvocation === "object");
}
