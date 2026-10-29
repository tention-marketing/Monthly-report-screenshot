import type { CaptureService } from "../screenshot-capture/capture-service.js";
import type { AutoCaptureFailureState, AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";
import { isSubscriberGrowthScreenshotType } from "../klaviyo-navigation/subscriber-growth-capture.js";
import type { SubscriberGrowthNavigation } from "../klaviyo-navigation/subscriber-growth-navigation-service.js";

/** Section 10: prepares Subscriber growth → Email → Growth, then captures the toolbar-authorized tab. */
export class SubscriberGrowthAutoCaptureController {
  constructor(private readonly navigation: SubscriberGrowthNavigation, private readonly capture: CaptureService, private readonly store: AutoCaptureStateStore) {}
  async start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState> { const state: AutoCaptureState = { request, stage: "preparing" }; await this.store.set(state); void this.run(request); return state; }
  private async run(request: ExecutiveSummaryAutoCaptureRequest): Promise<void> {
    if (!isSubscriberGrowthScreenshotType(request.screenshotType)) return void this.store.set({ request, stage: "failed", code: "CAPTURE_FAILED", message: "This controller only captures Subscriber Growth." });
    const prepared = await this.navigation.prepare({ period: request.period, sourceUrl: request.accountUrl, clientName: request.clientName ?? null, extendedReadiness: request.recovery?.actions.includes("extended-readiness") ?? false });
    if (prepared.kind === "failed") return void this.store.set({ request, stage: "failed", code: prepared.code as AutoCaptureFailureState["code"], message: prepared.message, ...(prepared.diagnostics ? { diagnostics: prepared.diagnostics } : {}) });
    if (!this.capture.captureVisibleTabFor) return void this.store.set({ request, stage: "failed", code: "CAPTURE_FAILED", message: "The verified Subscriber growth tab could not be captured safely." });
    try {
      await this.store.set({ request, stage: "capturing" });
      const captured = await this.capture.captureVisibleTabFor({ tabId: prepared.sourceTabId, windowId: prepared.windowId });
      await this.store.set({ request, stage: "review_ready", sourceTabId: prepared.sourceTabId, detectedPeriod: prepared.detectedPeriod, periodEvidence: prepared.periodEvidence, target: prepared.target, subscriberGrowthEvidence: prepared.evidence, captured });
    } catch (error) { await this.store.set({ request, stage: "failed", code: "CAPTURE_FAILED", message: error instanceof Error ? error.message : "Subscriber Growth capture failed." }); }
  }
}
