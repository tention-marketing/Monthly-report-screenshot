import { describe, expect, it, vi } from "vitest";
import { BusinessReviewAutoCaptureController } from "./business-review-auto-capture-controller.js";
import type { AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";
import type { BusinessReviewCaptureNavigation } from "../klaviyo-navigation/business-review-navigation-service.js";
import type { CaptureService } from "../screenshot-capture/capture-service.js";

const request: ExecutiveSummaryAutoCaptureRequest = {
  reportId: "report-1", screenshotType: "campaign_metrics", accountUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK",
  period: { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" },
};
class Store implements AutoCaptureStateStore {
  state: AutoCaptureState | null = null;
  async get() { return this.state; } async set(value: AutoCaptureState) { this.state = value; } async clear() { this.state = null; }
}

describe("Business Review worker capture controller", () => {
  it("captures only the prepared authoritative tab and leaves a persisted review state", async () => {
    const store = new Store();
    const navigation: BusinessReviewCaptureNavigation = { prepare: vi.fn().mockResolvedValue({ kind: "ready", sourceTabId: 7, windowId: 3, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 100, height: 80, viewportWidth: 1200, viewportHeight: 800 } }) };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/analytics/dashboards/target", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" }) };
    const controller = new BusinessReviewAutoCaptureController(navigation, capture, store);
    await controller.start(request);
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "review_ready", request: { screenshotType: "campaign_metrics" } }));
    expect(capture.captureVisibleTabFor).toHaveBeenCalledWith({ tabId: 7, windowId: 3 });
    expect(navigation.prepare).toHaveBeenCalledWith("campaign_metrics", request.period, request.accountUrl, undefined);
  });

  it("persists a typed failure and never substitutes a screenshot", async () => {
    const store = new Store();
    const navigation: BusinessReviewCaptureNavigation = { prepare: vi.fn().mockResolvedValue({ kind: "failed", code: "BUSINESS_REVIEW_TAB_NOT_SELECTED", message: "Metrics was not selected." }) };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn() };
    const controller = new BusinessReviewAutoCaptureController(navigation, capture, store);
    await controller.start(request);
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "failed", code: "BUSINESS_REVIEW_TAB_NOT_SELECTED" }));
    expect(capture.captureVisibleTabFor).not.toHaveBeenCalled();
  });
  it("preserves verified view and period diagnostics when Chrome capture is quota-limited", async () => {
    const store = new Store();
    const controls = [{ text: "Metrics", tag: "button", role: "tab", ariaSelected: "true", visible: true }];
    const navigation: BusinessReviewCaptureNavigation = { prepare: vi.fn().mockResolvedValue({ kind: "ready", sourceTabId: 7, windowId: 3, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", observedPeriod: { startDate: request.period.startDate, endDate: request.period.endDate }, target: { x: 10, y: 20, width: 100, height: 80, viewportWidth: 1200, viewportHeight: 800, visibleControls: controls, stageTimingsMs: { pageReadyMs: 4, viewSwitchMs: 20 } } }) };
    const quotaError = Object.assign(new Error("This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota."), { code: "VISIBLE_TAB_CAPTURE_FAILED" });
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn().mockRejectedValue(quotaError) };
    const controller = new BusinessReviewAutoCaptureController(navigation, capture, store);
    await controller.start(request);
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "failed", code: "VISIBLE_TAB_CAPTURE_FAILED", diagnostics: { failureStage: "CAPTURE", expectedPeriod: { startDate: request.period.startDate, endDate: request.period.endDate }, observedPeriod: { startDate: request.period.startDate, endDate: request.period.endDate }, visibleControls: controls, stageTimingsMs: { pageReadyMs: 4, viewSwitchMs: 20 } } }));
    expect(capture.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("does not revive the old Business Review Overview path after reclassification", async () => {
    const store = new Store();
    const navigation: BusinessReviewCaptureNavigation = { prepare: vi.fn() };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn() };
    const controller = new BusinessReviewAutoCaptureController(navigation, capture, store);
    await controller.start({ ...request, screenshotType: "overview" });
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "failed", code: "CAPTURE_FAILED" }));
    expect(navigation.prepare).not.toHaveBeenCalled();
    expect(capture.captureVisibleTabFor).not.toHaveBeenCalled();
  });
});
