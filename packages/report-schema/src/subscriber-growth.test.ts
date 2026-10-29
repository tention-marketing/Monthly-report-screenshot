import { describe, expect, it } from "vitest";
import {
  automaticCaptureTypesForSections, createScreenshotSourceProof, matchesReportCaptureSpec, REPORT_CAPTURE_SPEC_V1, reportCaptureSpecByScreenshotType,
  screenshotSectionMapping, screenshotSourceProofSchema, type ReportPeriod, type SectionConfiguration, type SubscriberGrowthEvidence,
} from "./index.js";

const CORE_NINE = ["overview", "month_comparison", "top_campaigns", "top_flows", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"];
const nineSectionConfiguration: SectionConfiguration = {
  executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", campaign_performance: "required",
  flow_performance: "required", signup_form: "optional", welcome_flow: "optional", customer_split: "optional", deliverability: "required",
  campaign_metrics: "required", flow_metrics: "required", analysis: "optional", next_month_plan: "optional",
};
const august: ReportPeriod = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
const evidence: SubscriberGrowthEvidence = {
  channel: "email", view: "growth", emailSubscribers: 17_698, newSubscribers: 943, exclusions: 499,
  changes: { emailSubscribers: "+2.1%", newSubscribers: null, exclusions: "-4%" },
  charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true }, visiblePeriodText: "Aug 1 – Aug 31, 2026",
};

describe("Section 10 — Subscriber Growth contract", () => {
  it("is a new section with its own key, source, and identity", () => {
    expect(REPORT_CAPTURE_SPEC_V1.find(({ key }) => key === "email_subscriber_growth")).toEqual({
      key: "email_subscriber_growth", screenshotType: "email_subscriber_growth", title: "Subscriber Growth", sourceFamily: "klaviyo-subscriber-growth",
      semanticCard: "email", semanticTab: "growth", datePolicy: "EXACT_MONTH", sourceIdentity: "klaviyo-subscriber-growth|email|growth",
      defaultRequirement: "required", navigationMode: "direct_configured_url", automationStatus: "auto", sourceUrlKey: "subscriberGrowthUrl", reportOptIn: true,
    });
    expect(screenshotSectionMapping.email_subscriber_growth).toBe("email_subscriber_growth");
  });

  it("keeps the legacy list_growth contract retired and distinct", () => {
    expect(REPORT_CAPTURE_SPEC_V1.some(({ key, screenshotType }) => key === "list_growth" || screenshotType === "list_growth")).toBe(false);
    expect(reportCaptureSpecByScreenshotType.list_growth).toMatchObject({ key: "list_growth", sourceIdentity: "list|configured-primary-list|growth", automationStatus: "deferred", sourceUrlKey: "listGrowthUrl" });
    expect(screenshotSectionMapping.list_growth).toBe("list_growth");
    // Legacy List Growth evidence can never satisfy Section 10, and Section 10 evidence can never satisfy List Growth.
    const legacy = createScreenshotSourceProof("list_growth", august);
    expect(matchesReportCaptureSpec("email_subscriber_growth", { ...legacy, subscriberGrowth: evidence })).toBe(false);
    expect(matchesReportCaptureSpec("list_growth", createScreenshotSourceProof("email_subscriber_growth", august, undefined, null, evidence))).toBe(false);
  });

  it("keeps an existing nine-section report at exactly its nine automatic sections", () => {
    expect(automaticCaptureTypesForSections(nineSectionConfiguration)).toEqual(CORE_NINE);
    expect(automaticCaptureTypesForSections({ ...nineSectionConfiguration, list_growth: "optional" })).toEqual(CORE_NINE);
  });

  it("adds Section 10 last only when the report enables it", () => {
    expect(automaticCaptureTypesForSections({ ...nineSectionConfiguration, email_subscriber_growth: "required" })).toEqual([...CORE_NINE, "email_subscriber_growth"]);
    expect(automaticCaptureTypesForSections({ ...nineSectionConfiguration, email_subscriber_growth: "optional" })).toEqual([...CORE_NINE, "email_subscriber_growth"]);
    expect(automaticCaptureTypesForSections({ ...nineSectionConfiguration, email_subscriber_growth: "disabled" })).toEqual(CORE_NINE);
  });

  it("requires structured Email → Growth evidence on the Section 10 proof", () => {
    const proof = createScreenshotSourceProof("email_subscriber_growth", august, undefined, null, evidence);
    expect(matchesReportCaptureSpec("email_subscriber_growth", proof)).toBe(true);
    expect(screenshotSourceProofSchema.parse(proof).subscriberGrowth).toEqual(evidence);
    expect(matchesReportCaptureSpec("email_subscriber_growth", createScreenshotSourceProof("email_subscriber_growth", august))).toBe(false);
    for (const wrong of [{ channel: "sms" }, { view: "overview" }, { view: "opt-in-sources" }, { view: "exclusion-sources" }, { emailSubscribers: 17.7 }, { exclusions: -1 }, { charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: false } }]) {
      expect(matchesReportCaptureSpec("email_subscriber_growth", { ...proof, subscriberGrowth: { ...evidence, ...wrong } as never })).toBe(false);
    }
  });

  it("never adds Subscriber Growth evidence to the nine existing sections' proofs", () => {
    for (const type of CORE_NINE) {
      const proof = createScreenshotSourceProof(type as never, august, undefined, null, evidence);
      expect("subscriberGrowth" in proof).toBe(false);
      expect(JSON.stringify(screenshotSourceProofSchema.parse(proof))).toBe(JSON.stringify(proof));
      expect(matchesReportCaptureSpec(type as never, { ...proof, subscriberGrowth: evidence })).toBe(false);
    }
  });

  it.each([
    ["July 2026", { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" }],
    ["August 2026", august],
    ["September 2026", { startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" }],
    ["February 2027", { startDate: "2027-02-01", endDate: "2027-02-28", previousStartDate: "2027-01-01", previousEndDate: "2027-01-31" }],
    ["February 2028 (leap)", { startDate: "2028-02-01", endDate: "2028-02-29", previousStartDate: "2028-01-01", previousEndDate: "2028-01-31" }],
  ] as const)("proves the exact report month for %s", (_label, period) => {
    const proof = createScreenshotSourceProof("email_subscriber_growth", period, undefined, null, evidence);
    expect(proof.expectedPeriod).toEqual({ startDate: period.startDate, endDate: period.endDate });
    expect(proof.observedPeriod).toEqual({ startDate: period.startDate, endDate: period.endDate });
  });
});
