import { describe, expect, it, vi } from "vitest";
import { ChromeCampaignsCaptureNavigation } from "./campaigns-navigation-service.js";
import type { KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";

const LIST_URL = "https://www.klaviyo.com/omnicampaigns?appBarNav=true";
const PERIOD_URL = "https://www.klaviyo.com/omnicampaigns?appBarNav=true&startDate=2026-08-01&endDate=2026-08-31";
const request = { clientName: "Acme Home", clientTimezone: "America/New_York", conversionMetric: "Placed Order", desiredCount: 3, period: { startDate: "2026-08-01", endDate: "2026-08-31" } };
const okResult = { ok: true, sourceUrl: "https://www.klaviyo.com/omnicampaigns", observedPeriod: request.period, evidence: { accountIdentity: "Acme Home", clientTimezone: "America/New_York", visibleMetricLabel: "Placed Order", rankingMethod: "klaviyo-native-sort", eligibleRowCount: 1, includedRowCount: 1, rows: [] }, targetRect: { x: 0, y: 0, width: 10, height: 10, viewportWidth: 10, viewportHeight: 10, availableRowCount: 1, includedRowCount: 1 } };

function fixture(startUrl: string, invoked = true) {
  let url = startUrl;
  const tabs = {
    get: vi.fn(async () => ({ id: 7, windowId: 3, active: true, status: "complete", url })),
    query: vi.fn(async () => [{ id: 7, windowId: 3, active: true }]),
    update: vi.fn(async (_id: number, properties: { url: string }) => { url = properties.url; return { id: 7, windowId: 3, active: true, status: "complete", url }; }),
  };
  const scripting = { executeScript: vi.fn(async () => [{ frameId: 0, result: okResult }]) };
  const grantStore: KlaviyoActiveTabGrantStore = {
    get: vi.fn().mockResolvedValue({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: startUrl, grantedAt: 1 }),
    getActionInvocation: vi.fn().mockResolvedValue(invoked ? { tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/dashboard", invokedAt: 1 } : null),
    set: vi.fn(), setActionInvocation: vi.fn(), clearGrant: vi.fn(), clear: vi.fn(),
  };
  return { navigation: new ChromeCampaignsCaptureNavigation({ tabs, scripting } as never, 100, grantStore), tabs, scripting };
}

describe("Campaigns capture navigation", () => {
  it.each(["https://www.klaviyo.com/dashboard", "https://www.klaviyo.com/analytics/dashboards/acme-review", "https://www.klaviyo.com/analytics/deliverability/email/score"])("moves the authorized tab from %s to the Campaigns list before inspecting", async (startUrl) => {
    const { navigation, tabs, scripting } = fixture(startUrl);
    await expect(navigation.prepare(request, LIST_URL)).resolves.toMatchObject({ kind: "ready" });
    expect(tabs.update).toHaveBeenCalledWith(7, { url: PERIOD_URL });
    expect(scripting.executeScript).toHaveBeenCalledTimes(1);
  });
  it("reloads the Campaigns list fresh even when the authorized tab already shows it for the report period", async () => {
    const { navigation, tabs } = fixture(PERIOD_URL);
    await expect(navigation.prepare(request, LIST_URL)).resolves.toMatchObject({ kind: "ready" });
    expect(tabs.update).toHaveBeenCalledWith(7, { url: PERIOD_URL });
  });
  it("re-opens the Campaigns list with the report period when another range is active", async () => {
    const { navigation, tabs } = fixture("https://www.klaviyo.com/omnicampaigns?appBarNav=true&startDate=2026-09-27&endDate=2026-10-27");
    await expect(navigation.prepare(request, LIST_URL)).resolves.toMatchObject({ kind: "ready" });
    expect(tabs.update).toHaveBeenCalledWith(7, { url: PERIOD_URL });
  });
  it("never navigates without a toolbar grant", async () => {
    const { navigation, tabs, scripting } = fixture("https://www.klaviyo.com/dashboard", false);
    await expect(navigation.prepare(request, LIST_URL)).resolves.toMatchObject({ kind: "failed", code: "ACTION_NOT_INVOKED" });
    expect(tabs.update).not.toHaveBeenCalled();
    expect(scripting.executeScript).not.toHaveBeenCalled();
  });
  it("refuses a list URL that is not the Campaigns listing", async () => {
    const { navigation, tabs } = fixture("https://www.klaviyo.com/dashboard");
    await expect(navigation.prepare(request, "https://www.klaviyo.com/campaign/abc123/edit")).resolves.toMatchObject({ kind: "failed", code: "CAMPAIGNS_ROUTE_REQUIRED" });
    expect(tabs.update).not.toHaveBeenCalled();
  });
});
