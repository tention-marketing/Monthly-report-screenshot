import { describe, expect, it } from "vitest";
import { createScreenshotSourceProof, formatCoverMoney, parseRenderedMoney, reportCover, verifyBusinessPerformance, type BusinessPerformanceEvidence, type ReportDraft } from "./index.js";

// Club Furniture, Klaviyo Home → Business performance summary as rendered for Sep 1–30, 2026 (DOM text, run c3d31628).
const september: BusinessPerformanceEvidence = { totalRevenue: "$584,032.35", totalAttributedRevenue: "$173,849.26", emailAttributedRevenue: "$156,674.44", smsAttributedRevenue: "$17,174.82", campaignRevenue: "$56,527.51", flowRevenue: "$117,321.75", visiblePeriodText: "Sep 1, 2026 - Sep 30, 2026" };

const pad = (value: number) => String(value).padStart(2, "0");
const getReportPeriodForTest = ({ year, month }: { year: number; month: number }) => {
  const last = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const [py, pm] = month === 1 ? [year - 1, 12] : [year, month - 1];
  return { startDate: `${year}-${pad(month)}-01`, endDate: `${year}-${pad(month)}-${last(year, month)}`, previousStartDate: `${py}-${pad(pm)}-01`, previousEndDate: `${py}-${pad(pm)}-${last(py, pm)}` };
};
function report(month: { year: number; month: number }, currency: string | null, evidence: BusinessPerformanceEvidence | undefined, overrides: { clientId?: string; observed?: { startDate: string; endDate: string } } = {}): Pick<ReportDraft, "client" | "reportMonth" | "period" | "screenshots"> {
  const period = getReportPeriodForTest(month);
  const proof = { ...createScreenshotSourceProof("overview", period, undefined, null, null, evidence ?? null), ...(overrides.observed ? { observedPeriod: overrides.observed } : {}) };
  return { client: { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency }, reportMonth: month, period, screenshots: [{
    id: "s1", clientId: overrides.clientId ?? "club-furniture", reportMonth: month, type: "overview", capturedAt: "2026-11-05T00:00:00.000Z", sourceUrl: "https://www.klaviyo.com/dashboard", width: 10, height: 10, approved: false,
    storageKey: "k", mimeType: "image/png", byteSize: 1, sha256: "a".repeat(64), captureOrigin: "live_acceptance_import", approvedAt: null, periodConfirmed: true, sourceProof: proof, automatedValidatedAt: "2026-11-05T00:00:00.000Z" }] };
}

describe("report cover: Business performance summary values", () => {
  it("reads USD exactly and formats it in USD", () => {
    expect(parseRenderedMoney("$584,032.35", "USD")).toEqual({ ok: true, value: { raw: "$584,032.35", amount: "584032.35", minor: 58403235, currency: "USD" } });
    expect(formatCoverMoney("584032.35", "USD")).toBe("$584,032.35");
    expect(formatCoverMoney("0.10", "USD")).toBe("$0.10");
  });

  it("uses each client's own currency (EUR, GBP, JPY) and rejects a value in another currency", () => {
    expect(parseRenderedMoney("€1,234.50", "EUR")).toMatchObject({ ok: true, value: { amount: "1234.50", minor: 123450 } });
    expect(formatCoverMoney("1234.50", "EUR")).toBe("€1,234.50");
    expect(formatCoverMoney("1234.50", "GBP")).toBe("£1,234.50");
    expect(parseRenderedMoney("¥12,345", "JPY")).toMatchObject({ ok: true, value: { amount: "12345", minor: 12345 } });
    expect(parseRenderedMoney("$1,234.50", "EUR")).toMatchObject({ ok: false, code: "COVER_CURRENCY_MISMATCH" });
  });

  it.each(["$1.2K", "1,234.50", "$12.345", "$1,23,4.00", "USD $5.00", "", "—"])("rejects the malformed money value %j", (raw) => {
    expect(parseRenderedMoney(raw, "USD").ok).toBe(false);
  });

  it("verifies all four cover values and the Campaigns + Flows = Attributed revenue identity", () => {
    const verified = verifyBusinessPerformance(september, "USD");
    expect(verified).toMatchObject({ ok: true, values: { totalRevenue: { amount: "584032.35" }, emailAttributedRevenue: { amount: "156674.44" }, campaignRevenue: { amount: "56527.51" }, flowRevenue: { amount: "117321.75" } }, totalAttributedRevenue: { amount: "173849.26" } });
  });

  it("allows one minor unit of rendering rounding, but fails closed on a material inconsistency", () => {
    expect(verifyBusinessPerformance({ ...september, flowRevenue: "$117,321.76" }, "USD").ok).toBe(true);
    expect(verifyBusinessPerformance({ ...september, flowRevenue: "$117,421.75" }, "USD")).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "COVER_METRICS_INCONSISTENT" })] });
  });

  it("rejects total attributed revenue taken as Email attributed revenue", () => {
    expect(verifyBusinessPerformance({ ...september, emailAttributedRevenue: "$173,849.26" }, "USD")).toMatchObject({ ok: false, issues: [expect.objectContaining({ code: "COVER_METRICS_INCONSISTENT", metric: "Email Attributed Revenue" })] });
  });

  it("names exactly which metric is missing, never treating it as $0", () => {
    const missing = verifyBusinessPerformance({ ...september, flowRevenue: null as unknown as string }, "USD");
    expect(missing).toMatchObject({ ok: false, issues: [{ code: "COVER_METRIC_MISSING", metric: "Revenue from Flows" }] });
    expect(verifyBusinessPerformance(september, null)).toMatchObject({ ok: false, issues: [{ code: "COVER_CURRENCY_NOT_CONFIGURED" }] });
  });

  it("keeps a real zero as $0.00", () => {
    expect(verifyBusinessPerformance({ ...september, totalAttributedRevenue: "$0.00", campaignRevenue: "$0.00", flowRevenue: "$0.00", emailAttributedRevenue: "$0.00", smsAttributedRevenue: "$0.00" }, "USD")).toMatchObject({ ok: true, values: { flowRevenue: { amount: "0.00", minor: 0 } } });
  });

  it.each([[{ year: 2026, month: 9 }, "September 2026"], [{ year: 2026, month: 4 }, "April 2026"], [{ year: 2028, month: 2 }, "February 2028"]] as const)("builds the cover for %j from that report's own capture", (month, label) => {
    const cover = reportCover(report(month, "USD", september));
    expect(cover).toMatchObject({ ok: true, cover: { reportMonthLabel: label, currency: "USD", metrics: { totalRevenue: { formatted: "$584,032.35", label: "Total Revenue" }, emailAttributedRevenue: { formatted: "$156,674.44" }, campaignRevenue: { formatted: "$56,527.51" }, flowRevenue: { formatted: "$117,321.75" } } } });
  });

  it("rejects values captured while Klaviyo showed another period", () => {
    expect(reportCover(report({ year: 2026, month: 4 }, "USD", september, { observed: { startDate: "2026-09-01", endDate: "2026-09-30" } }))).toMatchObject({ ok: false, issues: [{ code: "COVER_SOURCE_NOT_VERIFIED" }] });
  });

  it("rejects values from another client's capture", () => {
    expect(reportCover(report({ year: 2026, month: 9 }, "USD", september, { clientId: "another-client" }))).toMatchObject({ ok: false, issues: [{ code: "COVER_SOURCE_NOT_VERIFIED", message: expect.stringContaining("another client") }] });
  });

  it("does not backfill an older capture that carries no structured values", () => {
    expect(reportCover(report({ year: 2026, month: 9 }, "USD", undefined))).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "COVER_METRIC_MISSING", metric: "Total Revenue" })]) });
  });
});
