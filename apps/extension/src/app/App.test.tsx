import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "@tention/api-client";
import type { ReportDraft } from "@tention/report-schema";
import type { CaptureService } from "../features/screenshot-capture/capture-service.js";
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
  it("opens a recent report and derives required, optional, and disabled checklist states", async () => {
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) }));
    await user.click(await screen.findByRole("button", { name: /Orion Supplements/ }));
    await screen.findByRole("heading", { name: "Orion Supplements" });
    expect(screen.getByText("Required · Missing")).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
    await user.click(screen.getByText("Disabled sections"));
    expect(screen.getByText("Deliverability")).toBeInTheDocument();
  });
  it("offers capture only for screenshot-backed sections and warns before a non-Klaviyo capture", async () => {
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://example.com/private", isKlaviyo: false }),
      captureVisibleTab: vi.fn(),
    };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) }), captureService);
    await user.click(await screen.findByRole("button", { name: /Orion Supplements/ }));
    expect(screen.getAllByRole("button", { name: "Capture" })).toHaveLength(2);
    const analysis = screen.getByText("Analysis").closest("li")!;
    expect(within(analysis).queryByRole("button", { name: "Capture" })).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Capture" })[0]!);
    await user.click(await screen.findByRole("button", { name: "Capture Current Tab" }));
    expect(await screen.findByText("This capture is intended for a Klaviyo page.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture anyway" })).toBeInTheDocument();
    expect(captureService.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("renders readable validation errors", async () => {
    const validation = { status: "invalid" as const, errors: [{ code: "REQUIRED_SCREENSHOT_MISSING", severity: "error" as const, message: "Top Campaigns screenshot is missing." }], warnings: [] };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), validateReportDraft: vi.fn().mockResolvedValue(validation) }));
    await user.click(await screen.findByRole("button", { name: /Orion Supplements/ }));
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
    await user.click(await screen.findByRole("button", { name: "Start Data Fetch" }));
    expect(await screen.findByText("This report was updated somewhere else.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload Latest Version" }));
    await waitFor(() => expect(api.getReportDraft).toHaveBeenCalledTimes(2));
    const metadata = screen.getByText("Version").parentElement!;
    expect(within(metadata).getByText("2")).toBeInTheDocument();
  });
});
