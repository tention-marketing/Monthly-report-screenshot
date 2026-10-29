import { describe, expect, it } from "vitest";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotRecord, type ScreenshotType, type SectionConfiguration, type SubscriberGrowthEvidence } from "@tention/report-schema";
import { createReportDraft, emptyClientReportTargets, enableEmailSubscriberGrowth, getReportReadiness, ReportDomainError, retireLegacyListGrowth, validateReportDraft } from "./index.js";

const now = new Date("2026-09-09T12:00:00Z");
const draftId = "11111111-1111-4111-8111-111111111111";
const august = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
const nineSections: SectionConfiguration = {
  executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", campaign_performance: "required",
  flow_performance: "required", signup_form: "optional", welcome_flow: "optional", customer_split: "optional", deliverability: "required",
  campaign_metrics: "required", flow_metrics: "required", analysis: "optional", next_month_plan: "optional",
};
const evidence: SubscriberGrowthEvidence = {
  channel: "email", view: "growth", emailSubscribers: 17_698, newSubscribers: 943, exclusions: 499,
  changes: { emailSubscribers: null, newSubscribers: null, exclusions: null },
  charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true }, visiblePeriodText: "Aug 1 – Aug 31, 2026",
};
const coreNine: ScreenshotType[] = ["overview", "month_comparison", "top_campaigns", "top_flows", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"];
const urls: Partial<Record<ScreenshotType, string>> = {
  overview: "https://www.klaviyo.com/dashboard", top_flows: "https://www.klaviyo.com/dashboard", top_campaigns: "https://www.klaviyo.com/omnicampaigns",
  deliverability: "https://www.klaviyo.com/analytics/deliverability/email/score", email_subscriber_growth: "https://www.klaviyo.com/subscriber-growth-page-from-config",
};

function draft(sections: SectionConfiguration): ReportDraft {
  return createReportDraft({ client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata", currency: null }, reportMonth: { year: 2026, month: 8 }, sections }, { now, id: draftId });
}
function shot(type: ScreenshotType, index: number, overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  const proof = createScreenshotSourceProof(type, august, undefined,
    type === "top_campaigns" ? { accountIdentity: "Orion", clientTimezone: "Asia/Kolkata", visibleMetricLabel: "Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 1, includedRowCount: 1, rows: [{ name: "Campaign", type: "Email", status: "Sent", sendDate: "2026-08-01", openRate: "10%", clickRate: "1%", placedOrderValue: 1 }] } : null,
    type === "email_subscriber_growth" ? evidence : null);
  const id = `shot-${index}`;
  return {
    id, clientId: "client-1", reportMonth: { year: 2026, month: 8 }, type, capturedAt: now.toISOString(), sourceUrl: urls[type] ?? "https://www.klaviyo.com/analytics/dashboards/01ABC",
    width: 1440, height: 720, approved: true, storageKey: `reports/${draftId}/${type}/${id}.png`, mimeType: "image/png", byteSize: 100,
    sha256: index.toString(16).padStart(64, "0"), approvedAt: now.toISOString(), periodConfirmed: true, sourceProof: proof, ...overrides,
  };
}
const withShots = (report: ReportDraft, screenshots: ScreenshotRecord[]): ReportDraft => {
  const next = { ...report, screenshots };
  return { ...next, validation: validateReportDraft(next, { now }) };
};
const coreShots = () => coreNine.map((type, index) => shot(type, index + 1));

describe("legacy list_growth stays retired", () => {
  it("retires List Growth exactly as before and leaves Section 10 alone", () => {
    const legacy = withShots(draft({ ...nineSections, list_growth: "required" }), [...coreShots(), shot("list_growth", 40)]);
    const retired = retireLegacyListGrowth(legacy, { now });
    expect(retired.sections).not.toHaveProperty("list_growth");
    expect(retired.sections).not.toHaveProperty("email_subscriber_growth");
    expect(retired.screenshots).toEqual(legacy.screenshots);
    expect(retired.version).toBe(legacy.version + 1);
    expect(retired.validation).toEqual({ status: "valid", errors: [], warnings: [] });
  });

  it("keeps an old report with legacy List Growth evidence valid and unaltered, with no Section 10 requirement", () => {
    const legacy = withShots(draft({ ...nineSections, list_growth: "required" }), [...coreShots(), shot("list_growth", 40)]);
    expect(legacy.validation).toEqual({ status: "valid", errors: [], warnings: [] });
    expect(legacy.screenshots.some(({ type }) => type === "email_subscriber_growth")).toBe(false);
  });

  it("never migrates legacy List Growth into Section 10 when Section 10 is enabled", () => {
    const legacy = withShots(draft({ ...nineSections, list_growth: "required" }), [...coreShots(), shot("list_growth", 40)]);
    const enabled = enableEmailSubscriberGrowth(legacy, { now });
    expect(enabled.sections.list_growth).toBe("required");
    expect(enabled.screenshots).toEqual(legacy.screenshots);
    expect(enabled.validation.errors.map(({ code, screenshotType }) => [code, screenshotType])).toEqual([["REQUIRED_SCREENSHOT_MISSING", "email_subscriber_growth"]]);
  });
});

describe("Section 10 — Subscriber Growth", () => {
  it("leaves an existing nine-section report valid without Section 10", () => {
    expect(withShots(draft(nineSections), coreShots()).validation).toEqual({ status: "valid", errors: [], warnings: [] });
  });

  it("requires Section 10 evidence only on a report that includes it, and accepts a valid ten-section report", () => {
    const ten = draft({ ...nineSections, email_subscriber_growth: "required" });
    expect(withShots(ten, coreShots()).validation.errors.map(({ code, screenshotType }) => [code, screenshotType])).toEqual([["REQUIRED_SCREENSHOT_MISSING", "email_subscriber_growth"]]);
    expect(withShots(ten, [...coreShots(), shot("email_subscriber_growth", 10)]).validation).toEqual({ status: "valid", errors: [], warnings: [] });
  });

  it("rejects Section 10 evidence without structured Email → Growth proof, from outside Klaviyo, or for the wrong month", () => {
    const ten = draft({ ...nineSections, email_subscriber_growth: "required" });
    const codes = (screenshot: ScreenshotRecord) => withShots(ten, [...coreShots(), screenshot]).validation.errors.map(({ code }) => code);
    expect(codes(shot("email_subscriber_growth", 10, { sourceProof: createScreenshotSourceProof("email_subscriber_growth", august) }))).toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
    expect(codes(shot("email_subscriber_growth", 10, { sourceUrl: "https://example.com/subscriber-growth" }))).toContain("SCREENSHOT_SOURCE_URL_MISMATCH");
    const july = { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" };
    expect(codes(shot("email_subscriber_growth", 10, { sourceProof: createScreenshotSourceProof("email_subscriber_growth", july, undefined, null, evidence) }))).toContain("SCREENSHOT_SOURCE_PERIOD_MISMATCH");
  });

  it("enables Section 10 explicitly, once, and never on a generated report", () => {
    const report = draft(nineSections);
    const enabled = enableEmailSubscriberGrowth(report, { now });
    expect(enabled.sections).toEqual({ ...nineSections, email_subscriber_growth: "required" });
    expect(enabled.version).toBe(report.version + 1);
    expect(enableEmailSubscriberGrowth(enabled, { now })).toBe(enabled);
    expect(() => enableEmailSubscriberGrowth({ ...report, status: "generated" }, { now })).toThrow(ReportDomainError);
  });

  it("is not applicable to a report without it, and needs the configured Subscriber growth URL when included", () => {
    const targets = emptyClientReportTargets("client-1");
    const status = (sections: SectionConfiguration, configured: boolean) => getReportReadiness(configured ? { ...targets, sourceUrls: { subscriberGrowthUrl: urls.email_subscriber_growth } } : targets, sections)
      .sections.find(({ sectionKey }) => sectionKey === "email_subscriber_growth");
    expect(status(nineSections, false)).toMatchObject({ status: "not_applicable", required: false });
    expect(status({ ...nineSections, email_subscriber_growth: "disabled" }, false)).toMatchObject({ status: "not_applicable", required: false });
    expect(status({ ...nineSections, email_subscriber_growth: "required" }, false)).toMatchObject({ status: "missing_configuration", required: true, requiredTargets: ["subscriberGrowthUrl"] });
    expect(status({ ...nineSections, email_subscriber_growth: "required" }, true)).toMatchObject({ status: "ready", required: true });
  });

  it("does not change readiness of the nine existing sections", () => {
    const targets = emptyClientReportTargets("client-1");
    const core = (sections: SectionConfiguration) => getReportReadiness(targets, sections).sections.filter(({ sectionKey }) => sectionKey !== "email_subscriber_growth");
    expect(core({ ...nineSections, email_subscriber_growth: "required" })).toEqual(core(nineSections));
  });
});
