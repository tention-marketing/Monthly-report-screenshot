import type { CaptureService } from "../screenshot-capture/capture-service.js";
import type { BusinessReviewCaptureNavigation, BusinessReviewPreparation } from "../klaviyo-navigation/business-review-navigation-service.js";
import type { AutoCaptureFailureState, AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";
import { BUSINESS_REVIEW_TARGETS, isBusinessReviewScreenshotType } from "../klaviyo-navigation/business-review-capture.js";

/** Runs one semantic Business Review capture at a time in the MV3 worker. */
export class BusinessReviewAutoCaptureController {
  private readonly running = new Set<string>();
  constructor(private readonly navigation: BusinessReviewCaptureNavigation, private readonly capture: CaptureService, private readonly store: AutoCaptureStateStore) {}

  async start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState> {
    const state: AutoCaptureState = { request, stage: "preparing" };
    await this.store.set(state); void this.run(request); return state;
  }
  async get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null> {
    const state = await this.store.get(request);
    if (state && (state.stage === "preparing" || state.stage === "capturing")) void this.run(state.request);
    return state;
  }
  async clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void> { await this.store.clear(request); }

  private async run(request: ExecutiveSummaryAutoCaptureRequest): Promise<void> {
    const key = `${request.reportId}:${request.screenshotType}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    let prepared: BusinessReviewPreparation | null = null;
    try {
      if (!isBusinessReviewScreenshotType(request.screenshotType)) {
        await this.fail(request, "CAPTURE_FAILED", "This section is manual-required until its source is proven."); return;
      }
      prepared = await this.navigation.prepare(request.screenshotType, request.period, request.accountUrl);
      if (prepared.kind === "failed") { await this.fail(request, prepared.code, prepared.message, prepared.diagnostics); return; }
      if (!this.capture.captureVisibleTabFor) { await this.fail(request, "CAPTURE_FAILED", "The verified Klaviyo tab could not be captured safely."); return; }
      await this.store.set({ request, stage: "capturing" });
      const captured = await this.capture.captureVisibleTabFor({ tabId: prepared.sourceTabId, windowId: prepared.windowId });
      await this.store.set({ request, stage: "review_ready", sourceTabId: prepared.sourceTabId, detectedPeriod: prepared.detectedPeriod, periodEvidence: prepared.observedPeriod, target: prepared.target, captured });
    } catch (error) {
      const raw = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      const code = typeof raw === "string" ? raw as AutoCaptureFailureState["code"] : "CAPTURE_FAILED";
      const diagnostics = prepared?.kind === "ready" ? {
        failureStage: "CAPTURE", expectedUrl: request.accountUrl, observedUrl: null, lastVerifiedUrl: request.accountUrl,
        expectedSourceIdentity: BUSINESS_REVIEW_TARGETS[request.screenshotType as keyof typeof BUSINESS_REVIEW_TARGETS]?.sourceIdentity ?? null,
        expectedPeriod: { startDate: request.period.startDate, endDate: request.period.endDate }, observedPeriod: prepared.observedPeriod,
        visibleControls: prepared.target.visibleControls ?? [], targetBounds: prepared.target, stageTimingsMs: prepared.target.stageTimingsMs ?? {},
      } : undefined;
      await this.fail(request, code, error instanceof Error && error.message ? error.message : "Automatic capture could not complete.", diagnostics);
    } finally { this.running.delete(key); }
  }
  private async fail(request: ExecutiveSummaryAutoCaptureRequest, code: AutoCaptureFailureState["code"], message: string, diagnostics?: Record<string, unknown>): Promise<void> {
    let viewportScreenshot: Awaited<ReturnType<CaptureService["captureVisibleTab"]>> | null = null;
    if (code !== "VISIBLE_TAB_CAPTURE_FAILED") {
      try { viewportScreenshot = await this.capture.captureVisibleTab(); } catch { /* diagnostic screenshot is best effort; no capture state is altered */ }
    }
    await this.store.set({ request, stage: "failed", code, message, ...(diagnostics ? { diagnostics } : {}), viewportScreenshot });
  }
}
