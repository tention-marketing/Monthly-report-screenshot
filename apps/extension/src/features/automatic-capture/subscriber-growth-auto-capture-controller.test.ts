import { describe, expect, it, vi } from "vitest";
import { SubscriberGrowthAutoCaptureController } from "./subscriber-growth-auto-capture-controller.js";
import type { AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";

class Store implements AutoCaptureStateStore {
  state: AutoCaptureState | null = null;
  async get() { return this.state; }
  async set(value: AutoCaptureState) { this.state = value; }
  async clear() { this.state = null; }
}
const request: ExecutiveSummaryAutoCaptureRequest = {
  reportId: "report-1", screenshotType: "email_subscriber_growth", accountUrl: "https://www.klaviyo.com/saved-subscriber-growth",
  period: { startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" },
  clientName: "Club Furniture", recovery: { level: 1, actions: ["fresh-source", "extended-readiness"], previousFailure: "SUBSCRIBER_GROWTH_CHART_NOT_RENDERED" },
};
const evidence = { channel: "email" as const, view: "growth" as const, emailSubscribers: 1, newSubscribers: 2, exclusions: 3, changes: { emailSubscribers: null, newSubscribers: null, exclusions: null }, charts: { subscriberGrowthLine: true as const, newSubscribersExclusionsBar: true as const }, visiblePeriodText: "Sep 1 – Sep 30, 2026" };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Subscriber Growth automatic capture controller", () => {
  it("passes the saved source, client, period and recovery level, then stores the capture with its evidence", async () => {
    const store = new Store();
    const prepare = vi.fn().mockResolvedValue({ kind: "ready", sourceTabId: 7, windowId: 3, detectedPeriod: "Sep 1 – Sep 30, 2026", periodEvidence: { startDate: "2026-09-01", endDate: "2026-09-30" }, target: { x: 1, y: 1, width: 10, height: 10, viewportWidth: 20, viewportHeight: 20, visibleControls: [] }, evidence, diagnostics: {} });
    const captured = { sourceUrl: "https://www.klaviyo.com/saved-subscriber-growth", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" };
    await new SubscriberGrowthAutoCaptureController({ prepare }, { captureVisibleTabFor: vi.fn().mockResolvedValue(captured) } as never, store).start(request);
    await flush(); await flush();
    expect(prepare).toHaveBeenCalledWith({ period: request.period, sourceUrl: request.accountUrl, clientName: "Club Furniture", extendedReadiness: true });
    expect(store.state).toMatchObject({ stage: "review_ready", periodEvidence: { startDate: "2026-09-01", endDate: "2026-09-30" }, subscriberGrowthEvidence: evidence, captured });
  });
  it("never captures when preparation fails", async () => {
    const store = new Store(); const captureVisibleTabFor = vi.fn();
    await new SubscriberGrowthAutoCaptureController({ prepare: vi.fn().mockResolvedValue({ kind: "failed", code: "SUBSCRIBER_GROWTH_CHART_NOT_RENDERED", message: "blank chart" }) }, { captureVisibleTabFor } as never, store).start(request);
    await flush(); await flush();
    expect(store.state).toMatchObject({ stage: "failed", code: "SUBSCRIBER_GROWTH_CHART_NOT_RENDERED" });
    expect(captureVisibleTabFor).not.toHaveBeenCalled();
  });
});
