import { describe, expect, it } from "vitest";
import { createScreenshotSourceProof, matchesReportCaptureSpec, reportCaptureSpecByScreenshotType, type ScreenshotType } from "@tention/report-schema";
import { BUSINESS_REVIEW_TARGETS, isBusinessReviewScreenshotType } from "./business-review-capture.js";
import { DASHBOARD_TARGETS, isCanonicalDashboardScreenshotType } from "./dashboard-capture.js";
import { isDeliverabilityScoreScreenshotType } from "./deliverability-score-capture.js";
import { configuredAutomaticCaptureUrl } from "../screenshot-capture/capture-source-url.js";

const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };

describe("Top 5 Flows canonical source contract", () => {
  it("accepts only Klaviyo Home → Top performing flows (default view) for the exact report month", () => {
    expect(reportCaptureSpecByScreenshotType.top_flows).toMatchObject({ sourceFamily: "klaviyo-home", semanticCard: "top-performing-flows", semanticTab: "default", sourceIdentity: "klaviyo-home|top-performing-flows|default", datePolicy: "EXACT_MONTH", sourceUrlKey: "overviewUrl" });
    expect(DASHBOARD_TARGETS.top_flows.sourceIdentity).toBe("klaviyo-home|top-performing-flows|default");
    expect(matchesReportCaptureSpec("top_flows", createScreenshotSourceProof("top_flows", period))).toBe(true);
  });

  it("rejects the retired Business Review Top performing source", () => {
    const old = { ...createScreenshotSourceProof("top_flows", period), sourceFamily: "business-review", semanticCard: "flow-performance", semanticTab: "top-performing", sourceIdentity: "business-review|flow-performance|top-performing" };
    expect(matchesReportCaptureSpec("top_flows", old)).toBe(false);
    expect(isBusinessReviewScreenshotType("top_flows")).toBe(false);
  });
});

describe("other report sections are untouched by the Top Flows source change", () => {
  // Expected routing for the 8 other screenshot sections, as before the change.
  const unchanged: Array<[ScreenshotType, "home" | "business-review" | "klaviyo-campaigns" | "deliverability" | "manual", string]> = [
    ["overview", "home", "klaviyo-home|business-performance-summary|default"],
    ["top_campaigns", "klaviyo-campaigns", "klaviyo-campaigns|campaign-list|placed-order-revenue-desc"],
    ["month_comparison", "business-review", "business-review|growth-overview|message-type-breakdown|previous-period"],
    ["campaign_performance", "business-review", "business-review|campaign-performance|overview"],
    ["campaign_metrics", "business-review", "business-review|campaign-performance|metrics"],
    ["flow_performance", "business-review", "business-review|flow-performance|overview"],
    ["flow_metrics", "business-review", "business-review|flow-performance|metrics"],
    ["deliverability", "deliverability", reportCaptureSpecByScreenshotType.deliverability.sourceIdentity],
  ];
  const targets = { clientId: "c", sourceUrls: { overviewUrl: "https://www.klaviyo.com/dashboard", campaignsUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true", deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score" }, businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/BR" } } as never;

  it.each(unchanged)("%s keeps its %s route and source identity", (type, route, identity) => {
    expect(reportCaptureSpecByScreenshotType[type].sourceIdentity).toBe(identity);
    expect(isCanonicalDashboardScreenshotType(type)).toBe(route === "home");
    expect(isBusinessReviewScreenshotType(type)).toBe(route === "business-review");
    expect(isDeliverabilityScoreScreenshotType(type)).toBe(route === "deliverability");
    if (route === "business-review") expect(BUSINESS_REVIEW_TARGETS[type as keyof typeof BUSINESS_REVIEW_TARGETS].sourceIdentity).toBe(identity);
    const expectedUrl = route === "home" ? "https://www.klaviyo.com/dashboard" : route === "klaviyo-campaigns" ? "https://www.klaviyo.com/omnicampaigns?appBarNav=true" : route === "deliverability" ? "https://www.klaviyo.com/analytics/deliverability/email/score" : "https://www.klaviyo.com/analytics/dashboards/BR";
    expect(configuredAutomaticCaptureUrl(type, targets)).toBe(expectedUrl);
  });
});
