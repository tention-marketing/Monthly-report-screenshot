import { describe, expect, it, vi } from "vitest";
import { ChromeKlaviyoDashboardCaptureNavigation } from "./dashboard-navigation-service.js";
import type { KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";

const period = { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" };
const grantStore: KlaviyoActiveTabGrantStore = {
  get: vi.fn().mockResolvedValue({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/dashboard", grantedAt: 1 }),
  getActionInvocation: vi.fn().mockResolvedValue({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/dashboard", invokedAt: 1 }),
  set: vi.fn(), setActionInvocation: vi.fn(), clearGrant: vi.fn(), clear: vi.fn(),
};

describe("Klaviyo home dashboard capture navigation", () => {
  it("injects the requested card only into the one toolbar-authorized /dashboard tab", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, sourceUrl: "https://www.klaviyo.com/dashboard", targetRect: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } } }]);
    const chromeApi = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/dashboard" }), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), update: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/dashboard" }), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
      scripting: { executeScript },
    };
    const navigation = new ChromeKlaviyoDashboardCaptureNavigation(chromeApi, 100, grantStore);
    await expect(navigation.prepare("top_flows", period)).resolves.toMatchObject({ kind: "ready", sourceTabId: 7, windowId: 3 });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] }, args: [expect.objectContaining({ sectionKey: "top_flows", semanticCard: "top-performing-flows" }), period] }));
  });

  it("navigates the authorized same tab from Business Review to the configured Overview URL", async () => {
    const dashboardUrl = "https://www.klaviyo.com/dashboard";
    const tabs = {
      get: vi.fn()
        .mockResolvedValueOnce({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" })
        .mockResolvedValueOnce({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" })
        .mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: dashboardUrl }),
      query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]),
      update: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: dashboardUrl }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    const scripting = { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, sourceUrl: dashboardUrl, targetRect: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } } }]) };
    const navigation = new ChromeKlaviyoDashboardCaptureNavigation({ tabs, scripting }, 100, grantStore);
    await expect(navigation.prepare("overview", period, dashboardUrl)).resolves.toMatchObject({ kind: "ready", sourceTabId: 7, windowId: 3 });
    expect(tabs.update).toHaveBeenCalledTimes(1);
    expect(tabs.update).toHaveBeenCalledWith(7, { url: dashboardUrl });
    expect(scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] } }));
  });

  it("fails closed when the authorized tab is on another Klaviyo reporting route and no Overview target is configured", async () => {
    const tabs = { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" }), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), update: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } };
    const scripting = { executeScript: vi.fn() };
    const navigation = new ChromeKlaviyoDashboardCaptureNavigation({ tabs, scripting }, 100, grantStore);
    await expect(navigation.prepare("overview", period)).resolves.toMatchObject({ kind: "failed", code: "DASHBOARD_URL_REQUIRED" });
    expect(tabs.update).not.toHaveBeenCalled();
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });

  it("records safe details when Chrome returns a null dashboard helper result", async () => {
    const dashboardUrl = "https://www.klaviyo.com/dashboard";
    const chromeApi = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: dashboardUrl }), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), update: vi.fn(), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: null }]) },
    };
    const navigation = new ChromeKlaviyoDashboardCaptureNavigation(chromeApi, 100, grantStore);
    await expect(navigation.prepare("overview", period, dashboardUrl)).resolves.toMatchObject({ kind: "failed", code: "SCRIPT_RESULT_INVALID", diagnostics: { expectedUrl: dashboardUrl, observedUrl: dashboardUrl, expectedSourceIdentity: "klaviyo-home|business-performance-summary|default", resultShape: { kind: "null" } } });
  });
});
