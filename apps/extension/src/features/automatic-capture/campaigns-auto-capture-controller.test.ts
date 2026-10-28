import { describe, expect, it } from "vitest";
import { CampaignsAutoCaptureController } from "./campaigns-auto-capture-controller.js";
import type { AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { AutoCaptureStateStore } from "./auto-capture-controller.js";

class Store implements AutoCaptureStateStore {
  state: AutoCaptureState | null = null;
  async get() { return this.state; }
  async set(value: AutoCaptureState) { this.state = value; }
  async clear() { this.state = null; }
}

const request: ExecutiveSummaryAutoCaptureRequest = {
  reportId: "report-1", screenshotType: "top_campaigns", accountUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true",
  period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
  clientName: "A client", clientTimezone: "America/New_York",
};

describe("Campaigns automatic capture reconnection", () => {
  it("rehydrates a persisted pending Top Campaigns request after the side panel or service worker reconnects", async () => {
    const store = new Store();
    store.state = { request, stage: "preparing" };
    let resolvePrepare: (() => void) | undefined;
    const controller = new CampaignsAutoCaptureController({ prepare: () => new Promise((resolve) => { resolvePrepare = () => resolve({ kind: "failed", code: "REPORT_PERIOD_NOT_CONFIRMED", message: "period not visible" }); }) }, { captureVisibleTabFor: async () => { throw new Error("should not capture"); } } as never, store);
    await expect(controller.get({ reportId: request.reportId, screenshotType: "top_campaigns" })).resolves.toEqual({ request, stage: "preparing" });
    resolvePrepare?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.state).toMatchObject({ stage: "failed", code: "REPORT_PERIOD_NOT_CONFIRMED", request });
  });

  it("does not alter a completed or failed capture while rehydrating", async () => {
    const store = new Store();
    store.state = { request, stage: "failed", code: "REPORT_PERIOD_NOT_CONFIRMED", message: "period not visible" };
    const prepare = () => { throw new Error("must not run"); };
    const controller = new CampaignsAutoCaptureController({ prepare }, {} as never, store);
    await expect(controller.get({ reportId: request.reportId, screenshotType: "top_campaigns" })).resolves.toBe(store.state);
  });
});
