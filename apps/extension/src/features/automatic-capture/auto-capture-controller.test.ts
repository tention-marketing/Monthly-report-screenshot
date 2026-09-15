import { describe, expect, it, vi } from "vitest";
import { ExecutiveSummaryAutoCaptureController, type AutoCaptureStateStore } from "./auto-capture-controller.js";
import type { AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { CaptureService } from "../screenshot-capture/capture-service.js";
import { ChromeCaptureError } from "../screenshot-capture/capture-service.js";
import type { KlaviyoNavigationService } from "../klaviyo-navigation/navigation-service.js";

const request: ExecutiveSummaryAutoCaptureRequest = {
  reportId: "report-1", screenshotType: "overview", accountUrl: null,
  period: { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" },
};
const prepared = {
  kind: "ready" as const, sourceTabId: 7, windowId: 3, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026",
  target: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 },
};

class MemoryStore implements AutoCaptureStateStore {
  state: AutoCaptureState | null = null;
  async get() { return this.state; }
  async set(state: AutoCaptureState) { this.state = state; }
  async clear() { this.state = null; }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("Executive Summary service-worker auto capture", () => {
  it("continues after the UI disappears and a new UI instance restores the persisted review", async () => {
    const store = new MemoryStore();
    const captured = deferred<{ sourceUrl: string; isKlaviyo: true; dataUrl: string }>();
    const navigation: KlaviyoNavigationService = { openSection: vi.fn(), preparePeriod: vi.fn(() => ({ kind: "manual_period_required" as const })), prepareExecutiveSummary: vi.fn().mockResolvedValue(prepared) };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn(), captureVisibleTabFor: vi.fn(() => captured.promise) };
    const worker = new ExecutiveSummaryAutoCaptureController(navigation, capture, store);

    await expect(worker.start(request)).resolves.toMatchObject({ stage: "preparing" });
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "capturing" }));
    // No React component is retained here: the controller finishes independently.
    captured.resolve({ sourceUrl: "https://www.klaviyo.com/analytics/dashboards", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" });
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "review_ready", sourceTabId: 7 }));

    const reopenedUiWorker = new ExecutiveSummaryAutoCaptureController(navigation, capture, store);
    await expect(reopenedUiWorker.get({ reportId: request.reportId, screenshotType: request.screenshotType })).resolves.toMatchObject({
      stage: "review_ready", captured: { sourceUrl: "https://www.klaviyo.com/analytics/dashboards" },
    });
    expect(capture.captureVisibleTabFor).toHaveBeenCalledWith({ tabId: 7, windowId: 3 });
  });

  it("persists a typed navigation failure for a reopened UI", async () => {
    const store = new MemoryStore();
    const navigation: KlaviyoNavigationService = {
      openSection: vi.fn(), preparePeriod: vi.fn(() => ({ kind: "manual_period_required" as const })),
      prepareExecutiveSummary: vi.fn().mockResolvedValue({ kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: "Cannot access contents of URL" }),
    };
    const capture: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() };
    const worker = new ExecutiveSummaryAutoCaptureController(navigation, capture, store);

    await worker.start(request);
    await vi.waitFor(() => expect(store.state).toMatchObject({ stage: "failed", code: "SCRIPT_INJECTION_FAILED" }));
    const reopenedUiWorker = new ExecutiveSummaryAutoCaptureController(navigation, capture, store);
    await expect(reopenedUiWorker.get({ reportId: request.reportId, screenshotType: request.screenshotType })).resolves.toMatchObject({
      stage: "failed", message: "Cannot access contents of URL",
    });
  });

  it("ends loading with an actionable activeTab failure and does not create a review state", async () => {
    const store = new MemoryStore();
    const navigation: KlaviyoNavigationService = { openSection: vi.fn(), preparePeriod: vi.fn(() => ({ kind: "manual_period_required" as const })), prepareExecutiveSummary: vi.fn().mockResolvedValue(prepared) };
    const capture: CaptureService = {
      getActiveTab: vi.fn(), captureVisibleTab: vi.fn(),
      captureVisibleTabFor: vi.fn().mockRejectedValue(new ChromeCaptureError("KLAVIYO_CAPTURE_PERMISSION_REQUIRED", "raw Chrome message must not be shown")),
    };
    const worker = new ExecutiveSummaryAutoCaptureController(navigation, capture, store);

    await worker.start(request);
    await vi.waitFor(() => expect(store.state).toMatchObject({
      stage: "failed", code: "KLAVIYO_CAPTURE_PERMISSION_REQUIRED",
      message: "Open the Klaviyo Business Review tab and click the Tention Reports toolbar icon to start capture.",
    }));
  });
});
