import { describe, expect, it } from "vitest";
import type { ReportDraft, ScreenshotRecord, SectionConfiguration } from "@tention/report-schema";
import {
  applyReportEvent, createReportDraft, InMemoryReportDraftRepository,
  ReportDomainError, upsertScreenshotMetadata, validateReportDraft,
} from "./index.js";

const now = new Date("2026-09-09T12:00:00Z");
const draftId = "11111111-1111-4111-8111-111111111111";
const requiredOverview: SectionConfiguration = { executive_summary: "required" };

function draft(sections: SectionConfiguration = requiredOverview): ReportDraft {
  return createReportDraft({
    client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata", currency: null },
    reportMonth: { year: 2026, month: 8 }, sections,
  }, { now, id: draftId });
}

function overview(overrides: Partial<ScreenshotRecord> = {}): ScreenshotRecord {
  return {
    id: "shot-1", clientId: "client-1", reportMonth: { year: 2026, month: 8 },
    type: "overview", capturedAt: now.toISOString(), sourceUrl: "https://example.com/report",
    width: 1440, height: 720, approved: true, storageLocation: null, ...overrides,
  };
}

describe("report validation", () => {
  it("reports missing and unapproved required screenshots", () => {
    expect(validateReportDraft(draft(), { now }).errors.map(({ code }) => code)).toContain("REQUIRED_SCREENSHOT_MISSING");
    const withShot = { ...draft(), screenshots: [overview({ approved: false })] };
    expect(validateReportDraft(withShot, { now }).errors.map(({ code }) => code)).toContain("REQUIRED_SCREENSHOT_UNAPPROVED");
  });
  it("allows a missing optional screenshot", () => expect(validateReportDraft(draft({ executive_summary: "optional" }), { now }).status).toBe("valid"));
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
});

describe("report lifecycle", () => {
  it("supports the legal success path", () => {
    let value = { ...draft(), screenshots: [overview()] };
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW", "APPROVE", "START_GENERATION", "GENERATION_SUCCEEDED"] as const) {
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
  it("allows warnings during review submission", () => {
    let value = { ...draft({ executive_summary: "disabled" }), screenshots: [overview()] };
    value = applyReportEvent(value, "START_DATA_FETCH", { now });
    value = applyReportEvent(value, "DATA_FETCH_SUCCEEDED", { now });
    expect(applyReportEvent(value, "SUBMIT_FOR_REVIEW", { now }).status).toBe("ready_for_review");
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
});
