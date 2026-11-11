import { describe, expect, it } from "vitest";
import { createReportDraft } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft } from "@tention/report-schema";
import { assertReportMonthConsistent, finalPdfFilename, ReportMonthMismatchError } from "./report-month-safety.js";

function october(): ReportDraft {
  const draft = createReportDraft({ client: { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 10 }, sections: { executive_summary: "required" } }, { now: new Date("2026-11-02T12:00:00Z"), id: "d0000000-0000-4000-8000-000000000001" });
  return { ...draft, screenshots: [{ id: "e0000000-0000-4000-8000-000000000001", clientId: "club-furniture", reportMonth: { year: 2026, month: 10 }, type: "overview", capturedAt: "2026-11-02T10:00:00.000Z", sourceUrl: "https://www.klaviyo.com/dashboard", width: 10, height: 10, approved: true, approvedAt: "2026-11-02T10:01:00.000Z", periodConfirmed: true, storageKey: "k", mimeType: "image/png", byteSize: 1, sha256: "a".repeat(64), sourceProof: createScreenshotSourceProof("overview", draft.period) }] };
}
const mismatch = (run: () => void) => { try { run(); } catch (error) { return error instanceof ReportMonthMismatchError ? error.mismatches : ["unexpected error"]; } return []; };

describe("report month safety before final generation and Drive/Doc writes", () => {
  it("passes when the panel, report, periods, screenshots, PDF name, Drive names and Doc title all name October 2026", () => {
    expect(mismatch(() => assertReportMonthConsistent(october(), { year: 2026, month: 10 }))).toEqual([]);
    expect(finalPdfFilename(october())).toBe("Club-Furniture-October-2026-Monthly-Report.pdf");
  });
  it("fails closed when the panel shows another month", () => {
    expect(mismatch(() => assertReportMonthConsistent(october(), { year: 2026, month: 9 }))).toEqual(["the panel shows 2026-09 but the report is October 2026"]);
  });
  it("fails closed when a screenshot belongs to another month or client", () => {
    const draft = october();
    draft.screenshots = [{ ...draft.screenshots[0]!, reportMonth: { year: 2026, month: 9 } }, { ...draft.screenshots[0]!, type: "top_flows", clientId: "autoledtech" }];
    expect(mismatch(() => assertReportMonthConsistent(draft))).toEqual(["the overview screenshot belongs to 2026-09", "the top_flows screenshot belongs to another client"]);
  });
  it("fails closed when the stored reporting period is not the report month's calendar month", () => {
    const draft = { ...october(), period: { startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" } };
    expect(mismatch(() => assertReportMonthConsistent(draft))).toEqual(["the stored reporting periods do not match October 2026"]);
  });
  it("uses the REPORT_MONTH_MISMATCH code", () => {
    expect(() => assertReportMonthConsistent(october(), { year: 2026, month: 8 })).toThrow(expect.objectContaining({ code: "REPORT_MONTH_MISMATCH" }));
  });
});
