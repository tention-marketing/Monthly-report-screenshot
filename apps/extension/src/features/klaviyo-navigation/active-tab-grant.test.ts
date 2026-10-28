import { describe, expect, it, vi } from "vitest";
import { verifyKlaviyoActiveTabGrant, type KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";

function setup(url: string) {
  const store: KlaviyoActiveTabGrantStore = {
    get: vi.fn().mockResolvedValue({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1", grantedAt: 1 }),
    getActionInvocation: vi.fn().mockResolvedValue({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1", invokedAt: 1 }),
    set: vi.fn(), setActionInvocation: vi.fn(), clearGrant: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
  };
  const tabs = { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url }), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]) };
  return { store, tabs };
}

describe("toolbar grant after a stray Klaviyo route change", () => {
  it("still invalidates the grant on an unsupported route for a caller that would capture it", async () => {
    const { store, tabs } = setup("https://www.klaviyo.com/analytics/metrics");
    await expect(verifyKlaviyoActiveTabGrant(tabs as never, store)).resolves.toMatchObject({ ok: false, code: "GRANTED_TAB_ROUTE_NOT_SUPPORTED" });
  });

  it("keeps the grant for a caller returning the tab to its configured URL, on the same Klaviyo origin only", async () => {
    const { store, tabs } = setup("https://www.klaviyo.com/analytics/metrics");
    await expect(verifyKlaviyoActiveTabGrant(tabs as never, store, { returningToConfiguredUrl: true })).resolves.toMatchObject({ ok: true });
    expect(store.clearGrant).not.toHaveBeenCalled(); expect(store.clear).not.toHaveBeenCalled();
    const other = setup("https://evil.example.com/analytics/metrics");
    await expect(verifyKlaviyoActiveTabGrant(other.tabs as never, other.store, { returningToConfiguredUrl: true })).resolves.toMatchObject({ ok: false, code: "GRANTED_TAB_CHANGED_ORIGIN" });
  });
});
