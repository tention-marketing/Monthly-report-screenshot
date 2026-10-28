import { describe, expect, it, vi } from "vitest";
import { ChromeCampaignsSourceInspector } from "./campaigns-source-inspector.js";
import type { KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";

const grantStore: KlaviyoActiveTabGrantStore = {
  get: vi.fn().mockResolvedValue({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true", grantedAt: 1 }),
  getActionInvocation: vi.fn().mockResolvedValue({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/omnicampaigns", invokedAt: 1 }),
  set: vi.fn(), setActionInvocation: vi.fn(), clearGrant: vi.fn(), clear: vi.fn(),
};

describe("Campaigns source inspector", () => {
  it("reads only the explicit toolbar-authorized Campaigns listing tab", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: {
      ok: true, sourceUrl: "https://www.klaviyo.com/omnicampaigns", accountCandidates: ["Club Furniture"], pageRendered: true,
      pageHeading: "Campaigns", dateControls: ["Aug 1, 2026 - Aug 31, 2026"], conversionMetricControls: ["Shopify Placed Order"],
      sortControls: ["Placed Order"], tableHeaders: ["Campaign", "Placed Order"], visibleRows: [["Campaign A", "$9.00"]], pagination: ["Page 1 of 2"], rowCount: 1,
    } }]);
    const chromeApi = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, url: "https://www.klaviyo.com/omnicampaigns?appBarNav=true" }), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]) },
      scripting: { executeScript },
    };
    const inspector = new ChromeCampaignsSourceInspector(chromeApi, grantStore);
    await expect(inspector.inspect()).resolves.toMatchObject({ ok: true, sourceTabId: 7, pageRendered: true, tableHeaders: ["Campaign", "Placed Order"] });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] }, args: [] }));
  });

  it("fails closed before injection when the toolbar-authorized tab is not Campaigns", async () => {
    const executeScript = vi.fn();
    const chromeApi = {
      tabs: { get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, url: "https://www.klaviyo.com/dashboard" }), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]) },
      scripting: { executeScript },
    };
    const inspector = new ChromeCampaignsSourceInspector(chromeApi, grantStore);
    await expect(inspector.inspect()).resolves.toMatchObject({ ok: false, code: "CAMPAIGNS_ROUTE_REQUIRED" });
    expect(executeScript).not.toHaveBeenCalled();
  });
});
