import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "@tention/api-client";
import type { ReportDraft, ScreenshotType } from "@tention/report-schema";
import type { CaptureService } from "../features/screenshot-capture/capture-service.js";
import { DEFAULT_DRAFT_SECTION_CONFIGURATION } from "../features/create-report/defaults.js";
import { App } from "./App.js";

const NOW = new Date("2026-09-09T12:00:00Z");
const report: ReportDraft = {
  id: "11111111-1111-4111-8111-111111111111",
  client: { id: "orion", name: "Orion Supplements", timezone: "America/New_York", currency: null },
  reportMonth: { year: 2026, month: 8 },
  period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
  status: "draft", version: 1, sections: { top_campaigns: "required", signup_form: "optional", deliverability: "disabled", analysis: "optional" },
  screenshots: [], validation: { status: "valid", errors: [], warnings: [] },
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
};

const runnerScreenshotTypes = [
  "overview", "top_campaigns", "top_flows", "month_comparison",
  "deliverability", "campaign_metrics", "flow_metrics", "list_growth",
] as const satisfies readonly ScreenshotType[];

function runnerReport(approvedTypes: readonly ScreenshotType[] = []): ReportDraft {
  return {
    ...report,
    client: { id: "autoled", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null },
    reportMonth: { year: 2026, month: 7 },
    period: { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" },
    sections: { ...DEFAULT_DRAFT_SECTION_CONFIGURATION },
    screenshots: approvedTypes.map((type, index) => ({
      id: `screenshot-${index}`, clientId: "autoled", reportMonth: { year: 2026, month: 7 }, type,
      capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com", width: 100, height: 100,
      approved: true, periodConfirmed: true, storageKey: `reports/${type}.png`, mimeType: "image/png",
      byteSize: 100, sha256: "a".repeat(64), approvedAt: NOW.toISOString(),
    })),
  };
}

function mockApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  return {
    health: vi.fn().mockResolvedValue({ ok: true }),
    createReportDraft: vi.fn().mockResolvedValue(report),
    getReportDraft: vi.fn().mockResolvedValue(report),
    listReportDrafts: vi.fn().mockResolvedValue([]),
    validateReportDraft: vi.fn().mockResolvedValue(report.validation),
    getReportHistory: vi.fn().mockResolvedValue([]),
    uploadScreenshotImage: vi.fn().mockResolvedValue(report),
    getScreenshotImage: vi.fn().mockResolvedValue(new Blob()),
    applyEvent: vi.fn().mockResolvedValue({ ...report, status: "data_fetching", version: 2 }),
    ...overrides,
  } as ApiClient;
}
const renderApp = (api: ApiClient, captureService?: CaptureService) => render(<App api={api} {...(captureService ? { captureService } : {})} now={() => new Date(NOW)} />);

describe("extension report workflow", () => {
  it("shows API unavailable state and retry", async () => {
    renderApp(mockApi({ health: vi.fn().mockRejectedValue(new ApiError("NETWORK_ERROR", "offline", null)) }));
    expect(await screen.findByText("API unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  });
  it("renders completed month and derived immutable periods", async () => {
    const user = userEvent.setup(); renderApp(mockApi());
    await screen.findByText("Connected");
    await user.type(screen.getByLabelText("Timezone"), "America/New_York");
    expect(await screen.findByRole("option", { name: "August 2026" })).toBeInTheDocument();
    expect(screen.getByText("Aug 1, 2026 – Aug 31, 2026")).toBeInTheDocument();
    expect(screen.getByText("Jul 1, 2026 – Jul 31, 2026")).toBeInTheDocument();
  });
  it("creates a report without sending period boundaries", async () => {
    const api = mockApi(); const user = userEvent.setup(); renderApp(api);
    await screen.findByText("Connected");
    await user.type(screen.getByLabelText("Client Name"), "Orion Supplements");
    await user.type(screen.getByLabelText("Client ID"), "orion");
    await user.type(screen.getByLabelText("Timezone"), "America/New_York");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.createReportDraft).toHaveBeenCalled());
    const payload = vi.mocked(api.createReportDraft).mock.calls[0]?.[0];
    expect(payload).toMatchObject({ client: { id: "orion" }, reportMonth: { year: 2026, month: 8 } });
    expect(payload).not.toHaveProperty("period");
  });
  it("shows duplicate guidance and loads the existing report", async () => {
    const api = mockApi({
      createReportDraft: vi.fn().mockRejectedValue(new ApiError("REPORT_DRAFT_ALREADY_EXISTS", "duplicate", 409)),
      listReportDrafts: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([report]),
    });
    const user = userEvent.setup(); renderApp(api); await screen.findByText("Connected");
    await user.type(screen.getByLabelText("Client Name"), "Orion Supplements");
    await user.type(screen.getByLabelText("Client ID"), "orion");
    await user.type(screen.getByLabelText("Timezone"), "America/New_York");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("A monthly report already exists for this client and month.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load existing report" }));
    expect(await screen.findByRole("heading", { name: "Orion Supplements" })).toBeInTheDocument();
  });
  it("shows compact required progress and keeps optional and disabled sections out of the runner", async () => {
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) }));
    await user.click(await screen.findByRole("button", { name: /Orion Supplements/ }));
    await screen.findByRole("heading", { name: "Orion Supplements" });
    expect(screen.getByText("0 / 1 required screenshots completed")).toBeInTheDocument();
    expect(screen.getByText("Next required capture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Report" })).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(screen.queryByText("Deliverability")).toBeNull();
  });
  it("starts the runner and gives a non-Klaviyo capture a manual fallback", async () => {
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://example.com/private", isKlaviyo: false }),
      captureVisibleTab: vi.fn(),
    };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) }), captureService);
    await user.click(await screen.findByRole("button", { name: /Orion Supplements/ }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByText("Step 1 of 1")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Capture Current Tab" }));
    expect(await screen.findByText("This capture is intended for a Klaviyo page.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture anyway" })).toBeInTheDocument();
    expect(captureService.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("opens the first required July capture from Start Report without selecting a checklist row", async () => {
    const fullRunnerReport = runnerReport();
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([fullRunnerReport]), getReportDraft: vi.fn().mockResolvedValue(fullRunnerReport) }));
    await user.click(await screen.findByRole("button", { name: /AutoLEDTech\.com/ }));
    expect(screen.getByText("0 / 8 required screenshots completed")).toBeInTheDocument();
    expect(screen.getByText("Next required capture")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByText("Step 1 of 8")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Executive Summary" })).toBeInTheDocument();
    expect(screen.getByText("Expected report period: Jul 1, 2026 – Jul 31, 2026")).toBeInTheDocument();
  });
  it("resumes Start Report at the next incomplete required section", async () => {
    const fullRunnerReport = runnerReport(["overview"]);
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([fullRunnerReport]), getReportDraft: vi.fn().mockResolvedValue(fullRunnerReport) }));
    await user.click(await screen.findByRole("button", { name: /AutoLEDTech\.com/ }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByText("Step 2 of 8")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top Campaigns" })).toBeInTheDocument();
  });
  it("shows review instead of restarting Start Report when all required captures are approved", async () => {
    const fullRunnerReport = runnerReport(runnerScreenshotTypes);
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([fullRunnerReport]), getReportDraft: vi.fn().mockResolvedValue(fullRunnerReport) }));
    await user.click(await screen.findByRole("button", { name: /AutoLEDTech\.com/ }));
    expect(screen.getByText("8 / 8 required screenshots completed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Report" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review Report" })).toBeInTheDocument();
  });
  it("keeps raw validation details out of the normal view and exposes them in Advanced / Debug", async () => {
    const validation = { status: "invalid" as const, errors: [{ code: "REQUIRED_SCREENSHOT_MISSING", severity: "error" as const, message: "Top Campaigns screenshot is missing." }], warnings: [] };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), validateReportDraft: vi.fn().mockResolvedValue(validation) }));
    await user.click(await screen.findByRole("button", { name: /Orion Supplements/ }));
    expect(screen.queryByText("REQUIRED_SCREENSHOT_MISSING")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show Advanced / Debug" }));
    await user.click(await screen.findByRole("button", { name: "Validate Report" }));
    expect(await screen.findByText("Top Campaigns screenshot is missing.")).toBeInTheDocument();
    expect(screen.getByText("REQUIRED_SCREENSHOT_MISSING")).toBeInTheDocument();
  });
  it("shows a version conflict and reloads the server version", async () => {
    const latest = { ...report, version: 2, updatedAt: "2026-09-09T13:00:00.000Z" };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([report]),
      getReportDraft: vi.fn().mockResolvedValueOnce(report).mockResolvedValueOnce(latest),
      applyEvent: vi.fn().mockRejectedValue(new ApiError("REPORT_VERSION_CONFLICT", "conflict", 409)),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: /Orion Supplements/ }));
    await user.click(screen.getByRole("button", { name: "Show Advanced / Debug" }));
    await user.click(await screen.findByRole("button", { name: "Start Data Fetch" }));
    expect(await screen.findByText("This report was updated somewhere else.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload Latest Version" }));
    await waitFor(() => expect(api.getReportDraft).toHaveBeenCalledTimes(2));
    const metadata = screen.getByText("Version").parentElement!;
    expect(within(metadata).getByText("2")).toBeInTheDocument();
  });
});

describe("capture workflow cross-section safety", () => {
  beforeEach(() => {
    class TestUrl extends URL {
      static override createObjectURL = vi.fn(() => "blob:test-crop");
      static override revokeObjectURL = vi.fn();
    }
    class LoadedImage {
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.(new Event("load"))); }
    }
    vi.stubGlobal("URL", TestUrl);
    vi.stubGlobal("Image", LoadedImage);
    const bounds = { x: 0, y: 0, width: 100, height: 100, top: 0, right: 100, bottom: 100, left: 0, toJSON: () => ({}) } as DOMRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(bounds);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback?.(new Blob(["crop"], { type: "image/png" })));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  async function cropAndConfirm(user: ReturnType<typeof userEvent.setup>, confirm = true) {
    const image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, {
      naturalWidth: { configurable: true, value: 100 },
      naturalHeight: { configurable: true, value: 100 },
    });
    fireEvent.load(image);
    const cropSurface = image.parentElement!;
    Object.assign(cropSurface, {
      setPointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => true), releasePointerCapture: vi.fn(),
    });
    const pointer = (type: string, clientX: number, clientY: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, { pointerId: { value: 1 }, clientX: { value: clientX }, clientY: { value: clientY } });
      fireEvent(cropSurface, event);
    };
    pointer("pointerdown", 10, 10); pointer("pointermove", 90, 90); pointer("pointerup", 90, 90);
    const continueButton = screen.getByRole("button", { name: "Continue to Review" });
    expect(continueButton).toBeEnabled();
    await user.click(continueButton);
    const confirmation = await screen.findByRole("checkbox", { name: "I confirm this screenshot shows the selected report period." });
    expect(confirmation).not.toBeChecked();
    if (confirm) await user.click(confirmation);
    return confirmation;
  }

  it("starts each runner section with a fresh capture and uploads the image for its current screenshot type", async () => {
    const initial = runnerReport();
    const afterOverview = runnerReport(["overview"]);
    const afterCampaigns = runnerReport(["overview", "top_campaigns"]);
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]),
      getReportDraft: vi.fn().mockResolvedValue(initial),
      uploadScreenshotImage: vi.fn().mockImplementation((_reportId: string, type: ScreenshotType) => Promise.resolve(type === "overview" ? afterOverview : afterCampaigns)),
    });
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/account", isKlaviyo: true }),
      captureVisibleTab: vi.fn()
        .mockResolvedValueOnce({ sourceUrl: "https://www.klaviyo.com/overview", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" })
        .mockResolvedValueOnce({ sourceUrl: "https://www.klaviyo.com/campaigns", isKlaviyo: true, dataUrl: "data:image/png;base64,BBBB" }),
    };
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: /AutoLEDTech\.com/ }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(screen.getByRole("button", { name: "Capture Current Tab" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Capture Current Tab" }));
    await cropAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    expect(await screen.findByRole("heading", { name: "Top Campaigns" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture Current Tab" })).toBeEnabled();
    expect(screen.queryByAltText("Cropped Executive Summary screenshot")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "I confirm this screenshot shows the selected report period." })).toBeNull();
    expect(vi.mocked(api.uploadScreenshotImage)).toHaveBeenLastCalledWith(initial.id, "overview", expect.objectContaining({ sourceUrl: "https://www.klaviyo.com/overview", periodConfirmed: true }));
    await user.click(screen.getByRole("button", { name: "Capture Current Tab" }));
    await cropAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    expect(vi.mocked(api.uploadScreenshotImage)).toHaveBeenLastCalledWith(initial.id, "top_campaigns", expect.objectContaining({ sourceUrl: "https://www.klaviyo.com/campaigns", periodConfirmed: true }));
  });
  it("keeps every capture action visibly named, including disabled approval", async () => {
    const optionalReport: ReportDraft = { ...runnerReport(), sections: { signup_form: "optional" } };
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/signup", isKlaviyo: true }),
      captureVisibleTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/signup", isKlaviyo: true, dataUrl: "data:image/png;base64,CCCC" }),
    };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([optionalReport]), getReportDraft: vi.fn().mockResolvedValue(optionalReport) }), captureService);
    await user.click(await screen.findByRole("button", { name: /AutoLEDTech\.com/ }));
    await user.click(screen.getByText("Optional Sections · 1 available"));
    await user.click(screen.getByRole("button", { name: "Capture" }));
    expect(screen.getByRole("button", { name: "Capture Current Tab" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Capture Current Tab" }));
    await cropAndConfirm(user, false);
    expect(screen.getByRole("button", { name: "Approve & Upload" })).toBeDisabled();
  });
});
