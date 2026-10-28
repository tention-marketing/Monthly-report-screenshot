import { describe, expect, it, vi } from "vitest";
import { DashboardAutoCaptureController } from "./dashboard-auto-capture-controller.js";
import type { AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";
import type { DashboardCaptureNavigation } from "../klaviyo-navigation/dashboard-navigation-service.js";
import type { CaptureService } from "../screenshot-capture/capture-service.js";

const request: ExecutiveSummaryAutoCaptureRequest = { reportId: "report-1", screenshotType: "top_flows", accountUrl: "https://www.klaviyo.com/dashboard", period: { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" } };
class Store implements AutoCaptureStateStore { state: AutoCaptureState | null = null; async get() { return this.state; } async set(value: AutoCaptureState) { this.state = value; } async clear() { this.state = null; } }

describe("dashboard worker capture controller", () => {
  it("captures Top Flows from the same prepared authoritative tab without auto-approval", async () => {
    const store = new Store();
    const navigation: DashboardCaptureNavigation = { prepare: vi.fn().mockResolvedValue({ kind: "ready", sourceTabId: 7, windowId: 3, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 100, height: 80, viewportWidth: 1200, viewportHeight: 800 } }) };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/dashboard", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" }) };
    const controller = new DashboardAutoCaptureController(navigation, capture, store);
    await controller.start(request);
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "review_ready", request: { screenshotType: "top_flows" }, sourceTabId: 7 }));
    expect(navigation.prepare).toHaveBeenCalledWith("top_flows", request.period, request.accountUrl, undefined);
    expect(capture.captureVisibleTabFor).toHaveBeenCalledWith({ tabId: 7, windowId: 3 });
  });

  it("does not revive the old Business Review flow target", async () => {
    const store = new Store(); const navigation: DashboardCaptureNavigation = { prepare: vi.fn() }; const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn() };
    const controller = new DashboardAutoCaptureController(navigation, capture, store);
    await controller.start({ ...request, screenshotType: "campaign_metrics" });
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "failed", code: "CAPTURE_FAILED" }));
    expect(navigation.prepare).not.toHaveBeenCalled();
  });

  it("does not capture or upload when the semantic card bounds are heading-sized", async () => {
    const store = new Store();
    const navigation: DashboardCaptureNavigation = { prepare: vi.fn().mockResolvedValue({ kind: "failed", code: "TARGET_BOUNDS_INVALID", message: "The Business performance summary target bounds only cover a heading-sized region." }) };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn() };
    const controller = new DashboardAutoCaptureController(navigation, capture, store);
    await controller.start({ ...request, screenshotType: "overview" });
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "failed", code: "TARGET_BOUNDS_INVALID" }));
    expect(capture.captureVisibleTabFor).not.toHaveBeenCalled();
  });

  it("does not capture or upload when no usable Top Flows rows are proven", async () => {
    const store = new Store();
    const navigation: DashboardCaptureNavigation = { prepare: vi.fn().mockResolvedValue({ kind: "failed", code: "TOP_FLOW_ROWS_NOT_FOUND", message: "The Top performing flows table header or visible flow rows were not found." }) };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn() };
    const controller = new DashboardAutoCaptureController(navigation, capture, store);
    await controller.start(request);
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "failed", code: "TOP_FLOW_ROWS_NOT_FOUND" }));
    expect(capture.captureVisibleTabFor).not.toHaveBeenCalled();
  });
});
