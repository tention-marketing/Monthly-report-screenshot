import { describe, expect, it } from "vitest";
import { campaignChannel, campaignPeriodMatchesUrl, formatCampaignDateInput, parseCampaignRevenue, rankEligibleCampaigns, TOP_CAMPAIGN_ROW_COUNT, type CampaignRow, visibleCampaignPeriodText } from "./campaigns-capture.js";

const row = (overrides: Partial<CampaignRow> = {}): CampaignRow => ({ name: "Campaign", type: "Email", status: "Sent", sendDate: "Aug 10, 2026", openRate: "42%", clickRate: "2%", placedOrderValue: 1, domOrder: 0, ...overrides });

describe("Campaigns-list Top Campaigns ranking", () => {
  it("formats the exact report calendar month for native and compact Campaigns date inputs", () => {
    expect(formatCampaignDateInput("2026-08-01", { type: "date", value: "", placeholder: "" })).toBe("2026-08-01");
    expect(formatCampaignDateInput("2026-08-31", { type: "text", value: "09/27/2026", placeholder: "MM/DD/YYYY" })).toBe("08/31/2026");
  });
  it("requires both the effective Campaigns URL and visible exact dates, rejecting rolling ranges", () => {
    const period = { startDate: "2026-08-01", endDate: "2026-08-31" };
    expect(campaignPeriodMatchesUrl("https://www.klaviyo.com/omnicampaigns?startDate=2026-08-01&endDate=2026-08-31", period)).toBe(true);
    expect(campaignPeriodMatchesUrl("https://www.klaviyo.com/omnicampaigns?startDate=2026-09-27&endDate=2026-10-27", period)).toBe(false);
    expect(visibleCampaignPeriodText(["Date range Aug 1, 2026 – Aug 31, 2026"], period)).toBe(true);
    expect(visibleCampaignPeriodText(["Date range Last 30 days"], period)).toBe(false);
  });
  it.each([["$16,600.00", 16600], ["$0.00", 0], ["€1,234.50", 1234.5], ["—", null], ["", null]])("parses %s safely", (value, expected) => expect(parseCampaignRevenue(value)).toBe(expected));
  it("includes Sent Email and SMS rows, but excludes Draft, Scheduled, and Cancelled rows", () => {
    const ranked = rankEligibleCampaigns([row({ name: "Email", placedOrderValue: 40 }), row({ name: "SMS", type: "SMS", placedOrderValue: 30 }), row({ name: "Draft", status: "Draft", placedOrderValue: 999 }), row({ name: "Scheduled", status: "Scheduled", placedOrderValue: 999 }), row({ name: "Cancelled", status: "Cancelled", placedOrderValue: 999 })]);
    expect(ranked.map(({ name }) => name)).toEqual(["Email", "SMS"]);
  });
  it("excludes missing metric rows and retains confirmed zero revenue", () => expect(rankEligibleCampaigns([row({ name: "Missing", placedOrderValue: null }), row({ name: "Zero", placedOrderValue: 0 })]).map(({ name }) => name)).toEqual(["Zero"]));
  it("ranks revenue descending", () => expect(rankEligibleCampaigns([row({ name: "Low", placedOrderValue: 2 }), row({ name: "High", placedOrderValue: 20 }), row({ name: "Middle", placedOrderValue: 9 })]).map(({ name }) => name)).toEqual(["High", "Middle", "Low"]));
  it("uses send date descending then stable DOM order as the deterministic tie-break", () => {
    expect(rankEligibleCampaigns([row({ name: "Old", placedOrderValue: 8, sendDate: "Aug 1, 2026", domOrder: 0 }), row({ name: "New second", placedOrderValue: 8, sendDate: "Aug 9, 2026", domOrder: 2 }), row({ name: "New first", placedOrderValue: 8, sendDate: "Aug 9, 2026", domOrder: 1 })]).map(({ name }) => name)).toEqual(["New first", "New second", "Old"]);
  });
  it("ranks the Top 5 campaigns by default, like Top 5 Flows", () => {
    expect(TOP_CAMPAIGN_ROW_COUNT).toBe(5);
  });
  it.each([[7, 5], [5, 5], [4, 4], [2, 2], [1, 1], [0, 0]])("from %i eligible Sent campaigns selects %i without inventing rows", (available, expected) => {
    const sent = Array.from({ length: available }, (_, index) => row({ name: `Campaign ${index}`, placedOrderValue: 100 - index, domOrder: index }));
    // Canceled/Draft/Scheduled campaigns never count toward the five, whatever their position or value.
    const others = ["Canceled", "Draft", "Scheduled"].map((status, index) => row({ name: status, status, placedOrderValue: 1_000 + index, domOrder: available + index }));
    const ranked = rankEligibleCampaigns([...others, ...sent], TOP_CAMPAIGN_ROW_COUNT);
    expect(ranked.map((campaign) => campaign.name)).toEqual(sent.slice(0, expected).map((campaign) => campaign.name));
  });
});

describe("visible Campaigns period proof", () => {
  const august = { startDate: "2026-08-01", endDate: "2026-08-31" };
  it.each(["Date range Aug 1, 2026 – Aug 31, 2026", "08/01/2026 - 08/31/2026", "Aug 1 – Aug 31, 2026"])("accepts the exact range shown as %s", (shown) => expect(visibleCampaignPeriodText([shown], august)).toBe(true));
  it.each(["Last 30 days", "Aug 1, 2026 – Aug 30, 2026", "07/01/2026 - 07/31/2026", "Sep 1 – Sep 30, 2026"])("rejects %s", (shown) => expect(visibleCampaignPeriodText([shown], august)).toBe(false));
});

describe("Top Campaigns Type column", () => {
  it("resolves Email from visible text", () => {
    expect(campaignChannel(["Email"])).toBe("Email");
  });
  it("resolves Email from an accessible icon name, SVG title, or test id", () => {
    expect(campaignChannel(["", "Email campaign"])).toBe("Email");
    expect(campaignChannel([null, "envelope"])).toBe("Email");
    expect(campaignChannel([undefined, "EmailIcon"])).toBe("Email");
  });
  it("resolves SMS from an accessible icon name or SVG title", () => {
    expect(campaignChannel(["", "SMS"])).toBe("SMS");
    expect(campaignChannel(["", "Text message"])).toBe("SMS");
    expect(campaignChannel(["", "icon-sms"])).toBe("SMS");
  });
  it("returns null, never an empty string, when nothing proves exactly one channel", () => {
    expect(campaignChannel([])).toBeNull();
    expect(campaignChannel(["", "  ", null])).toBeNull();
    expect(campaignChannel(["A/B test"])).toBeNull();
    expect(campaignChannel(["Email", "SMS"])).toBeNull();
  });
});
