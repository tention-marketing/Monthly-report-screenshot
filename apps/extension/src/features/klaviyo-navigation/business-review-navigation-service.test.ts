import { describe, expect, it, vi } from "vitest";
import { ChromeBusinessReviewCaptureNavigation } from "./business-review-navigation-service.js";
import type { KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";

const period = { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" };
const grantStore: KlaviyoActiveTabGrantStore = {
  get: vi.fn().mockResolvedValue({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK", grantedAt: 1 }),
  getActionInvocation: vi.fn().mockResolvedValue({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK", invokedAt: 1 }),
  set: vi.fn(), setActionInvocation: vi.fn(), clearGrant: vi.fn(), clear: vi.fn(),
};

describe("Business Review capture navigation", () => {
  it("navigates only the toolbar-authorized tab to configured Business Review, then injects the requested target", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, sourceUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK", targetRect: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } } }]);
    const chromeApi = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" }), update: vi.fn(), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
      scripting: { executeScript },
    };
    const navigation = new ChromeBusinessReviewCaptureNavigation(chromeApi, 100, grantStore);
    await expect(navigation.prepare("campaign_metrics", period, "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK")).resolves.toMatchObject({ kind: "ready", sourceTabId: 7, windowId: 3 });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] }, args: [expect.objectContaining({ sectionKey: "campaign_metrics", tabAliases: ["Metrics"] }), period] }));
  });

  it("reuses the authorized dashboard tab when moving from /dashboard to the configured Business Review URL", async () => {
    const targetUrl = "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK";
    const tab = { id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/dashboard" };
    const update = vi.fn().mockImplementation(async (_id: number, properties: { url: string }) => ({ ...tab, url: properties.url }));
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, sourceUrl: targetUrl, targetRect: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } } }]);
    const chromeApi = { tabs: { get: vi.fn().mockImplementation(async () => ({ ...tab, url: update.mock.calls.length ? targetUrl : tab.url })), update, query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } }, scripting: { executeScript } };
    const navigation = new ChromeBusinessReviewCaptureNavigation(chromeApi, 100, grantStore);
    await expect(navigation.prepare("top_campaigns", period, targetUrl)).resolves.toMatchObject({ kind: "ready", sourceTabId: 7 });
    expect(update).toHaveBeenCalledWith(7, { url: targetUrl });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] }, args: [expect.objectContaining({ sectionKey: "top_campaigns", tabAliases: ["Top performing messages"] }), period] }));
  });

  it("reloads the dashboard fresh for every section and injects only after the load it started completes", async () => {
    const targetUrl = "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK";
    const listeners: Array<(id: number, change: { status?: string }, tab: object) => void> = [];
    const order: string[] = [];
    const tab = { id: 7, windowId: 3, active: true, status: "complete", url: targetUrl };
    const update = vi.fn().mockImplementation(async () => {
      order.push("update");
      setTimeout(() => { order.push("loading"); listeners.forEach((listener) => listener(7, { status: "loading" }, { ...tab, status: "loading" })); }, 5);
      setTimeout(() => { order.push("complete"); listeners.forEach((listener) => listener(7, { status: "complete" }, tab)); }, 30);
      return tab;
    });
    const executeScript = vi.fn().mockImplementation(async () => { order.push("inject"); return [{ frameId: 0, result: { ok: true, sourceUrl: targetUrl, targetRect: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } } }]; });
    const chromeApi = { tabs: { get: vi.fn().mockResolvedValue(tab), update, query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), onUpdated: { addListener: (listener: typeof listeners[number]) => listeners.push(listener), removeListener: vi.fn() } }, scripting: { executeScript } };
    const navigation = new ChromeBusinessReviewCaptureNavigation(chromeApi, 1_000, grantStore);
    await expect(navigation.prepare("campaign_performance", period, targetUrl)).resolves.toMatchObject({ kind: "ready" });
    expect(update).toHaveBeenCalledWith(7, { url: targetUrl });
    expect(order).toEqual(["update", "loading", "complete", "inject"]);
  });

  it("returns a tab left on Klaviyo's global Analytics → Metrics page to the saved Business Review URL and retries there", async () => {
    const targetUrl = "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK";
    let url = "https://www.klaviyo.com/analytics/metrics";
    const update = vi.fn().mockImplementation(async (_id: number, properties: { url: string }) => { url = properties.url; return { id: 7, windowId: 3, active: true, status: "complete", url }; });
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, sourceUrl: targetUrl, targetRect: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } } }]);
    const chromeApi = { tabs: { get: vi.fn().mockImplementation(async () => ({ id: 7, windowId: 3, active: true, status: "complete", url })), update, query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } }, scripting: { executeScript } };
    const navigation = new ChromeBusinessReviewCaptureNavigation(chromeApi, 100, grantStore);
    await expect(navigation.prepare("campaign_metrics", period, targetUrl)).resolves.toMatchObject({ kind: "ready" });
    expect(update).toHaveBeenCalledWith(7, { url: targetUrl });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it("persists a safe shape diagnosis when Chrome returns an adapter result outside the accepted contract", async () => {
    const targetUrl = "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK";
    const chromeApi = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: targetUrl }), update: vi.fn(), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, targetRect: { x: "invalid", y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 } } }]) },
    };
    const navigation = new ChromeBusinessReviewCaptureNavigation(chromeApi, 100, grantStore);
    await expect(navigation.prepare("top_campaigns", period, targetUrl)).resolves.toMatchObject({ kind: "failed", code: "SCRIPT_RESULT_INVALID", diagnostics: { failureStage: "PAGE_READY", expectedSourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc", resultShape: { okValue: true, targetRectCoordinates: { x: { type: "string", finite: false } } } } });
  });

  it("allows the condition-driven SPA readiness script to outlive the shorter route-load timeout", async () => {
    const targetUrl = "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK";
    const executeScript = vi.fn().mockImplementation(() => new Promise((resolve) => window.setTimeout(() => resolve([{ frameId: 0, result: { ok: true, sourceUrl: targetUrl, targetRect: { x: 10, y: 20, width: 300, height: 200, viewportWidth: 1200, viewportHeight: 800 }, observedPeriod: { startDate: period.startDate, endDate: period.endDate } } }]), 40)));
    const chromeApi = { tabs: { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: targetUrl }), update: vi.fn(), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), onUpdated: { addListener: vi.fn(), removeListener: vi.fn() } }, scripting: { executeScript } };
    const navigation = new ChromeBusinessReviewCaptureNavigation(chromeApi, 20, grantStore);
    await expect(navigation.prepare("top_campaigns", period, targetUrl)).resolves.toMatchObject({ kind: "ready", sourceTabId: 7 });
  });
});
