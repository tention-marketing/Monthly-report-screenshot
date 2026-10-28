import type { CaptureService } from "../screenshot-capture/capture-service.js";
import type { AutoCaptureFailureState, AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";
import type { CampaignsCaptureNavigation, CampaignsPreparation } from "../klaviyo-navigation/campaigns-navigation-service.js";
import { TOP_CAMPAIGN_ROW_COUNT } from "../klaviyo-navigation/campaigns-capture.js";

export class CampaignsAutoCaptureController {
  private readonly running = new Set<string>();
  constructor(private readonly navigation: CampaignsCaptureNavigation, private readonly capture: CaptureService, private readonly store: AutoCaptureStateStore) {}
  async start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState> { const state: AutoCaptureState = { request, stage: "preparing" }; await this.store.set(state); void this.run(request); return state; }
  /**
   * A side-panel or service-worker reconnection must not strand a persisted
   * preparation state. The state store is the durable hand-off between the UI
   * and worker, so reading a pending state resumes the same authorized-tab
   * request rather than requiring the operator to recreate the report.
   */
  async get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null> {
    const state = await this.store.get(request);
    if (state && (state.stage === "preparing" || state.stage === "capturing")) void this.run(state.request);
    return state;
  }
  private async run(request: ExecutiveSummaryAutoCaptureRequest): Promise<void> {
    const key = `${request.reportId}:${request.screenshotType}`; if (this.running.has(key)) return; this.running.add(key);
    let prepared: CampaignsPreparation | null = null;
    try {
      if (request.screenshotType !== "top_campaigns" || !request.clientName || !request.clientTimezone) return await this.fail(request, "CAPTURE_FAILED", "Top Campaigns requires a report client identity and timezone.");
      prepared = await this.navigation.prepare({ clientName: request.clientName, clientTimezone: request.clientTimezone, conversionMetric: request.conversionMetric ?? "Placed Order", desiredCount: request.desiredCampaignCount ?? TOP_CAMPAIGN_ROW_COUNT, period: request.period }, request.accountUrl);
      if (prepared.kind === "failed") return await this.fail(request, prepared.code, prepared.message, prepared.diagnostics);
      if (!this.capture.captureVisibleTabFor) return await this.fail(request, "CAPTURE_FAILED", "The verified Campaigns tab could not be captured safely.");
      await this.store.set({ request, stage: "capturing" });
      const captured = await this.capture.captureVisibleTabFor({ tabId: prepared.sourceTabId, windowId: prepared.windowId });
      await this.store.set({ request, stage: "review_ready", sourceTabId: prepared.sourceTabId, detectedPeriod: prepared.detectedPeriod, periodEvidence: prepared.observedPeriod, target: prepared.target, campaignsEvidence: prepared.evidence, captured });
    } catch (error) { await this.fail(request, "CAPTURE_FAILED", error instanceof Error ? error.message : "Campaigns capture could not complete.", prepared?.kind === "ready" ? { targetBounds: prepared.target, campaigns: prepared.evidence } : undefined); }
    finally { this.running.delete(key); }
  }
  private async fail(request: ExecutiveSummaryAutoCaptureRequest, code: AutoCaptureFailureState["code"], message: string, diagnostics?: Record<string, unknown>) { await this.store.set({ request, stage: "failed", code, message, ...(diagnostics ? { diagnostics } : {}) }); }
}
