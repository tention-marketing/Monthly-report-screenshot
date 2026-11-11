import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "@tention/api-client";
import { clientReportSnapshot, clientReportTargetsSchema, clientSetupBlockers, clientSetupStatus, createScreenshotSourceProof, type ClientReportTargets, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import { deriveNewClientId } from "../lib/client-id.js";
import { cleanTargetInput, targetInput } from "../features/clients/client-targets.js";
import type { ClientSetupSources } from "./App.js";
import type { CaptureService } from "../features/screenshot-capture/capture-service.js";
import type { KlaviyoNavigationService } from "../features/klaviyo-navigation/navigation-service.js";
import type { AutoCaptureService, AutoCaptureState } from "../features/automatic-capture/auto-capture-service.js";
import type { BusinessReviewDiscoveryResult } from "../features/klaviyo-navigation/business-review-discovery.js";
import { DEFAULT_DRAFT_SECTION_CONFIGURATION } from "../features/create-report/defaults.js";
import { formatCalendarRange, formatReportMonth } from "../lib/dates/month-options.js";
/** A report created before Section 10: exactly the frozen nine-section core. */
const { email_subscriber_growth: _sectionTen, ...NINE_SECTION_CONFIGURATION } = DEFAULT_DRAFT_SECTION_CONFIGURATION;
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
    sections: { ...NINE_SECTION_CONFIGURATION },
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
  // Report fixtures stand for onboarded clients: unless a test sets `getClientSetup`, the client's setup is READY.
  // It reads the targets through their implementation so getClientReportTargets call counts stay untouched.
  if (!overrides.getClientSetup) api.getClientSetup = vi.fn(async (clientId: string) => {
    const setup = await vi.mocked(api.getClientReportTargets).getMockImplementation()!(clientId);
    return { clientId, name: setup?.profile?.name ?? clientId, status: "READY", blockers: [], setup };
  }) as ApiClient["getClientSetup"];
  return api;
}
function baseMockApi(overrides: Partial<Record<keyof ApiClient, unknown>>): ApiClient {
  return {
    listClientConfigurations: vi.fn().mockResolvedValue([]),
    listClientSetups: vi.fn().mockResolvedValue([]),
    createClient: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
    createReportDraft: vi.fn().mockResolvedValue(report),
    getReportDraft: vi.fn().mockResolvedValue(report),
    deleteReportDraft: vi.fn().mockResolvedValue(undefined),
    deleteClientReport: vi.fn().mockResolvedValue({ reportId: report.id, driveFilesRetained: 0 }),
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
/** Source-setup hooks for tests: `take` returns what the service worker verified at the toolbar click. */
const sourceHooks = (take: () => Promise<unknown>, persisted = vi.fn().mockResolvedValue(null)) => ({ take: take as never, persisted, watch: () => () => undefined });
/** Client configuration that returns what was last saved, so the panel's reload confirmation is real. */
/** Final generation needs a configured currency (on the report) and conversion metric ID (on the client profile). */
function withConfiguredDataDefinition<T extends ReportDraft>(draft: T, api: ApiClient): T {
  const read = api.getClientReportTargets;
  api.getClientReportTargets = vi.fn(async (clientId: string) => ({ ...(await read(clientId)), profile: { name: draft.client.name, timezone: draft.client.timezone, currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "TEST01" }, sections: null } })) as ApiClient["getClientReportTargets"];
  return draft;
}
function rememberingTargets(api: ApiClient, initial?: Record<string, unknown>) {
  let saved: Record<string, unknown> | null = initial ?? null;
  const read = api.getClientReportTargets;
  api.getClientReportTargets = vi.fn(async (clientId: string) => saved ? { ...(await read(clientId)), ...saved } : read(clientId)) as ApiClient["getClientReportTargets"];
  const write = api.saveClientReportTargets;
  api.saveClientReportTargets = vi.fn(async (clientId: string, input: never) => { const result = await write(clientId, input); saved = { ...(result as Record<string, unknown>) }; return result; }) as ApiClient["saveClientReportTargets"];
  return api;
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
    expect(screen.getByRole("button", { name: "+ Add New Client" })).toBeDisabled();
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
    expect(screen.getByText("Automatic capture: 9 / 9 sections captured")).toBeInTheDocument();
    expect(screen.queryByText(/Approve all .* required screenshots/)).toBeNull();
    expect(screen.getByText(/final-only sections below are separate from the 9 automatic captures/)).toBeInTheDocument();
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
    expect(document.querySelector(".report-month")).toHaveTextContent("August 2026");
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
      generatePdf: vi.fn(), autoGenerateFinalReport: vi.fn(), generateDevelopmentReviewPdf: vi.fn().mockResolvedValue(artifact), getDevelopmentReviewPdfStatus: vi.fn().mockRejectedValueOnce(new ApiError("PDF_REVIEW_NOT_GENERATED", "Not generated yet.", 404)).mockResolvedValue(artifact),
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
    await user.click(screen.getByRole("button", { name: "Open Review PDF" }));
    expect(opened).toHaveBeenCalledWith(`http://127.0.0.1:4000/api/v1/dev/report-drafts/${canonical.id}/partial-review/pdf`, "_blank", "noopener,noreferrer");
    await user.click(screen.getByRole("button", { name: "Download Review PDF" }));
    expect(opened).toHaveBeenCalledWith(`http://127.0.0.1:4000/api/v1/dev/report-drafts/${canonical.id}/partial-review/pdf?download=1`, "_blank", "noopener,noreferrer");
    expect(api.getDevelopmentReviewPdfStatus).toHaveBeenCalledWith(canonical.id, canonical.version);
    expect(screen.getByText("This is a temporary review PDF. It does not update Google Drive or the editable Google Doc.")).toBeInTheDocument();
    expect(api.generatePdf).not.toHaveBeenCalled();
    // Captured 9/9, but the data definition is incomplete: nothing is generated, and approval is not what blocks it.
    const final = screen.getByLabelText("Final Client Report");
    expect(final).toHaveTextContent("Captured9/9"); expect(final).toHaveTextContent("Automated validationBLOCKED"); expect(final).toHaveTextContent("Final PDFBLOCKED");
    expect(final).toHaveTextContent("Google DriveBLOCKED"); expect(final).toHaveTextContent("Google DocBLOCKED"); expect(final).toHaveTextContent("Human reviewOptional");
    expect(final).toHaveTextContent("Reason: CURRENCY_NOT_CONFIGURED, CONVERSION_METRIC_ID_NOT_CONFIGURED");
    expect(final).not.toHaveTextContent(/Approve all/);
    expect(within(final).queryByRole("button", { name: /Generate Final Report|Retry Final Report/ })).toBeNull();
    expect(api.autoGenerateFinalReport).not.toHaveBeenCalled();
  });
  describe("automatic final report after a validated automatic capture, with human review optional", () => {
    function capturedNine() {
      const canonical = structuredClone(runnerReport());
      canonical.id = "e1376a59-9eb5-40a4-9fc1-2da03facb005";
      canonical.client = { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency: "USD" };
      canonical.reportMonth = { year: 2026, month: 9 };
      canonical.period = { startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" };
      canonical.version = 10;
      const types: ScreenshotType[] = ["overview", "top_flows", "top_campaigns", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"];
      canonical.screenshots = types.map((type, index) => ({
        id: `imported-${type}`, clientId: canonical.client.id, reportMonth: canonical.reportMonth, type, capturedAt: NOW.toISOString(),
        sourceUrl: "https://www.klaviyo.com/analytics/dashboards", width: 100, height: 100, approved: false, approvedAt: null,
        captureOrigin: "live_acceptance_import" as const, periodConfirmed: true, storageKey: `reports/${canonical.id}/${type}.png`, mimeType: "image/png" as const,
        byteSize: 100, sha256: (index + 1).toString(16).repeat(64), sourceProof: createScreenshotSourceProof(type, canonical.period),
      }));
      return { canonical, types };
    }
    const artifactFor = (reportId: string, drive: "uploaded" | "failed", doc: "synced" | "failed") => ({ id: "c0000000-0000-4000-8000-000000000001", reportId, storageKey: `reports/${reportId}/artifacts/a.pdf`, mimeType: "application/pdf" as const, byteSize: 10, sha256: "b".repeat(64), sourceFingerprint: "c".repeat(64), templateVersion: "monthly-report-v1", generatedAt: NOW.toISOString(),
      driveDelivery: drive === "uploaded"
        ? { driveUploadStatus: "uploaded" as const, driveFileName: "Club Furniture - September 2026.pdf", driveFileId: "pdf-id", driveFolderId: "folder-id", driveWebViewLink: "https://drive.google.com/file/d/pdf-id/view", driveUploadedAt: NOW.toISOString(), driveUploadAction: "updated" as const, driveErrorCode: null, driveAttemptedAt: NOW.toISOString() }
        : { driveUploadStatus: "failed" as const, driveFileName: "Club Furniture - September 2026.pdf", driveFileId: null, driveFolderId: null, driveWebViewLink: null, driveUploadedAt: null, driveUploadAction: null, driveErrorCode: "DRIVE_UPLOAD_FAILED", driveAttemptedAt: NOW.toISOString() },
      googleDoc: doc === "synced"
        ? { googleDocStatus: "synced" as const, googleDocName: "Club Furniture - September 2026", googleDocId: "doc-id", googleDocFolderId: "folder-id", googleDocWebViewLink: "https://docs.google.com/document/d/doc-id/edit", googleDocUpdatedAt: NOW.toISOString(), googleDocVersion: "3", googleDocAction: "updated" as const, googleDocErrorCode: null, googleDocAttemptedAt: NOW.toISOString() }
        : { googleDocStatus: "failed" as const, googleDocName: "Club Furniture - September 2026", googleDocId: null, googleDocFolderId: null, googleDocWebViewLink: null, googleDocUpdatedAt: null, googleDocVersion: null, googleDocAction: null, googleDocErrorCode: "GOOGLE_DOC_WRITE_FAILED", googleDocAttemptedAt: NOW.toISOString() } });
    /** Approves one capture per call and bumps the version, as the backend does. */
    function liveBackend(canonical: ReportDraft) {
      let current = canonical; const calls: string[] = [];
      return { calls, get: () => current,
        approveImportedScreenshot: vi.fn(async (_id: string, type: ScreenshotType, input: { expectedVersion: number }) => { calls.push(`approve:${type}@${input.expectedVersion}`); current = { ...current, version: current.version + 1, screenshots: current.screenshots.map((shot) => shot.type === type ? { ...shot, approved: true, approvedAt: NOW.toISOString() } : shot) }; return current; }),
        applyEvent: vi.fn(async (_id: string, event: string, version: number) => { calls.push(`event:${event}@${version}`); current = { ...current, status: "ready_for_review" as const, version: current.version + 1 }; return current; }),
      };
    }

    const machineValidated = (draft: ReportDraft): ReportDraft => ({ ...draft, screenshots: draft.screenshots.map((shot) => ({ ...shot, automatedValidatedAt: NOW.toISOString() })) });

    it("generates the final PDF, Drive PDF and Google Doc automatically with no approval and no Generate click", async () => {
      const { canonical } = capturedNine();
      const generated = { ...machineValidated(canonical), status: "generated" as const, version: 13 };
      const autoGenerateFinalReport = vi.fn().mockResolvedValue({ report: generated, artifact: artifactFor(canonical.id, "uploaded", "synced") });
      const live = liveBackend(canonical);
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical), autoGenerateFinalReport, approveImportedScreenshot: live.approveImportedScreenshot, applyEvent: live.applyEvent, generatePdf: vi.fn(),
        getCurrentPdfArtifact: vi.fn().mockResolvedValue(artifactFor(canonical.id, "uploaded", "synced")) });
      withConfiguredDataDefinition(canonical, api);
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      await waitFor(() => expect(screen.getByLabelText("Final Client Report")).toHaveTextContent("Final PDFPASS"));
      expect(autoGenerateFinalReport).toHaveBeenCalledTimes(1);
      expect(autoGenerateFinalReport).toHaveBeenCalledWith(canonical.id, canonical.version, canonical.reportMonth);
      // Nothing was approved, submitted or generated through the human path.
      expect(live.approveImportedScreenshot).not.toHaveBeenCalled(); expect(live.applyEvent).not.toHaveBeenCalled(); expect(api.generatePdf).not.toHaveBeenCalled();
      const done = screen.getByLabelText("Final Client Report");
      expect(done).toHaveTextContent("Captured9/9"); expect(done).toHaveTextContent("Automated validationPASS");
      expect(done).toHaveTextContent("Google DrivePASS"); expect(done).toHaveTextContent("Google DocPASS"); expect(done).toHaveTextContent("Human reviewOptional");
      expect(within(done).getByRole("link", { name: "Open Drive PDF" })).toHaveAttribute("href", "https://drive.google.com/file/d/pdf-id/view");
      expect(within(done).getByRole("link", { name: "Open Editable Google Doc" })).toHaveAttribute("href", "https://docs.google.com/document/d/doc-id/edit");
      expect(within(done).queryByRole("button", { name: /Generate Final Report|Retry Final Report/ })).toBeNull();
      expect(screen.queryByText(/Approve all .* before generating/)).toBeNull();
    });

    it("keeps Review & Approve as optional QA after the automatic report; approving does not generate again", async () => {
      const { canonical, types } = capturedNine();
      const generated = { ...machineValidated(canonical), status: "generated" as const, version: 13 };
      const live = liveBackend(generated);
      const autoGenerateFinalReport = vi.fn(async (_id: string, version: number) => { live.calls.push(`auto@${version}`); return { report: live.get(), artifact: artifactFor(canonical.id, "uploaded", "synced") }; });
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([generated]), getReportDraft: vi.fn().mockResolvedValue(generated), getPendingImportedScreenshotImage: vi.fn().mockResolvedValue(new Blob(["png"])), approveImportedScreenshot: live.approveImportedScreenshot, applyEvent: live.applyEvent, generatePdf: vi.fn(), autoGenerateFinalReport,
        getCurrentPdfArtifact: vi.fn().mockResolvedValue(artifactFor(canonical.id, "uploaded", "synced")) });
      withConfiguredDataDefinition(generated, api); mockObjectUrls();
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      await waitFor(() => expect(screen.getByLabelText("Final Client Report")).toHaveTextContent("Final PDFPASS"));
      // A generated report with a current artifact is never generated again on open.
      expect(autoGenerateFinalReport).not.toHaveBeenCalled();
      const qa = screen.getByLabelText("Optional Human Review");
      await user.click(within(qa).getByRole("button", { name: "Review & Approve 9 Captures" }));
      expect(await screen.findAllByRole("img", { name: /^Saved .* capture$/ })).toHaveLength(9);
      await user.click(screen.getByRole("button", { name: "Approve All 9" }));
      await waitFor(() => expect(live.calls.at(-1)).toBe("auto@22"));
      expect(live.calls).toEqual([...types.map((type, index) => `approve:${type}@${13 + index}`), "auto@22"]);
      expect(live.applyEvent).not.toHaveBeenCalled(); expect(api.generatePdf).not.toHaveBeenCalled();
    });

    it("shows a failed backend validation with a retry, never recaptures, and keeps optional review showing the failing capture", async () => {
      const { canonical } = capturedNine();
      mockObjectUrls();
      const autoGenerateFinalReport = vi.fn().mockRejectedValue(new ApiError("REQUIRED_SCREENSHOT_ASSET_MISSING", "Automatic capture flow_metrics failed stored-byte verification (hash, size or dimensions); nothing was generated.", 400));
      const getPending = vi.fn(async (_id: string, type: ScreenshotType) => { if (type === "flow_metrics") throw new ApiError("IMPORTED_SCREENSHOT_REVIEW_REJECTED", "Imported screenshot source proof or period is stale or invalid.", 400); return new Blob(["png"]); });
      const service = automaticService({ status: "idle" } as never);
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical), getPendingImportedScreenshotImage: getPending, approveImportedScreenshot: vi.fn(), generatePdf: vi.fn(), autoGenerateFinalReport });
      withConfiguredDataDefinition(canonical, api);
      const user = userEvent.setup(); renderApp(api, undefined, undefined, service);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      expect(await screen.findByText(/Automatic final report failed: REQUIRED_SCREENSHOT_ASSET_MISSING: Automatic capture flow_metrics failed stored-byte verification/)).toBeInTheDocument();
      const final = screen.getByLabelText("Final Client Report");
      expect(final).toHaveTextContent("Automated validationFAIL"); expect(final).not.toHaveTextContent("Final PDFPASS");
      expect(service.start).not.toHaveBeenCalled();
      await user.click(within(final).getByRole("button", { name: "Retry Final Report" }));
      await waitFor(() => expect(autoGenerateFinalReport).toHaveBeenCalledTimes(2));
      expect(service.start).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Review & Approve 9 Captures" }));
      expect(await screen.findByText(/flow_metrics: Imported screenshot source proof or period is stale or invalid/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Approve All 9" })).toBeDisabled();
      expect(api.approveImportedScreenshot).not.toHaveBeenCalled(); expect(api.generatePdf).not.toHaveBeenCalled();
    });

    it("does not generate while a data blocker is open", async () => {
      const { canonical } = capturedNine();
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([canonical]), getReportDraft: vi.fn().mockResolvedValue(canonical), generatePdf: vi.fn(), autoGenerateFinalReport: vi.fn() });
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      const final = await screen.findByLabelText("Final Client Report");
      await waitFor(() => expect(final).toHaveTextContent("CONVERSION_METRIC_ID_NOT_CONFIGURED"));
      expect(final).toHaveTextContent("Automated validationBLOCKED");
      expect(screen.getByRole("button", { name: "Review & Approve 9 Captures" })).toBeDisabled();
      expect(api.autoGenerateFinalReport).not.toHaveBeenCalled();
    });

    it("regenerates automatically when a generated report's captures changed after generation", async () => {
      const { canonical } = capturedNine();
      const generated = { ...canonical, status: "generated" as const, version: 22 };
      const autoGenerateFinalReport = vi.fn(() => new Promise(() => undefined));
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([generated]), getReportDraft: vi.fn().mockResolvedValue(generated), getCurrentPdfArtifact: vi.fn().mockRejectedValue(new ApiError("PDF_ARTIFACT_STALE", "No current generated PDF exists.", 404)), autoGenerateFinalReport });
      withConfiguredDataDefinition(generated, api);
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      await waitFor(() => expect(autoGenerateFinalReport).toHaveBeenCalledWith(generated.id, 22, generated.reportMonth));
    });

    const generatedNine = () => { const { canonical } = capturedNine(); return { ...canonical, status: "generated" as const, version: 22, screenshots: canonical.screenshots.map((shot) => ({ ...shot, automatedValidatedAt: NOW.toISOString() })) }; };

    it("shows direct links to the Drive PDF, the editable Google Doc and the month folder — two different files", async () => {
      const generated = generatedNine();
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([generated]), getReportDraft: vi.fn().mockResolvedValue(generated), getCurrentPdfArtifact: vi.fn().mockResolvedValue(artifactFor(generated.id, "uploaded", "synced")), autoGenerateFinalReport: vi.fn() });
      withConfiguredDataDefinition(generated, api);
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      const files = await screen.findByLabelText("Report files");
      expect(within(files).getByRole("link", { name: "Open Drive PDF" })).toHaveAttribute("href", "https://drive.google.com/file/d/pdf-id/view");
      expect(within(files).getByRole("link", { name: "Open Editable Google Doc" })).toHaveAttribute("href", "https://docs.google.com/document/d/doc-id/edit");
      expect(within(files).getByRole("link", { name: "Open September 2026 Folder" })).toHaveAttribute("href", "https://drive.google.com/drive/folders/folder-id");
      const final = screen.getByLabelText("Final Client Report");
      expect(within(final).getByRole("button", { name: "Open Final PDF" })).toBeInTheDocument(); expect(within(final).getByRole("button", { name: "Download Final PDF" })).toBeInTheDocument();
      expect(within(final).queryByRole("button", { name: /Retry/ })).toBeNull();
    });

    it("keeps an existing Doc openable beside Retry when its sync failed", async () => {
      const generated = generatedNine();
      const failed = artifactFor(generated.id, "uploaded", "failed");
      const artifact = { ...failed, googleDoc: { ...failed.googleDoc, googleDocId: "doc-id", googleDocFolderId: "folder-id", googleDocWebViewLink: "https://docs.google.com/document/d/doc-id/edit", googleDocErrorCode: "GOOGLE_DOC_EDITED_IN_DRIVE" } };
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([generated]), getReportDraft: vi.fn().mockResolvedValue(generated), getCurrentPdfArtifact: vi.fn().mockResolvedValue(artifact), autoGenerateFinalReport: vi.fn() });
      withConfiguredDataDefinition(generated, api);
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      const files = await screen.findByLabelText("Report files");
      expect(within(files).getByRole("link", { name: "Open Existing Google Doc" })).toHaveAttribute("href", "https://docs.google.com/document/d/doc-id/edit");
      expect(within(screen.getByLabelText("Final Client Report")).getByRole("button", { name: "Retry Google Doc" })).toBeInTheDocument();
    });

    it("never adopts an unverified Doc by itself: it shows it, and adopts that exact Doc only on Adopt Existing Doc", async () => {
      const generated = generatedNine();
      const failed = artifactFor(generated.id, "uploaded", "failed");
      const candidate = { ...failed, googleDoc: { ...failed.googleDoc, googleDocErrorCode: "GOOGLE_DOC_NOT_TENTION_MANAGED", googleDocFolderId: "folder-id", googleDocCandidateId: "found-doc", googleDocCandidateWebViewLink: "https://docs.google.com/document/d/found-doc/edit" } };
      const adoptGoogleDoc = vi.fn().mockResolvedValue(artifactFor(generated.id, "uploaded", "synced"));
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([generated]), getReportDraft: vi.fn().mockResolvedValue(generated), getCurrentPdfArtifact: vi.fn().mockResolvedValue(candidate), adoptGoogleDoc, retryGoogleDoc: vi.fn(), autoGenerateFinalReport: vi.fn() });
      withConfiguredDataDefinition(generated, api);
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      const notice = await screen.findByLabelText("Unverified Google Doc");
      expect(notice).toHaveTextContent("Existing Google Doc found but not verified as Tention-managed.");
      expect(within(notice).getByRole("link", { name: "Open Existing Google Doc" })).toHaveAttribute("href", "https://docs.google.com/document/d/found-doc/edit");
      expect(adoptGoogleDoc).not.toHaveBeenCalled();
      await user.click(within(notice).getByRole("button", { name: "Adopt Existing Doc" }));
      await waitFor(() => expect(adoptGoogleDoc).toHaveBeenCalledWith(generated.id, "found-doc"));
      await waitFor(() => expect(screen.getByLabelText("Final Client Report")).toHaveTextContent("Google DocPASS"));
      expect(screen.queryByLabelText("Unverified Google Doc")).toBeNull();
      expect(api.retryGoogleDoc).not.toHaveBeenCalled();
    });

    it("retries only Drive, then only the Google Doc, from the existing PDF without generating again", async () => {
      const { canonical } = capturedNine();
      const generated = { ...canonical, status: "generated" as const, version: 22, screenshots: canonical.screenshots.map((shot) => ({ ...shot, approved: true, approvedAt: NOW.toISOString() })) };
      const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([generated]), getReportDraft: vi.fn().mockResolvedValue(generated), getCurrentPdfArtifact: vi.fn().mockResolvedValue(artifactFor(generated.id, "failed", "failed")),
        retryDriveDelivery: vi.fn().mockResolvedValue(artifactFor(generated.id, "uploaded", "failed")), retryGoogleDoc: vi.fn().mockResolvedValue(artifactFor(generated.id, "uploaded", "synced")), generatePdf: vi.fn(), autoGenerateFinalReport: vi.fn() });
      withConfiguredDataDefinition(generated, api);
      const user = userEvent.setup(); renderApp(api);
      await user.click(await screen.findByRole("button", { name: "Open Report" }));
      const final = screen.getByLabelText("Final Client Report");
      await waitFor(() => expect(final).toHaveTextContent("Google DriveFAIL · DRIVE_UPLOAD_FAILED"));
      expect(final).toHaveTextContent("Final PDFPASS");
      await user.click(within(final).getByRole("button", { name: "Retry Google Drive upload" }));
      await waitFor(() => expect(screen.getByLabelText("Final Client Report")).toHaveTextContent("Google DrivePASS"));
      await user.click(within(screen.getByLabelText("Final Client Report")).getByRole("button", { name: "Retry Google Doc" }));
      await waitFor(() => expect(screen.getByLabelText("Final Client Report")).toHaveTextContent("Google DocPASS"));
      expect(api.retryDriveDelivery).toHaveBeenCalledWith(generated.id); expect(api.retryGoogleDoc).toHaveBeenCalledWith(generated.id);
      expect(api.generatePdf).not.toHaveBeenCalled(); expect(api.autoGenerateFinalReport).not.toHaveBeenCalled();
    });
  });

  it("always shows which client, month and periods the open report is for", async () => {
    const report = runnerReport();
    renderApp(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]), getReportDraft: vi.fn().mockResolvedValue(report) }));
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open Report" }));
    const header = document.querySelector(".period-preview")!;
    expect(header).toHaveTextContent(`Client${report.client.name}`);
    expect(header).toHaveTextContent(`Report Month${formatReportMonth(report.reportMonth)}`);
    expect(header).toHaveTextContent(`Reporting Period${formatCalendarRange(report.period.startDate, report.period.endDate)}`);
    expect(header).toHaveTextContent(`Previous Comparison${formatCalendarRange(report.period.previousStartDate, report.period.previousEndDate)}`);
  });
  it("generates the final client report for the displayed month automatically and shows the PDF, Drive PDF and Google Doc results with links", async () => {
    const ready = { ...runnerReport(runnerScreenshotTypes), status: "ready_for_review" as const, version: 11 };
    ready.client = { ...ready.client, currency: "USD" };
    const generated = { ...ready, status: "generated" as const, version: 12 };
    const artifact = { id: "c0000000-0000-4000-8000-000000000001", reportId: ready.id, storageKey: `reports/${ready.id}/artifacts/a.pdf`, mimeType: "application/pdf" as const, byteSize: 10, sha256: "b".repeat(64), sourceFingerprint: "c".repeat(64), templateVersion: "monthly-report-v1", generatedAt: NOW.toISOString(),
      driveDelivery: { driveUploadStatus: "uploaded" as const, driveFileName: "Report - August 2026.pdf", driveFileId: "pdf-id", driveFolderId: "folder-id", driveWebViewLink: "https://drive.google.com/file/d/pdf-id/view", driveUploadedAt: NOW.toISOString(), driveUploadAction: "created" as const, driveErrorCode: null, driveAttemptedAt: NOW.toISOString() },
      googleDoc: { googleDocStatus: "synced" as const, googleDocName: "Report - August 2026", googleDocId: "doc-id", googleDocFolderId: "folder-id", googleDocWebViewLink: "https://docs.google.com/document/d/doc-id/edit", googleDocUpdatedAt: NOW.toISOString(), googleDocVersion: "3", googleDocAction: "created" as const, googleDocErrorCode: null, googleDocAttemptedAt: NOW.toISOString() } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([ready]), getReportDraft: vi.fn().mockResolvedValue(ready), generatePdf: vi.fn(), autoGenerateFinalReport: vi.fn().mockResolvedValue({ report: generated, artifact }), getCurrentPdfArtifact: vi.fn().mockResolvedValue(artifact) });
    withConfiguredDataDefinition(ready, api);
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await waitFor(() => expect(api.autoGenerateFinalReport).toHaveBeenCalledWith(ready.id, ready.version, ready.reportMonth));
    expect(api.generatePdf).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByLabelText("Final Client Report")).toHaveTextContent("Final PDFPASS"));
    const done = screen.getByLabelText("Final Client Report");
    expect(done).toHaveTextContent("Google DrivePASS"); expect(done).toHaveTextContent("Google DocPASS");
    expect(within(done).getByRole("link", { name: "Open Drive PDF" })).toHaveAttribute("href", "https://drive.google.com/file/d/pdf-id/view");
    expect(within(done).getByRole("link", { name: "Open Editable Google Doc" })).toHaveAttribute("href", "https://docs.google.com/document/d/doc-id/edit");
    expect(within(done).queryByRole("button", { name: /Retry|Generate Final Report/ })).toBeNull();
    expect(within(done).getByRole("button", { name: "Open Final PDF" })).toBeInTheDocument();
  });
  it("does not generate at 9/9 approved and reviewed while currency and the Placed Order metric ID are unconfigured", async () => {
    const ready = { ...runnerReport(runnerScreenshotTypes), status: "ready_for_review" as const, version: 11 };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([ready]), getReportDraft: vi.fn().mockResolvedValue(ready), generatePdf: vi.fn(), autoGenerateFinalReport: vi.fn() });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    const final = screen.getByLabelText("Final Client Report");
    await waitFor(() => expect(final).toHaveTextContent("Final PDFBLOCKED"));
    expect(within(final).queryByRole("button", { name: /Generate Final Report|Retry Final Report/ })).toBeNull();
    expect(api.autoGenerateFinalReport).not.toHaveBeenCalled();
    expect(final).toHaveTextContent("CURRENCY_NOT_CONFIGURED");
    expect(final).toHaveTextContent("CONVERSION_METRIC_ID_NOT_CONFIGURED");
    expect(api.generatePdf).not.toHaveBeenCalled();
  });
  it("applies the client's verified profile currency to a report frozen with none, changing only the currency", async () => {
    const ready = { ...runnerReport(runnerScreenshotTypes), status: "ready_for_review" as const, version: 11 };
    const withCurrency = { ...ready, client: { ...ready.client, currency: "USD" }, version: 12 };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([ready]), getReportDraft: vi.fn().mockResolvedValue(ready), applyClientProfileCurrency: vi.fn().mockResolvedValue(withCurrency), generatePdf: vi.fn(), autoGenerateFinalReport: vi.fn(() => new Promise(() => undefined)) });
    withConfiguredDataDefinition(ready, api);
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    const final = screen.getByLabelText("Final Client Report");
    expect(final).toHaveTextContent("CURRENCY_NOT_CONFIGURED");
    await user.click(await within(final).findByRole("button", { name: "Apply client currency (USD) to this report" }));
    expect(api.applyClientProfileCurrency).toHaveBeenCalledWith(ready.id, ready);
    await waitFor(() => expect(screen.getByLabelText("Final Client Report")).not.toHaveTextContent("CURRENCY_NOT_CONFIGURED"));
    // Once the data definition is complete the final report starts on its own.
    await waitFor(() => expect(api.autoGenerateFinalReport).toHaveBeenCalledWith(ready.id, withCurrency.version, ready.reportMonth));
    expect(api.generatePdf).not.toHaveBeenCalled();
  });
  it("shows REPORT_MONTH_MISMATCH and no results when the backend refuses a month mismatch", async () => {
    const ready = { ...runnerReport(runnerScreenshotTypes), status: "ready_for_review" as const, version: 11 };
    ready.client = { ...ready.client, currency: "USD" };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([ready]), getReportDraft: vi.fn().mockResolvedValue(ready), autoGenerateFinalReport: vi.fn().mockRejectedValue(new ApiError("REPORT_MONTH_MISMATCH", "The report month is inconsistent.", 409)) });
    withConfiguredDataDefinition(ready, api);
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText(/REPORT_MONTH_MISMATCH: The report month is inconsistent/)).toBeInTheDocument();
    const final = screen.getByLabelText("Final Client Report");
    expect(final).not.toHaveTextContent("Final PDFPASS"); expect(final).not.toHaveTextContent("Google DrivePASS");
    expect(within(final).queryByRole("link")).toBeNull();
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
    awaitingReview.client = { ...awaitingReview.client, currency: "USD" };
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
  it("returns to the clients screen without deleting the current report when starting a new report", async () => {
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([report]) });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: "Start New Report" }));
    expect(await screen.findByRole("heading", { name: "Clients" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add New Client" })).toBeInTheDocument();
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
    expect(await screen.findByRole("status")).toHaveTextContent("August 2026 report deleted.");
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
    expect(await screen.findByRole("status")).toHaveTextContent("August 2026 report deleted.");
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
    await screen.findByRole("heading", { name: "Automatic capture paused" }, { timeout: 10_000 }); // attempt 5 includes the bounded cool-down
    expect(service.start).toHaveBeenCalledTimes(5);
    expect(api.startLocalAutomaticCaptureRun).toHaveBeenCalledOnce();
    expect(api.saveLocalAutomaticCaptureSection).toHaveBeenCalledTimes(10);
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
    expect(screen.getByText("Fresh captures: 0 / 9 successful", { exact: false })).toBeInTheDocument();
    expect(screen.getAllByText("Not started")).toHaveLength(8);
  }, 15_000);
  it("saves the Subscriber Growth source once from the authorized tab, then runs all ten sections in order", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = rememberingTargets(mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    }));
    // A lost toolbar grant is permanent, so the run stops at once at section 1 of 10.
    const service: AutoCaptureService = {
      start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "ACTION_NOT_INVOKED" as const, message: "Click the toolbar icon." })),
      get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined),
    };
    const discoverSubscriberGrowth = vi.fn().mockResolvedValue({ ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/discovered-subscriber-growth", accountLabels: ["Account AutoLEDTech.com"] });
    const user = userEvent.setup();
    render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }} automaticCaptureService={service} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(discoverSubscriberGrowth)} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.getByText("10 supported sections")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture · 10 sections/ }));
    await screen.findByRole("heading", { name: "Automatic capture paused" }, { timeout: 10_000 });
    expect(discoverSubscriberGrowth).toHaveBeenCalledOnce();
    expect(api.saveClientReportTargets).toHaveBeenCalledWith("autoled", expect.objectContaining({ sourceUrls: expect.objectContaining({ subscriberGrowthUrl: "https://www.klaviyo.com/discovered-subscriber-growth" }) }));
    expect(screen.getByText("Fresh captures: 0 / 10 successful", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("10/10 Subscriber Growth")).toBeInTheDocument();
  });
  it("reuses a saved Subscriber Growth source without rediscovering it", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      getClientReportTargets: vi.fn().mockResolvedValue({ clientId: "autoled", profile: { name: "AutoLEDTech.com", timezone: "America/New_York", currency: null, conversionMetric: { label: "Placed Order", providerMetricId: null }, sections: null }, businessReview: null, sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/saved-subscriber-growth" }, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, welcomeFlowListing: null, customerSegment: null, nonCustomerSegment: null, signupForms: null, createdAt: null, updatedAt: null }),
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    });
    const service: AutoCaptureService = { start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "ACTION_NOT_INVOKED" as const, message: "Click the toolbar icon." })), get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined) };
    const discoverSubscriberGrowth = vi.fn();
    const user = userEvent.setup();
    render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }} automaticCaptureService={service} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(discoverSubscriberGrowth)} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText(/Verified Subscriber growth source saved for this client/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture · 10 sections/ }));
    await screen.findByRole("heading", { name: "Automatic capture paused" }, { timeout: 10_000 });
    expect(discoverSubscriberGrowth).not.toHaveBeenCalled();
  });
  it("blocks a ten-section run when the authorized tab is not Subscriber growth → Email → Growth", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), startLocalAutomaticCaptureRun: vi.fn() });
    const discoverSubscriberGrowth = vi.fn().mockResolvedValue({ ok: false, code: "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED", message: "Select the Growth view under Email on Subscriber growth, then click the Tention toolbar icon again." });
    const user = userEvent.setup();
    render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }} automaticCaptureService={{ start: vi.fn(), get: vi.fn().mockResolvedValue(null), clear: vi.fn() }} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(discoverSubscriberGrowth)} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture · 10 sections/ }));
    expect(await screen.findByText(/SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED/)).toBeInTheDocument();
    expect(api.startLocalAutomaticCaptureRun).not.toHaveBeenCalled();
    expect(vi.mocked(api.saveClientReportTargets).mock.calls.some(([, input]) => Boolean((input as { sourceUrls?: { subscriberGrowthUrl?: string } }).sourceUrls?.subscriberGrowthUrl))).toBe(false);
  });
  it("keeps an existing nine-section report at nine sections until Section 10 is added explicitly", async () => {
    const initial = runnerReport();
    const enabled: ReportDraft = { ...initial, version: initial.version + 1, sections: { ...initial.sections, email_subscriber_growth: "required" } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), enableSubscriberGrowthSection: vi.fn().mockResolvedValue(enabled) });
    const user = userEvent.setup(); renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(screen.getByText("9 supported sections")).toBeInTheDocument();
    expect(screen.queryByText("Subscriber Growth")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Section 10 · Subscriber Growth" }));
    expect(api.enableSubscriberGrowthSection).toHaveBeenCalledWith(initial.id, initial.version);
    expect(await screen.findByText("10 supported sections")).toBeInTheDocument();
  });
  it("resumes only Section 10 when sections 1–9 are already captured, keeping their evidence", async () => {
    const initial: ReportDraft = { ...runnerReport(runnerScreenshotTypes), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = rememberingTargets(mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), uploadScreenshotImage: vi.fn(),
    }), { sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/saved-subscriber-growth" } });
    const service: AutoCaptureService = { start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "ACTION_NOT_INVOKED" as const, message: "Click the toolbar icon." })), get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined) };
    const user = userEvent.setup();
    render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }} automaticCaptureService={service} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(vi.fn())} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await user.click(await screen.findByRole("button", { name: "Resume Automatic Capture · Subscriber Growth" }));
    await screen.findByRole("heading", { name: "Automatic capture paused" }, { timeout: 10_000 });
    expect(api.startLocalAutomaticCaptureRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "resume", plannedSections: ["email_subscriber_growth"] }));
    expect(vi.mocked(service.start).mock.calls.map(([request]) => request.screenshotType)).toEqual(["email_subscriber_growth"]);
    expect(screen.getByText("10/10 Subscriber Growth")).toBeInTheDocument();
    expect(screen.queryByText(/Executive Summary/)).not.toBeInTheDocument();
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
  });
  it.each([["Flow Performance", "flow_performance"], ["Campaign Metrics", "campaign_metrics"]] as const)("retakes only %s while it is captured but pending review, without rerunning the other sections", async (label, type) => {
    const initial = runnerReport(runnerScreenshotTypes);
    initial.screenshots = initial.screenshots.map((shot) => ({ ...shot, approved: false, approvedAt: null, captureOrigin: "live_acceptance_import" as const }));
    const api = rememberingTargets(mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), uploadScreenshotImage: vi.fn(), approveImportedScreenshot: vi.fn(),
    }));
    const service: AutoCaptureService = { start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "ACTION_NOT_INVOKED" as const, message: "Click the toolbar icon." })), get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined) };
    const user = userEvent.setup();
    const { container } = render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }} automaticCaptureService={service} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(vi.fn())} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    // Every captured, pending required section offers its own retake next to its review.
    await screen.findAllByRole("button", { name: "Retake saved capture" });
    const checklist = [...container.querySelectorAll<HTMLElement>(".runner-checklist")].find((list) => !list.closest("[aria-label='Automatic Capture Progress']"))!;
    expect(within(checklist).getAllByRole("button", { name: "Retake saved capture" })).toHaveLength(runnerScreenshotTypes.length);
    expect(screen.queryByRole("button", { name: /^Resume Automatic Capture/ })).not.toBeInTheDocument();
    const row = within(checklist).getByText(label, { selector: "strong" }).closest("li")!;
    await user.click(within(row).getByRole("button", { name: "Retake saved capture" }));
    await screen.findByRole("heading", { name: "Automatic capture paused" }, { timeout: 10_000 });
    // A resume run planned for exactly this section; nothing else is captured, uploaded, or approved.
    expect(api.startLocalAutomaticCaptureRun).toHaveBeenCalledWith(expect.objectContaining({ mode: "resume", plannedSections: [type] }));
    expect(vi.mocked(service.start).mock.calls.map(([request]) => request.screenshotType)).toEqual([type]);
    expect(api.uploadScreenshotImage).not.toHaveBeenCalled();
    expect(api.approveImportedScreenshot).not.toHaveBeenCalled();
  });
  it("offers no pending retake for an approved section; approved evidence keeps its own Retake", async () => {
    const initial = runnerReport(runnerScreenshotTypes);
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial), startLocalAutomaticCaptureRun: vi.fn() });
    const user = userEvent.setup(); const { container } = renderApp(api);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await screen.findAllByRole("button", { name: "Retake" });
    expect(within([...container.querySelectorAll<HTMLElement>(".runner-checklist")].find((list) => !list.closest("[aria-label='Automatic Capture Progress']"))!).getAllByRole("button", { name: "Retake" })).toHaveLength(runnerScreenshotTypes.length);
    expect(screen.queryByRole("button", { name: "Retake saved capture" })).not.toBeInTheDocument();
  });
  it("saves the Subscriber Growth source from one toolbar click, confirmed by reloading the client configuration", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = rememberingTargets(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }));
    let notify: () => void = () => undefined;
    let verified = false;
    const take = vi.fn(async () => verified ? { ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/clicked-subscriber-growth", accountLabels: ["AutoLEDTech.com"] } : { ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED", message: "Click the toolbar icon." });
    const persisted = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();
    render(<App api={api} automaticCaptureService={automaticService(null as never)} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={{ take: take as never, persisted, watch: (callback) => { notify = callback; return () => undefined; } }} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText(/Not yet saved · open Audience → Profiles/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    verified = true; notify(); // the service worker verified the clicked Email → Growth tab
    expect(await screen.findByText(/Verified Subscriber growth source saved for this client/)).toBeInTheDocument();
    expect(api.saveClientReportTargets).toHaveBeenCalledWith("autoled", expect.objectContaining({ sourceUrls: expect.objectContaining({ subscriberGrowthUrl: "https://www.klaviyo.com/clicked-subscriber-growth" }) }));
    expect(persisted).toHaveBeenLastCalledWith({ saved: true, sourceUrl: "https://www.klaviyo.com/clicked-subscriber-growth", failureCode: null });
  });
  it("never saves a verified Subscriber Growth page from another client's Klaviyo account", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = rememberingTargets(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }));
    const persisted = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();
    render(<App api={api} automaticCaptureService={automaticService(null as never)} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(vi.fn().mockResolvedValue({ ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/other", accountLabels: ["Club Furniture"] }), persisted)} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText(/could not be proven to be AutoLEDTech.com/)).toBeInTheDocument();
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    expect(persisted).toHaveBeenLastCalledWith({ saved: false, sourceUrl: "https://www.klaviyo.com/other", failureCode: "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN" });
  });
  it("does not mark the source configured when the reloaded client configuration does not confirm it", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) });
    const persisted = vi.fn().mockResolvedValue(null);
    const user = userEvent.setup();
    render(<App api={api} automaticCaptureService={automaticService(null as never)} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(vi.fn().mockResolvedValue({ ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/clicked", accountLabels: ["AutoLEDTech.com"] }), persisted)} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText("The client configuration did not confirm the saved Subscriber Growth source.")).toBeInTheDocument();
    expect(screen.queryByText(/Verified Subscriber growth source saved/)).not.toBeInTheDocument();
    expect(persisted).toHaveBeenLastCalledWith({ saved: false, sourceUrl: "https://www.klaviyo.com/clicked", failureCode: "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED" });
  });
  it("keeps a saved Business Review binding when the Subscriber Growth source is saved", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const businessReview = { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/verified-test-source", displayName: "Business Review", accountLabel: "AutoLEDTech.com" };
    const api = rememberingTargets(mockApi({ listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial) }), { businessReview });
    const user = userEvent.setup();
    render(<App api={api} automaticCaptureService={automaticService(null as never)} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(vi.fn().mockResolvedValue({ ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers", accountLabels: ["AutoLEDTech.com"] }))} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    expect(await screen.findByText(/Verified Subscriber growth source saved for this client/)).toBeInTheDocument();
    expect(api.saveClientReportTargets).toHaveBeenCalledWith("autoled", expect.objectContaining({ businessReview: expect.objectContaining(businessReview), sourceUrls: expect.objectContaining({ subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" }) }));
  });
  it("keeps a saved Subscriber Growth source when Business Review is saved later", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = rememberingTargets(mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    }), { sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" } });
    const service: AutoCaptureService = { start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "ACTION_NOT_INVOKED" as const, message: "Click the toolbar icon." })), get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined) };
    const user = userEvent.setup();
    render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }} automaticCaptureService={service} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(vi.fn())} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await screen.findByText(/Verified Subscriber growth source saved for this client/);
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture · 10 sections/ }));
    await screen.findByRole("heading", { name: "Automatic capture paused" }, { timeout: 10_000 });
    const businessReviewSave = vi.mocked(api.saveClientReportTargets).mock.calls.find(([, input]) => Boolean((input as { businessReview?: unknown }).businessReview));
    expect(businessReviewSave?.[1]).toMatchObject({ sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" } });
  });
  it("never loses the Subscriber Growth source when Start runs the Business Review preflight while the source is still saving", async () => {
    const initial: ReportDraft = { ...runnerReport(), sections: { ...NINE_SECTION_CONFIGURATION, email_subscriber_growth: "required" } };
    const api = rememberingTargets(mockApi({
      listReportDrafts: vi.fn().mockResolvedValue([initial]), getReportDraft: vi.fn().mockResolvedValue(initial),
      startLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined), saveLocalAutomaticCaptureSection: vi.fn().mockResolvedValue(undefined),
      saveLocalAutomaticCaptureEvidence: vi.fn(), finishLocalAutomaticCaptureRun: vi.fn().mockResolvedValue(undefined),
    }));
    // The automatic save on opening the report is slow: Start is clicked while it is still in flight.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const take = vi.fn(async () => { await held; return { ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers", accountLabels: ["AutoLEDTech.com"] }; });
    const service: AutoCaptureService = { start: vi.fn().mockImplementation(async (request) => ({ request, stage: "failed" as const, code: "ACTION_NOT_INVOKED" as const, message: "Click the toolbar icon." })), get: vi.fn().mockResolvedValue(null), clear: vi.fn().mockResolvedValue(undefined) };
    const user = userEvent.setup();
    render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() }} automaticCaptureService={service} discoverBusinessReviewSource={testDiscovery} subscriberGrowthSource={sourceHooks(take)} now={() => new Date(NOW)} />);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    await vi.waitFor(() => expect(take).toHaveBeenCalledOnce());
    const start = user.click(screen.getByRole("button", { name: /Start Automatic Capture · 10 sections/ }));
    release();
    await start;
    await screen.findByRole("heading", { name: "Automatic capture paused" }, { timeout: 10_000 });
    expect(take).toHaveBeenCalledOnce();
    const finalConfig = await api.getClientReportTargets("autoled");
    expect(finalConfig).toMatchObject({ sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" }, businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/verified-test-source" } });
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

  const noGrant = { ok: false as const, code: "ACTION_NOT_INVOKED" as const, message: "Open the intended client’s Klaviyo account and click the Tention Reports extension before discovery." };
  const wrongAccount = { ok: false as const, code: "ACCOUNT_CONTEXT_MISMATCH" as const, message: "The authenticated Klaviyo account differs from this client’s saved account binding. No dashboard URL was saved." };
  /** Renders with an injectable Tention Reports toolbar click (the activeTab grant event). */
  function renderWithToolbar(api: ApiClient, service: AutoCaptureService, discovery: ReturnType<typeof vi.fn>) {
    const listeners = new Set<() => void>();
    const watchToolbarClick = vi.fn((callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); });
    render(<App api={api} captureService={{ getActiveTab: vi.fn(), captureVisibleTab: vi.fn() } as never} automaticCaptureService={service} discoverBusinessReviewSource={discovery as never} watchToolbarClick={watchToolbarClick} now={() => new Date(NOW)} />);
    return { clickToolbar: () => act(() => { for (const listener of listeners) listener(); }) };
  }

  it("a configured client without a toolbar grant needs Klaviyo tab access, not client setup", async () => {
    const discovery = vi.fn().mockResolvedValue(noGrant);
    const { api, service } = setup(savedTargets, discovery); renderWithToolbar(api, service, discovery);
    await openAndStart();
    const notice = await screen.findByRole("alert", { name: "Klaviyo tab access required" });
    expect(notice).toHaveTextContent("Open Acme Home in Klaviyo and click the Tention Reports extension once to continue.");
    expect(screen.queryByText(/Client setup needs attention/)).toBeNull();
    expect(service.start).not.toHaveBeenCalled();
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
  });

  it("continues the pending start by itself after one toolbar click, re-verifying the saved account first", async () => {
    const discovery = vi.fn().mockResolvedValueOnce(noGrant).mockResolvedValueOnce(accountVerified);
    const { api, service } = setup(savedTargets, discovery); const toolbar = renderWithToolbar(api, service, discovery);
    await openAndStart();
    await screen.findByRole("alert", { name: "Klaviyo tab access required" });
    expect(service.start).not.toHaveBeenCalled();
    await toolbar.clickToolbar();
    // No second Start click: the grant resumes the same start, and the saved account is proven again first.
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "overview" })));
    expect(discovery).toHaveBeenCalledTimes(2);
    expect(discovery).toHaveBeenLastCalledWith(expect.objectContaining({ clientName: "Acme Home", configuredUrl: savedUrl, verifySavedAccountOnly: true }));
    expect(screen.queryByRole("alert", { name: "Klaviyo tab access required" })).toBeNull();
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
  });

  it("does nothing on a toolbar click when no start is waiting", async () => {
    const discovery = vi.fn().mockResolvedValue(accountVerified);
    const { api, service } = setup(savedTargets, discovery); const toolbar = renderWithToolbar(api, service, discovery);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Open Report" }));
    await screen.findByRole("button", { name: /Start Automatic Capture/ });
    await toolbar.clickToolbar();
    expect(discovery).not.toHaveBeenCalled(); expect(service.start).not.toHaveBeenCalled();
  });

  it("fails closed when another client's Klaviyo account is open, also after a toolbar click on that account", async () => {
    const discovery = vi.fn().mockResolvedValue(wrongAccount);
    const { api, service } = setup(savedTargets, discovery); const toolbar = renderWithToolbar(api, service, discovery);
    await openAndStart();
    const notice = await screen.findByRole("alert", { name: "Wrong Klaviyo account" });
    expect(notice).toHaveTextContent("could not be verified as Acme Home. Nothing was captured.");
    expect(notice).toHaveTextContent("ACCOUNT_CONTEXT_MISMATCH");
    await toolbar.clickToolbar();
    await waitFor(() => expect(discovery).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alert", { name: "Wrong Klaviyo account" })).toBeInTheDocument();
    expect(service.start).not.toHaveBeenCalled();
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    expect(screen.queryByText(/Client setup needs attention/)).toBeNull();
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
    await waitFor(() => expect(api.saveClientReportTargets).toHaveBeenCalledWith("acme-home", expect.objectContaining({ businessReview: expect.objectContaining({ dashboardUrl: savedUrl, accountLabel: "Acme Home" }) })));
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
    // Genuinely missing configuration is reported as such, never as a Klaviyo tab-access step.
    expect(screen.queryByRole("alert", { name: "Klaviyo tab access required" })).toBeNull();
    expect(service.start).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Client timezone"), "America/Chicago");
    await user.click(screen.getByRole("button", { name: "Save Client Timezone" }));
    await waitFor(() => expect(api.saveClientReportTargets).toHaveBeenCalledWith("gamma-supply", expect.objectContaining({ profile: expect.objectContaining({ name: "Gamma Supply", timezone: "America/Chicago" }) })));
    expect(await screen.findByText("America/Chicago · saved client configuration")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Start Automatic Capture/ }));
    await waitFor(() => expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ screenshotType: "overview", accountUrl: "https://www.klaviyo.com/dashboard" })));
  });
});


describe("client onboarding (phase 1) before monthly reports (phase 2)", () => {
  const ONBOARDING_NOW = new Date("2026-11-06T12:00:00Z");
  const READY_SOURCES = { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" };
  const STEVEN_REVIEW = { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01SDBR", displayName: "Business Review", accountLabel: "Steven Dann" };
  const targets = (clientId: string, value: Record<string, unknown>) => clientReportTargetsSchema.parse({ clientId, createdAt: null, updatedAt: null, ...value });
  const club = () => targets("club-furniture", { profile: { name: "Club Furniture", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "KyqTnx" }, sections: null }, businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01CF", displayName: "Business Review", accountLabel: "CL Club Furniture" }, sourceUrls: READY_SOURCES });
  const readySteven = () => targets("steven-dann", { profile: { name: "Steven Dann", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "SDmet1" }, sections: null }, businessReview: STEVEN_REVIEW, sourceUrls: READY_SOURCES });

  /** A stateful fake of the API's client endpoints, computing status with the same shared validator the API uses. */
  function backend(initial: ClientReportTargets[] = [], drafts: ReportDraft[] = []) {
    const store = new Map(initial.map((value) => [value.clientId, value]));
    const summary = (value: ClientReportTargets) => { const blockers = clientSetupBlockers(value, [...store.values()]); return { clientId: value.clientId, name: value.profile?.name ?? value.clientId, status: clientSetupStatus(blockers), blockers, setup: structuredClone(value) }; };
    const reports = [...drafts];
    const api = mockApi({
      listClientSetups: vi.fn(async () => [...store.values()].filter(({ profile }) => profile).map(summary).sort((a, b) => a.name.localeCompare(b.name))),
      getClientSetup: vi.fn(async (clientId: string) => summary(store.get(clientId)!)),
      createClient: vi.fn(async (name: string) => {
        const clientId = deriveNewClientId(name);
        if (store.get(clientId)?.profile) throw new ApiError("CLIENT_ALREADY_EXISTS", `${name} already exists.`, 409, { error: "CLIENT_ALREADY_EXISTS", clientId });
        store.set(clientId, targets(clientId, { profile: { name, timezone: null } }));
        return summary(store.get(clientId)!);
      }),
      getClientReportTargets: vi.fn(async (clientId: string) => structuredClone(store.get(clientId) ?? targets(clientId, {}))),
      saveClientReportTargets: vi.fn(async (clientId: string, input: Record<string, unknown>) => {
        const metricId = (input.profile as ClientReportTargets["profile"])?.conversionMetric.providerMetricId;
        if (metricId && [...store.values()].some((other) => other.clientId !== clientId && other.profile?.conversionMetric.providerMetricId === metricId)) throw new ApiError("CONVERSION_METRIC_ID_ALREADY_BOUND", "This Klaviyo metric ID is already saved on another client.", 409);
        store.set(clientId, targets(clientId, input)); return structuredClone(store.get(clientId)!);
      }),
      listReportDrafts: vi.fn(async (filters?: { clientId?: string; year?: number; month?: number }) => reports.filter((draft) => (!filters?.clientId || draft.client.id === filters.clientId) && (!filters?.month || draft.reportMonth.month === filters.month))),
      createReportDraft: vi.fn(async (request: { client: { id: string }; reportMonth: { year: number; month: number }; sections: Record<string, string> }) => {
        const value = store.get(request.client.id)!;
        const blockers = clientSetupBlockers(value, [...store.values()]);
        if (blockers.length) throw new ApiError("CLIENT_SETUP_INCOMPLETE", "Client setup is incomplete.", 409, { error: "CLIENT_SETUP_INCOMPLETE", blockers });
        if (reports.some((draft) => draft.client.id === request.client.id && draft.reportMonth.month === request.reportMonth.month)) throw new ApiError("REPORT_DRAFT_ALREADY_EXISTS", "duplicate", 409);
        const created: ReportDraft = { ...report, id: "33333333-3333-4333-8333-333333333333", client: clientReportSnapshot(value), reportMonth: request.reportMonth as ReportDraft["reportMonth"], period: { startDate: "2026-10-01", endDate: "2026-10-31", previousStartDate: "2026-09-01", previousEndDate: "2026-09-30" }, sections: request.sections as ReportDraft["sections"] };
        reports.push(created); return created;
      }),
    });
    api.getReportDraft = vi.fn(async (id: string) => reports.find((draft) => draft.id === id) ?? report) as ApiClient["getReportDraft"];
    // Mirrors DELETE /clients/:clientId/reports/:reportId: one report only, never the client; Drive files are never deleted.
    api.deleteClientReport = vi.fn(async (clientId: string, reportId: string) => {
      const index = reports.findIndex((draft) => draft.id === reportId);
      if (index < 0) throw new ApiError("REPORT_NOT_FOUND", "This report no longer exists.", 404);
      if (reports[index]!.client.id !== clientId) throw new ApiError("REPORT_CLIENT_MISMATCH", "This report belongs to another client.", 409);
      if (reports[index]!.status === "generating") throw new ApiError("REPORT_DELETE_BLOCKED_GENERATING", "This report is currently generating. Try again after generation finishes.", 409);
      const [removed] = reports.splice(index, 1);
      return { reportId, driveFilesRetained: removed!.status === "generated" ? 2 : 0 };
    }) as ApiClient["deleteClientReport"];
    return { api, store, reports };
  }
  function discoveryFakes() {
    const toolbar: Array<() => void> = []; const metricWatchers: Array<() => void> = [];
    const sources = {
      verifyDeliverability: vi.fn(async () => ({ ok: true as const, deliverabilityUrl: READY_SOURCES.deliverabilityUrl, accountLabel: "Steven Dann" })),
      takeConversionMetric: vi.fn(async () => ({ ok: true as const, metricId: "SDmet1", headings: ["Placed Order"], title: "Placed Order | Klaviyo", accountLabels: ["Steven Dann"], sourceUrl: "https://www.klaviyo.com/metric/SDmet1/placed-order" })),
      watchConversionMetric: (callback: () => void) => { metricWatchers.push(callback); return () => undefined; },
    } satisfies ClientSetupSources;
    const subscriberGrowth = { take: vi.fn(async () => ({ ok: true, subscriberGrowthUrl: READY_SOURCES.subscriberGrowthUrl, accountLabels: ["Steven Dann"] })), persisted: vi.fn().mockResolvedValue(null), watch: () => () => undefined };
    const verifyAccount = vi.fn(async (input: { clientName: string; verifySavedAccountOnly?: boolean; configuredUrl?: string | null }): Promise<BusinessReviewDiscoveryResult> => input.verifySavedAccountOnly
      ? { ok: true, verification: "saved_target_account", dashboardUrl: input.configuredUrl!, accountLabel: input.clientName, accountMatchesClient: true }
      : { ok: true, dashboardUrl: STEVEN_REVIEW.dashboardUrl, accountLabel: input.clientName, accountMatchesClient: true, evidence: { businessReviewHeading: true, growthOverview: true, campaignPerformance: true, flowPerformance: true } });
    return { sources, subscriberGrowth, verifyAccount, clickToolbar: () => act(() => { for (const callback of toolbar) callback(); }), metricPageRead: () => act(() => { for (const callback of metricWatchers) callback(); }), watchToolbarClick: (callback: () => void) => { toolbar.push(callback); return () => undefined; } };
  }
  function renderOnboarding(api: ApiClient, fakes = discoveryFakes(), automaticCaptureService?: AutoCaptureService) {
    render(<App api={api} discoverBusinessReviewSource={fakes.verifyAccount as never} subscriberGrowthSource={fakes.subscriberGrowth as never} clientSetupSources={fakes.sources} watchToolbarClick={fakes.watchToolbarClick} {...(automaticCaptureService ? { automaticCaptureService } : {})} now={() => new Date(ONBOARDING_NOW)} />);
    return fakes;
  }
  const checklistRow = (label: string) => within(screen.getByRole("list", { name: "Client setup checklist" })).getByText(label).closest("li")!;

  it("lists every client with its server-computed setup status", async () => {
    const { api } = backend([club(), targets("steven-dann", { profile: { name: "Steven Dann", timezone: "America/New_York" } })]);
    renderOnboarding(api);
    expect(await screen.findByRole("button", { name: "Club Furniture READY" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Steven Dann SETUP INCOMPLETE" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Add New Client" })).toBeEnabled();
  });

  it("adds a brand-new client from its name (a name is required), then shows only the setup checklist — no report creation", async () => {
    const { api } = backend();
    const user = userEvent.setup(); renderOnboarding(api);
    await user.click(await screen.findByRole("button", { name: "+ Add New Client" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the client name.");
    expect(api.createClient).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText("Client Name"), "Steven Dann");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(api.createClient).toHaveBeenCalledWith("Steven Dann");
    expect(await screen.findByRole("list", { name: "Client setup checklist" })).toBeInTheDocument();
    expect(checklistRow("Client Name")).toHaveTextContent("Steven Dann");
    expect(checklistRow("Currency")).toHaveTextContent("The client's ISO currency code is not configured.");
    expect(screen.getByText("SETUP INCOMPLETE")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create New Report" })).toBeNull();
    // The large Advanced Targets form stays collapsed under Advanced / Debug.
    expect(screen.getByText("Advanced / Debug").closest("details")).not.toHaveAttribute("open");
  });

  it("without Klaviyo tab access nothing is verified or saved, and it says what to do", async () => {
    const { api } = backend([targets("steven-dann", { profile: { name: "Steven Dann", timezone: null } })]);
    const fakes = discoveryFakes();
    fakes.verifyAccount.mockResolvedValueOnce({ ok: false, code: "ACTION_NOT_INVOKED", message: "Open the intended client’s Klaviyo account and click the Tention Reports extension before discovery." });
    const user = userEvent.setup(); renderOnboarding(api, fakes);
    await user.click(await screen.findByRole("button", { name: "Steven Dann SETUP INCOMPLETE" }));
    await user.click(await screen.findByRole("button", { name: "Continue Client Setup" }));
    expect(await screen.findByText("Open Steven Dann's Klaviyo account in Chrome and click the Tention Reports extension. The account and its Business Review dashboard are verified automatically.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Verify Klaviyo Account" }));
    expect(await screen.findByText(/click the Tention Reports extension before discovery/)).toBeInTheDocument();
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
  });

  it("refuses the wrong Klaviyo account: shows expected and detected, saves nothing", async () => {
    const { api } = backend([targets("steven-dann", { profile: { name: "Steven Dann", timezone: null } })]);
    const fakes = discoveryFakes();
    fakes.verifyAccount.mockResolvedValueOnce({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH", message: "The authenticated Klaviyo account does not match the selected client.", diagnostics: { accountLabel: "CL Club Furniture" } });
    const user = userEvent.setup(); renderOnboarding(api, fakes);
    await user.click(await screen.findByRole("button", { name: "Steven Dann SETUP INCOMPLETE" }));
    await user.click(await screen.findByRole("button", { name: "Continue Client Setup" }));
    await screen.findByRole("region", { name: "Klaviyo Account" });
    fakes.clickToolbar();
    const alert = await screen.findByRole("alert", { name: "Wrong Klaviyo account" });
    expect(alert).toHaveTextContent("Expected:Steven Dann");
    expect(alert).toHaveTextContent("Detected:CL Club Furniture");
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
  });

  it("onboards Steven Dann to READY from his own Klaviyo pages, then creates October 2026 and starts automatic capture", async () => {
    const { api, store } = backend([club()]);
    const fakes = discoveryFakes();
    const user = userEvent.setup(); renderOnboarding(api, fakes);
    await user.click(await screen.findByRole("button", { name: "+ Add New Client" }));
    await user.type(screen.getByLabelText("Client Name"), "Steven Dann");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("list", { name: "Client setup checklist" });
    // Toolbar click on Steven Dann's Klaviyo: account + Business Review are verified and saved by themselves.
    fakes.clickToolbar();
    await waitFor(() => expect(checklistRow("Klaviyo Account")).toHaveTextContent("Steven Dann"));
    expect(fakes.verifyAccount).toHaveBeenCalledWith(expect.objectContaining({ clientName: "Steven Dann", configuredUrl: null }));
    expect(checklistRow("Business Review")).toHaveTextContent("Verified");
    await user.type(screen.getByLabelText("Timezone"), "America/New_York");
    await user.click(screen.getByRole("button", { name: "Save Timezone" }));
    await user.selectOptions(screen.getByLabelText("Currency"), "USD");
    await user.click(screen.getByRole("button", { name: "Save Currency" }));
    // The metric page read at the toolbar click is used by itself; its ID is Steven Dann's own.
    fakes.metricPageRead();
    await waitFor(() => expect(checklistRow("Metric ID")).toHaveTextContent("SDmet1"));
    await user.click(screen.getByRole("button", { name: "Verify Deliverability" }));
    await user.click(screen.getByRole("button", { name: "Verify Subscriber Growth" }));
    expect(await screen.findByText("Client setup complete.")).toBeInTheDocument();
    expect(screen.getByText("READY")).toBeInTheDocument();
    expect(store.get("steven-dann")).toMatchObject({ profile: { timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "SDmet1" } }, businessReview: STEVEN_REVIEW, sourceUrls: READY_SOURCES });
    expect(store.get("club-furniture")!.profile!.conversionMetric.providerMetricId).toBe("KyqTnx");

    await user.click(screen.getByRole("button", { name: "Create New Report" }));
    expect(await screen.findByLabelText("Report Month")).toHaveValue("2026-10");
    expect(screen.queryByRole("option", { name: "November 2026" })).toBeNull();
    expect(screen.getByText("Oct 1, 2026 – Oct 31, 2026")).toBeInTheDocument();
    expect(screen.getByText("Sep 1, 2026 – Sep 30, 2026")).toBeInTheDocument();
    const saves = vi.mocked(api.saveClientReportTargets).mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Create & Start Automatic Capture" }));
    await waitFor(() => expect(api.createReportDraft).toHaveBeenCalledWith(expect.objectContaining({ client: { id: "steven-dann" }, reportMonth: { year: 2026, month: 10 } })));
    expect(vi.mocked(api.createReportDraft).mock.calls[0]![0]).not.toHaveProperty("period");
    // Automatic capture starts by itself on the new report: all 10 sections, for Steven Dann's October.
    expect(await screen.findByText("Step 1 of 10")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Executive Summary" })).toBeInTheDocument();
    expect(screen.getByText("Steven Dann", { selector: ".report-month" })).toBeInTheDocument();
    // Capture starts by itself: its preflight re-proves the saved account; nothing is configured again.
    await waitFor(() => expect(fakes.verifyAccount).toHaveBeenCalledWith(expect.objectContaining({ verifySavedAccountOnly: true, configuredAccountLabel: "Steven Dann" })));
    expect(vi.mocked(api.saveClientReportTargets).mock.calls.length).toBe(saves);
  });

  describe("Delete Report in a client's Reports list (one month only)", () => {
    const monthReport = (id: string, month: number, status: ReportDraft["status"]): ReportDraft => ({ ...report, id, client: clientReportSnapshot(readySteven()), reportMonth: { year: 2026, month: month as ReportDraft["reportMonth"]["month"] }, status });
    const october = () => monthReport("55555555-5555-4555-8555-555555555555", 10, "generated");
    const september = () => monthReport("66666666-6666-4666-8666-666666666666", 9, "captures_incomplete");
    const july = () => monthReport("77777777-7777-4777-8777-777777777777", 7, "failed");
    async function openSteven(drafts: ReportDraft[]) {
      const backendState = backend([readySteven()], drafts);
      const user = userEvent.setup(); renderOnboarding(backendState.api);
      await user.click(await screen.findByRole("button", { name: "Steven Dann READY" }));
      const list = await screen.findByRole("region", { name: "Reports" });
      return { ...backendState, user, list, row: (month: string) => within(list).getByText(month).closest("li")! };
    }

    it("12. shows Open Report and Delete Report on every report row", async () => {
      const { list, row } = await openSteven([october(), september(), july()]);
      for (const month of ["October 2026", "September 2026", "July 2026"]) {
        expect(within(row(month)).getByRole("button", { name: "Open Report" })).toBeInTheDocument();
        expect(within(row(month)).getByRole("button", { name: `Delete ${month} report` })).toHaveTextContent("Delete Report");
      }
      expect(within(list).getByRole("button", { name: "Delete October 2026 report" })).toHaveClass("danger");
    });

    it("asks for confirmation first and names the month and client; 11. Cancel deletes nothing", async () => {
      const { api, user, row } = await openSteven([october(), september()]);
      await user.click(within(row("October 2026")).getByRole("button", { name: "Delete October 2026 report" }));
      const dialog = screen.getByRole("alertdialog", { name: "Delete October 2026 report?" });
      expect(dialog).toHaveTextContent("Client:Steven Dann");
      expect(dialog).toHaveTextContent("This will remove this report and its stored report data.");
      expect(within(dialog).getByRole("button", { name: "Delete Report" })).toHaveClass("danger-solid");
      expect(api.deleteClientReport).not.toHaveBeenCalled();
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(api.deleteClientReport).not.toHaveBeenCalled();
      expect(row("October 2026")).toHaveTextContent("Generated");
    });

    it("13. deletes only the selected month, removes its row at once, stays on the client page, and the client stays READY", async () => {
      const { api, user, list, row } = await openSteven([october(), september(), july()]);
      // The history refresh never answers: the row must still go away immediately.
      vi.mocked(api.listReportDrafts).mockImplementation(() => new Promise(() => undefined));
      await user.click(within(row("July 2026")).getByRole("button", { name: "Delete July 2026 report" }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete Report" }));
      expect(await screen.findByRole("status")).toHaveTextContent("July 2026 report deleted.");
      expect(api.deleteClientReport).toHaveBeenCalledTimes(1);
      expect(api.deleteClientReport).toHaveBeenCalledWith("steven-dann", "77777777-7777-4777-8777-777777777777");
      expect(within(list).queryByText("July 2026")).toBeNull();
      expect(row("October 2026")).toHaveTextContent("Generated");
      expect(row("September 2026")).toHaveTextContent("In progress");
      expect(screen.getByRole("heading", { name: "Steven Dann" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create New Report" })).toBeEnabled();
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });

    it("15. a generated report's Drive files are reported as not deleted", async () => {
      const { user, row } = await openSteven([october()]);
      await user.click(within(row("October 2026")).getByRole("button", { name: "Delete October 2026 report" }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete Report" }));
      expect(await screen.findByRole("status")).toHaveTextContent("October 2026 report deleted. Drive files were not deleted.");
      // A recent month stays listed as "Not created" so it can be created again; the report's buttons are gone.
      expect(row("October 2026")).toHaveTextContent("Not created");
      expect(within(row("October 2026")).queryByRole("button")).toBeNull();
    });

    it("5. blocks a generating report without opening the confirmation or calling the API", async () => {
      const { api, user, row } = await openSteven([monthReport("88888888-8888-4888-8888-888888888888", 10, "generating")]);
      await user.click(within(row("October 2026")).getByRole("button", { name: "Delete October 2026 report" }));
      expect(screen.getByRole("alert")).toHaveTextContent("This report is currently generating. Try again after generation finishes.");
      expect(screen.queryByRole("alertdialog")).toBeNull();
      expect(api.deleteClientReport).not.toHaveBeenCalled();
    });

    it("10. the deleted month can be created again from the client's saved READY setup", async () => {
      const { api, user, row } = await openSteven([october(), september()]);
      await user.click(within(row("October 2026")).getByRole("button", { name: "Delete October 2026 report" }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete Report" }));
      await screen.findByRole("status");
      await user.click(screen.getByRole("button", { name: "Create New Report" }));
      await user.click(await screen.findByRole("button", { name: "Create & Start Automatic Capture" }));
      await waitFor(() => expect(api.createReportDraft).toHaveBeenCalledWith(expect.objectContaining({ client: { id: "steven-dann" }, reportMonth: { year: 2026, month: 10 } })));
      await expect(vi.mocked(api.createReportDraft).mock.results[0]!.value).resolves.toMatchObject({ client: clientReportSnapshot(readySteven()), reportMonth: { year: 2026, month: 10 } });
    });
  });

  describe("one reconciliation after a report is deleted or found missing (Recent Reports, client Reports, open report)", () => {
    const steven = (id: string, month: number, status: ReportDraft["status"]): ReportDraft => ({ ...report, id, client: clientReportSnapshot(readySteven()), reportMonth: { year: 2026, month: month as ReportDraft["reportMonth"]["month"] }, status });
    const SEPTEMBER_ID = "99999999-9999-4999-8999-999999999999";
    const OCTOBER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const CLUB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const clubReport = (): ReportDraft => ({ ...report, id: CLUB_ID, client: clientReportSnapshot(club()), reportMonth: { year: 2026, month: 9 }, status: "generated" });
    /** Steven Dann (September generated, October in progress) and Club Furniture (September generated). */
    function start(options: { open?: string } = {}) {
      const state = backend([readySteven(), club()], [steven(SEPTEMBER_ID, 9, "generated"), steven(OCTOBER_ID, 10, "captures_incomplete"), clubReport()]);
      const { api, reports } = state;
      // The canonical endpoints: a deleted report is gone (404), exactly like the API.
      api.getReportDraft = vi.fn(async (id: string) => { const found = reports.find((draft) => draft.id === id); if (!found) throw new ApiError("REPORT_NOT_FOUND", "Report not found.", 404); return structuredClone(found); }) as ApiClient["getReportDraft"];
      api.deleteReportDraft = vi.fn(async (id: string) => { const index = reports.findIndex((draft) => draft.id === id); if (index < 0) throw new ApiError("REPORT_NOT_FOUND", "Report not found.", 404); reports.splice(index, 1); }) as ApiClient["deleteReportDraft"];
      if (options.open) window.sessionStorage.setItem("tention.active-report-id", options.open);
      const reload = vi.fn(); vi.stubGlobal("location", { ...window.location, reload });
      const user = userEvent.setup(); renderOnboarding(api);
      return { ...state, user, reload };
    }
    afterEach(() => { vi.unstubAllGlobals(); });
    const recentList = () => screen.getByRole("heading", { name: "Recent Reports" }).closest("section")!;
    const recentRow = (client: string, month: string) => within(recentList()).queryAllByRole("listitem").find((item) => item.textContent?.includes(client) && item.textContent.includes(month)) ?? null;
    const clientReports = () => screen.getByRole("region", { name: "Reports" });
    const clientRow = (month: string) => within(clientReports()).getByText(month).closest("li")!;
    async function openStevenPage(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole("button", { name: "Steven Dann READY" }));
      await screen.findByRole("region", { name: "Reports" });
    }
    async function deleteFromClientPage(user: ReturnType<typeof userEvent.setup>, month: string) {
      await user.click(within(clientRow(month)).getByRole("button", { name: `Delete ${month} report` }));
      await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete Report" }));
    }

    it("1–4, 9, 10, 13, 15. a client-page delete removes it from client Reports and Recent Reports at once; other months and clients remain", async () => {
      const { api, user, reload } = start();
      await openStevenPage(user);
      expect(recentRow("Steven Dann", "September 2026")).not.toBeNull();
      const listCallsBefore = vi.mocked(api.listReportDrafts).mock.calls.length;
      await deleteFromClientPage(user, "September 2026");
      expect(await within(clientReports()).findByRole("status")).toHaveTextContent("September 2026 report deleted.");
      // Client Reports: the month stays as "Not created" (it can be created again) with no Open/Delete.
      expect(clientRow("September 2026")).toHaveTextContent("Not created");
      expect(within(clientRow("September 2026")).queryByRole("button", { name: "Open Report" })).toBeNull();
      expect(within(clientRow("September 2026")).queryByRole("button", { name: /Delete/ })).toBeNull();
      // Recent Reports: gone, with no Open/Delete left anywhere for it.
      await waitFor(() => expect(recentRow("Steven Dann", "September 2026")).toBeNull());
      // Other months of this client and other clients remain.
      expect(clientRow("October 2026")).toHaveTextContent("In progress");
      expect(recentRow("Steven Dann", "October 2026")).not.toBeNull();
      expect(recentRow("Club Furniture", "September 2026")).not.toBeNull();
      // 15. Both lists were refetched from the API after the delete (authoritative state), without a page reload.
      const refetches = vi.mocked(api.listReportDrafts).mock.calls.slice(listCallsBefore);
      expect(refetches).toEqual(expect.arrayContaining([[], [{ clientId: "steven-dann" }]]));
      expect(reload).not.toHaveBeenCalled();
      expect(screen.queryByText("Report not found.")).toBeNull();
    });

    it("2. a Recent Reports delete removes it from the open client's Reports immediately", async () => {
      const { api, user } = start();
      await openStevenPage(user);
      // The client page's refetch never answers: the row must still go at once.
      vi.mocked(api.listReportDrafts).mockImplementation((filters?: { clientId?: string }) => filters?.clientId ? new Promise(() => undefined) : Promise.resolve([]));
      await user.click(within(recentRow("Steven Dann", "September 2026")!).getByRole("button", { name: "Delete Report" }));
      const dialog = screen.getByRole("dialog", { name: "Delete report?" });
      await user.type(within(dialog).getByRole("textbox", { name: "Type DELETE to confirm" }), "DELETE");
      await user.click(within(dialog).getByRole("button", { name: "Delete Report" }));
      await waitFor(() => expect(clientRow("September 2026")).toHaveTextContent("Not created"));
      expect(within(clientRow("September 2026")).queryByRole("button")).toBeNull();
      expect(clientRow("October 2026")).toHaveTextContent("In progress");
    });

    it("5 + 7. deleting the open report clears it and returns to its client page, not a dead report screen", async () => {
      const { user } = start();
      await openStevenPage(user);
      await user.click(within(clientRow("September 2026")).getByRole("button", { name: "Open Report" }));
      await screen.findByText("Report options");
      expect(window.sessionStorage.getItem("tention.active-report-id")).toBe(SEPTEMBER_ID);
      await user.click(screen.getByText("Report options"));
      await user.click(screen.getByRole("button", { name: "Delete Report" }));
      const dialog = screen.getByRole("dialog", { name: "Delete report?" });
      await user.type(within(dialog).getByRole("textbox", { name: "Type DELETE to confirm" }), "DELETE");
      await user.click(within(dialog).getByRole("button", { name: "Delete Report" }));
      expect(await screen.findByRole("status")).toHaveTextContent("September 2026 report deleted.");
      expect(await screen.findByRole("heading", { name: "Steven Dann" })).toBeInTheDocument();
      expect(screen.queryByText("Report options")).toBeNull();
      expect(window.sessionStorage.getItem("tention.active-report-id")).toBeNull();
      await waitFor(() => expect(clientRow("September 2026")).toHaveTextContent("Not created"));
      expect(recentRow("Steven Dann", "September 2026")).toBeNull();
    });

    it("6. deleting another month leaves a different report openable and selectable", async () => {
      const { user } = start();
      await openStevenPage(user);
      await deleteFromClientPage(user, "September 2026");
      await within(clientReports()).findByRole("status");
      await user.click(within(clientRow("October 2026")).getByRole("button", { name: "Open Report" }));
      await screen.findByText("Report options");
      expect(window.sessionStorage.getItem("tention.active-report-id")).toBe(OCTOBER_ID);
    });

    it("8. a stale Recent Reports entry whose report is gone (404) is removed, returns to its client, and shows a small notice", async () => {
      const { user, reports } = start();
      await screen.findByText("Recent Reports");
      await waitFor(() => expect(recentRow("Steven Dann", "September 2026")).not.toBeNull());
      reports.splice(reports.findIndex((draft) => draft.id === SEPTEMBER_ID), 1); // deleted elsewhere
      await user.click(within(recentRow("Steven Dann", "September 2026")!).getByRole("button", { name: "Open Report" }));
      expect(await screen.findByRole("status")).toHaveTextContent("That report no longer exists.");
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Report not found.")).toBeNull();
      expect(await screen.findByRole("heading", { name: "Steven Dann" })).toBeInTheDocument();
      await waitFor(() => expect(recentRow("Steven Dann", "September 2026")).toBeNull());
      expect(recentRow("Club Furniture", "September 2026")).not.toBeNull();
    });

    it("8. an old report link restored from the session that no longer exists is dropped without a persistent error", async () => {
      start({ open: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
      expect(await screen.findByRole("status")).toHaveTextContent("That report no longer exists.");
      expect(screen.queryByText("Report not found.")).toBeNull();
      expect(window.sessionStorage.getItem("tention.active-report-id")).toBeNull();
      expect(await screen.findByRole("heading", { name: "Clients" })).toBeInTheDocument();
    });

    it("11 + 12. the deleted month is created again and appears normally in Recent Reports", async () => {
      const { api, user } = start();
      await openStevenPage(user);
      await deleteFromClientPage(user, "October 2026");
      await within(clientReports()).findByRole("status");
      await waitFor(() => expect(recentRow("Steven Dann", "October 2026")).toBeNull());
      await user.click(screen.getByRole("button", { name: "Create New Report" }));
      await user.click(await screen.findByRole("button", { name: "Create & Start Automatic Capture" }));
      await waitFor(() => expect(api.createReportDraft).toHaveBeenCalledWith(expect.objectContaining({ client: { id: "steven-dann" }, reportMonth: { year: 2026, month: 10 } })));
      await user.click(await screen.findByRole("button", { name: "Clients" }));
      await waitFor(() => expect(recentRow("Steven Dann", "October 2026")).not.toBeNull());
      expect(within(recentRow("Steven Dann", "October 2026")!).getByRole("button", { name: "Open Report" })).toBeInTheDocument();
    });

    it("14. a failed delete removes nothing", async () => {
      const { api, user } = start();
      await openStevenPage(user);
      vi.mocked(api.deleteClientReport).mockRejectedValueOnce(new ApiError("NETWORK_ERROR", "offline", null));
      await deleteFromClientPage(user, "September 2026");
      expect(await within(clientReports()).findByRole("alert")).toHaveTextContent("September 2026 report could not be deleted.");
      expect(clientRow("September 2026")).toHaveTextContent("Generated");
      expect(within(clientRow("September 2026")).getByRole("button", { name: "Open Report" })).toBeInTheDocument();
      expect(recentRow("Steven Dann", "September 2026")).not.toBeNull();
    });
  });

  describe("Klaviyo account label: the real account name, never another client", () => {
    const boundAsInitials = () => targets("steven-dann", { profile: { name: "Steven Dann", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "QuWhQ9" } }, businessReview: { ...STEVEN_REVIEW, accountLabel: "ST Steven Dann" }, sourceUrls: { deliverabilityUrl: READY_SOURCES.deliverabilityUrl } });

    it("saves the real Klaviyo account name, not the avatar initials the page reader picks up with it", async () => {
      const { api, store } = backend([club()]);
      const fakes = discoveryFakes();
      fakes.verifyAccount.mockResolvedValueOnce({ ok: true, dashboardUrl: STEVEN_REVIEW.dashboardUrl, accountLabel: "ST Steven Dann", accountMatchesClient: true, evidence: { businessReviewHeading: true, growthOverview: true, campaignPerformance: true, flowPerformance: true } });
      const user = userEvent.setup(); renderOnboarding(api, fakes);
      await user.click(await screen.findByRole("button", { name: "+ Add New Client" }));
      await user.type(screen.getByLabelText("Client Name"), "Steven Dann");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByRole("list", { name: "Client setup checklist" });
      fakes.clickToolbar();
      await waitFor(() => expect(store.get("steven-dann")!.businessReview?.accountLabel).toBe("Steven Dann"));
      expect(checklistRow("Klaviyo Account")).toHaveTextContent("Steven Dann");
      expect(store.get("club-furniture")!.businessReview!.accountLabel).toBe("CL Club Furniture");
    });

    it("accepts Steven Dann's Subscriber Growth page against the old 'ST Steven Dann' binding and reaches READY", async () => {
      const { api, store } = backend([club(), boundAsInitials()]);
      const fakes = discoveryFakes();
      fakes.subscriberGrowth.take.mockResolvedValueOnce({ ok: true, subscriberGrowthUrl: READY_SOURCES.subscriberGrowthUrl, accountLabels: ["Steven Dann", "Help"] });
      const user = userEvent.setup(); renderOnboarding(api, fakes);
      await user.click(await screen.findByRole("button", { name: "Steven Dann SETUP INCOMPLETE" }));
      await user.click(await screen.findByRole("button", { name: "Continue Client Setup" }));
      await user.click(await screen.findByRole("button", { name: "Verify Subscriber Growth" }));
      expect(await screen.findByText("Client setup complete.")).toBeInTheDocument();
      expect(store.get("steven-dann")!.sourceUrls?.subscriberGrowthUrl).toBe(READY_SOURCES.subscriberGrowthUrl);
    });

    it("still refuses a Subscriber Growth page from Club Furniture's account", async () => {
      const { api, store } = backend([club(), boundAsInitials()]);
      const fakes = discoveryFakes();
      fakes.subscriberGrowth.take.mockResolvedValueOnce({ ok: true, subscriberGrowthUrl: READY_SOURCES.subscriberGrowthUrl, accountLabels: ["CL Club Furniture"] });
      const user = userEvent.setup(); renderOnboarding(api, fakes);
      await user.click(await screen.findByRole("button", { name: "Steven Dann SETUP INCOMPLETE" }));
      await user.click(await screen.findByRole("button", { name: "Continue Client Setup" }));
      await user.click(await screen.findByRole("button", { name: "Verify Subscriber Growth" }));
      expect(await screen.findByText("This page appears to belong to another Klaviyo account. Nothing was saved.")).toBeInTheDocument();
      expect(store.get("steven-dann")!.sourceUrls?.subscriberGrowthUrl).toBeUndefined();
      expect(fakes.subscriberGrowth.persisted).toHaveBeenCalledWith(expect.objectContaining({ saved: false, failureCode: "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN" }));
    });
  });

  describe("Subscriber Growth source: verify, current page, or pasted URL — this client's only", () => {
    const GROWTH = "https://www.klaviyo.com/people/subscribers";
    /** Steven Dann as he is live now: everything verified except Subscriber Growth. */
    const stevenWithoutGrowth = () => targets("steven-dann", { profile: { name: "Steven Dann", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "QuWhQ9" } }, businessReview: STEVEN_REVIEW, sourceUrls: { deliverabilityUrl: READY_SOURCES.deliverabilityUrl } });
    async function openGrowthSetup(fakes = discoveryFakes()) {
      const { api, store } = backend([club(), stevenWithoutGrowth()]);
      const user = userEvent.setup(); renderOnboarding(api, fakes);
      await user.click(await screen.findByRole("button", { name: "Steven Dann SETUP INCOMPLETE" }));
      await user.click(await screen.findByRole("button", { name: "Continue Client Setup" }));
      const panel = await screen.findByLabelText("Subscriber Growth setup");
      return { api, store, user, panel, fakes };
    }
    const probed = (accountLabels: string[], url = GROWTH) => ({ ok: true, subscriberGrowthUrl: url, accountLabels });

    it("auto-verifies when the page shows no readable account name by re-proving the saved binding, and reaches READY", async () => {
      const fakes = discoveryFakes(); fakes.subscriberGrowth.take.mockResolvedValueOnce(probed(["Profiles", "Help"]));
      const { store, user, panel } = await openGrowthSetup(fakes);
      await user.click(within(panel).getByRole("button", { name: "Verify Subscriber Growth" }));
      expect(await screen.findByText("Client setup complete.")).toBeInTheDocument();
      expect(fakes.verifyAccount).toHaveBeenCalledWith(expect.objectContaining({ verifySavedAccountOnly: true, configuredAccountLabel: "Steven Dann" }));
      expect(store.get("steven-dann")!.sourceUrls).toEqual({ deliverabilityUrl: READY_SOURCES.deliverabilityUrl, subscriberGrowthUrl: GROWTH });
      expect(checklistRow("Subscriber Growth")).toHaveTextContent("Verified");
      expect(fakes.subscriberGrowth.persisted).toHaveBeenCalledWith({ saved: true, sourceUrl: GROWTH, failureCode: null });
    });

    it("blocks when the authorized tab is another client's account, and offers fallbacks when the account cannot be read", async () => {
      const fakes = discoveryFakes();
      fakes.subscriberGrowth.take.mockResolvedValue(probed([]));
      fakes.verifyAccount.mockResolvedValueOnce({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH", message: "differs" }).mockResolvedValueOnce({ ok: false, code: "ACCOUNT_CONTEXT_NOT_VERIFIED", message: "not found" });
      const { api, user, panel } = await openGrowthSetup(fakes);
      await user.click(within(panel).getByRole("button", { name: "Verify Subscriber Growth" }));
      expect(await within(panel).findByRole("alert", { name: "WRONG KLAVIYO ACCOUNT" })).toHaveTextContent("This page appears to belong to another Klaviyo account. Nothing was saved.");
      await user.click(within(panel).getByRole("button", { name: "Verify Subscriber Growth" }));
      expect(await within(panel).findByRole("alert", { name: "AUTO VERIFICATION FAILED" })).toHaveTextContent("Use the current Subscriber Growth page or paste its URL.");
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });

    it("Use Current Subscriber Growth Page: shows the client, source and stable URL, and saves only on Confirm", async () => {
      const fakes = discoveryFakes(); fakes.subscriberGrowth.take.mockResolvedValueOnce(probed([], `${GROWTH}?view=overview`));
      const { api, store, user, panel } = await openGrowthSetup(fakes);
      await user.click(within(panel).getByRole("button", { name: "Use Current Subscriber Growth Page" }));
      const confirm = await within(panel).findByRole("group", { name: "Confirm Subscriber Growth source" });
      expect(confirm).toHaveTextContent("Client:Steven Dann");
      expect(confirm).toHaveTextContent("Source:Subscriber Growth");
      expect(confirm).toHaveTextContent(`URL:${GROWTH}`);
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
      await user.click(within(confirm).getByRole("button", { name: "Confirm & Save" }));
      expect(await screen.findByText("Client setup complete.")).toBeInTheDocument();
      expect(store.get("steven-dann")!.sourceUrls?.subscriberGrowthUrl).toBe(GROWTH);
      expect(fakes.subscriberGrowth.persisted).toHaveBeenCalledWith(expect.objectContaining({ saved: true }));
    });

    it("Use Current Subscriber Growth Page never offers a page that shows Club Furniture's account", async () => {
      const fakes = discoveryFakes(); fakes.subscriberGrowth.take.mockResolvedValueOnce(probed(["CL Club Furniture"]));
      const { api, user, panel } = await openGrowthSetup(fakes);
      await user.click(within(panel).getByRole("button", { name: "Use Current Subscriber Growth Page" }));
      expect(await within(panel).findByRole("alert", { name: "WRONG KLAVIYO ACCOUNT" })).toBeInTheDocument();
      expect(within(panel).queryByRole("group", { name: "Confirm Subscriber Growth source" })).toBeNull();
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });

    it("saves a pasted URL as the stable route (query removed) on this client only, without copying Club Furniture's setup", async () => {
      const { api, store, user, panel } = await openGrowthSetup();
      await user.type(within(panel).getByLabelText("Subscriber Growth URL"), `${GROWTH}?channel=email&view=growth`);
      await user.click(within(panel).getByRole("button", { name: "Save Subscriber Growth Source" }));
      expect(await screen.findByText("Client setup complete.")).toBeInTheDocument();
      expect(store.get("steven-dann")!.sourceUrls?.subscriberGrowthUrl).toBe(GROWTH);
      expect(vi.mocked(api.saveClientReportTargets).mock.calls.map(([clientId]) => clientId)).toEqual(["steven-dann"]);
      expect(store.get("club-furniture")).toEqual(club());
    });

    it.each([
      ["an unrelated Klaviyo page", "https://www.klaviyo.com/analytics/metrics"],
      ["another host", "https://evil.example/people/subscribers"],
      ["text that is not a URL", "people/subscribers"],
    ])("rejects %s", async (_case, value) => {
      const { api, user, panel } = await openGrowthSetup();
      await user.type(within(panel).getByLabelText("Subscriber Growth URL"), value);
      await user.click(within(panel).getByRole("button", { name: "Save Subscriber Growth Source" }));
      expect(within(panel).getByRole("alert", { name: "INVALID_SUBSCRIBER_GROWTH_URL" })).toHaveTextContent("Paste the Klaviyo Subscriber Growth URL, such as https://www.klaviyo.com/people/subscribers.");
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });
  });

  describe("Conversion Metric: current page, pasted URL or manual ID — always this client's own", () => {
    const QUWHQ9_URL = "https://www.klaviyo.com/metric/QuWhQ9/placed-order";
    /** Steven Dann as onboarded live: account bound as "ST Steven Dann", timezone and currency saved, metric missing. */
    const stevenWithoutMetric = (sources: Record<string, string> | null = null) => targets("steven-dann", { profile: { name: "Steven Dann", timezone: "America/New_York", currency: "USD" }, businessReview: { ...STEVEN_REVIEW, accountLabel: "ST Steven Dann" }, sourceUrls: sources });
    async function openMetricSetup(initial: ClientReportTargets[], fakes = discoveryFakes()) {
      const { api, store } = backend(initial);
      const user = userEvent.setup(); renderOnboarding(api, fakes);
      await user.click(await screen.findByRole("button", { name: "Steven Dann SETUP INCOMPLETE" }));
      await user.click(await screen.findByRole("button", { name: "Continue Client Setup" }));
      const card = await screen.findByRole("region", { name: "Conversion Metric" });
      return { api, store, user, card, fakes };
    }
    const page = (accountLabels: string[], overrides: Record<string, unknown> = {}) => ({ ok: true as const, metricId: "QuWhQ9", headings: ["Placed Order"], title: "Placed Order | Klaviyo", accountLabels, sourceUrl: QUWHQ9_URL, ...overrides });

    it("detects Placed Order automatically, accepting a harmless account-label variation, and updates the checklist at once", async () => {
      const fakes = discoveryFakes(); fakes.sources.takeConversionMetric.mockResolvedValueOnce(page(["ST", "Steven Dann", "Analytics"]));
      const { store, user, card } = await openMetricSetup([club(), stevenWithoutMetric()], fakes);
      expect(card).toHaveTextContent("Status: Not configured");
      await user.click(within(card).getByRole("button", { name: "Use Current Klaviyo Page" }));
      await waitFor(() => expect(checklistRow("Metric ID")).toHaveTextContent("QuWhQ9"));
      expect(checklistRow("Conversion Metric")).toHaveTextContent("Placed Order");
      expect(store.get("steven-dann")!.profile!.conversionMetric).toEqual({ label: "Placed Order", providerMetricId: "QuWhQ9" });
      // Still INCOMPLETE: the remaining sources are listed exactly.
      expect(screen.getByText("SETUP INCOMPLETE")).toBeInTheDocument();
      expect(checklistRow("Deliverability")).toHaveTextContent("has not been verified");
      expect(checklistRow("Subscriber Growth")).toHaveTextContent("has not been verified");
      expect(store.get("club-furniture")!.profile!.conversionMetric.providerMetricId).toBe("KyqTnx");
    });

    it("keeps wrong-account protection: another client's Klaviyo page is blocked and nothing is saved", async () => {
      const fakes = discoveryFakes(); fakes.sources.takeConversionMetric.mockResolvedValueOnce(page(["CL Club Furniture"], { metricId: "KyqTnx", sourceUrl: "https://www.klaviyo.com/metric/KyqTnx/placed-order" }));
      const { api, user, card } = await openMetricSetup([club(), stevenWithoutMetric()], fakes);
      await user.click(within(card).getByRole("button", { name: "Use Current Klaviyo Page" }));
      expect(await within(card).findByRole("alert", { name: "WRONG KLAVIYO ACCOUNT" })).toHaveTextContent("This page appears to belong to another Klaviyo account. Nothing was saved.");
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });

    it("refuses a page that is not Placed Order", async () => {
      const fakes = discoveryFakes(); fakes.sources.takeConversionMetric.mockResolvedValueOnce(page(["Steven Dann"], { metricId: "Act1v3", headings: ["Active on Site"], title: "Active on Site", sourceUrl: "https://www.klaviyo.com/metric/Act1v3/active-on-site" }));
      const { api, user, card } = await openMetricSetup([stevenWithoutMetric()], fakes);
      await user.click(within(card).getByRole("button", { name: "Use Current Klaviyo Page" }));
      expect(await within(card).findByRole("alert", { name: "AUTO DETECTION FAILED" })).toHaveTextContent("found: Active on Site");
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });

    it("when automatic detection cannot prove the account, the pasted URL (with query) is parsed, confirmed and saved", async () => {
      const fakes = discoveryFakes(); fakes.sources.takeConversionMetric.mockResolvedValueOnce(page(["ST", "Metrics"]));
      const { api, store, user, card } = await openMetricSetup([club(), stevenWithoutMetric()], fakes);
      await user.click(within(card).getByRole("button", { name: "Use Current Klaviyo Page" }));
      expect(await within(card).findByRole("alert", { name: "AUTO DETECTION FAILED" })).toHaveTextContent("We couldn't verify this metric automatically. You can paste the Placed Order metric URL or enter the Provider Metric ID manually.");
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
      await user.type(within(card).getByLabelText("Paste Metric URL"), `${QUWHQ9_URL}?function=&dimension=&value=`);
      await user.click(within(card).getByRole("button", { name: "Save From URL" }));
      const confirm = within(card).getByRole("group", { name: "Confirm metric ID" });
      expect(confirm).toHaveTextContent("Detected Metric:Placed Order");
      expect(confirm).toHaveTextContent("Provider Metric ID:QuWhQ9");
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
      await user.click(within(confirm).getByRole("button", { name: "Confirm & Save" }));
      await waitFor(() => expect(checklistRow("Metric ID")).toHaveTextContent("QuWhQ9"));
      expect(vi.mocked(api.saveClientReportTargets).mock.calls.map(([clientId]) => clientId)).toEqual(["steven-dann"]);
      expect(store.get("steven-dann")!.profile!.conversionMetric.providerMetricId).toBe("QuWhQ9");
      expect(store.get("club-furniture")!.profile!.conversionMetric.providerMetricId).toBe("KyqTnx");
    });

    it("rejects an invalid metric URL", async () => {
      const { api, user, card } = await openMetricSetup([stevenWithoutMetric()]);
      await user.type(within(card).getByLabelText("Paste Metric URL"), "https://www.klaviyo.com/metric/QuWhQ9/active-on-site");
      await user.click(within(card).getByRole("button", { name: "Save From URL" }));
      expect(within(card).getByRole("alert", { name: "INVALID_METRIC_URL" })).toHaveTextContent("Paste a Klaviyo Placed Order URL such as /metric/<id>/placed-order.");
      expect(within(card).queryByRole("group", { name: "Confirm metric ID" })).toBeNull();
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });

    it("saves a manually entered ID (whitespace trimmed) only after confirming it is this client's own, and reaches READY when nothing else is missing", async () => {
      const { store, user, card } = await openMetricSetup([club(), stevenWithoutMetric(READY_SOURCES)]);
      // Never prefilled from another client.
      expect(within(card).getByLabelText("Provider Metric ID")).toHaveValue("");
      await user.type(within(card).getByLabelText("Provider Metric ID"), "  QuWhQ9  ");
      await user.click(within(card).getByRole("button", { name: "Save Metric ID" }));
      const confirm = within(card).getByRole("group", { name: "Confirm metric ID" });
      expect(confirm).toHaveTextContent("Client:Steven Dann");
      expect(confirm).toHaveTextContent("Metric:Placed Order");
      expect(confirm).toHaveTextContent("Provider Metric ID:QuWhQ9");
      expect(confirm).toHaveTextContent("Confirm that this ID came from Steven Dann's own Klaviyo account.");
      await user.click(within(confirm).getByRole("button", { name: "Confirm & Save" }));
      expect(await screen.findByText("Client setup complete.")).toBeInTheDocument();
      expect(store.get("steven-dann")!.profile!.conversionMetric).toEqual({ label: "Placed Order", providerMetricId: "QuWhQ9" });
    });

    it.each([
      ["QuW hQ9", "A Klaviyo metric ID has no spaces."],
      [QUWHQ9_URL, "Enter only the Klaviyo metric ID, not the full URL."],
      ["QuWhQ9$", "A Klaviyo metric ID contains only letters and digits (for example QuWhQ9)."],
    ])("rejects the manual ID %j with a specific message", async (value, message) => {
      const { api, user, card } = await openMetricSetup([stevenWithoutMetric()]);
      await user.type(within(card).getByLabelText("Provider Metric ID"), value);
      await user.click(within(card).getByRole("button", { name: "Save Metric ID" }));
      expect(within(card).getByRole("alert", { name: "INVALID_PROVIDER_METRIC_ID" })).toHaveTextContent(message);
      expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    });

    it("never reuses Club Furniture's metric ID for Steven Dann, even when typed by hand", async () => {
      const { store, user, card } = await openMetricSetup([club(), stevenWithoutMetric()]);
      await user.type(within(card).getByLabelText("Provider Metric ID"), "KyqTnx");
      await user.click(within(card).getByRole("button", { name: "Save Metric ID" }));
      await user.click(within(card).getByRole("button", { name: "Confirm & Save" }));
      expect(await within(card).findByText("This Klaviyo metric ID is already saved on another client.")).toBeInTheDocument();
      expect(store.get("steven-dann")!.profile!.conversionMetric.providerMetricId).toBeNull();
      expect(store.get("club-furniture")!.profile!.conversionMetric.providerMetricId).toBe("KyqTnx");
      expect(checklistRow("Metric ID")).not.toHaveTextContent("KyqTnx");
    });
  });

  it("an INCOMPLETE client cannot create a report and shows exactly what is missing", async () => {
    const { api } = backend([targets("steven-dann", { profile: { name: "Steven Dann", timezone: "America/New_York" }, businessReview: STEVEN_REVIEW, sourceUrls: READY_SOURCES })]);
    const user = userEvent.setup(); renderOnboarding(api);
    await user.click(await screen.findByRole("button", { name: "Steven Dann SETUP INCOMPLETE" }));
    const missing = await screen.findByRole("alert", { name: "Client setup incomplete" });
    expect(within(missing).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Currency", "Placed Order metric ID"]);
    expect(screen.getByRole("button", { name: "Create New Report" })).toBeDisabled();
    expect(api.createReportDraft).not.toHaveBeenCalled();
  });

  it("a READY client starts each new month from its saved configuration only: no setup or discovery is repeated", async () => {
    const september: ReportDraft = { ...report, id: "44444444-4444-4444-8444-444444444444", client: clientReportSnapshot(readySteven()), reportMonth: { year: 2026, month: 9 }, status: "generated" };
    const { api } = backend([readySteven()], [september]);
    const fakes = discoveryFakes();
    const user = userEvent.setup(); renderOnboarding(api, fakes);
    await user.click(await screen.findByRole("button", { name: "Steven Dann READY" }));
    const reports = await screen.findByRole("region", { name: "Reports" });
    expect(within(reports).getByText("September 2026").closest("li")).toHaveTextContent("Generated");
    expect(within(reports).getByText("October 2026").closest("li")).toHaveTextContent("Not created");
    await user.click(screen.getByRole("button", { name: "Create New Report" }));
    await user.click(await screen.findByRole("button", { name: "Create & Start Automatic Capture" }));
    await waitFor(() => expect(api.createReportDraft).toHaveBeenCalledWith(expect.objectContaining({ client: { id: "steven-dann" }, reportMonth: { year: 2026, month: 10 } })));
    expect(api.saveClientReportTargets).not.toHaveBeenCalled();
    expect(fakes.sources.takeConversionMetric).not.toHaveBeenCalled();
    expect(fakes.sources.verifyDeliverability).not.toHaveBeenCalled();
  });

  it("offers the existing report when the month already has one", async () => {
    const october: ReportDraft = { ...report, id: "55555555-5555-4555-8555-555555555555", client: clientReportSnapshot(readySteven()), reportMonth: { year: 2026, month: 10 } };
    const { api } = backend([readySteven()], [october]);
    const user = userEvent.setup(); renderOnboarding(api);
    await user.click(await screen.findByRole("button", { name: "Steven Dann READY" }));
    await user.click(await screen.findByRole("button", { name: "Create New Report" }));
    await user.click(await screen.findByRole("button", { name: "Create & Start Automatic Capture" }));
    expect(await screen.findByText("A October 2026 report already exists for Steven Dann.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open existing report" }));
    expect(await screen.findByRole("heading", { name: "Steven Dann" })).toBeInTheDocument();
  });

  it("an open report of a client that is no longer READY cannot capture or generate", async () => {
    const draft = { ...runnerReport(), client: { id: "steven-dann", name: "Steven Dann", timezone: "America/New_York", currency: "USD" } };
    const incomplete = targets("steven-dann", { profile: { name: "Steven Dann", timezone: "America/New_York", currency: "USD" }, businessReview: STEVEN_REVIEW, sourceUrls: READY_SOURCES });
    const { api } = backend([incomplete], [draft]);
    const service: AutoCaptureService = { start: vi.fn(), get: vi.fn().mockResolvedValue(null), clear: vi.fn() };
    const user = userEvent.setup(); renderOnboarding(api, discoveryFakes(), service);
    await user.click(await screen.findByRole("button", { name: "Open Report" }));
    const missing = await screen.findByRole("alert", { name: "Client setup incomplete" });
    expect(missing).toHaveTextContent("Placed Order metric ID");
    expect(screen.getByRole("button", { name: /Start Automatic Capture/ })).toBeDisabled();
    expect(service.start).not.toHaveBeenCalled();
  });

  it("Advanced / Debug saves keep every verified source, including Subscriber Growth", () => {
    const saved = cleanTargetInput(targetInput(readySteven()));
    expect(saved.sourceUrls).toEqual(READY_SOURCES);
  });
});
