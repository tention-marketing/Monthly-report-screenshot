import { describe, expect, it } from "vitest";
import type { ReportDraft } from "@tention/report-schema";
import { getReportRunnerState } from "./runner.js";

const draft = (screenshots: ReportDraft["screenshots"] = []): ReportDraft => ({
  id: "11111111-1111-4111-8111-111111111111",
  client: { id: "smoke", name: "Smoke Client", timezone: "Asia/Kolkata", currency: null },
  reportMonth: { year: 2026, month: 8 },
  period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
  status: "draft", version: 1,
  sections: { executive_summary: "required", top_campaigns: "required", signup_form: "optional", analysis: "optional" },
  screenshots, validation: { status: "valid", errors: [], warnings: [] },
  createdAt: "2026-09-09T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z",
});

const approved = (type: "overview" | "top_campaigns"): ReportDraft["screenshots"][number] => ({
  id: type === "overview" ? "22222222-2222-4222-8222-222222222222" : "33333333-3333-4333-8333-333333333333",
  clientId: "smoke", reportMonth: { year: 2026, month: 8 }, type, capturedAt: "2026-09-09T12:00:00.000Z",
  sourceUrl: "https://www.klaviyo.com", width: 100, height: 100, approved: true, periodConfirmed: true,
  storageKey: "reports/test.png", mimeType: "image/png", byteSize: 10, sha256: "a".repeat(64), approvedAt: "2026-09-09T12:00:00.000Z",
});

describe("report runner", () => {
  it("chooses the first incomplete required screenshot-backed section", () => {
    const state = getReportRunnerState(draft());
    expect(state.next?.section).toBe("executive_summary");
    expect(state.completed).toBe(0);
  });
  it("advances from the server-returned uploaded report and does not let optional sections block progress", () => {
    const state = getReportRunnerState(draft([approved("overview")]));
    expect(state.next?.section).toBe("top_campaigns");
    expect(state.required.map(({ section }) => section)).toEqual(["executive_summary", "top_campaigns"]);
  });
  it("resumes the next incomplete required section after an extension reload", () => {
    const reloadedState = getReportRunnerState(draft([approved("overview")]));
    expect(reloadedState.next?.label).toBe("Top Campaigns");
  });
  it("reports completion only after every required screenshot is approved", () => {
    const state = getReportRunnerState(draft([approved("overview"), approved("top_campaigns")]));
    expect(state).toMatchObject({ completed: 2, isComplete: true, next: null });
  });
});
