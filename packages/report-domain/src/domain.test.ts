import { describe, expect, it } from "vitest";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotRecord, type SectionConfiguration } from "@tention/report-schema";
import {
  applyReportEvent, createReportDraft, InMemoryReportDraftRepository,
  replaceScreenshotAndInvalidateCaptureReview, ReportDomainError, retireLegacyListGrowth, upsertScreenshotMetadata, upsertScreenshotMetadataBatch, validateReportDraft,
} from "./index.js";

const now = new Date("2026-09-09T12:00:00Z");
const draftId = "11111111-1111-4111-8111-111111111111";
const requiredOverview: SectionConfiguration = { executive_summary: "required" };
const klaviyoHomeUrl = "https://www.klaviyo.com/dashboard";
const businessReviewUrl = "https://www.klaviyo.com/analytics/dashboards/01ABC";

function draft(sections: SectionConfiguration = requiredOverview): ReportDraft {
  return createReportDraft({
    client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata", currency: null },
    reportMonth: { year: 2026, month: 8 }, sections,
  }, { now, id: draftId });
}

function overview(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    id: "shot-1", clientId: "client-1", reportMonth: { year: 2026, month: 8 },
    type: "overview", capturedAt: now.toISOString(), sourceUrl: klaviyoHomeUrl,
    width: 1440, height: 720, approved: true, storageKey: "reports/11111111-1111-4111-8111-111111111111/overview/22222222-2222-4222-8222-222222222222.png",
    mimeType: "image/png", byteSize: 100, sha256: "a".repeat(64), approvedAt: now.toISOString(), periodConfirmed: true,
    sourceProof: createScreenshotSourceProof("overview", {
      startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31",
    }), ...overrides,
  };
}
function validProof(type: ScreenshotRecord["type"], period: ReportDraft["period"]) {
  return createScreenshotSourceProof(type, period, type === "signup_form" ? { scope: "all_forms" }
    : type === "welcome_flow" ? { scope: "email_welcome_flows", entities: [{ id: "fixture-email-1", name: "Fixture Email Welcome 1", channel: "email" }, { id: "fixture-email-2", name: "Fixture Email Welcome 2", channel: "email" }] } : undefined,
  type === "top_campaigns" ? { accountIdentity: "Orion", clientTimezone: "Asia/Kolkata", visibleMetricLabel: "Shopify Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 1, includedRowCount: 1, rows: [{ name: "Campaign", type: "Email", status: "Sent", sendDate: "2026-08-01", openRate: "10%", clickRate: "1%", placedOrderValue: 1 }] } : null);
}

function screenshot(type: ScreenshotRecord["type"], id: string, sha256: string, overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    ...overview({
      id, type, sha256, storageKey: `reports/${draftId}/${type}/${id}.png`,
      sourceUrl: type === "overview" || type === "top_flows" ? klaviyoHomeUrl : type === "top_campaigns" ? "https://www.klaviyo.com/omnicampaigns?appBarNav=true" : "https://example.com/report",
      sourceProof: validProof(type, {
        startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31",
      }),
    }),
    ...overrides,
  };
}

describe("report validation", () => {
  it("retires List Growth from active configuration without deleting historical screenshot metadata", () => {
    const legacy = { ...draft({ executive_summary: "required", list_growth: "required" }), screenshots: [screenshot("list_growth", "legacy-list", "b".repeat(64))] };
    const migrated = retireLegacyListGrowth(legacy, { now });
    expect(migrated.sections).not.toHaveProperty("list_growth");
    expect(migrated.screenshots).toEqual(legacy.screenshots);
    expect(migrated.version).toBe(legacy.version + 1);
    expect(migrated.validation.errors.map(({ screenshotType }) => screenshotType)).not.toContain("list_growth");
  });
  it("reports missing and unapproved required screenshots", () => {
    expect(validateReportDraft(draft(), { now }).errors.map(({ code }) => code)).toContain("REQUIRED_SCREENSHOT_MISSING");
    const withShot = { ...draft(), screenshots: [overview({ approved: false })] };
    expect(validateReportDraft(withShot, { now }).errors.map(({ code }) => code)).toContain("REQUIRED_SCREENSHOT_UNAPPROVED");
  });
  it("requires human period confirmation and stored PNG asset metadata", () => {
    const unconfirmed = { ...draft(), screenshots: [overview({ periodConfirmed: false })] };
    expect(validateReportDraft(unconfirmed, { now }).errors.map(({ code }) => code)).toContain("REQUIRED_SCREENSHOT_PERIOD_UNCONFIRMED");
    const withoutAsset = { ...draft(), screenshots: [overview({ storageKey: null, sha256: null })] };
    expect(validateReportDraft(withoutAsset, { now }).errors.map(({ code }) => code)).toContain("REQUIRED_SCREENSHOT_ASSET_MISSING");
  });
  it("allows a missing optional non-core screenshot", () => expect(validateReportDraft(draft({ signup_form: "optional" }), { now }).status).toBe("valid"));
  it("warns when a disabled section has a screenshot", () => {
    const value = { ...draft({ executive_summary: "disabled" }), screenshots: [overview()] };
    expect(validateReportDraft(value, { now }).warnings.map(({ code }) => code)).toContain("DISABLED_SECTION_SCREENSHOT_PRESENT");
  });
  it("detects period tampering", () => {
    const value = draft({});
    value.period.startDate = "2026-08-02";
    expect(validateReportDraft(value, { now }).errors.map(({ code }) => code)).toContain("REPORT_PERIOD_MISMATCH");
  });
  it("detects duplicate types and mismatched metadata", () => {
    const value = { ...draft({}), screenshots: [overview(), overview({ id: "shot-2", clientId: "other", reportMonth: { year: 2026, month: 7 } })] };
    const codes = validateReportDraft(value, { now }).errors.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining(["DUPLICATE_SCREENSHOT_TYPE", "SCREENSHOT_CLIENT_MISMATCH", "SCREENSHOT_MONTH_MISMATCH"]));
  });
  it("detects unknown section configuration", () => {
    expect(validateReportDraft(draft({ invented_section: "required" }), { now }).errors.map(({ code }) => code)).toContain("UNKNOWN_SECTION_CONFIGURATION");
  });
  it("requires canonical capture source proof for enabled screenshots", () => {
    const missing = validateReportDraft({ ...draft(), screenshots: [overview({ sourceProof: null })] }, { now });
    expect(missing.errors.map(({ code }) => code)).toContain("SCREENSHOT_SOURCE_PROOF_MISSING");
    const mismatched = validateReportDraft({ ...draft(), screenshots: [overview({ sourceProof: createScreenshotSourceProof("month_comparison", draft().period) })] }, { now });
    expect(mismatched.errors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "SCREENSHOT_SOURCE_IDENTITY_MISMATCH", "SCREENSHOT_SOURCE_PERIOD_MISMATCH",
    ]));
  });
  it("accepts the standalone Deliverability Score page for every client after canonical semantic proof", () => {
    const value = {
      ...draft({ deliverability: "required" }),
      screenshots: [screenshot("deliverability", "standalone-score", "f".repeat(64), {
        sourceUrl: "https://www.klaviyo.com/analytics/deliverability/email/score",
      })],
    };
    const validation = validateReportDraft(value, { now });
    expect(validation.errors.map(({ code }) => code)).not.toContain("SCREENSHOT_SOURCE_URL_MISMATCH");
  });
  it("rejects the Business Review Deliverability Email card for different client identities", () => {
    for (const client of ["club-furniture", "autoledtech"]) {
      const value = {
        ...draft({ deliverability: "required" }),
        client: { ...draft().client, id: client },
        screenshots: [screenshot("deliverability", `deliverability-${client}`, `${client === "club-furniture" ? "a" : "b"}`.repeat(64), {
          clientId: client,
          sourceUrl: "https://www.klaviyo.com/analytics/dashboards/verified-business-review",
        })],
      };
      expect(validateReportDraft(value, { now }).errors.map(({ code }) => code)).toEqual(expect.arrayContaining(["SCREENSHOT_SOURCE_URL_MISMATCH"]));
    }
  });
  it("rejects a standalone score URL if gauge, rolling-window, or rate-table semantic proof is absent", () => {
    const value = {
      ...draft({ deliverability: "required" }),
      screenshots: [screenshot("deliverability", "incomplete-score-proof", "d".repeat(64), {
        sourceUrl: "https://www.klaviyo.com/analytics/deliverability/email/score",
        sourceProof: { ...validProof("deliverability", draft().period), semanticEvidence: ["deliverability-score"] },
      })],
    };
    expect(validateReportDraft(value, { now }).errors.map(({ code }) => code)).toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
  });
  it("marks only Month Comparison evidence from the retired Conversion summary view as stale", () => {
    const sections: SectionConfiguration = { month_comparison: "required", campaign_performance: "required", campaign_metrics: "required", flow_performance: "required", flow_metrics: "required" };
    const period = draft().period;
    const businessReview = (type: ScreenshotRecord["type"], index: number) => screenshot(type, `br-${index}`, String(index).repeat(64), { sourceUrl: businessReviewUrl });
    const conversionSummary = { ...validProof("month_comparison", period), semanticTab: "conversion-summary|previous-period", sourceIdentity: "business-review|growth-overview|conversion-summary|previous-period" };
    const value = { ...draft(sections), screenshots: [
      screenshot("month_comparison", "old-month-comparison", "1".repeat(64), { sourceUrl: businessReviewUrl, sourceProof: conversionSummary }),
      ...(["campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics"] as const).map((type, index) => businessReview(type, index + 2)),
    ] };
    const mismatches = validateReportDraft(value, { now }).errors.filter(({ code }) => code === "SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]!.message).toMatch(/Month Comparison/);
    const recaptured = { ...value, screenshots: [screenshot("month_comparison", "new-month-comparison", "1".repeat(64), { sourceUrl: businessReviewUrl }), ...value.screenshots.slice(1)] };
    expect(validateReportDraft(recaptured, { now }).errors.map(({ code }) => code)).not.toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
  });
  it("rejects a wrong source identity even when it is a newly captured asset", () => {
    const value = {
      ...draft(),
      screenshots: [screenshot("overview", "new-wrong-source", "b".repeat(64), {
        sourceProof: createScreenshotSourceProof("top_campaigns", draft().period),
      })],
    };
    expect(validateReportDraft(value, { now }).errors.map(({ code }) => code)).toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
  });
  it.each([
    ["overview", "executive_summary", "business-review", "growth-overview", "summary", "business-review|growth-overview|summary"],
    ["top_campaigns", "top_campaigns", "campaigns", "campaigns-list", "default", "campaigns|campaigns-list|default"],
    ["top_flows", "top_flows", "business-review", "flow-performance", "top-performing", "business-review|flow-performance|top-performing"],
  ] as const)("keeps persisted old C1 %s proof readable but stale and ineligible for review", (type, section, sourceFamily, semanticCard, semanticTab, sourceIdentity) => {
    const oldProof = { ...createScreenshotSourceProof(type, draft().period), sourceFamily, semanticCard, semanticTab, sourceIdentity };
    const value = { ...draft({ [section]: "required" }), screenshots: [screenshot(type, `old-${type}`, "e".repeat(64), { sourceProof: oldProof })] };
    const validation = validateReportDraft(value, { now });
    expect(value.screenshots[0]?.sourceProof).toEqual(oldProof);
    expect(validation.errors.map(({ code }) => code)).toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
    expect(() => applyReportEvent(value, "SUBMIT_FOR_REVIEW", { now })).toThrow(ReportDomainError);
  });
  it("keeps old Business Review top_flows evidence stale on both identity and source URL", () => {
    const oldProof = { ...createScreenshotSourceProof("top_flows", draft().period), sourceFamily: "business-review", semanticCard: "flow-performance", semanticTab: "top-performing", sourceIdentity: "business-review|flow-performance|top-performing" };
    const value = { ...draft({ top_flows: "required" }), screenshots: [screenshot("top_flows", "old-br-top-flows", "e".repeat(64), { sourceProof: oldProof, sourceUrl: businessReviewUrl })] };
    expect(validateReportDraft(value, { now }).errors.map(({ code }) => code)).toEqual(expect.arrayContaining([
      "SCREENSHOT_SOURCE_IDENTITY_MISMATCH", "SCREENSHOT_SOURCE_URL_MISMATCH",
    ]));
    expect(() => applyReportEvent(value, "SUBMIT_FOR_REVIEW", { now })).toThrow(ReportDomainError);
  });
  it("requires Top Flows evidence with the canonical Home proof to come from the Klaviyo Home dashboard URL", () => {
    const sections: SectionConfiguration = { top_flows: "required" };
    const fromBusinessReview = { ...draft(sections), screenshots: [screenshot("top_flows", "top-flows-br", "c".repeat(64), { sourceUrl: businessReviewUrl })] };
    const rejected = validateReportDraft(fromBusinessReview, { now });
    expect(rejected.errors.map(({ code }) => code)).toContain("SCREENSHOT_SOURCE_URL_MISMATCH");
    expect(rejected.errors.map(({ code }) => code)).not.toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
    const fromHome = { ...draft(sections), screenshots: [screenshot("top_flows", "top-flows-home", "c".repeat(64), { sourceUrl: klaviyoHomeUrl })] };
    const accepted = validateReportDraft(fromHome, { now });
    expect(accepted.errors.map(({ code }) => code)).not.toContain("SCREENSHOT_SOURCE_URL_MISMATCH");
    expect(accepted.status).toBe("valid");
  });
  it("accepts different valid capture tabs and allows a same-section replacement", () => {
    const sections: SectionConfiguration = { top_campaigns: "required", campaign_metrics: "required" };
    const base = draft(sections);
    const valid = {
      ...base,
      screenshots: [screenshot("top_campaigns", "campaigns", "1".repeat(64)), screenshot("campaign_metrics", "metrics", "2".repeat(64))],
    };
    expect(validateReportDraft(valid, { now }).status).toBe("valid");
    const replaced = upsertScreenshotMetadata({ ...draft(), screenshots: [overview()] }, screenshot("overview", "retake", "3".repeat(64)), "overview", { now });
    expect(replaced.screenshots).toEqual([expect.objectContaining({ id: "retake", sha256: "3".repeat(64) })]);
    expect(replaced.validation.status).toBe("valid");
  });
  it("imports a batch of live-acceptance screenshots as pending review without satisfying approval gates", () => {
    const sections: SectionConfiguration = { executive_summary: "required", signup_form: "optional" };
    const base = draft(sections);
    const imported = screenshot("overview", "imported-overview", "8".repeat(64), {
      approved: false, approvedAt: null, captureOrigin: "live_acceptance_import",
    });
    const updated = upsertScreenshotMetadataBatch(base, [imported], { now });
    expect(updated.version).toBe(base.version + 1);
    expect(updated.screenshots[0]).toMatchObject({ captureOrigin: "live_acceptance_import", approved: false, approvedAt: null });
    expect(updated.validation.errors.map(({ code }) => code)).toContain("REQUIRED_SCREENSHOT_UNAPPROVED");
    expect(updated.status).toBe("draft");
    expect(() => applyReportEvent(updated, "SUBMIT_FOR_REVIEW", { now })).toThrow(ReportDomainError);
  });
  it("rejects duplicate screenshot types in a batch without changing the draft", () => {
    const base = draft({});
    const first = screenshot("overview", "overview-a", "1".repeat(64));
    const second = screenshot("overview", "overview-b", "2".repeat(64));
    expect(() => upsertScreenshotMetadataBatch(base, [first, second], { now })).toThrow(ReportDomainError);
    expect(base.screenshots).toHaveLength(0);
    expect(base.version).toBe(1);
  });
  it("rejects the AutoLEDTech-style campaign screenshot reuse before review or PDF rendering", () => {
    const sections: SectionConfiguration = {
      executive_summary: "disabled", top_campaigns: "required", month_comparison: "required",
      deliverability: "required", campaign_metrics: "required", flow_metrics: "required", list_growth: "required",
    };
    const campaign = screenshot("top_campaigns", "campaign", "c".repeat(64));
    const reusedTypes = ["month_comparison", "deliverability", "campaign_metrics", "flow_metrics", "list_growth"] as const;
    const value = {
      ...draft(sections),
      screenshots: [campaign, ...reusedTypes.map((type) => screenshot(type, `wrong-${type}`, "c".repeat(64), {
        sourceProof: campaign.sourceProof,
      }))],
    };
    const codes = validateReportDraft(value, { now }).errors.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining([
      "DUPLICATE_SCREENSHOT_SOURCE", "SCREENSHOT_SOURCE_IDENTITY_MISMATCH", "SCREENSHOT_SOURCE_PERIOD_MISMATCH",
    ]));
    expect(() => applyReportEvent(value, "SUBMIT_FOR_REVIEW", { now })).toThrow(ReportDomainError);
  });
  it.each([
    ["overview", "month_comparison"], ["campaign_performance", "campaign_metrics"], ["campaign_metrics", "top_campaigns"],
    ["flow_performance", "flow_metrics"], ["flow_metrics", "top_flows"], ["campaign_performance", "flow_performance"], ["flow_performance", "campaign_performance"],
  ] as const)("keeps C1 source proof distinct: %s cannot satisfy %s", (wrongSource, storedType) => {
    const value = { ...draft({}), screenshots: [screenshot(storedType, `wrong-${wrongSource}-${storedType}`, "d".repeat(64), { sourceProof: createScreenshotSourceProof(wrongSource, draft().period) })] };
    expect(validateReportDraft(value, { now }).errors.map(({ code }) => code)).toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
  });
});

describe("report lifecycle", () => {
  it("supports the legal success path", () => {
    let value = { ...draft(), screenshots: [overview()] };
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW", "START_GENERATION", "GENERATION_SUCCEEDED"] as const) {
      value = applyReportEvent(value, event, { now });
    }
    expect(value.status).toBe("generated");
  });
  it("blocks illegal transitions", () => {
    expect(() => applyReportEvent(draft(), "GENERATION_SUCCEEDED", { now })).toThrow(ReportDomainError);
  });
  it("blocks review when validation has errors and exposes them", () => {
    const dataReady = applyReportEvent(applyReportEvent(draft(), "START_DATA_FETCH", { now }), "DATA_FETCH_SUCCEEDED", { now });
    try { applyReportEvent(dataReady, "SUBMIT_FOR_REVIEW", { now }); }
    catch (error) {
      expect(error).toBeInstanceOf(ReportDomainError);
      expect((error as ReportDomainError).validation?.errors).not.toHaveLength(0);
      return;
    }
    throw new Error("Expected submission to fail");
  });
  it("allows a capture-only draft with valid required screenshots to complete capture review", () => {
    expect(applyReportEvent({ ...draft(), screenshots: [overview()] }, "SUBMIT_FOR_REVIEW", { now }).status).toBe("ready_for_review");
  });
  it("migrates only a valid legacy generated capture-only report back to capture review", () => {
    let value = { ...draft(), screenshots: [overview()] };
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW", "START_GENERATION", "GENERATION_SUCCEEDED"] as const) {
      value = applyReportEvent(value, event, { now });
    }
    expect(() => applyReportEvent(value, "SUBMIT_FOR_REVIEW", { now })).toThrow(ReportDomainError);
    expect(applyReportEvent(value, "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW", { now }).status).toBe("ready_for_review");
    expect(() => applyReportEvent({ ...value, screenshots: [] }, "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW", { now })).toThrow(ReportDomainError);
    expect(() => applyReportEvent(draft(), "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW", { now })).toThrow(ReportDomainError);
  });
  it("allows warnings during review submission", () => {
    let value = { ...draft({ executive_summary: "disabled" }), screenshots: [overview()] };
    value = applyReportEvent(value, "START_DATA_FETCH", { now });
    value = applyReportEvent(value, "DATA_FETCH_SUCCEEDED", { now });
    expect(applyReportEvent(value, "SUBMIT_FOR_REVIEW", { now }).status).toBe("ready_for_review");
  });
  it("returns a reviewed report to captures incomplete when a required screenshot is replaced", () => {
    let value = { ...draft(), screenshots: [overview()] };
    value = applyReportEvent(value, "START_DATA_FETCH", { now });
    value = applyReportEvent(value, "DATA_FETCH_SUCCEEDED", { now });
    value = applyReportEvent(value, "SUBMIT_FOR_REVIEW", { now });
    const replaced = replaceScreenshotAndInvalidateCaptureReview(value, overview({ id: "shot-2" }), "overview", { now });
    expect(replaced.status).toBe("captures_incomplete");
    expect(replaced.version).toBe(value.version + 1);
  });
});

describe("screenshot service and repository", () => {
  it("upserts matching metadata and rejects mismatches", () => {
    expect(upsertScreenshotMetadata(draft(), overview(), "overview", { now }).screenshots).toHaveLength(1);
    expect(() => upsertScreenshotMetadata(draft(), overview({ type: "top_flows" }), "overview", { now })).toThrowError(/Route and payload/);
    expect(() => upsertScreenshotMetadata(draft(), overview({ clientId: "other" }), "overview", { now })).toThrowError(/another client/);
    expect(() => upsertScreenshotMetadata(draft(), overview({ reportMonth: { year: 2026, month: 7 } }), "overview", { now })).toThrowError(/another report month/);
  });
  it("stores defensive copies in the non-production repository", async () => {
    const repository = new InMemoryReportDraftRepository();
    const value = draft();
    await repository.create(value);
    value.status = "failed";
    expect((await repository.getById(draftId))?.status).toBe("draft");
  });
  it("keeps a stale historical capture readable without rewriting its proof", async () => {
    const repository = new InMemoryReportDraftRepository();
    const oldProof = { ...createScreenshotSourceProof("overview", draft().period), sourceFamily: "business-review", semanticCard: "growth-overview", semanticTab: "summary", sourceIdentity: "business-review|growth-overview|summary" };
    const historical = { ...draft(), screenshots: [overview({ sourceProof: oldProof })] };
    await repository.create(historical);
    const reloaded = await repository.getById(draftId);
    expect(reloaded?.screenshots[0]?.sourceProof).toEqual(oldProof);
    expect(validateReportDraft(reloaded!, { now }).errors.map(({ code }) => code)).toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
    expect(await repository.getHistory(draftId)).toHaveLength(1);
  });
});
