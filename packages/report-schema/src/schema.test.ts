import { describe, expect, it } from "vitest";
import {
  clientReportTargetsInputSchema, clientSummarySchema, createScreenshotSourceProof, matchesReportCaptureSpec, REPORT_CAPTURE_SPEC_V1, reportMonthSchema, reportSectionKeySchema,
  sectionConfigurationSchema, sectionRequirementSchema,
} from "./index.js";

describe("shared report schemas", () => {
  it.each(["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Kolkata"])(
    "accepts IANA timezone %s", (timezone) => {
      expect(clientSummarySchema.safeParse({ id: "c1", name: "Client", timezone, currency: null }).success).toBe(true);
    },
  );
  it("rejects an invalid timezone", () => {
    expect(clientSummarySchema.safeParse({ id: "c1", name: "Client", timezone: "Mars/Base", currency: null }).success).toBe(false);
  });
  it.each([0, 13])("rejects invalid report month %s", (month) => {
    expect(reportMonthSchema.safeParse({ year: 2026, month }).success).toBe(false);
  });
  it("rejects a clearly invalid year", () => expect(reportMonthSchema.safeParse({ year: 0, month: 1 }).success).toBe(false));
  it("defines stable section requirements", () => expect(sectionRequirementSchema.options).toEqual(["required", "optional", "disabled"]));
  it("supports per-report partial section configuration", () => {
    expect(sectionConfigurationSchema.parse({ executive_summary: "required", analysis: "disabled" })).toEqual({ executive_summary: "required", analysis: "disabled" });
    expect(reportSectionKeySchema.options).toHaveLength(16);
  });
  it("locks the current capture specification to the twelve canonical sections plus additive Section 10, with stable wire types", () => {
    expect(REPORT_CAPTURE_SPEC_V1).toHaveLength(13);
    expect(REPORT_CAPTURE_SPEC_V1.map(({ key }) => key)).toEqual([
      "executive_summary", "month_comparison", "top_campaigns", "top_flows", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "signup_form_performance", "welcome_flow_performance", "customer_split", "deliverability",
      "email_subscriber_growth",
    ]);
    expect(new Set(REPORT_CAPTURE_SPEC_V1.map(({ screenshotType }) => screenshotType)).size).toBe(13);
    expect(new Set(REPORT_CAPTURE_SPEC_V1.map(({ sourceIdentity }) => sourceIdentity)).size).toBe(13);
    // Only Section 10 is opt-in per report; the frozen core never is.
    expect(REPORT_CAPTURE_SPEC_V1.filter(({ reportOptIn }) => reportOptIn).map(({ key }) => key)).toEqual(["email_subscriber_growth"]);
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "signup_form_performance")?.screenshotType).toBe("signup_form");
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "welcome_flow_performance")?.screenshotType).toBe("welcome_flow");
    const identity = (key: string) => REPORT_CAPTURE_SPEC_V1.find((spec) => spec.key === key)?.sourceIdentity;
    expect(new Set([identity("campaign_performance"), identity("campaign_metrics"), identity("top_campaigns")]).size).toBe(3);
    expect(new Set([identity("flow_performance"), identity("flow_metrics"), identity("top_flows")]).size).toBe(3);
    expect(identity("executive_summary")).not.toBe(identity("month_comparison"));
    expect(REPORT_CAPTURE_SPEC_V1.filter(({ sourceFamily }) => sourceFamily === "business-review").map(({ key }) => key)).toEqual([
      "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics",
    ]);
    expect(REPORT_CAPTURE_SPEC_V1.filter(({ sourceFamily }) => sourceFamily === "klaviyo-home").map(({ key }) => key)).toEqual([
      "executive_summary", "top_flows",
    ]);
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "executive_summary")).toMatchObject({
      sourceIdentity: "klaviyo-home|business-performance-summary|default", automationStatus: "auto",
    });
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "top_campaigns")).toMatchObject({
      sourceFamily: "klaviyo-campaigns", semanticCard: "campaign-list", semanticTab: "placed-order-revenue-desc",
      sourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc", navigationMode: "direct_configured_url", sourceUrlKey: "campaignsUrl", automationStatus: "auto",
    });
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "top_flows")).toMatchObject({
      sourceFamily: "klaviyo-home", semanticCard: "top-performing-flows", semanticTab: "default",
      sourceIdentity: "klaviyo-home|top-performing-flows|default", automationStatus: "auto", sourceUrlKey: "overviewUrl", datePolicy: "EXACT_MONTH",
    });
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "month_comparison")).toMatchObject({
      sourceFamily: "business-review", semanticCard: "growth-overview", semanticTab: "message-type-breakdown|previous-period",
      sourceIdentity: "business-review|growth-overview|message-type-breakdown|previous-period", datePolicy: "PREVIOUS_MONTH_COMPARISON", automationStatus: "auto",
    });
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "deliverability")).toMatchObject({
      sourceFamily: "klaviyo-deliverability", semanticCard: "deliverability-score", semanticTab: "email",
      sourceIdentity: "klaviyo-deliverability|deliverability-score|email", datePolicy: "ROLLING_30_DAY", automationStatus: "auto", sourceUrlKey: "deliverabilityUrl",
    });
    expect(createScreenshotSourceProof("overview", {
      startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30",
    }).sourceIdentity).toBe("klaviyo-home|business-performance-summary|default");
    expect(createScreenshotSourceProof("top_flows", {
      startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30",
    }).sourceIdentity).toBe("klaviyo-home|top-performing-flows|default");
    // The retired Business Review Top performing tab no longer satisfies the Top 5 Flows contract.
    expect(matchesReportCaptureSpec("top_flows", { ...createScreenshotSourceProof("top_flows", { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" }), sourceFamily: "business-review", semanticCard: "flow-performance", semanticTab: "top-performing", sourceIdentity: "business-review|flow-performance|top-performing" })).toBe(false);
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "signup_form_performance")?.datePolicy).toBe("ROLLING_30_DAY");
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "welcome_flow_performance")).toMatchObject({ sourceFamily: "flows", semanticCard: "listing", semanticTab: "email-welcome-rows", datePolicy: "ROLLING_30_DAY", sourceIdentity: "flows|listing|email-welcome-rows", navigationMode: "direct_configured_url" });
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "signup_form_performance")).toMatchObject({ semanticCard: "listing", semanticTab: "all-forms", sourceIdentity: "signup-forms|listing|all-forms", automationStatus: "manual_required" });
    const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
    const welcomeProof = createScreenshotSourceProof("welcome_flow", period, { scope: "email_welcome_flows", entities: [{ id: "WN2GLE", name: "BM | Welcome Flow [February Offer A/B Test]", channel: "email" }, { id: "Rex4Pp", name: "(Instant Audiences) WC | Welcome Flow", channel: "email" }] });
    expect(welcomeProof).toMatchObject({ listingScope: "email_welcome_flows", configuredEntityId: null, configuredEntityName: null, configuredEntities: [{ id: "WN2GLE" }, { id: "Rex4Pp" }] });
    expect(matchesReportCaptureSpec("welcome_flow", welcomeProof)).toBe(true);
    expect(matchesReportCaptureSpec("welcome_flow", createScreenshotSourceProof("welcome_flow", period, { scope: "email_welcome_flows", entities: [{ id: "WN2GLE", name: "Welcome", channel: "email" }, { id: "X6jdED", name: "SMS Welcome Series", channel: "email" }] }))).toBe(true);
    expect(matchesReportCaptureSpec("welcome_flow", createScreenshotSourceProof("welcome_flow", period))).toBe(false);
    expect(createScreenshotSourceProof("signup_form", period, { scope: "all_forms" })).toMatchObject({ listingScope: "all_forms", configuredEntities: [] });
    expect(createScreenshotSourceProof("month_comparison", {
      startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31",
    })).toMatchObject({ datePolicy: "PREVIOUS_MONTH_COMPARISON", observedPeriod: { comparisonStartDate: "2026-07-01", comparisonEndDate: "2026-07-31" } });
    const deliverabilityProof = createScreenshotSourceProof("deliverability", period);
    expect(deliverabilityProof).toMatchObject({ sourceIdentity: "klaviyo-deliverability|deliverability-score|email", expectedPeriod: null, observedPeriod: null, semanticEvidence: ["deliverability-score", "based-on-last-30-days", "score-gauge", "rate-table"] });
    expect(matchesReportCaptureSpec("deliverability", { ...deliverabilityProof, semanticEvidence: ["deliverability-score"] })).toBe(false);
  });
  it("normalizes client target values and rejects unsafe or ambiguous target configuration", () => {
    const normalized = clientReportTargetsInputSchema.parse({
      businessReview: { dashboardUrl: " https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK ", accountLabel: " Club Furniture ", providerAccountId: " acct_123 ", providerIdentityKind: "account" },
      welcomeFlow: { name: " Welcome ", aliases: ["welcome", "WELCOME SERIES", "welcome series", " "] },
      welcomeFlowListing: { mode: "email_welcome_flows", flows: [{ id: " WN2GLE ", name: " BM | Welcome Flow [February Offer A/B Test] ", channel: "email" }, { id: " Rex4Pp ", name: " (Instant Audiences) WC | Welcome Flow ", channel: "email" }] },
      signupForms: { mode: "configured", ids: [" form-a ", "FORM-A"], names: [" Main form "] },
      customerSegment: { id: "customers" }, nonCustomerSegment: { name: "Non-customers" },
    });
    expect(normalized.businessReview?.dashboardUrl).toBe("https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK");
    expect(normalized.businessReview?.accountLabel).toBe("Club Furniture");
    expect(normalized.businessReview?.providerAccountId).toBe("acct_123");
    expect(normalized.businessReview?.providerIdentityKind).toBe("account");
    expect(normalized.welcomeFlow).toEqual({ name: "Welcome", aliases: ["WELCOME SERIES"] });
    expect(normalized.welcomeFlowListing?.flows.map(({ id }) => id)).toEqual(["WN2GLE", "Rex4Pp"]);
    expect(clientReportTargetsInputSchema.safeParse({ welcomeFlowListing: { mode: "email_welcome_flows", flows: [{ id: "WN2GLE", name: "Email", channel: "email" }, { id: "WN2GLE", name: "Duplicate", channel: "email" }] } }).success).toBe(false);
    expect(clientReportTargetsInputSchema.safeParse({ welcomeFlowListing: { mode: "email_welcome_flows", flows: [{ id: "WN2GLE", name: "Email", channel: "sms" }, { id: "Rex4Pp", name: "Email 2", channel: "email" }] } }).success).toBe(false);
    expect(normalized.signupForms).toEqual({ mode: "configured", ids: ["form-a"], names: ["Main form"] });
    expect(clientReportTargetsInputSchema.safeParse({ businessReview: { dashboardUrl: "http://www.klaviyo.com/dashboard" } }).success).toBe(false);
    expect(clientReportTargetsInputSchema.safeParse({ businessReview: { dashboardUrl: "https://klaviyo.example.com/dashboard" } }).success).toBe(false);
    const knownKlaviyoUrl = "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK";
    expect(clientReportTargetsInputSchema.parse({ sourceUrls: { overviewUrl: knownKlaviyoUrl } }).sourceUrls).toEqual({ overviewUrl: knownKlaviyoUrl });
    expect(clientReportTargetsInputSchema.safeParse({ sourceUrls: { overviewUrl: "http://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" } }).success).toBe(false);
    expect(clientReportTargetsInputSchema.safeParse({ sourceUrls: { overviewUrl: "https://klaviyo.example.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" } }).success).toBe(false);
    expect(clientReportTargetsInputSchema.safeParse({ signupForms: { mode: "configured", ids: [], names: [] } }).success).toBe(false);
    expect(clientReportTargetsInputSchema.safeParse({ customerSegment: { id: "same" }, nonCustomerSegment: { id: "same" } }).success).toBe(false);
    expect(clientReportTargetsInputSchema.safeParse({ primaryEmailList: {} }).success).toBe(false);
  });
});

describe("Month Comparison source contract", () => {
  const period = (startDate: string, endDate: string, previousStartDate: string, previousEndDate: string) => ({ startDate, endDate, previousStartDate, previousEndDate });

  it("identifies Growth overview → Message type breakdown with the previous-month policy", () => {
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "month_comparison")).toMatchObject({
      sourceFamily: "business-review", semanticCard: "growth-overview", semanticTab: "message-type-breakdown|previous-period",
      sourceIdentity: "business-review|growth-overview|message-type-breakdown|previous-period", datePolicy: "PREVIOUS_MONTH_COMPARISON", sourceUrlKey: "businessReviewUrl",
    });
  });

  it.each([
    ["August 2026 vs July 2026", period("2026-08-01", "2026-08-31", "2026-07-01", "2026-07-31")],
    ["September 2026 vs August 2026", period("2026-09-01", "2026-09-30", "2026-08-01", "2026-08-31")],
    ["January 2027 vs December 2026", period("2027-01-01", "2027-01-31", "2026-12-01", "2026-12-31")],
  ])("proves the exact current and previous calendar month: %s", (_label, reportPeriod) => {
    const proof = createScreenshotSourceProof("month_comparison", reportPeriod);
    expect(proof.expectedPeriod).toEqual({ startDate: reportPeriod.startDate, endDate: reportPeriod.endDate, comparisonStartDate: reportPeriod.previousStartDate, comparisonEndDate: reportPeriod.previousEndDate });
    expect(proof.observedPeriod).toEqual(proof.expectedPeriod);
    expect(matchesReportCaptureSpec("month_comparison", proof)).toBe(true);
  });

  it("treats earlier Conversion summary evidence as stale", () => {
    const current = createScreenshotSourceProof("month_comparison", period("2026-08-01", "2026-08-31", "2026-07-01", "2026-07-31"));
    expect(matchesReportCaptureSpec("month_comparison", { ...current, semanticTab: "conversion-summary|previous-period", sourceIdentity: "business-review|growth-overview|conversion-summary|previous-period" })).toBe(false);
  });

  it("leaves every other section's source identity unchanged", () => {
    expect(Object.fromEntries(REPORT_CAPTURE_SPEC_V1.filter(({ key }) => key !== "month_comparison").map(({ key, sourceIdentity }) => [key, sourceIdentity]))).toEqual({
      executive_summary: "klaviyo-home|business-performance-summary|default",
      top_campaigns: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc",
      top_flows: "klaviyo-home|top-performing-flows|default",
      campaign_performance: "business-review|campaign-performance|overview",
      campaign_metrics: "business-review|campaign-performance|metrics",
      flow_performance: "business-review|flow-performance|overview",
      flow_metrics: "business-review|flow-performance|metrics",
      signup_form_performance: "signup-forms|listing|all-forms",
      welcome_flow_performance: "flows|listing|email-welcome-rows",
      customer_split: "segments|configured-customer-split|overview",
      deliverability: "klaviyo-deliverability|deliverability-score|email",
      email_subscriber_growth: "klaviyo-subscriber-growth|email|growth",
    });
  });
});
