import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "@tention/api-client";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import type { CaptureService } from "../features/screenshot-capture/capture-service.js";
import type { KlaviyoNavigationService } from "../features/klaviyo-navigation/navigation-service.js";
import type { AutoCaptureService, AutoCaptureState } from "../features/automatic-capture/auto-capture-service.js";
import type { BusinessReviewDiscoveryResult } from "../features/klaviyo-navigation/business-review-discovery.js";
import { DEFAULT_DRAFT_SECTION_CONFIGURATION } from "../features/create-report/defaults.js";
import { App } from "./App.js";

afterEach(() => { window.sessionStorage.clear(); });

const NOW = new Date("2026-09-09T12:00:00Z");
const NativeURL = URL;
function mockObjectUrls() {
  class URLWithObjectUrls extends NativeURL {
    static override createObjectURL(_object: Blob): string { return "blob:imported-review"; }
    static override revokeObjectURL(_url: string): void { /* test stub */ }
  }
  vi.stubGlobal("URL", URLWithObjectUrls);
}
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
  "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability",
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
      approved: true, approvedAt: NOW.toISOString(), captureOrigin: "extension_manual", periodConfirmed: true, storageKey: `reports/${type}.png`, mimeType: "image/png",
      byteSize: 100, sha256: `${(index + 10).toString(16)}`.repeat(64).slice(0, 64),
      sourceProof: createScreenshotSourceProof(type, report.period),
    })),
  };
}
function staleTopCampaignReport(): ReportDraft {
  const stale = runnerReport(["top_campaigns"]);
  const screenshot = stale.screenshots[0]!;
  screenshot.sourceProof = { ...screenshot.sourceProof!, sourceFamily: "business-review", semanticCard: "campaign-performance", semanticTab: "top-performing", sourceIdentity: "business-review|campaign-performance|top-performing" };
  return stale;
}
function businessReviewAutoReport(approvedTypes: readonly ScreenshotType[] = []): ReportDraft {
  return { ...runnerReport(approvedTypes), sections: { campaign_metrics: "required" } };
}

function mockApi(overrides: Partial<Record<keyof ApiClient, unknown>> = {}): ApiClient {
  const api = baseMockApi(overrides);
  // Fixtures stand for already-onboarded clients: unless a test sets `profile`, the
  // canonical client profile matches the test's own report. Reading the report mocks
  // through their implementations leaves call counts untouched.
  const targetsFor = api.getClientReportTargets;
  const reports = async (): Promise<ReportDraft[]> => {
    const list = await (vi.mocked(api.listReportDrafts).getMockImplementation()?.() ?? []);
    const single = await vi.mocked(api.getReportDraft).getMockImplementation()?.("");
    return [...list, ...(single ? [single] : [])];
  };
  api.getClientReportTargets = vi.fn(async (clientId: string) => {
    const targets = await targetsFor(clientId);
    if (!targets || targets.profile !== undefined) return targets;
    const draft = (await reports()).find((item) => item.client.id === clientId);
    return { ...targets, profile: draft ? { name: draft.client.name, timezone: draft.client.timezone, currency: draft.client.currency, conversionMetric: { label: "Placed Order", providerMetricId: null }, sections: null } : null };
  }) as ApiClient["getClientReportTargets"];
  return api;
}
function baseMockApi(overrides: Partial<Record<keyof ApiClient, unknown>>): ApiClient {
  return {
    listClientConfigurations: vi.fn().mockResolvedValue([]),
    health: vi.fn().mockResolvedValue({ ok: true }),
    createReportDraft: vi.fn().mockResolvedValue(report),
    getReportDraft: vi.fn().mockResolvedValue(report),
    deleteReportDraft: vi.fn().mockResolvedValue(undefined),
    listReportDrafts: vi.fn().mockResolvedValue([]),
    validateReportDraft: vi.fn().mockResolvedValue(report.validation),
    getReportHistory: vi.fn().mockResolvedValue([]),
    generateDevelopmentReviewPdf: vi.fn().mockResolvedValue({ reportId: "f577d631-a1f6-4cc0-9052-68e30460876d", reportVersion: 2, fileName: "AutoLEDTech-2026-08-Performance-Review.pdf", byteSize: 1000, sha256: "a".repeat(64), physicalPageCount: 7, developmentOnly: true }),
    getDevelopmentReviewPdfStatus: vi.fn().mockRejectedValue(new ApiError("PDF_REVIEW_NOT_GENERATED", "No development review PDF exists.", 404)),
    developmentReviewPdfUrl: vi.fn((id: string, download = false) => `http://127.0.0.1:4000/api/v1/dev/report-drafts/${id}/partial-review/pdf${download ? "?download=1" : ""}`),
    uploadScreenshotImage: vi.fn().mockResolvedValue(report),
    getScreenshotImage: vi.fn().mockResolvedValue(new Blob()),
    applyEvent: vi.fn().mockResolvedValue({ ...report, status: "data_fetching", version: 2 }),
    getClientReportTargets: vi.fn().mockImplementation(async (clientId: string) => ({
      clientId, businessReview: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null,
      customerSegment: null, nonCustomerSegment: null, signupForms: null, welcomeFlowListing: null, createdAt: null, updatedAt: null,
    })),
    saveClientReportTargets: vi.fn().mockImplementation(async (clientId: string, input: Record<string, unknown>) => ({
      ...input, clientId, businessReview: input.businessReview ?? null,
      primaryEmailList: input.primaryEmailList ?? null, primarySmsList: input.primarySmsList ?? null,
      welcomeFlow: input.welcomeFlow ?? null, customerSegment: input.customerSegment ?? null,
      nonCustomerSegment: input.nonCustomerSegment ?? null, signupForms: input.signupForms ?? null,
      welcomeFlowListing: input.welcomeFlowListing ?? null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    })),
    getReportReadiness: vi.fn().mockResolvedValue({ ready: true, sections: [] }),
    ...overrides,
  } as ApiClient;
}
const testDiscovery = async (input: { clientName: string }): Promise<BusinessReviewDiscoveryResult> => ({ ok: true, dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/verified-test-source", accountLabel: input.clientName, accountMatchesClient: true, evidence: { businessReviewHeading: true, growthOverview: true, campaignPerformance: true, flowPerformance: true } });
const renderApp = (api: ApiClient, captureService?: CaptureService, navigationService?: KlaviyoNavigationService, automaticCaptureService?: AutoCaptureService, discoverBusinessReviewSource = testDiscovery) => render(<App api={api} {...(captureService ? { captureService } : {})} {...(navigationService ? { navigationService } : {})} {...(automaticCaptureService ? { automaticCaptureService } : {})} discoverBusinessReviewSource={discoverBusinessReviewSource} now={() => new Date(NOW)} />);

function automaticRequest(initial: ReportDraft) {
  return { reportId: initial.id, screenshotType: "campaign_metrics" as const, accountUrl: null, period: initial.period };
}
function automaticService(state: AutoCaptureState, restored: AutoCaptureState | null = null): AutoCaptureService {
  return { start: vi.fn().mockResolvedValue(state), get: vi.fn().mockResolvedValue(restored), clear: vi.fn().mockResolvedValue(undefined) };
}

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
    await user.type(screen.getByLabelText("Timezone"), "America/New_York");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.createReportDraft).toHaveBeenCalled());
    const payload = vi.mocked(api.createReportDraft).mock.calls[0]?.[0];
    expect(payload).toMatchObject({ client: { id: "orion-supplements" }, reportMonth: { year: 2026, month: 8 } });
    expect(payload).not.toHaveProperty("period");
  });
  it("shows duplicate guidance and loads the existing report", async () => {
    const api = mockApi({
      createReportDraft: vi.fn().mockRejectedValue(new ApiError("REPORT_DRAFT_ALREADY_EXISTS", "duplicate", 409)),
      listReportDrafts: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([report]),
    });
    const user = userEvent.setup(); renderApp(api); await screen.findByText("Connected");
    await user.type(screen.getByLabelText("Client Name"), "Orion Supplements");
    await user.type(screen.getByLabelText("Timezone"), "America/New_York");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("A monthly report already exists for this client and month.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load existing report" }));
    expect(await screen.findByRole("heading", { name: "Orion Supplements" })).toBeInTheDocument();
  });
  it("shows compact required progress and keeps optional and disabled sections out of the runner", async () => {
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) }));
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await screen.findByRole("heading", { name: "Orion Supplements" });
    expect(screen.getByText("Final report readiness: 0 / 2 required screenshots approved")).toBeInTheDocument();
    expect(screen.getByText("Next required capture")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Report" })).toBeInTheDocument();
    expect(screen.getByText("Optional")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Automatic Capture Progress" })).getByText("Deliverability Score")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Automatic Capture Progress" })).getAllByText("Missing")).toHaveLength(2);
  });
  it("separates nine captured pending automatic sections from final approval readiness", async () => {
    const types: ScreenshotType[] = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"];
    const canonical: ReportDraft = {
      ...runnerReport(), id: "f577d631-a1f6-4cc0-9052-68e30460876d", client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 },
      period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
      screenshots: types.map((type, index) => ({ id: `e0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, clientId: "autoledtech", reportMonth: { year: 2026, month: 8 }, type, capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/analytics/dashboards/example", width: 100, height: 100, approved: false, approvedAt: null, captureOrigin: "live_acceptance_import", periodConfirmed: true, storageKey: `reports/f577d631/${type}.png`, mimeType: "image/png", byteSize: 100, sha256: `${index + 1}`.repeat(64), sourceProof: createScreenshotSourceProof(type, { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" }) })),
    };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical) });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByRole("heading", { name: "AutoLEDTech.com" })).toBeInTheDocument();
    expect(screen.getByText("Captured: 9 / 9 · Pending review: 9 · Approved: 0 · Missing/stale: 0")).toBeInTheDocument();
    expect(screen.getAllByText("Captured · Pending review")).toHaveLength(9);
    expect(screen.getByText("Final report readiness: 0 / 9 required screenshots approved")).toBeInTheDocument();
    expect(screen.getByText(/final-only sections below are separate from the nine automatic captures/)).toBeInTheDocument();
    const finalOnly = within(screen.getByRole("region", { name: "Final Report Readiness" }));
    expect(finalOnly.getByText("Signup Form Performance")).toBeInTheDocument();
    expect(finalOnly.getByText("Welcome Flow Performance")).toBeInTheDocument();
    expect(finalOnly.getByText("Customer Split")).toBeInTheDocument();
    expect(finalOnly.queryByText("List Growth")).toBeNull();
  });
  it("opens the canonical AutoLEDTech August draft using the exact report ID returned by the API", async () => {
    const canonical = { ...runnerReport(), id: "f577d631-a1f6-4cc0-9052-68e30460876d", client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical) });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(api.getReportDraft).toHaveBeenCalledWith("f577d631-a1f6-4cc0-9052-68e30460876d");
    expect(await screen.findByRole("heading", { name: "AutoLEDTech.com" })).toBeInTheDocument();
    expect(screen.getByText("August 2026")).toBeInTheDocument();
  });
  it("rebuilds completed checklist state from the persisted report after the extension view reloads", async () => {
    const persisted = { ...runnerReport(["overview"]), id: "f577d631-a1f6-4cc0-9052-68e30460876d", client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([persisted]), getReportDraft: vi.fn().mockResolvedValue(persisted) });
    const user = userEvent.setup(); const firstMount = renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText("Final report readiness: 1 / 9 required screenshots approved")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Automatic Capture Progress" })).getByText("Approved")).toBeInTheDocument();
    firstMount.unmount();

    renderApp(api);
    expect(await screen.findByText("Final report readiness: 1 / 9 required screenshots approved")).toBeInTheDocument();
    expect(api.getReportDraft).toHaveBeenLastCalledWith(persisted.id);
  });
  it("rehydrates the pending Top Campaigns step after a side-panel reload without recreating the report", async () => {
    const base = runnerReport(["overview", "top_flows"]);
    const oldCampaign = staleTopCampaignReport().screenshots[0]!;
    const persisted = { ...base, id: "f577d631-a1f6-4cc0-9052-68e30460876d", client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, screenshots: [...base.screenshots, { ...oldCampaign, clientId: "autoledtech", reportMonth: { year: 2026, month: 7 }, sourceProof: { ...createScreenshotSourceProof("top_campaigns", base.period), sourceFamily: "business-review", semanticCard: "campaign-performance", semanticTab: "top-performing", sourceIdentity: "business-review|campaign-performance|top-performing" } }] };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([persisted]), getReportDraft: vi.fn().mockResolvedValue(persisted) });
    const user = userEvent.setup(); const firstMount = renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByRole("heading", { name: "Top 5 Campaigns" })).toBeInTheDocument();
    firstMount.unmount();

    renderApp(api);
    expect(await screen.findByRole("heading", { name: "Top 5 Campaigns" })).toBeInTheDocument();
    expect(api.getReportDraft).toHaveBeenLastCalledWith(persisted.id);
  });
  it("offers enabled stale Top Campaigns Recapture and surfaces the typed adapter failure", async () => {
    const stale = staleTopCampaignReport();
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([stale]), getReportDraft: vi.fn().mockResolvedValue(stale) });
    const service: AutoCaptureService = {
      start: vi.fn().mockResolvedValue({ request: { reportId: stale.id, screenshotType: "top_campaigns", accountUrl: null, period: stale.period }, stage: "failed", code: "CAMPAIGNS_ROUTE_REQUIRED", message: "Top Campaigns must be captured from the Klaviyo Campaigns listing." }),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, undefined, undefined, service);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    const progress = screen.getByRole("region", { name: "Automatic Capture Progress" });
    expect(within(progress).getByText("Stale evidence · recapture required")).toBeInTheDocument();
    const recapture = within(progress).getByRole("button", { name: "Recapture Top Campaigns" });
    expect(recapture).toBeEnabled();
    expect(within(progress).getByText("Top 5 Flows").closest("li")).not.toHaveTextContent("Recapture");
    await user.click(recapture);
    expect(await screen.findByRole("heading", { name: "Open the correct Klaviyo screen" })).toBeInTheDocument();
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "top_campaigns", reportId: stale.id, period: stale.period, clientName: stale.client.name, clientTimezone: stale.client.timezone })));
    expect(await screen.findByRole("alert")).toHaveTextContent("CAMPAIGNS_ROUTE_REQUIRED: Top Campaigns must be captured from the Klaviyo Campaigns listing.");
    expect(api.createReportDraft).not.toHaveBeenCalled();
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
  });
  it("activates stale Top Campaigns Recapture by keyboard", async () => {
    const stale = staleTopCampaignReport();
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([stale]), getReportDraft: vi.fn().mockResolvedValue(stale) });
    const service: AutoCaptureService = {
      start: vi.fn().mockResolvedValue({ request: { reportId: stale.id, screenshotType: "top_campaigns", accountUrl: null, period: stale.period }, stage: "preparing" }),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, undefined, undefined, service);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    const recapture = within(screen.getByRole("region", { name: "Automatic Capture Progress" })).getByRole("button", { name: "Recapture Top Campaigns" });
    recapture.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "top_campaigns", reportId: stale.id })));
    expect(await screen.findByRole("heading", { name: "Open the correct Klaviyo screen" })).toBeInTheDocument();
  });
  it("keeps a fresh approved Top Campaigns screenshot on its normal Retake action", async () => {
    const fresh = runnerReport(["top_campaigns"]);
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([fresh]), getReportDraft: vi.fn().mockResolvedValue(fresh) });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    const progress = screen.getByRole("region", { name: "Automatic Capture Progress" });
    expect(within(progress).getByText("Approved")).toBeInTheDocument();
    expect(within(progress).queryByRole("button", { name: "Recapture Top Campaigns" })).not.toBeInTheDocument();
    expect(within(progress).getByRole("button", { name: "Retake" })).toBeEnabled();
  });
  it("reviews an imported screenshot explicitly and updates checklist only from the backend-confirmed report", async () => {
    vi.stubEnv("DEV", false);
    mockObjectUrls();
    const canonical = runnerReport();
    canonical.id = "c1234567-1234-4234-8234-123456789012";
    canonical.client = { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency: null };
    canonical.reportMonth = { year: 2026, month: 8 };
    canonical.period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
    canonical.version = 2;
    const sha256 = "a".repeat(64);
    canonical.screenshots = [{ id: "imported-overview", clientId: canonical.client.id, reportMonth: canonical.reportMonth, type: "overview", capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard?session=must-not-display", width: 10, height: 10, approved: false, approvedAt: null, captureOrigin: "live_acceptance_import", periodConfirmed: true, storageKey: `reports/${canonical.id}/overview/imported-overview.png`, mimeType: "image/png", byteSize: 10, sha256, sourceProof: createScreenshotSourceProof("overview", canonical.period) }];
    const approved = { ...canonical, version: 3, screenshots: [{ ...canonical.screenshots[0]!, approved: true, approvedAt: NOW.toISOString() }] };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical),
      getPendingImportedScreenshotImage: vi.fn().mockResolvedValue(new Blob(["local png"])),
      approveImportedScreenshot: vi.fn().mockResolvedValue(approved),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText("Final report readiness: 0 / 9 required screenshots approved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review saved capture" }));
    expect(await screen.findByRole("heading", { name: "Review saved Executive Summary" })).toBeInTheDocument();
    expect(await screen.findByAltText("Pending imported Executive Summary evidence")).toBeInTheDocument();
    expect(screen.getByText("https://www.klaviyo.com/dashboard")).toBeInTheDocument();
    expect(screen.queryByText(/session=/)).toBeNull();
    expect(screen.getByRole("button", { name: "Approve this saved evidence" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Approve this saved evidence" }));
    await waitFor(() => expect(api.approveImportedScreenshot).toHaveBeenCalledWith(canonical.id, "overview", { expectedVersion: 2, expectedSha256: sha256 }));
    expect(await screen.findByText("Final report readiness: 1 / 9 required screenshots approved")).toBeInTheDocument();
  });
  it("does not complete an imported checklist item when backend review acknowledgement fails", async () => {
    mockObjectUrls();
    const canonical = runnerReport();
    canonical.screenshots = [{ id: "imported-overview", clientId: canonical.client.id, reportMonth: canonical.reportMonth, type: "overview", capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard", width: 10, height: 10, approved: false, approvedAt: null, captureOrigin: "live_acceptance_import", periodConfirmed: true, storageKey: "reports/imported.png", mimeType: "image/png", byteSize: 10, sha256: "b".repeat(64), sourceProof: createScreenshotSourceProof("overview", canonical.period) }];
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical), getPendingImportedScreenshotImage: vi.fn().mockResolvedValue(new Blob(["png"])), approveImportedScreenshot: vi.fn().mockRejectedValue(new ApiError("REPORT_VERSION_CONFLICT", "The report changed while reviewing.", 409)) });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Review saved capture" }));
    await user.click(await screen.findByRole("button", { name: "Approve this saved evidence" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The report changed while reviewing.");
    expect(screen.getByRole("heading", { name: "Review saved Executive Summary" })).toBeInTheDocument();
    expect(screen.queryByText("Final report readiness: 1 / 9 required screenshots approved")).toBeNull();
  });
  it("generates, previews, opens, downloads, and reloads only the current development review PDF", async () => {
    const canonical = structuredClone(runnerReport());
    canonical.id = "f577d631-a1f6-4cc0-9052-68e30460876d";
    canonical.client = { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null };
    canonical.reportMonth = { year: 2026, month: 8 };
    canonical.period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
    canonical.version = 2;
    const types: ScreenshotType[] = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"];
    canonical.screenshots = types.map((type, index) => ({
      id: `imported-${type}`, clientId: canonical.client.id, reportMonth: canonical.reportMonth, type, capturedAt: NOW.toISOString(),
      sourceUrl: "https://www.klaviyo.com/analytics/dashboards", width: 100, height: 100, approved: false, approvedAt: null,
      captureOrigin: "live_acceptance_import", periodConfirmed: true, storageKey: `reports/${canonical.id}/${type}.png`, mimeType: "image/png",
      byteSize: 100, sha256: (index + 1).toString(16).repeat(64), sourceProof: createScreenshotSourceProof(type, canonical.period),
    }));
    const artifact = { reportId: canonical.id, reportVersion: canonical.version, fileName: "Club-Furniture-2026-08-Performance-Review.pdf", byteSize: 1000, sha256: "a".repeat(64), physicalPageCount: 7, developmentOnly: true as const };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical),
      generateDevelopmentReviewPdf: vi.fn().mockResolvedValue(artifact), getDevelopmentReviewPdfStatus: vi.fn().mockRejectedValueOnce(new ApiError("PDF_REVIEW_NOT_GENERATED", "Not generated yet.", 404)).mockResolvedValue(artifact),
    });
    const user = userEvent.setup(); const opened = vi.spyOn(window, "open").mockReturnValue(null);
    renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByRole("heading", { name: "Development Review PDF" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Generate Review PDF" }));
    await waitFor(() => expect(api.generateDevelopmentReviewPdf).toHaveBeenCalledWith(canonical.id, canonical.version));
    expect(await screen.findByText(/Saved for report version 2 · 7 pages/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Preview Review PDF" }));
    expect(await screen.findByTitle("Development Review PDF Preview")).toHaveAttribute("src", `http://127.0.0.1:4000/api/v1/dev/report-drafts/${canonical.id}/partial-review/pdf`);
    await user.click(screen.getByRole("button", { name: "Open PDF" }));
    expect(opened).toHaveBeenCalledWith(`http://127.0.0.1:4000/api/v1/dev/report-drafts/${canonical.id}/partial-review/pdf`, "_blank", "noopener,noreferrer");
    await user.click(screen.getByRole("button", { name: "Download PDF" }));
    expect(opened).toHaveBeenCalledWith(`http://127.0.0.1:4000/api/v1/dev/report-drafts/${canonical.id}/partial-review/pdf?download=1`, "_blank", "noopener,noreferrer");
    expect(api.getDevelopmentReviewPdfStatus).toHaveBeenCalledWith(canonical.id, canonical.version);
  });
  it("does not render retired List Growth configuration or let it block the current report", async () => {
    const targetless = { clientId: "orion", businessReview: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, createdAt: null, updatedAt: null };
    const readiness = { ready: true, sections: [
      { sectionKey: "signup_form_performance", status: "optional_not_configured" as const, required: false, reason: "Signup Forms is optional and not configured.", requiredTargets: ["signupForms"] },
    ] };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([report]), getReportDraft: vi.fn().mockResolvedValue(report),
      getClientReportTargets: vi.fn().mockResolvedValue(targetless),
      getReportReadiness: vi.fn().mockResolvedValue(readiness),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText((_, node) => node?.tagName === "SMALL" && (node.textContent?.includes("Optional — Not configured") ?? false))).toBeInTheDocument();
    expect(screen.queryByLabelText("Primary email list ID")).toBeNull();
    expect(screen.queryByLabelText("Primary SMS list ID")).toBeNull();
    expect(screen.queryByText("List Growth")).toBeNull();
  });
  it("discovers, account-verifies, and persists Business Review without exposing a dashboard URL field", async () => {
    const discovered = { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/discovered-existing-id", accountLabel: "Orion Supplements" };
    const targets = { clientId: "orion", businessReview: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, welcomeFlowListing: null, createdAt: null, updatedAt: null };
    const savedTargets = { ...targets, businessReview: { ...discovered, displayName: "Business Review" }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
    const discovery = vi.fn().mockResolvedValue({ ok: true, ...discovered, accountMatchesClient: true, evidence: { businessReviewHeading: true, growthOverview: true, campaignPerformance: true, flowPerformance: true } });
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), getReportDraft: vi.fn().mockResolvedValue(report), getClientReportTargets: vi.fn().mockResolvedValue(targets), saveClientReportTargets: vi.fn().mockResolvedValue(savedTargets) });
    const user = userEvent.setup(); renderApp(api, undefined, undefined, undefined, discovery);
    try {
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      await user.click(screen.getByRole("button", { name: "Configure Missing Targets" }));
      expect(screen.getByText(/Tention can discover the existing dashboard/)).toBeInTheDocument();
      expect(screen.queryByLabelText("Business Review URL")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Discover Business Review" }));
      await waitFor(() => expect(api.saveClientReportTargets).toHaveBeenCalledWith("orion", expect.objectContaining({ businessReview: { dashboardUrl: discovered.dashboardUrl, accountLabel: discovered.accountLabel, displayName: "Business Review" } })));
      expect(discovery).toHaveBeenCalledWith(expect.objectContaining({ clientName: "Orion Supplements", useCurrentPage: false }));
      expect(await screen.findByText("Verified for Orion Supplements. The dashboard address stays internal.")).toBeInTheDocument();
      expect(screen.queryByLabelText(/dashboard ID/i)).not.toBeInTheDocument();
    } finally { cleanup(); }
  });
  it("does not save a current page until Business Review semantics are verified", async () => {
    const targets = { clientId: "orion", businessReview: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, welcomeFlowListing: null, createdAt: null, updatedAt: null };
    const discovery = vi.fn().mockResolvedValue({ ok: false, code: "BUSINESS_REVIEW_PAGE_NOT_VERIFIED", message: "Open the existing Business Review in Klaviyo, then choose Use Current Page." });
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), getReportDraft: vi.fn().mockResolvedValue(report), getClientReportTargets: vi.fn().mockResolvedValue(targets) });
    const user = userEvent.setup(); renderApp(api, undefined, undefined, undefined, discovery);
    try {
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      await user.click(screen.getByRole("button", { name: "Configure Missing Targets" }));
      await user.click(screen.getByRole("button", { name: "Use Current Page" }));
      expect(await screen.findAllByText("Open the existing Business Review in Klaviyo, then choose Use Current Page.")).toHaveLength(2);
      expect(discovery).toHaveBeenCalledWith(expect.objectContaining({ clientName: "Orion Supplements", useCurrentPage: true }));
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });
  it("shows safe Business Review inspection diagnostics locally without exposing secrets", async () => {
    const targets = { clientId: "orion", businessReview: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, welcomeFlowListing: null, createdAt: null, updatedAt: null };
    const discovery = vi.fn().mockResolvedValue({
      ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Could not inspect the visible Klaviyo page.",
      diagnostics: { discoveryStage: "CURRENT_PAGE_INSPECTION", activeTabFound: true, tabId: 42, tabHostname: "www.klaviyo.com", observedUrl: "https://www.klaviyo.com/dashboard", urlEligible: true, permissionResult: "toolbar active-tab authorization not verified", scriptInjectionResult: "rejected", inspectionResultReturned: false, visibleHeadingsCount: 0, visibleLinksCount: 0, viewDashboardCandidateCount: 1, businessReviewCandidateCount: 0, typedErrorCode: "SCRIPT_INJECTION_FAILED", safeErrorMessage: "Chrome denied page access for this tab.", selectedClientName: "Club Furniture", accountLabelCandidates: ["Club Furniture", "Analytics"], accountContextSource: "header_match", secretForRegression: "must-not-display" },
    });
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), getReportDraft: vi.fn().mockResolvedValue(report), getClientReportTargets: vi.fn().mockResolvedValue(targets) });
    const user = userEvent.setup(); renderApp(api, undefined, undefined, undefined, discovery);
    try {
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      await user.click(screen.getByRole("button", { name: "Configure Missing Targets" }));
      await user.click(screen.getByRole("button", { name: "Discover Business Review" }));
      expect(await screen.findAllByText("Could not inspect the visible Klaviyo page.")).toHaveLength(2);
      await user.click(screen.getByRole("button", { name: "Close Advanced Targets" }));
      await user.click(screen.getByRole("button", { name: "Show Advanced / Debug" }));
      const diagnostic = await screen.findByRole("region", { name: "Business Review discovery diagnostics" });
      expect(diagnostic).toHaveTextContent("CURRENT_PAGE_INSPECTION");
      expect(diagnostic).toHaveTextContent("www.klaviyo.com");
      expect(diagnostic).toHaveTextContent("Club Furniture");
      expect(diagnostic).toHaveTextContent("Club Furniture · Analytics");
      expect(diagnostic).toHaveTextContent("Chrome denied page access for this tab.");
      expect(diagnostic).not.toHaveTextContent("must-not-display");
    } finally { cleanup(); }
  });
  it("starts the runner and gives a non-Klaviyo capture a manual fallback", async () => {
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://example.com/private", isKlaviyo: false }),
      captureVisibleTab: vi.fn(),
    };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) }), captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByText("Step 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    expect(await screen.findByText("This capture is intended for a Klaviyo page.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture anyway" })).toBeInTheDocument();
    expect(captureService.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("opens the first required July capture from Start Report without selecting a checklist row", async () => {
    const fullRunnerReport = runnerReport();
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([fullRunnerReport]), getReportDraft: vi.fn().mockResolvedValue(fullRunnerReport) }));
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.getByText("Final report readiness: 0 / 9 required screenshots approved")).toBeInTheDocument();
    expect(screen.getByText("Next required capture")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByText("Step 1 of 9")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Executive Summary" })).toBeInTheDocument();
    expect(screen.getByText("Expected report period: Jul 1, 2026 – Jul 31, 2026")).toBeInTheDocument();
  });
  it("resumes Start Report at the next incomplete required section", async () => {
    const fullRunnerReport = runnerReport(["overview"]);
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([fullRunnerReport]), getReportDraft: vi.fn().mockResolvedValue(fullRunnerReport) }));
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByText("Step 2 of 9")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Top 5 Flows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture Automatically" })).toBeEnabled();
    expect(screen.getByText(/keep the Klaviyo home dashboard active/)).toBeInTheDocument();
    expect(screen.getByText(/Do not click a flow name or open Flow Builder/)).toBeInTheDocument();
  });
  it("shows review instead of restarting Start Report when all required captures are approved", async () => {
    const fullRunnerReport = runnerReport(runnerScreenshotTypes);
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([fullRunnerReport]), getReportDraft: vi.fn().mockResolvedValue(fullRunnerReport) }));
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.getByText("Final report readiness: 9 / 9 required screenshots approved")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Report" })).toBeNull();
    expect(screen.getByRole("button", { name: "Review Report" })).toBeInTheDocument();
  });
  it("persists capture review completion in the UI and keeps reopening review idempotent", async () => {
    const awaitingReview = { ...runnerReport(runnerScreenshotTypes), status: "draft" as const, version: 10 };
    const completed = { ...awaitingReview, status: "ready_for_review" as const, version: 11 };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([awaitingReview]), getReportDraft: vi.fn().mockResolvedValue(awaitingReview),
      applyEvent: vi.fn().mockResolvedValue(completed),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.getByLabelText("Capture Review")).toHaveTextContent("Review required");
    await user.click(screen.getByRole("button", { name: "Review Report" }));
    await user.click(await screen.findByRole("button", { name: "Complete Capture Review" }));
    await waitFor(() => expect(api.applyEvent).toHaveBeenCalledWith(awaitingReview.id, "SUBMIT_FOR_REVIEW", awaitingReview.version));
    expect(await screen.findByLabelText("Capture Review")).toHaveTextContent("Completed");
    expect(screen.getByRole("button", { name: "View Review" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview Report" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate PDF" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "View Review" }));
    expect(await screen.findByRole("button", { name: "Back to report" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to report" }));
    expect(api.applyEvent).toHaveBeenCalledTimes(1);
  });
  it("recovers a legacy generated eight-capture report through the explicit compatibility event", async () => {
    const legacyGenerated = { ...runnerReport(runnerScreenshotTypes), status: "generated" as const, version: 10 };
    const completed = { ...legacyGenerated, status: "ready_for_review" as const, version: 11 };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([legacyGenerated]), getReportDraft: vi.fn().mockResolvedValue(legacyGenerated),
      applyEvent: vi.fn().mockResolvedValue(completed),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.getByLabelText("Capture Review")).toHaveTextContent("Review required");
    await user.click(screen.getByRole("button", { name: "Review Report" }));
    await user.click(await screen.findByRole("button", { name: "Complete Capture Review" }));
    await waitFor(() => expect(api.applyEvent).toHaveBeenCalledWith(legacyGenerated.id, "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW", legacyGenerated.version));
    expect(await screen.findByLabelText("Capture Review")).toHaveTextContent("Completed");
    await user.click(screen.getByRole("button", { name: "View Review" }));
    expect(await screen.findByRole("button", { name: "Back to report" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Back to report" }));
    expect(api.applyEvent).toHaveBeenCalledTimes(1);
  });
  it("does not expose pre-PDF generation simulation controls", async () => {
    const readyForReview = { ...runnerReport(runnerScreenshotTypes), status: "ready_for_review" as const, version: 10 };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([readyForReview]), getReportDraft: vi.fn().mockResolvedValue(readyForReview) }));
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Show Advanced / Debug" }));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Simulate Generation Start" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Simulate Generated" })).toBeNull();
  });
  it("shows a capture-review completion failure without leaving the review screen", async () => {
    const awaitingReview = { ...runnerReport(runnerScreenshotTypes), status: "draft" as const, version: 10 };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([awaitingReview]), getReportDraft: vi.fn().mockResolvedValue(awaitingReview),
      applyEvent: vi.fn().mockRejectedValue(new ApiError("REPORT_VALIDATION_FAILED", "Report validation blocks review submission.", 400)),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Review Report" }));
    await user.click(await screen.findByRole("button", { name: "Complete Capture Review" }));
    expect(await screen.findByText("Report validation blocks review submission.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Complete Capture Review" })).toBeInTheDocument();
  });
  it("returns to setup without deleting the current report when starting a new report", async () => {
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start New Report" }));
    expect(await screen.findByRole("heading", { name: "Report setup" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ New Monthly Report" })).toBeInTheDocument();
    expect(api.deleteReportDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Open Report" })).toBeInTheDocument();
  });
  it("shows explicit recent report actions and deletes only the confirmed report", async () => {
    const otherReport: ReportDraft = {
      ...report, id: "22222222-2222-4222-8222-222222222222",
      client: { id: "client-2", name: "Second Client", timezone: "America/New_York", currency: null },
      reportMonth: { year: 2026, month: 7 },
    };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValueOnce([report, otherReport]).mockResolvedValueOnce([otherReport]),
      deleteReportDraft: vi.fn().mockResolvedValue(undefined),
    });
    const user = userEvent.setup(); renderApp(api);
    const firstReport = (await screen.findByText("Orion Supplements")).closest("li")!;
    expect(within(firstReport).getByRole("button", { name: "Open Report" })).toBeInTheDocument();
    await user.click(within(firstReport).getByRole("button", { name: "Delete Report" }));
    const dialog = screen.getByRole("dialog", { name: "Delete report?" });
    await user.type(within(dialog).getByRole("textbox", { name: "Type DELETE to confirm" }), "wrong");
    expect(within(dialog).getByRole("button", { name: "Delete Report" })).toBeDisabled();
    expect(api.deleteReportDraft).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.deleteReportDraft).not.toHaveBeenCalled();
    await user.click(within(firstReport).getByRole("button", { name: "Delete Report" }));
    const confirmedDialog = screen.getByRole("dialog", { name: "Delete report?" });
    await user.type(within(confirmedDialog).getByRole("textbox", { name: "Type DELETE to confirm" }), "DELETE");
    await user.click(within(confirmedDialog).getByRole("button", { name: "Delete Report" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Report deleted.");
    expect(api.deleteReportDraft).toHaveBeenCalledWith(report.id, report.version);
    expect(screen.queryByText("Orion Supplements")).toBeNull();
    expect(screen.getByText("Second Client")).toBeInTheDocument();
  });
  it("keeps a recent report visible when its delete version is stale", async () => {
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([report]),
      deleteReportDraft: vi.fn().mockRejectedValue(new ApiError("REPORT_VERSION_CONFLICT", "stale", 409)),
    });
    const user = userEvent.setup(); renderApp(api);
    const recentReport = (await screen.findByText("Orion Supplements")).closest("li")!;
    await user.click(within(recentReport).getByRole("button", { name: "Delete Report" }));
    const dialog = screen.getByRole("dialog", { name: "Delete report?" });
    await user.type(within(dialog).getByRole("textbox", { name: "Type DELETE to confirm" }), "DELETE");
    await user.click(within(dialog).getByRole("button", { name: "Delete Report" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This report was updated somewhere else.");
    expect(within(recentReport).getByText("Orion Supplements")).toBeInTheDocument();
    expect(api.deleteReportDraft).toHaveBeenCalledWith(report.id, report.version);
  });
  it("requires DELETE confirmation before deleting a report and refreshes the setup view", async () => {
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValueOnce([report]).mockResolvedValueOnce([]),
      deleteReportDraft: vi.fn().mockResolvedValue(undefined),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByText("Report options"));
    await user.click(screen.getByRole("button", { name: "Delete Report" }));
    const dialog = screen.getByRole("dialog", { name: "Delete report?" });
    expect(within(dialog).getByText("Orion Supplements")).toBeInTheDocument();
    const confirmation = within(dialog).getByRole("textbox", { name: "Type DELETE to confirm" });
    await user.type(confirmation, "delete");
    expect(within(dialog).getByRole("button", { name: "Delete Report" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.deleteReportDraft).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Delete Report" }));
    const confirmedDialog = screen.getByRole("dialog", { name: "Delete report?" });
    await user.type(within(confirmedDialog).getByRole("textbox", { name: "Type DELETE to confirm" }), "DELETE");
    await user.click(within(confirmedDialog).getByRole("button", { name: "Delete Report" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Report deleted.");
    expect(api.deleteReportDraft).toHaveBeenCalledWith(report.id, report.version);
    expect(screen.queryByRole("button", { name: "Open Report" })).toBeNull();
  });
  it("keeps raw validation details out of the normal view and exposes them in Advanced / Debug", async () => {
    const validation = { status: "invalid" as const, errors: [{ code: "REQUIRED_SCREENSHOT_MISSING", severity: "error" as const, message: "Top Campaigns screenshot is missing." }], warnings: [] };
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), validateReportDraft: vi.fn().mockResolvedValue(validation) }));
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.queryByText("REQUIRED_SCREENSHOT_MISSING")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show Advanced / Debug" }));
    await user.click(await screen.findByRole("button", { name: "Validate Report" }));
    expect(await screen.findByText("Top Campaigns screenshot is missing.")).toBeInTheDocument();
    expect(screen.getByText("REQUIRED_SCREENSHOT_MISSING")).toBeInTheDocument();
  });
  it("shows persisted toolbar invocation diagnostics only in Advanced / Debug", async () => {
    const automaticCaptureService = automaticService({ request: automaticRequest(report), stage: "failed", code: "ACTION_NOT_INVOKED", message: "not started" });
    automaticCaptureService.getToolbarDiagnostics = vi.fn().mockResolvedValue({
      actionInvocation: { tabId: 7, windowId: 4, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/business-review", invokedAt: 1 },
      grantedTabId: 7, currentActiveTabId: 7, routeMatched: true,
    });
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) }), undefined, undefined, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.queryByText("Toolbar capture diagnostics")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show Advanced / Debug" }));
    expect(await screen.findByText("Toolbar capture diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Action handler fired").parentElement).toHaveTextContent("Yes");
    expect(screen.getByText("Granted page").parentElement).toHaveTextContent("/analytics/dashboards/business-review");
  });
  it("shows a version conflict and reloads the server version", async () => {
    const latest = { ...report, version: 2, updatedAt: "2026-09-09T13:00:00.000Z" };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([report]),
      getReportDraft: vi.fn().mockResolvedValueOnce(report).mockResolvedValueOnce(latest),
      applyEvent: vi.fn().mockRejectedValue(new ApiError("REPORT_VERSION_CONFLICT", "conflict", 409)),
    });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
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
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  async function cropAndConfirm(user: ReturnType<typeof userEvent.setup>, confirm = true, confirmationName = "I confirm this screenshot shows the selected report period.") {
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
    const confirmation = await screen.findByRole("checkbox", { name: confirmationName });
    expect(confirmation).not.toBeChecked();
    if (confirm) await user.click(confirmation);
    return confirmation;
  }

  it("starts each runner section with a fresh capture and uploads the image for its current screenshot type", async () => {
    const initial = runnerReport();
    const afterOverview = runnerReport(["overview"]);
    const afterFlows = runnerReport(["overview", "top_flows"]);
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]),
      getReportDraft: vi.fn().mockResolvedValue(initial),
      uploadScreenshotImage: vi.fn().mockImplementation((_reportId: string, type: ScreenshotType) => Promise.resolve(type === "overview" ? afterOverview : afterFlows)),
    });
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/account", isKlaviyo: true }),
      captureVisibleTab: vi.fn()
        .mockResolvedValueOnce({ sourceUrl: "https://www.klaviyo.com/overview", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" })
        .mockResolvedValueOnce({ sourceUrl: "https://www.klaviyo.com/dashboard", isKlaviyo: true, dataUrl: "data:image/png;base64,BBBB" }),
    };
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    await cropAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    expect(await screen.findByRole("heading", { name: "Top 5 Flows" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
    expect(screen.queryByAltText("Cropped Executive Summary screenshot")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "I confirm this screenshot shows the selected report period." })).toBeNull();
    expect(vi.mocked(api.uploadScreenshotImage)).toHaveBeenLastCalledWith(initial.id, "overview", expect.objectContaining({ sourceUrl: "https://www.klaviyo.com/overview", periodConfirmed: true }));
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    await cropAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    expect(vi.mocked(api.uploadScreenshotImage)).toHaveBeenLastCalledWith(initial.id, "top_flows", expect.objectContaining({ sourceUrl: "https://www.klaviyo.com/dashboard", periodConfirmed: true }));
  });
  it("keeps the checklist incomplete after an offline screenshot write and exposes typed development diagnostics", async () => {
    const initial = runnerReport();
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), uploadScreenshotImage: vi.fn().mockRejectedValue(new ApiError("NETWORK_ERROR", "The API could not be reached.", null)) });
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/forms", isKlaviyo: true }),
      captureVisibleTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/forms", isKlaviyo: true, dataUrl: "data:image/png;base64,CCCC" }),
    };
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    await cropAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The API could not be reached.");
    expect(screen.getByRole("button", { name: "Confirm & Continue" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retake" }));
    await user.click(screen.getByRole("button", { name: "Back to report" }));
    expect(screen.getByText("Final report readiness: 0 / 9 required screenshots approved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show Advanced / Debug" }));
    expect(screen.getByLabelText("Development capture persistence")).toHaveTextContent("http://127.0.0.1:4000");
    expect(screen.getByLabelText("Development capture persistence")).toHaveTextContent(initial.id);
    expect(screen.getByLabelText("Development capture persistence")).toHaveTextContent("autoled");
    expect(screen.getByLabelText("Development capture persistence")).toHaveTextContent("failed");
    expect(screen.getByLabelText("Development capture persistence")).toHaveTextContent("NETWORK_ERROR");
  });
  it("does not advance after a stale screenshot version and requests canonical reload", async () => {
    const initial = runnerReport();
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), uploadScreenshotImage: vi.fn().mockRejectedValue(new ApiError("REPORT_VERSION_CONFLICT", "stale version", 409)) });
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/dashboard", isKlaviyo: true }),
      captureVisibleTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/dashboard", isKlaviyo: true, dataUrl: "data:image/png;base64,CCCC" }),
    };
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    await cropAndConfirm(user);
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    expect(await screen.findByRole("heading", { name: "This report was updated somewhere else." })).toBeInTheDocument();
    expect(screen.getByText("Final report readiness: 0 / 9 required screenshots approved")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reload Latest Version" }));
    await waitFor(() => expect(api.getReportDraft).toHaveBeenCalledWith(initial.id));
    expect(screen.getByText("Final report readiness: 0 / 9 required screenshots approved")).toBeInTheDocument();
  });
  it("keeps every capture action visibly named, including disabled approval", async () => {
    const optionalReport: ReportDraft = { ...runnerReport(), sections: { signup_form: "optional" } };
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/forms", isKlaviyo: true }),
      captureVisibleTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/forms", isKlaviyo: true, dataUrl: "data:image/png;base64,CCCC" }),
    };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([optionalReport]), getReportDraft: vi.fn().mockResolvedValue(optionalReport), getClientReportTargets: vi.fn().mockResolvedValue({ clientId: "autoled", signupForms: { mode: "all", ids: [], names: [] }, welcomeFlowListing: null }) });
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByText("Optional Sections · 1 available"));
    await user.click(screen.getByRole("button", { name: "Capture" }));
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
    expect(await screen.findByText(/Listing-only capture: stay on the Sign-up Forms listing/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    await cropAndConfirm(user, false, "I verified this is the account-wide Sign-up Forms listing and the visible rows include performance columns; no form is open.");
    expect(screen.getByRole("button", { name: "Approve & Upload" })).toBeDisabled();
  });
  it("instructs Welcome Flow capture to stay on the Email listing and exclude SMS without opening flows", async () => {
    const optionalReport: ReportDraft = { ...runnerReport(), sections: { welcome_flow: "optional" } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([optionalReport]), getReportDraft: vi.fn().mockResolvedValue(optionalReport), getClientReportTargets: vi.fn().mockResolvedValue({ clientId: "autoled", signupForms: null, welcomeFlowListing: { mode: "email_welcome_flows", flows: [{ id: "WN2GLE", name: "BM | Welcome Flow [February Offer A/B Test]", channel: "email" }, { id: "Rex4Pp", name: "(Instant Audiences) WC | Welcome Flow", channel: "email" }] } }) });
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/flows", isKlaviyo: true }),
      captureVisibleTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/flows", isKlaviyo: true, dataUrl: "data:image/png;base64,CCCC" }),
    };
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByText("Optional Sections · 1 available"));
    await user.click(screen.getByRole("button", { name: "Capture" }));
    expect(await screen.findByText(/Listing-only capture: stay on the Flows listing/)).toBeInTheDocument();
    expect(screen.getByText(/include only the configured Email rows \(WN2GLE and Rex4Pp\)\. Exclude SMS rows/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open flow/i })).toBeNull();
  });
  it("blocks a form detail route before taking any Signup Forms screenshot", async () => {
    const optionalReport: ReportDraft = { ...runnerReport(), sections: { signup_form: "optional" } };
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/forms/form-detail-id", isKlaviyo: true }),
      captureVisibleTab: vi.fn(),
    };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([optionalReport]), getReportDraft: vi.fn().mockResolvedValue(optionalReport), getClientReportTargets: vi.fn().mockResolvedValue({ clientId: "autoled", signupForms: { mode: "all", ids: [], names: [] }, welcomeFlowListing: null }) });
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByText("Optional Sections · 1 available"));
    await user.click(screen.getByRole("button", { name: "Capture" }));
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("SIGNUP_FORMS_LISTING_REQUIRED");
    expect(captureService.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("automatically crops a verified Business Review target but still requires human approval", async () => {
    const initial = businessReviewAutoReport(); const uploaded = businessReviewAutoReport(["campaign_metrics"]);
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), uploadScreenshotImage: vi.fn().mockResolvedValue(uploaded) });
    const captureService: CaptureService = {
      getActiveTab: vi.fn(),
      captureVisibleTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/analytics/dashboards", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" }),
    };
    const navigationService: KlaviyoNavigationService = {
      openSection: vi.fn(), preparePeriod: vi.fn(() => ({ kind: "manual_period_required" as const })),
      prepareExecutiveSummary: vi.fn().mockResolvedValue({ kind: "ready", detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100 } }),
    };
    const automaticCaptureService = automaticService({ request: automaticRequest(initial), stage: "review_ready", sourceTabId: 7, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100 }, captured: { sourceUrl: "https://www.klaviyo.com/analytics/dashboards", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" } });
    const user = userEvent.setup(); renderApp(api, captureService, navigationService, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" })); await user.click(screen.getByRole("button", { name: "Start Report" }));
    await user.click(screen.getByRole("button", { name: "Capture Automatically" }));
    const image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } });
    fireEvent.load(image);
    expect(await screen.findByText("Period detected: Jul 1, 2026 – Jul 31, 2026")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "I confirm this screenshot shows the selected report period." })).toBeNull();
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    expect(api.uploadScreenshotImage).toHaveBeenCalledWith(initial.id, "campaign_metrics", expect.objectContaining({ periodConfirmed: true, sourceUrl: "https://www.klaviyo.com/analytics/dashboards" }));
  });
  it("runs enabled Business Review targets in canonical order and retains Phase A source proof", async () => {
    const initial = businessReviewAutoReport(); const afterOverview = businessReviewAutoReport(["campaign_metrics"]);
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), uploadScreenshotImage: vi.fn().mockResolvedValue(afterOverview), getReportReadiness: vi.fn().mockResolvedValue({ ready: true, sections: [] }) });
    const automaticCaptureService: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "review_ready" as const, sourceTabId: 7, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100 }, captured: { sourceUrl: "https://www.klaviyo.com/analytics/dashboards", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" } })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    expect(await screen.findByAltText("Captured browser tab")).toBeInTheDocument();
    const image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    await user.click(await screen.findByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(api.uploadScreenshotImage).toHaveBeenCalledWith(initial.id, "campaign_metrics", expect.objectContaining({ sourceProof: expect.objectContaining({ sectionKey: "campaign_metrics", sourceIdentity: "business-review|campaign-performance|metrics" }) })));
    expect(automaticCaptureService.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "campaign_metrics" }));
  });
  it.each([[3, "3 of 5 — Klaviyo shows only 3 usable flows for this month"], [1, "1 of 5 — Klaviyo shows only 1 usable flow for this month"], [5, "Top 5 flows"]])("automatically captures Top Flows from Klaviyo Home with %i rows and labels the real count", async (rows, label) => {
    const initial = { ...runnerReport(), sections: { top_flows: "required" as const } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), uploadScreenshotImage: vi.fn().mockResolvedValue(initial), getReportReadiness: vi.fn().mockResolvedValue({ ready: true, sections: [] }) });
    const automaticCaptureService: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "review_ready" as const, sourceTabId: 7, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100, availableRowCount: rows, includedRowCount: rows }, captured: { sourceUrl: "https://www.klaviyo.com/dashboard", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" } })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    const image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(automaticCaptureService.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "top_flows" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(api.uploadScreenshotImage).toHaveBeenCalledWith(initial.id, "top_flows", expect.objectContaining({ sourceProof: expect.objectContaining({ sourceIdentity: "klaviyo-home|top-performing-flows|default" }) })));
  });
  it.each([
    ["rejected", new ApiError("SCREENSHOT_UPLOAD_ACK_MISMATCH", "The API acknowledgement did not match the approved screenshot and source proof.", 200)],
    ["persisted", null],
  ] as const)("marks recaptured Top Campaigns complete only once the API has persisted it (%s)", async (_case, uploadError) => {
    const stale = staleTopCampaignReport();
    const persisted = runnerReport(["top_campaigns"]);
    const campaignsEvidence = { accountIdentity: stale.client.name, clientTimezone: stale.client.timezone, visibleMetricLabel: "Conversion metric Placed Order", rankingMethod: "klaviyo-native-sort" as const, eligibleRowCount: 4, includedRowCount: 3,
      rows: [9800, 4210.5, 1050.25].map((placedOrderValue, index) => ({ name: `Campaign ${index + 1}`, type: "Email", status: "Sent" as const, sendDate: "2026-07-14", openRate: "40%", clickRate: "2%", placedOrderValue })) };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([stale]), getReportDraft: vi.fn().mockResolvedValue(stale),
      uploadScreenshotImage: uploadError ? vi.fn().mockRejectedValue(uploadError) : vi.fn().mockResolvedValue(persisted) });
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "review_ready" as const, sourceTabId: 7, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", campaignsEvidence,
        target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100, availableRowCount: 4, includedRowCount: 3 },
        captured: { sourceUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true&startDate=2026-07-01&endDate=2026-07-31", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" } })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, service);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(within(screen.getByRole("region", { name: "Automatic Capture Progress" })).getByRole("button", { name: "Recapture Top Campaigns" }));
    await screen.findByAltText("Captured browser tab");
    const image = screen.getByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    expect(await screen.findByText("3 of 4 eligible Sent campaigns")).toBeInTheDocument();
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(api.uploadScreenshotImage).toHaveBeenCalledWith(stale.id, "top_campaigns", expect.objectContaining({
      expectedVersion: stale.version, sourceUrl: expect.stringContaining("https://www.klaviyo.com/omnicampaigns"),
      sourceProof: expect.objectContaining({ sourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc", campaigns: campaignsEvidence }),
    })));
    if (uploadError) {
      expect(await screen.findByRole("alert")).toHaveTextContent("The API acknowledgement did not match");
      expect(screen.getByRole("button", { name: "Confirm & Continue" })).toBeInTheDocument();
      expect(service.clear).not.toHaveBeenCalled();
    } else {
      const progress = await screen.findByRole("region", { name: "Automatic Capture Progress" });
      expect(within(progress).getByText("Top 5 Campaigns").closest("li")).toHaveTextContent("Approved");
      expect(within(progress).queryByRole("button", { name: "Recapture Top Campaigns" })).not.toBeInTheDocument();
      expect(api.createReportDraft).not.toHaveBeenCalled();
    }
  });
  it("requires explicit manual confirmation of both exact months for Month Comparison and uploads canonical proof", async () => {
    const initial = runnerReport(["overview", "top_campaigns", "top_flows"]);
    const completed = runnerReport(["overview", "top_campaigns", "top_flows", "month_comparison"]);
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      uploadScreenshotImage: vi.fn().mockResolvedValue(completed),
    });
    const captureService: CaptureService = {
      getActiveTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/analytics/dashboards", isKlaviyo: true }),
      captureVisibleTab: vi.fn().mockResolvedValue({ sourceUrl: "https://www.klaviyo.com/analytics/dashboards", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" }),
    };
    const user = userEvent.setup(); renderApp(api, captureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByText(/Manual comparison proof is required/)).toHaveTextContent("Jul 1, 2026 – Jul 31, 2026");
    expect(screen.getByText(/immediately previous complete month/)).toHaveTextContent("Jun 1, 2026 – Jun 30, 2026");
    await user.click(screen.getByRole("button", { name: "Capture Manually" }));
    const confirmationName = "I verified this screenshot visibly shows Jul 1, 2026 – Jul 31, 2026 and Jun 1, 2026 – Jun 30, 2026 as the current and previous periods.";
    const confirmation = await cropAndConfirm(user, false, confirmationName);
    expect(screen.getByRole("button", { name: "Confirm & Continue" })).toBeDisabled();
    await user.click(confirmation);
    await user.click(screen.getByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(api.uploadScreenshotImage).toHaveBeenCalledWith(initial.id, "month_comparison", expect.objectContaining({
      periodConfirmed: true,
      sourceProof: expect.objectContaining({ sectionKey: "month_comparison", sourceIdentity: "business-review|growth-overview|message-type-breakdown|previous-period", expectedPeriod: { startDate: "2026-07-01", endDate: "2026-07-31", comparisonStartDate: "2026-06-01", comparisonEndDate: "2026-06-30" } }),
    })));
  });
  it("runs Executive Summary and Top 5 Flows on Klaviyo Home, then Top Campaigns through the canonical Campaigns path", async () => {
    const initial = runnerReport(); const afterOverview = runnerReport(["overview"]); const afterFlows = runnerReport(["overview", "top_flows"]); const afterCampaigns = runnerReport(["overview", "top_flows", "top_campaigns"]);
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      uploadScreenshotImage: vi.fn().mockImplementation((_reportId: string, type: ScreenshotType) => Promise.resolve(type === "overview" ? afterOverview : type === "top_flows" ? afterFlows : afterCampaigns)),
    });
    const automaticCaptureService: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "review_ready" as const, sourceTabId: 7, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100 }, captured: { sourceUrl: request.screenshotType === "top_campaigns" ? "https://www.klaviyo.com/omnicampaigns?appBarNav=true" : "https://www.klaviyo.com/dashboard", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" } })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    let image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    await user.click(await screen.findByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(api.uploadScreenshotImage).toHaveBeenCalledWith(initial.id, "overview", expect.objectContaining({ sourceProof: expect.objectContaining({ sourceIdentity: "klaviyo-home|business-performance-summary|default" }) })));
    image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    await user.click(await screen.findByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(api.uploadScreenshotImage).toHaveBeenLastCalledWith(initial.id, "top_flows", expect.objectContaining({ sourceUrl: "https://www.klaviyo.com/dashboard", sourceProof: expect.objectContaining({ sourceFamily: "klaviyo-home", semanticCard: "top-performing-flows", semanticTab: "default", sourceIdentity: "klaviyo-home|top-performing-flows|default", expectedPeriod: { startDate: "2026-07-01", endDate: "2026-07-31" } }) })));
    image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    await user.click(await screen.findByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(api.uploadScreenshotImage).toHaveBeenLastCalledWith(initial.id, "top_campaigns", expect.objectContaining({ sourceUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true", sourceProof: expect.objectContaining({ sourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc" }) })));
    expect(automaticCaptureService.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ screenshotType: "overview" }));
    expect(automaticCaptureService.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ screenshotType: "top_flows" }));
    expect(automaticCaptureService.start).toHaveBeenNthCalledWith(3, expect.objectContaining({ screenshotType: "top_campaigns" }));
  });
  it("passes the freshly discovered Business Review target into the same automatic run", async () => {
    const initial = { ...runnerReport(), client: { ...runnerReport().client, id: "club-furniture", name: "Club Furniture" } };
    const afterOverview = { ...initial, screenshots: runnerReport(["overview"]).screenshots.map((shot) => ({ ...shot, clientId: "club-furniture" })) };
    const afterFlows = { ...initial, screenshots: runnerReport(["overview", "top_flows"]).screenshots.map((shot) => ({ ...shot, clientId: "club-furniture" })) };
    const discoveredUrl = "https://www.klaviyo.com/analytics/dashboards/verified-club-review";
    const emptyTargets = { clientId: "club-furniture", businessReview: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, welcomeFlowListing: null, createdAt: null, updatedAt: null };
    const savedTargets = { ...emptyTargets, businessReview: { dashboardUrl: discoveredUrl, displayName: "Business Review", accountLabel: "CL Club Furniture", providerAccountId: "acct_club_fixture", providerIdentityKind: "account" as const }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      getClientReportTargets: vi.fn().mockResolvedValue(emptyTargets), saveClientReportTargets: vi.fn().mockResolvedValue(savedTargets),
      uploadScreenshotImage: vi.fn().mockImplementation((_reportId: string, type: ScreenshotType) => Promise.resolve(type === "overview" ? afterOverview : afterFlows)),
    });
    const discovery = vi.fn().mockResolvedValue({ ok: true, dashboardUrl: discoveredUrl, accountLabel: "CL Club Furniture", providerAccountId: "acct_club_fixture", providerIdentityKind: "account", accountMatchesClient: true, evidence: { businessReviewHeading: true, growthOverview: true, campaignPerformance: true, flowPerformance: true } });
    const automaticCaptureService: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "review_ready" as const, sourceTabId: 7, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100 }, captured: { sourceUrl: request.screenshotType === "overview" || request.screenshotType === "top_flows" ? "https://www.klaviyo.com/dashboard" : discoveredUrl, isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" } })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, automaticCaptureService, discovery);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    expect(discovery).toHaveBeenCalledWith(expect.objectContaining({ clientName: "Club Furniture", configuredUrl: null }));
    expect(api.saveClientReportTargets).toHaveBeenCalledWith("club-furniture", expect.objectContaining({ businessReview: expect.objectContaining({ dashboardUrl: discoveredUrl, providerAccountId: "acct_club_fixture" }) }));
    let image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    await user.click(await screen.findByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(automaticCaptureService.start).toHaveBeenCalledTimes(2));
    expect(automaticCaptureService.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ screenshotType: "top_flows" }));
    expect(automaticCaptureService.start).not.toHaveBeenNthCalledWith(2, expect.objectContaining({ accountUrl: discoveredUrl }));
    image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } }); fireEvent.load(image);
    await user.click(await screen.findByRole("button", { name: "Confirm & Continue" }));
    await waitFor(() => expect(automaticCaptureService.start).toHaveBeenCalledTimes(3));
    expect(automaticCaptureService.start).toHaveBeenNthCalledWith(3, expect.objectContaining({ screenshotType: "top_campaigns", accountUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true", clientName: "Club Furniture", clientTimezone: initial.client.timezone }));
  });
  it("starts the nine-section local acceptance run from one user action without replacing canonical screenshots", async () => {
    const initial = runnerReport();
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(),
      finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    });
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "BUSINESS_REVIEW_CARD_NOT_FOUND" as const, message: "The reporting card was not found." })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup(); renderApp(api, { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, service);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    await screen.findByRole("heading", { name: "Automatic capture paused" });
    expect(service.start).toHaveBeenCalledTimes(5);
    expect(api.startLocalAutomaticCaptureRun).toHaveBeenCalledOnce();
    expect(api.saveLocalAutomaticCaptureSection).toHaveBeenCalledTimes(10);
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
    expect(screen.getByText("Fresh captures: 0 / 9 successful", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText("Not started")).toHaveLength(8);
  });
  it("restores a persisted worker capture into review after the UI remounts", async () => {
    const initial = businessReviewAutoReport();
    const saved: AutoCaptureState = { request: automaticRequest(initial), stage: "review_ready", sourceTabId: 7, detectedPeriod: "Jul 1, 2026 – Jul 31, 2026", target: { x: 10, y: 20, width: 80, height: 60, viewportWidth: 100, viewportHeight: 100 }, captured: { sourceUrl: "https://www.klaviyo.com/analytics/dashboards", isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" } };
    const automaticCaptureService = automaticService(saved, saved);
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }), { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" })); await user.click(screen.getByRole("button", { name: "Start Report" }));
    const image = await screen.findByAltText("Captured browser tab");
    Object.defineProperties(image, { naturalWidth: { configurable: true, value: 200 }, naturalHeight: { configurable: true, value: 200 } });
    fireEvent.load(image);
    expect(await screen.findByText("Period detected: Jul 1, 2026 – Jul 31, 2026")).toBeInTheDocument();
    expect(automaticCaptureService.start).not.toHaveBeenCalled();
  });
  it("keeps manual capture available and does not upload when automatic verification fails", async () => {
    const initial = businessReviewAutoReport();
    const captureService: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() };
    const navigationService: KlaviyoNavigationService = {
      openSection: vi.fn(), preparePeriod: vi.fn(() => ({ kind: "manual_period_required" as const })),
      prepareExecutiveSummary: vi.fn().mockResolvedValue({ kind: "failed", code: "PERIOD_VERIFY_FAILED" }),
    };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) });
    const automaticCaptureService = automaticService({ request: automaticRequest(initial), stage: "failed", code: "PERIOD_VERIFY_FAILED", message: "Klaviyo did not verify the selected report period. No screenshot was captured." });
    const user = userEvent.setup(); renderApp(api, captureService, navigationService, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" })); await user.click(screen.getByRole("button", { name: "Start Report" }));
    await user.click(screen.getByRole("button", { name: "Capture Automatically" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Klaviyo did not verify the selected report period. No screenshot was captured.");
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
    expect(captureService.captureVisibleTab).not.toHaveBeenCalled();
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
  });
  it("leaves Preparing after an automatic-capture Chrome error and keeps manual capture available", async () => {
    const initial = businessReviewAutoReport();
    const captureService: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() };
    const navigationService: KlaviyoNavigationService = {
      openSection: vi.fn(), preparePeriod: vi.fn(() => ({ kind: "manual_period_required" as const })),
      prepareExecutiveSummary: vi.fn().mockResolvedValue({ kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: "checking the Klaviyo Business review page failed: Cannot access contents of URL" }),
    };
    const automaticCaptureService = automaticService({ request: automaticRequest(initial), stage: "failed", code: "SCRIPT_INJECTION_FAILED", message: "checking the Klaviyo Business review page failed: Cannot access contents of URL" });
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }), captureService, navigationService, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" })); await user.click(screen.getByRole("button", { name: "Start Report" }));
    await user.click(screen.getByRole("button", { name: "Capture Automatically" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot access contents of URL");
    expect(screen.getByRole("button", { name: "Try Again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
    expect(captureService.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("makes the activeTab capture denial actionable and leaves Try Again plus manual capture available", async () => {
    const initial = businessReviewAutoReport();
    const captureService: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() };
    const permissionMessage = "To allow screenshot capture, keep the Klaviyo tab active and click the Tention Reports toolbar icon once.";
    const saved: AutoCaptureState = { request: automaticRequest(initial), stage: "failed", code: "KLAVIYO_CAPTURE_PERMISSION_REQUIRED", message: permissionMessage };
    const automaticCaptureService = automaticService(saved, saved);
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }), captureService, undefined, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" })); await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(permissionMessage);
    expect(screen.getByRole("button", { name: "Try Again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
  });
  it("shows an Apply failure as a manual fallback instead of remaining in Preparing", async () => {
    const initial = businessReviewAutoReport();
    const captureService: CaptureService = { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() };
    const navigationService: KlaviyoNavigationService = {
      openSection: vi.fn(), preparePeriod: vi.fn(() => ({ kind: "manual_period_required" as const })),
      prepareExecutiveSummary: vi.fn().mockResolvedValue({ kind: "failed", code: "KLAVIYO_PERIOD_APPLY_NOT_FOUND" }),
    };
    const automaticCaptureService = automaticService({ request: automaticRequest(initial), stage: "failed", code: "KLAVIYO_PERIOD_APPLY_NOT_FOUND", message: "Klaviyo's Apply button was not found. Confirm the month and use Capture Manually." });
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }), captureService, navigationService, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" })); await user.click(screen.getByRole("button", { name: "Start Report" }));
    await user.click(screen.getByRole("button", { name: "Capture Automatically" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Apply button was not found");
    expect(screen.getByRole("button", { name: "Try Again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
    expect(captureService.captureVisibleTab).not.toHaveBeenCalled();
  });
  it("restores a persisted worker failure with Try Again and Capture Manually available", async () => {
    const initial = businessReviewAutoReport();
    const saved: AutoCaptureState = { request: automaticRequest(initial), stage: "failed", code: "TARGET_NOT_FOUND", message: "Growth overview was not found." };
    const automaticCaptureService = automaticService(saved, saved);
    const user = userEvent.setup(); renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }), { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, automaticCaptureService);
    await user.click(await screen.findByRole("button", { name: "Open Report" })); await user.click(screen.getByRole("button", { name: "Start Report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Automatic capture couldn't complete. Growth overview was not found.");
    expect(screen.getByRole("button", { name: "Try Again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Capture Manually" })).toBeEnabled();
  });
});

describe("client setup preflight for automatic capture", () => {
  const savedUrl = "https://www.klaviyo.com/analytics/dashboards/acme-verified-review";
  const acme = (): ReportDraft => ({ ...runnerReport(), client: { id: "acme-home", name: "Acme Home", timezone: "Pacific/Auckland", currency: null }, sections: { executive_summary: "required", campaign_metrics: "required" } });
  const emptyTargets = { clientId: "acme-home", businessReview: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, welcomeFlowListing: null, createdAt: null, updatedAt: null };
  const savedTargets = { ...emptyTargets, businessReview: { dashboardUrl: savedUrl, displayName: "Business Review", accountLabel: "AC Acme Home" }, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
  const accountVerified = { ok: true as const, verification: "saved_target_account" as const, dashboardUrl: savedUrl, accountLabel: "Acme Home", accountMatchesClient: true as const };
  const pageVerified = { ok: true as const, dashboardUrl: savedUrl, accountLabel: "AC Acme Home", accountMatchesClient: true as const, evidence: { businessReviewHeading: true as const, growthOverview: true as const, campaignPerformance: true as const, flowPerformance: true as const } };
  const preparing = (request: Parameters<AutoCaptureService["start"]>[0]) => ({ request, stage: "preparing" as const });
  function setup(targets: object, discovery: ReturnType<typeof vi.fn>, report = acme()) {
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), getReportDraft: vi.fn().mockResolvedValue(report), getClientReportTargets: vi.fn().mockResolvedValue(targets), saveClientReportTargets: vi.fn().mockResolvedValue(savedTargets) });
    const service: AutoCaptureService = { start: vi.fn().mockImplementation(async (request) => preparing(request)), get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined) };
    return { api, service, report, render: () => renderApp(api, { getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }, undefined, service, discovery as never) };
  }
  async function openAndStart() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(await screen.findByRole("button", { name: /Start Automatic Capture/ }));
    return user;
  }

  it("treats a saved Business Review source as ready: account-only check, no rediscovery, no re-save, capture starts", async () => {
    const discovery = vi.fn().mockResolvedValue(accountVerified);
    const { api, service, render } = setup(savedTargets, discovery); render();
    await openAndStart();
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "overview", accountUrl: "https://www.klaviyo.com/dashboard" })));
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(discovery).toHaveBeenCalledWith(expect.objectContaining({ clientName: "Acme Home", configuredUrl: savedUrl, configuredAccountLabel: "AC Acme Home", verifySavedAccountOnly: true }));
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    expect(screen.queryByText(/no source was saved/i)).toBeNull();
    expect(screen.queryByText(/could not be discovered automatically/i)).toBeNull();
  });

  it.each([
    ["the authorized tab shows another account", { ok: false, code: "ACCOUNT_CONTEXT_MISMATCH", message: "The authenticated Klaviyo account differs from this client’s saved account binding. No dashboard URL was saved." }],
    ["the toolbar grant is missing", { ok: false, code: "ACTION_NOT_INVOKED", message: "Open the intended client’s Klaviyo account and click the Tention Reports extension before discovery." }],
  ])("fails closed with the typed reason when %s", async (_case, failure) => {
    const discovery = vi.fn().mockResolvedValue(failure);
    const { api, service, render } = setup(savedTargets, discovery); render();
    await openAndStart();
    expect(await screen.findByText(`Client setup needs attention before capture. ${failure.code}: ${failure.message}`)).toBeInTheDocument();
    expect(service.start).not.toHaveBeenCalled();
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
  });

  it("still blocks Business Review sections when no verified Business Review exists, then clears the old error after a successful save", async () => {
    const discovery = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: "BUSINESS_REVIEW_NOT_DISCOVERED", message: "Business Review could not be discovered automatically. Open the existing Business Review in Klaviyo and click Use Current Page." })
      .mockResolvedValueOnce(pageVerified);
    const { api, service, render } = setup(emptyTargets, discovery); render();
    const user = await openAndStart();
    expect(await screen.findByText(/BUSINESS_REVIEW_NOT_DISCOVERED/)).toBeInTheDocument();
    expect(discovery).toHaveBeenLastCalledWith(expect.not.objectContaining({ verifySavedAccountOnly: true }));
    expect(service.start).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    await waitFor(() => expect(api.saveClientReportTargets).toHaveBeenCalledWith("acme-home", expect.objectContaining({ businessReview: expect.objectContaining({ dashboardUrl: savedUrl, accountLabel: "AC Acme Home" }) })));
    await waitFor(() => expect(service.start).toHaveBeenCalled());
    expect(screen.queryByText(/could not be discovered automatically/i)).toBeNull();
    expect(screen.queryByText(/BUSINESS_REVIEW_NOT_DISCOVERED/)).toBeNull();
  });

  it("does not require a saved Overview URL or any discovery for Home-only captures", async () => {
    const discovery = vi.fn();
    const { service, render } = setup(emptyTargets, discovery, { ...acme(), sections: { executive_summary: "required" } }); render();
    await openAndStart();
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "overview", accountUrl: "https://www.klaviyo.com/dashboard" })));
    expect(discovery).not.toHaveBeenCalled();
  });

  it("rehydrates the saved Business Review source and stored client timezone from the API on panel reload", async () => {
    const discovery = vi.fn().mockResolvedValue(accountVerified);
    const first = setup(savedTargets, discovery); first.render();
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText("Verified reporting source saved for this client")).toBeInTheDocument();
    cleanup();
    const reloaded = setup(savedTargets, discovery); reloaded.render();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText("Verified reporting source saved for this client")).toBeInTheDocument();
    expect(screen.getByText("Pacific/Auckland · saved client configuration")).toBeInTheDocument();
    expect(screen.queryByText(/could not be discovered automatically/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    await waitFor(() => expect(reloaded.service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "overview" })));
    expect(reloaded.api.getClientReportTargets).toHaveBeenCalledWith("acme-home");
    expect(screen.queryByText(/no source was saved/i)).toBeNull();
  });
});

describe("canonical client configuration in the extension", () => {
  const profile = (name: string, timezone: string) => ({ name, timezone, currency: null, conversionMetric: { label: "Placed Order", providerMetricId: null }, sections: null });
  const configured = (clientId: string, name: string, timezone: string) => ({ clientId, profile: profile(name, timezone), businessReview: null, sourceUrls: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, welcomeFlowListing: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() });

  it.each([
    ["alpha-goods", "Alpha Goods", "America/New_York"],
    ["beta-outfitters", "Beta Outfitters", "Asia/Kolkata"],
  ])("creates a %s report from the saved profile without asking for the timezone again", async (clientId, name, timezone) => {
    const api = mockApi({ listClientConfigurations: vi.fn().mockResolvedValue([configured("alpha-goods", "Alpha Goods", "America/New_York"), configured("beta-outfitters", "Beta Outfitters", "Asia/Kolkata")]) });
    const user = userEvent.setup(); renderApp(api);
    await screen.findByText("Connected");
    await user.type(screen.getByLabelText("Client Name"), name);
    expect(await screen.findByLabelText("Client timezone")).toHaveTextContent(`Timezone ${timezone} · saved client configuration`);
    expect(screen.queryByLabelText("Timezone")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.createReportDraft).toHaveBeenCalledWith(expect.objectContaining({ client: { id: clientId, name, timezone } })));
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
  });

  it("asks a new client for its timezone once and saves it on the client before the first report", async () => {
    const api = mockApi();
    const user = userEvent.setup(); renderApp(api);
    await screen.findByText("Connected");
    await user.type(screen.getByLabelText("Client Name"), "Delta Home");
    expect(screen.getByText("New client: this timezone is saved once and reused for every report.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Timezone"), "Europe/London");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(api.createReportDraft).toHaveBeenCalledWith(expect.objectContaining({ client: { id: "delta-home", name: "Delta Home", timezone: "Europe/London" } })));
    expect(api.saveClientReportTargets).toHaveBeenCalledWith("delta-home", expect.objectContaining({ profile: expect.objectContaining({ name: "Delta Home", timezone: "Europe/London" }) }));
    expect(vi.mocked(api.saveClientReportTargets).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(api.createReportDraft).mock.invocationCallOrder[0]!);
  });

  it("blocks capture for a report whose timezone differs from the saved client configuration and never rewrites it", async () => {
    const draft = { ...runnerReport(), client: { id: "alpha-goods", name: "Alpha Goods", timezone: "America/Chicago", currency: null } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([draft]), getReportDraft: vi.fn().mockResolvedValue(draft), getClientReportTargets: vi.fn().mockResolvedValue(configured("alpha-goods", "Alpha Goods", "America/New_York")) });
    const service: AutoCaptureService = { start: vi.fn(), get: vi.fn().mockResolvedValue(null), clear: vi.fn() };
    const user = userEvent.setup(); renderApp(api, undefined, undefined, service);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(await screen.findByRole("button", { name: /Start Automatic Capture/ }));
    expect((await screen.findAllByText(/CLIENT_CONFIGURATION_MISMATCH: This report was created as Alpha Goods \(America\/Chicago\), but the client is configured as Alpha Goods \(America\/New_York\)/)).length).toBeGreaterThan(0);
    expect(service.start).not.toHaveBeenCalled();
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    expect(api.deleteReportDraft).not.toHaveBeenCalled();
  });

  it("requires the client timezone once for an existing report without a profile, without adopting the report's value", async () => {
    const draft = { ...runnerReport(), client: { id: "gamma-supply", name: "Gamma Supply", timezone: "America/Chicago", currency: null }, sections: { executive_summary: "required" as const } };
    const legacyTargets = { ...configured("gamma-supply", "Gamma Supply", "UTC"), profile: null };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([draft]), getReportDraft: vi.fn().mockResolvedValue(draft), getClientReportTargets: vi.fn().mockResolvedValue(legacyTargets),
      saveClientReportTargets: vi.fn().mockImplementation(async (_id: string, input: { profile: ReturnType<typeof profile> }) => ({ ...legacyTargets, profile: input.profile })) });
    const service: AutoCaptureService = { start: vi.fn().mockImplementation(async (request) => ({ request, stage: "preparing" as const })), get: vi.fn().mockResolvedValue(null), clear: vi.fn() };
    const user = userEvent.setup(); renderApp(api, undefined, undefined, service);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText("Not saved for this client · this report was created with America/Chicago")).toBeInTheDocument();
    expect(screen.getByLabelText("Client timezone")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    expect(await screen.findByText(/CLIENT_CONFIGURATION_REQUIRED/)).toBeInTheDocument();
    expect(service.start).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Client timezone"), "America/Chicago");
    await user.click(screen.getByRole("button", { name: "Save Client Timezone" }));
    await waitFor(() => expect(api.saveClientReportTargets).toHaveBeenCalledWith("gamma-supply", expect.objectContaining({ profile: expect.objectContaining({ name: "Gamma Supply", timezone: "America/Chicago" }) })));
    expect(await screen.findByText("America/Chicago · saved client configuration")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "overview", accountUrl: "https://www.klaviyo.com/dashboard" })));
  });
});
