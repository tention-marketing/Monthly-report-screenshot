import { describe, expect, it } from "vitest";
import { emptyClientReportTargets } from "@tention/report-domain";
import { configuredAutomaticCaptureUrl } from "./capture-source-url.js";

const targets = {
  ...emptyClientReportTargets("autoledtech"),
  sourceUrls: { overviewUrl: "https://www.klaviyo.com/dashboard", campaignsUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true", businessReviewUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK", deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score" },
  businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" },
};

describe("automatic capture source URL selection", () => {
  it("uses the configured Klaviyo Overview URL for Executive Summary", () => {
    expect(configuredAutomaticCaptureUrl("overview", targets)).toBe("https://www.klaviyo.com/dashboard");
  });
  it("uses the configured Klaviyo Overview (Home) URL for Top 5 Flows, not Business Review", () => {
    expect(configuredAutomaticCaptureUrl("top_flows", targets)).toBe("https://www.klaviyo.com/dashboard");
    expect(configuredAutomaticCaptureUrl("top_flows", { ...targets, sourceUrls: { ...targets.sourceUrls, overviewUrl: undefined } })).toBe("https://www.klaviyo.com/dashboard");
  });
  it("uses Campaigns only for Top Campaigns", () => {
    expect(configuredAutomaticCaptureUrl("top_campaigns", targets)).toBe("https://www.klaviyo.com/omnicampaigns?appBarNav=true");
  });
  it("uses the standalone Score route only for Deliverability", () => {
    expect(configuredAutomaticCaptureUrl("deliverability", targets)).toBe("https://www.klaviyo.com/analytics/deliverability/email/score");
  });
  it("uses Klaviyo's fixed Home, Campaigns, and Score routes when no client override is saved", () => {
    expect(configuredAutomaticCaptureUrl("overview", null)).toBe("https://www.klaviyo.com/dashboard");
    expect(configuredAutomaticCaptureUrl("top_flows", emptyClientReportTargets("any-client"))).toBe("https://www.klaviyo.com/dashboard");
    expect(configuredAutomaticCaptureUrl("top_campaigns", emptyClientReportTargets("any-client"))).toBe("https://www.klaviyo.com/omnicampaigns?appBarNav=true");
    expect(configuredAutomaticCaptureUrl("deliverability", emptyClientReportTargets("any-client"))).toBe("https://www.klaviyo.com/analytics/deliverability/email/score");
  });
  it.each(["month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics"] as const)("fails closed for %s without a saved, verified Business Review target", (type) => {
    expect(configuredAutomaticCaptureUrl(type, null)).toBeNull();
    expect(configuredAutomaticCaptureUrl(type, emptyClientReportTargets("any-client"))).toBeNull();
    expect(configuredAutomaticCaptureUrl(type, targets)).toBe("https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK");
  });
});
