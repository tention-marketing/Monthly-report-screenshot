import { describe, expect, it, vi } from "vitest";
import { createReportDraft } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import { DEFAULT_DRAFT_SECTION_CONFIGURATION } from "../create-report/defaults.js";
import { approveAllAndFinalize, approveAllBlockers, FinalizeError } from "./approve-and-finalize.js";

const TYPES: ScreenshotType[] = ["overview", "top_flows", "top_campaigns", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability", "email_subscriber_growth"];

function capturedReport(approved: ScreenshotType[] = []): ReportDraft {
  const base = createReportDraft({ client: { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency: "USD" }, reportMonth: { year: 2026, month: 9 }, sections: DEFAULT_DRAFT_SECTION_CONFIGURATION }, { now: new Date("2026-11-04T12:00:00.000Z"), id: "e1376a59-9eb5-40a4-9fc1-2da03facb005" });
  return { ...base, version: 10, screenshots: TYPES.map((type, index) => ({
    id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, clientId: base.client.id, reportMonth: base.reportMonth, type, capturedAt: "2026-11-03T04:30:00.000Z",
    sourceUrl: "https://www.klaviyo.com/analytics/dashboards/x", width: 100, height: 100, approved: approved.includes(type), approvedAt: approved.includes(type) ? "2026-11-04T10:00:00.000Z" : null,
    periodConfirmed: true, captureOrigin: "live_acceptance_import" as const, storageKey: `reports/${base.id}/${type}.png`, mimeType: "image/png" as const, byteSize: 100,
    sha256: (index + 1).toString(16).repeat(64), sourceProof: createScreenshotSourceProof(type, base.period),
  })) };
}

/** A backend double that approves one capture per call and bumps the version, as the real route does. */
function backend(options: { failApprovalOf?: ScreenshotType; failGenerate?: boolean } = {}) {
  const calls: string[] = [];
  const api = {
    approveImportedScreenshot: vi.fn(async (_id: string, type: ScreenshotType, input: { expectedVersion: number; expectedSha256: string }) => {
      calls.push(`approve:${type}@${input.expectedVersion}`);
      if (type === options.failApprovalOf) throw Object.assign(new Error("The imported screenshot changed while it was being reviewed."), { code: "SCREENSHOT_SHA256_MISMATCH" });
      current = { ...current, version: current.version + 1, screenshots: current.screenshots.map((shot) => shot.type === type ? { ...shot, approved: true, approvedAt: "2026-11-04T12:00:00.000Z" } : shot) };
      return current;
    }),
    applyEvent: vi.fn(async (_id: string, event: string, version: number) => { calls.push(`event:${event}@${version}`); current = { ...current, status: "ready_for_review" as const, version: current.version + 1 }; return current; }),
    generatePdf: vi.fn(async (_id: string, version: number) => {
      calls.push(`generate@${version}`);
      if (options.failGenerate) throw Object.assign(new Error("PDF rendering failed."), { code: "PDF_RENDER_FAILED" });
      current = { ...current, status: "generated" as const, version: current.version + 2 };
      return { report: current, artifact: { id: "artifact" } as never };
    }),
  };
  let current = capturedReport();
  return { api, calls, set: (report: ReportDraft) => { current = report; }, get: () => current };
}

describe("approve all 10 captures, then finalize without another click", () => {
  it("approves every pending capture in order on the returned version, submits for review, then generates once", async () => {
    const live = backend(); const report = capturedReport(); live.set(report);
    const stages: string[] = [];
    const result = await approveAllAndFinalize(live.api as never, report, TYPES, ({ stage, approved }) => stages.push(`${stage}:${approved}`));
    expect(live.calls).toEqual([...TYPES.map((type, index) => `approve:${type}@${10 + index}`), "event:SUBMIT_FOR_REVIEW@20", "generate@21"]);
    expect(result.report.status).toBe("generated");
    expect(stages.at(-2)).toBe("submitting:10"); expect(stages.at(-1)).toBe("generating:10");
  });

  it("skips captures already approved (retry after a partial approval) and approves only the rest", async () => {
    const live = backend(); const report = capturedReport(["overview", "top_flows"]); live.set(report);
    await approveAllAndFinalize(live.api as never, report, TYPES);
    expect(live.api.approveImportedScreenshot).toHaveBeenCalledTimes(8);
    expect(live.calls).not.toContain("approve:overview@10");
  });

  it("stops at the first failed approval: no submit, no generation, and the latest report is returned", async () => {
    const live = backend({ failApprovalOf: "campaign_performance" }); const report = capturedReport(); live.set(report);
    const failure = await approveAllAndFinalize(live.api as never, report, TYPES).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FinalizeError);
    expect(failure).toMatchObject({ stage: "approving", message: expect.stringContaining("SCREENSHOT_SHA256_MISMATCH") });
    expect((failure as FinalizeError).report.version).toBe(14);
    expect(live.api.applyEvent).not.toHaveBeenCalled(); expect(live.api.generatePdf).not.toHaveBeenCalled();
  });

  it("does not submit again when the report is already ready for review; a failed generation keeps every approval", async () => {
    const live = backend({ failGenerate: true }); const report = { ...capturedReport(TYPES), status: "ready_for_review" as const }; live.set(report);
    const failure = await approveAllAndFinalize(live.api as never, report, TYPES).catch((error: unknown) => error);
    expect(failure).toMatchObject({ stage: "generating" });
    expect(live.api.approveImportedScreenshot).not.toHaveBeenCalled(); expect(live.api.applyEvent).not.toHaveBeenCalled();
    expect((failure as FinalizeError).report.screenshots.every((shot) => shot.approved)).toBe(true);
  });

  it("refuses to run with a missing capture", async () => {
    const live = backend(); const report = { ...capturedReport(), screenshots: capturedReport().screenshots.filter((shot) => shot.type !== "deliverability") }; live.set(report);
    await expect(approveAllAndFinalize(live.api as never, report, TYPES)).rejects.toMatchObject({ stage: "approving" });
    expect(live.api.generatePdf).not.toHaveBeenCalled();
  });
});

describe("Approve All gate", () => {
  it("is open for 10/10 verified captures with no data blockers", () => {
    expect(approveAllBlockers(capturedReport(), TYPES, 10, [])).toEqual([]);
  });
  it.each([
    ["a missing section", (report: ReportDraft) => ({ ...report, screenshots: report.screenshots.slice(1) }), [], /Missing captures: overview/],
    ["a capture without its hash", (report: ReportDraft) => ({ ...report, screenshots: report.screenshots.map((shot, index) => index === 0 ? { ...shot, sha256: null } : shot) }), [], /overview has no verified saved capture/],
    ["a capture from another month", (report: ReportDraft) => ({ ...report, screenshots: report.screenshots.map((shot, index) => index === 0 ? { ...shot, reportMonth: { year: 2026, month: 8 } } : shot) }), [], /another client or month/],
    ["open data blockers", (report: ReportDraft) => report, ["CONVERSION_METRIC_ID_NOT_CONFIGURED"], /CONVERSION_METRIC_ID_NOT_CONFIGURED/],
  ] as const)("is closed for %s", (_label, change, codes, reason) => {
    expect(approveAllBlockers(change(capturedReport()), TYPES, 10, codes).join(" ")).toMatch(reason);
  });
});
