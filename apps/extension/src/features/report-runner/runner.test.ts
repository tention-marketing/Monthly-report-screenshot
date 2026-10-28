import { describe, expect, it } from "vitest";
import { createScreenshotSourceProof, type ReportDraft } from "@tention/report-schema";
import { getAutomaticCapturePlan, getReportRunnerState } from "./runner.js";

const draft = (screenshots: ReportDraft["screenshots"] = []): ReportDraft => ({
  id: "11111111-1111-4111-8111-111111111111",
  client: { id: "smoke", name: "Smoke Client", timezone: "Asia/Kolkata", currency: null },
  reportMonth: { year: 2026, month: 8 },
  period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
  status: "draft", version: 1,
  sections: { executive_summary: "required", top_campaigns: "required", top_flows: "required", signup_form: "optional", analysis: "optional" },
  screenshots, validation: { status: "valid", errors: [], warnings: [] },
  createdAt: "2026-09-09T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z",
});

const approved = (type: "overview" | "top_campaigns" | "top_flows"): ReportDraft["screenshots"][number] => ({
  id: type === "overview" ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
  clientId: "smoke", reportMonth: { year: 2026, month: 8 }, type, capturedAt: "2026-09-09T12:00:00.000Z",
  sourceUrl: "https://www.klaviyo.com", width: 100, height: 100, approved: true, periodConfirmed: true,
  storageKey: "reports/test.png", mimeType: "image/png", byteSize: 10, sha256: "a".repeat(64), approvedAt: "2026-09-09T12:00:00.000Z",
  sourceProof: createScreenshotSourceProof(type, { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" }),
});

describe("report runner", () => {
  it("chooses the first incomplete required screenshot-backed section", () => {
    const state = getReportRunnerState(draft());
    expect(state.next?.section).toBe("executive_summary");
    expect(state.completed).toBe(0);
  });
  it("advances from the server-returned uploaded report and does not let optional sections block progress", () => {
    const state = getReportRunnerState(draft([approved("overview")]));
    expect(state.next?.section).toBe("top_flows");
    expect(state.required.map(({ section }) => section)).toEqual(["executive_summary", "top_flows", "top_campaigns"]);
  });
  it("resumes the next incomplete required section after an extension reload", () => {
    const reloadedState = getReportRunnerState(draft([approved("overview")]));
    expect(reloadedState.next?.label).toBe("Top 5 Flows");
  });
  it("reports completion only after every required screenshot is approved", () => {
    const state = getReportRunnerState(draft([approved("overview"), approved("top_flows"), approved("top_campaigns")]));
    expect(state).toMatchObject({ completed: 3, isComplete: true, next: null });
  });
  it("treats a persisted old Business Review Overview proof as stale instead of complete", () => {
    const old = approved("overview");
    old.sourceProof = { ...old.sourceProof!, sourceFamily: "business-review", semanticCard: "growth-overview", semanticTab: "summary", sourceIdentity: "business-review|growth-overview|summary" };
    const state = getReportRunnerState(draft([old, approved("top_campaigns")]));
    expect(state.required.find(({ section }) => section === "executive_summary")).toMatchObject({ state: "stale" });
    expect(state).toMatchObject({ completed: 1, next: { section: "executive_summary" }, isComplete: false });
  });
  it("captures both Klaviyo Home sections first, then moves to canonical Business Review rankings", () => {
    const state = getReportRunnerState(draft());
    expect(state.required.slice(0, 3).map(({ section }) => section)).toEqual(["executive_summary", "top_flows", "top_campaigns"]);
    expect(state.next?.section).toBe("executive_summary");
  });
  it("orders all enabled Business Review sections after the Klaviyo Home sections", () => {
    const state = getReportRunnerState({ ...draft(), sections: {
      executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required",
      campaign_performance: "required", campaign_metrics: "required", flow_performance: "required", flow_metrics: "required",
    } });
    expect(state.required.map(({ section }) => section)).toEqual([
      "executive_summary", "top_flows", "top_campaigns", "month_comparison",
      "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics",
    ]);
  });
  it("treats a historical Business Review Top Flows proof as stale", () => {
    const old = approved("top_flows");
    old.sourceProof = { ...old.sourceProof!, sourceFamily: "business-review", semanticCard: "flow-performance", semanticTab: "top-performing", sourceIdentity: "business-review|flow-performance|top-performing" };
    const state = getReportRunnerState(draft([approved("overview"), old, approved("top_campaigns")]));
    expect(state.required.find(({ section }) => section === "top_flows")).toMatchObject({ state: "stale" });
  });
  it("accepts a Klaviyo Home Top performing flows proof as complete", () => {
    expect(approved("top_flows").sourceProof).toMatchObject({ sourceFamily: "klaviyo-home", semanticCard: "top-performing-flows", semanticTab: "default", sourceIdentity: "klaviyo-home|top-performing-flows|default", expectedPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" } });
    const state = getReportRunnerState(draft([approved("overview"), approved("top_flows"), approved("top_campaigns")]));
    expect(state.required.find(({ section }) => section === "top_flows")).toMatchObject({ state: "approved" });
  });
  it("queues all enabled automatic slots in canonical order even when approved and before unrelated manual blockers", () => {
    const report = {
      ...draft([approved("overview"), approved("top_campaigns")]),
      sections: {
        executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required",
        campaign_performance: "optional", campaign_metrics: "required", flow_performance: "optional", flow_metrics: "required",
        deliverability: "required", signup_form: "required", welcome_flow: "required",
      },
    } as ReportDraft;
    expect(getAutomaticCapturePlan(report).map(({ section }) => section)).toEqual([
      "executive_summary", "top_flows", "top_campaigns", "month_comparison",
      "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability",
    ]);
    expect(getAutomaticCapturePlan(report).slice(0, 3).map(({ state }) => state)).toEqual(["approved", "missing", "approved"]);
  });
});
