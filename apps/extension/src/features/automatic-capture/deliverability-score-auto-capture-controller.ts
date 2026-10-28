import type { CaptureService } from "../screenshot-capture/capture-service.js";
import type { AutoCaptureFailureState, AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";
import { isDeliverabilityScoreScreenshotType } from "../klaviyo-navigation/deliverability-score-capture.js";
import type { DeliverabilityScoreNavigation } from "../klaviyo-navigation/deliverability-score-navigation-service.js";

export class DeliverabilityScoreAutoCaptureController {
  constructor(private readonly navigation: DeliverabilityScoreNavigation, private readonly capture: CaptureService, private readonly store: AutoCaptureStateStore) {}
  async start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState> { const state: AutoCaptureState = { request, stage: "preparing" }; await this.store.set(state); void this.run(request); return state; }
  private async run(request: ExecutiveSummaryAutoCaptureRequest): Promise<void> {
    if (!isDeliverabilityScoreScreenshotType(request.screenshotType)) return void this.store.set({ request, stage: "failed", code: "CAPTURE_FAILED", message: "This controller only captures Deliverability Score." });
    const prepared = await this.navigation.prepare(request.period, request.accountUrl);
    if (prepared.kind === "failed") return void this.store.set({ request, stage: "failed", code: prepared.code as AutoCaptureFailureState["code"], message: prepared.message, ...(prepared.diagnostics ? { diagnostics: prepared.diagnostics } : {}) });
    if (!this.capture.captureVisibleTabFor) return void this.store.set({ request, stage: "failed", code: "CAPTURE_FAILED", message: "The verified Deliverability Score tab could not be captured safely." });
    try { await this.store.set({ request, stage: "capturing" }); const captured = await this.capture.captureVisibleTabFor({ tabId: prepared.sourceTabId, windowId: prepared.windowId }); await this.store.set({ request, stage: "review_ready", sourceTabId: prepared.sourceTabId, detectedPeriod: prepared.detectedPeriod, target: prepared.target, captured }); }
    catch (error) { await this.store.set({ request, stage: "failed", code: "CAPTURE_FAILED", message: error instanceof Error ? error.message : "Deliverability Score capture failed." }); }
  }
}
