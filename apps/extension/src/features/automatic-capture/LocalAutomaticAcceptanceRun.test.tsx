import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createReportDraft } from "@tention/report-domain";
import type { ApiClient } from "@tention/api-client";
import type { AutoCaptureService, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import { getAutomaticCapturePlan } from "../report-runner/runner.js";
import { LocalAutomaticAcceptanceRun } from "./LocalAutomaticAcceptanceRun.js";
import { createScreenshotSourceProof } from "@tention/report-schema";

const report = createReportDraft({
  client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null },
  reportMonth: { year: 2026, month: 8 },
  sections: { executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", campaign_performance: "required", campaign_metrics: "required", flow_performance: "required", flow_metrics: "required", deliverability: "required", signup_form: "optional", welcome_flow: "optional", customer_split: "optional", analysis: "optional", next_month_plan: "optional" },
}, { now: new Date("2026-10-09T12:00:00.000Z"), id: "f577d631-a1f6-4cc0-9052-68e30460876d" });
function importedReport() {
  return { ...report, version: 2, screenshots: getAutomaticCapturePlan(report).map(({ screenshotType }, index) => ({
    id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, clientId: report.client.id, reportMonth: report.reportMonth,
    type: screenshotType!, capturedAt: "2026-10-10T06:46:04.645Z", sourceUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK",
    width: 100, height: 100, approved: false, approvedAt: null, periodConfirmed: true, captureOrigin: "live_acceptance_import" as const,
    storageKey: `reports/${report.id}/${screenshotType}.png`, mimeType: "image/png" as const, byteSize: 100, sha256: String(index + 1).repeat(64),
    sourceProof: createScreenshotSourceProof(screenshotType!, report.period),
  })) };
}

afterEach(() => { vi.restoreAllMocks(); });

function readyState(request: ExecutiveSummaryAutoCaptureRequest) {
  return {
    request, stage: "review_ready" as const, sourceTabId: 7, detectedPeriod: "Aug 1, 2026 - Aug 31, 2026",
    periodEvidence: { startDate: "2026-08-01", endDate: "2026-08-31", ...(request.screenshotType === "month_comparison" ? { comparisonStartDate: "2026-07-01", comparisonEndDate: "2026-07-31" } : {}) },
    target: { x: 0, y: 0, width: 5, height: 5, viewportWidth: 10, viewportHeight: 10, availableRowCount: request.screenshotType === "top_campaigns" ? 3 : request.screenshotType === "top_flows" ? 5 : undefined, visibleControls: [], stageTimingsMs: { navigationMs: 3, pageReadyMs: 4, periodSetMs: 5, cardResolveMs: 6, viewSwitchMs: 7, contentReadyMs: 8 } },
    captured: { sourceUrl: request.accountUrl, isKlaviyo: true, tabId: 7, dataUrl: "data:image/png;base64,AA==" },
    ...(request.screenshotType === "top_campaigns" ? { campaignsEvidence: {
      accountIdentity: request.clientName ?? "", clientTimezone: request.clientTimezone ?? "", visibleMetricLabel: "Placed Order", rankingMethod: "klaviyo-native-sort" as const, eligibleRowCount: 3, includedRowCount: 3,
      rows: [3, 2, 1].map((placedOrderValue) => ({ name: `Campaign ${placedOrderValue}`, type: "Email", status: "Sent" as const, sendDate: "2026-08-10", openRate: null, clickRate: null, placedOrderValue })),
    } } : {}),
  };
}

function mockCropEnvironment() {
  class FakeImage {
    naturalWidth = 10; naturalHeight = 10; onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
  }
  vi.stubGlobal("Image", FakeImage);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })));
}

describe("local one-click automatic acceptance run strict barriers", () => {
  it("retries the same transiently failing section up to five times, saves every attempt, and pauses without cascade failures", async () => {
    const api = {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiClient;
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "BUSINESS_REVIEW_CARD_NOT_FOUND" as const, message: "The reporting card was not found." })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Automatic capture paused" })).toBeInTheDocument(), { timeout: 10_000 }); // attempt 5 includes the bounded cool-down
    expect(service.start).toHaveBeenCalledTimes(5);
    expect(service.clear).toHaveBeenCalledTimes(6); // a clean start for each of the five attempts, then the consumed state is released
    expect(api.saveLocalAutomaticCaptureSection).toHaveBeenCalledTimes(10);
    const writes = vi.mocked(api.saveLocalAutomaticCaptureSection).mock.calls;
    expect(writes.map(([, section, result]) => [section, result.status, result.attemptNumber])).toEqual([
      ["overview", "running", 1], ["overview", "fail", 1],
      ["overview", "running", 2], ["overview", "fail", 2],
      ["overview", "running", 3], ["overview", "fail", 3],
      ["overview", "running", 4], ["overview", "fail", 4],
      ["overview", "running", 5], ["overview", "fail", 5],
    ]);
    expect(api.finishLocalAutomaticCaptureRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "failed" }));
    expect(screen.getByText(/Executive Summary needs attention/)).toBeInTheDocument();
    expect(screen.getAllByText("Not started")).toHaveLength(8);
    expect(screen.getAllByText(/FAIL after 5 attempt/)).toHaveLength(1);
    expect(report.screenshots).toHaveLength(0);
  }, 15_000);

  it("fails a schema-invalid source proof on its first attempt with the exact field instead of retrying", async () => {
    mockCropEnvironment();
    const api = {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn().mockResolvedValue({ sha256: "a".repeat(64), byteSize: 3 }), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
      importLocalAutomaticCaptureRun: vi.fn(),
    } as unknown as ApiClient;
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => {
        const state = readyState(request);
        return state.campaignsEvidence ? { ...state, campaignsEvidence: { ...state.campaignsEvidence, rows: state.campaignsEvidence.rows.map((row) => ({ ...row, type: "" })) } } : state;
      }),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Automatic capture paused" })).toBeInTheDocument(), { timeout: 10_000 }); // attempt 5 includes the bounded cool-down
    const campaignAttempts = vi.mocked(service.start).mock.calls.filter(([request]) => request.screenshotType === "top_campaigns");
    expect(campaignAttempts).toHaveLength(1);
    expect(screen.getByText(/campaigns\.rows\.0\.type: String must contain at least 1 character/)).toBeInTheDocument();
    expect(api.importLocalAutomaticCaptureRun).not.toHaveBeenCalled();
  });

  it("does not retry a permanent failure such as the wrong Klaviyo account", async () => {
    const api = {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiClient;
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "ACCOUNT_CONTEXT_MISMATCH" as const, message: "The authorized Klaviyo account is not this client." })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Automatic capture paused" })).toBeInTheDocument(), { timeout: 10_000 }); // attempt 5 includes the bounded cool-down
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/FAIL after 1 attempt/)).toBeInTheDocument();
  });

  it("names a rows failure as a content failure with its exact code, never as a view failure", async () => {
    const api = {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiClient;
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "BUSINESS_REVIEW_ROWS_NOT_FOUND" as const, message: "The campaign_metrics table's final row was not found." })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Automatic capture paused" })).toBeInTheDocument(), { timeout: 10_000 }); // attempt 5 includes the bounded cool-down
    expect(screen.getByText(/The required report content could not be verified\. \(BUSINESS_REVIEW_ROWS_NOT_FOUND · CARD_NOT_READY\)/)).toBeInTheDocument();
    expect(screen.queryByText(/reporting view could not be selected/)).not.toBeInTheDocument();
  }, 15_000);

  it("treats an undefined or null script result as transient and retries the section from a clean start until it passes", async () => {
    mockCropEnvironment();
    const api = {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn().mockResolvedValue({ sha256: "a".repeat(64), byteSize: 3 }), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
      importLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(importedReport()),
    } as unknown as ApiClient;
    const transient = ["SCRIPT_RESULT_UNDEFINED", "SCRIPT_RESULT_INVALID"];
    const calls: Record<string, number> = {};
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => {
        calls[request.screenshotType] = (calls[request.screenshotType] ?? 0) + 1;
        const failure = request.screenshotType === "month_comparison" ? transient[calls[request.screenshotType]! - 1] : undefined;
        return failure ? { request, stage: "failed" as const, code: failure as never, message: "The Business Review helper returned an invalid result." } : readyState(request);
      }),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(api.importLocalAutomaticCaptureRun).toHaveBeenCalled(), { timeout: 10_000 });
    expect(calls.month_comparison).toBe(3);
    // Every attempt clears the section's controller state and starts it again (each start re-enters its source fresh).
    // A clean start for each of the three attempts, then the consumed state is released.
    expect(vi.mocked(service.clear).mock.calls.filter(([request]) => request.screenshotType === "month_comparison")).toHaveLength(4);
    expect(api.finishLocalAutomaticCaptureRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "completed" }));
  }, 20_000);

  function recoveringApi() {
    return {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn().mockResolvedValue({ sha256: "a".repeat(64), byteSize: 3 }), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
      importLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(importedReport()),
    } as unknown as ApiClient;
  }

  it.each([
    ["top_campaigns", "CAPTURE_FAILED", "Session storage quota bytes exceeded. Values were not stored.", ["fresh-source", "release-capture-state"], "SESSION_STORAGE_QUOTA"],
    ["campaign_metrics", "TARGET_LAYOUT_NOT_STABLE", "The campaign_metrics card did not hold the same view, content, and layout.", ["fresh-source", "extended-readiness"], null],
    ["month_comparison", "SCRIPT_RESULT_INVALID", "The Business Review helper returned an invalid result.", ["fresh-source", "settle-before-inject"], "SCRIPT_RESULT_NULL"],
  ] as const)("recovers %s from %s with a specific recovery action, not an identical retry", async (section, code, message, actions, knownFailure) => {
    mockCropEnvironment();
    const api = recoveringApi();
    const starts: ExecutiveSummaryAutoCaptureRequest[] = [];
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request: ExecutiveSummaryAutoCaptureRequest) => {
        if (request.screenshotType === section) starts.push(request);
        return request.screenshotType === section && starts.length === 1 ? { request, stage: "failed" as const, code: code as never, message } : readyState(request);
      }),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined), clearAll: vi.fn().mockResolvedValue(undefined),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(api.importLocalAutomaticCaptureRun).toHaveBeenCalled(), { timeout: 10_000 });
    expect(starts).toHaveLength(2);
    expect(starts[0]!.recovery).toEqual({ level: 0, actions: ["fresh-source"], previousFailure: null });
    expect(starts[1]!.recovery).toEqual({ level: 1, actions, previousFailure: code });
    expect(starts[1]!.attemptId).not.toBe(starts[0]!.attemptId);
    if (actions.includes("release-capture-state" as never)) expect(vi.mocked(service.clearAll!).mock.calls.length).toBeGreaterThanOrEqual(2); // run start + the recovery
    const recorded = vi.mocked(api.saveLocalAutomaticCaptureSection).mock.calls.filter(([, type, result]) => type === section && result.status === "fail").map(([, , result]) => result.diagnostics as Record<string, unknown>);
    expect(recorded[0]).toMatchObject({ knownFailure, failureCategory: expect.any(String), stageTimeline: { attemptStartedAt: expect.any(String), failedAt: expect.any(String) } });
  }, 20_000);

  it("aborts a section whose capture never returns (Flow Metrics stuck at Capturing) and passes on a clean attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    try {
      mockCropEnvironment();
      const api = recoveringApi();
      const attempts: ExecutiveSummaryAutoCaptureRequest[] = [];
      const service: AutoCaptureService = {
        start: vi.fn().mockImplementation(async (request: ExecutiveSummaryAutoCaptureRequest) => {
          if (request.screenshotType === "flow_metrics") attempts.push(request);
          // Attempt 1 of Flow Metrics never leaves "capturing"; every other attempt is ready at once.
          return request.screenshotType === "flow_metrics" && attempts.length === 1 ? { request, stage: "capturing" as const } : readyState(request);
        }),
        get: vi.fn().mockImplementation(async (request: ExecutiveSummaryAutoCaptureRequest) => request.screenshotType === "flow_metrics" && request.attemptId === attempts[0]?.attemptId ? { request, stage: "capturing" as const } : null),
        clear: vi.fn().mockResolvedValue(undefined), clearAll: vi.fn().mockResolvedValue(undefined),
      };
      render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);
      for (let step = 0; step < 30 && !vi.mocked(api.importLocalAutomaticCaptureRun).mock.calls.length; step += 1) await vi.advanceTimersByTimeAsync(10_000);
      expect(api.importLocalAutomaticCaptureRun).toHaveBeenCalled();
      expect(attempts).toHaveLength(2);
      expect(attempts[1]!.recovery).toEqual({ level: 1, actions: ["fresh-source", "release-capture-state"], previousFailure: "CAPTURE_TIMEOUT" });
      const failure = vi.mocked(api.saveLocalAutomaticCaptureSection).mock.calls.find(([, type, result]) => type === "flow_metrics" && result.status === "fail")![2];
      expect(failure).toMatchObject({ errorCode: "CAPTURE_TIMEOUT", diagnostics: { knownFailure: "HIDDEN_TAB_ANIMATION_FRAME_HANG", stageTimeline: { controllerStartRequestedAt: expect.any(String), preparedAt: expect.any(String) } } });
      expect(failure.diagnostics!.stageTimeline).not.toHaveProperty("captureReturnedAt");
    } finally { vi.useRealTimers(); }
  }, 30_000);

  it("refuses to start when the service worker runs a different build than the panel", async () => {
    const api = { startLocalAutomaticCaptureRun: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn() } as unknown as ApiClient;
    const service: AutoCaptureService = { start: vi.fn(), get: vi.fn(), clear: vi.fn(), getExtensionBuild: vi.fn().mockResolvedValue("2000-01-01T00:00:00.000Z") };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/service worker is running build 2000-01-01T00:00:00.000Z.*Reload the extension/));
    expect(api.startLocalAutomaticCaptureRun).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
  });

  it("does not start section two until section one capture and backend PASS acknowledgement complete; all nine stay ordered", async () => {
    mockCropEnvironment();
    let releaseUpload!: (value: { sha256: string; byteSize: number }) => void;
    const uploadBarrier = new Promise<{ sha256: string; byteSize: number }>((resolve) => { releaseUpload = resolve; });
    let releasePassAck!: () => void;
    const passAckBarrier = new Promise<void>((resolve) => { releasePassAck = resolve; });
    let firstPassAck = true;
    const api = {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureSection: vi.fn().mockImplementation(async (_id: string, section: string, result: { status: string }) => {
        if (section === "overview" && result.status === "pass" && firstPassAck) { firstPassAck = false; await passAckBarrier; }
      }),
      saveLocalAutomaticCaptureEvidence: vi.fn().mockImplementationOnce(() => uploadBarrier).mockResolvedValue({ sha256: "a".repeat(64), byteSize: 3 }),
      finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), importLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(importedReport()),
    } as unknown as ApiClient;
    const order: string[] = [];
    const onClose = vi.fn();
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => { order.push(`start:${request.screenshotType}`); return readyState(request); }),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockImplementation(async (request) => { order.push(`clear:${request.screenshotType}`); }),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={onClose} />);
    await waitFor(() => expect(api.saveLocalAutomaticCaptureEvidence).toHaveBeenCalledTimes(1));
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["clear:overview", "start:overview"]);

    releaseUpload({ sha256: "a".repeat(64), byteSize: 3 });
    await waitFor(() => expect(api.saveLocalAutomaticCaptureSection).toHaveBeenCalledWith(expect.any(String), "overview", expect.objectContaining({ status: "pass" })));
    expect(service.start).toHaveBeenCalledTimes(1);
    releasePassAck();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Automatic capture finished" })).toBeInTheDocument());
    expect(service.start).toHaveBeenCalledTimes(9);
    expect(order.filter((entry) => entry.startsWith("start:")).map((entry) => entry.slice(6))).toEqual([
      "overview", "top_flows", "top_campaigns", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability",
    ]);
    const calls = vi.mocked(api.saveLocalAutomaticCaptureSection).mock.calls;
    for (let index = 0; index < 9; index += 1) {
      const section = order.filter((entry) => entry.startsWith("start:"))[index]!.slice(6);
      const passIndex = calls.findIndex(([, writtenSection, result]) => writtenSection === section && result.status === "pass");
      expect(passIndex).toBeGreaterThanOrEqual(0);
      if (index < 8) {
        const nextSection = order.filter((entry) => entry.startsWith("start:"))[index + 1]!.slice(6);
        const nextRunningIndex = calls.findIndex(([, writtenSection, result]) => writtenSection === nextSection && result.status === "running");
        expect(passIndex).toBeLessThan(nextRunningIndex);
      }
    }
    expect(api.finishLocalAutomaticCaptureRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "completed" }));
    expect(api.importLocalAutomaticCaptureRun).toHaveBeenCalledTimes(1);
    // Every saved attempt names the extension build that produced it (unbundled under the test runner).
    const saved = vi.mocked(api.saveLocalAutomaticCaptureSection).mock.calls.map(([, , result]) => (result as { diagnostics: Record<string, unknown> }).diagnostics.extensionBuild);
    expect(saved.length).toBeGreaterThan(0);
    expect(new Set(saved)).toEqual(new Set(["unbundled"]));
    expect(screen.getByText(/9 captured · 9 pending review · 0 approved · 0 missing/)).toBeInTheDocument();
    expect(screen.getByText("Fresh captures: 9 / 9 successful", { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to report" }));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ id: report.id, screenshots: expect.arrayContaining([expect.objectContaining({ type: "overview", captureOrigin: "live_acceptance_import", approved: false })]) }));
  });

  it("stops at backend upload failure and retries only that section", async () => {
    mockCropEnvironment();
    const api = {
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn().mockRejectedValue(new Error("offline")), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    } as unknown as ApiClient;
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => readyState(request)), get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    render(<LocalAutomaticAcceptanceRun api={api} report={report} targets={null} plan={getAutomaticCapturePlan(report)} service={service} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Automatic capture paused" })).toBeInTheDocument(), { timeout: 10_000 }); // attempt 5 includes the bounded cool-down
    expect(service.start).toHaveBeenCalledTimes(5);
    expect(api.saveLocalAutomaticCaptureEvidence).toHaveBeenCalledTimes(10); // capture upload plus viewport diagnostics for each rejected attempt
    expect(screen.getAllByText("Not started")).toHaveLength(8);
    expect(api.finishLocalAutomaticCaptureRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "failed" }));
  }, 15_000);
});
