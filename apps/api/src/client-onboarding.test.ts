import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository, upsertScreenshotMetadata } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotRecord } from "@tention/report-schema";
import { buildApp } from "./app.js";
import { InMemoryScreenshotStorage } from "./storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage } from "./storage/pdf-artifact-storage.js";
import { SUMMARY_EVIDENCE } from "./test-support/business-performance.js";

/** Client onboarding with the production rule on: nothing monthly happens until the client's setup is READY. */
const NOW = new Date("2026-11-06T12:00:00Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const renderedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
let app: FastifyInstance;
let repository: InMemoryReportDraftRepository;
let targets: InMemoryClientReportTargetsRepository;
let screenshotStorage: InMemoryScreenshotStorage;
let renderer: { render: ReturnType<typeof vi.fn>; close: () => Promise<void> };
let drive: { deliver: ReturnType<typeof vi.fn> };
let docs: { syncGoogleDoc: ReturnType<typeof vi.fn> };

beforeEach(() => {
  repository = new InMemoryReportDraftRepository(); targets = new InMemoryClientReportTargetsRepository(); screenshotStorage = new InMemoryScreenshotStorage();
  renderer = { render: vi.fn().mockResolvedValue(renderedPdf), close: async () => undefined };
  drive = { deliver: vi.fn().mockResolvedValue({ fileId: "drive-file", folderId: "october-folder", webViewLink: "https://drive.google.com/file/d/drive-file/view", action: "created" }) };
  docs = { syncGoogleDoc: vi.fn().mockResolvedValue({ docId: "doc-1", folderId: "october-folder", webViewLink: "https://docs.google.com/document/d/doc-1/edit", version: "1", action: "created" }) };
  // No requireClientSetupReady override: this is the production default.
  app = buildApp({ now: () => new Date(NOW), repository, clientReportTargetsRepository: targets, screenshotStorage, pdfArtifactStorage: new InMemoryPdfArtifactStorage(), pdfRenderer: renderer, pdfDriveDelivery: drive, googleDocSync: docs });
});
afterEach(async () => app.close());

const addClient = (name: unknown) => app.inject({ method: "POST", url: "/api/v1/clients", payload: { name } });
const setupOf = async (clientId: string) => (await app.inject({ method: "GET", url: `/api/v1/clients/${clientId}/setup` })).json();
const targetsOf = async (clientId: string) => (await app.inject({ method: "GET", url: `/api/v1/clients/${clientId}/report-targets` })).json();
/** Saves on top of what is stored, exactly as the extension does (it always sends the whole configuration). */
async function update(clientId: string, change: (current: Record<string, any>) => Record<string, any>) {
  const { clientId: _id, createdAt: _c, updatedAt: _u, ...current } = await targetsOf(clientId);
  return app.inject({ method: "PUT", url: `/api/v1/clients/${clientId}/report-targets`, payload: change(current) });
}
/** Steven Dann's own values, as onboarding verifies them; nothing is copied from another client. */
async function completeStevenDannSetup(metricId = "SDmet1", accountLabel = "Steven Dann") {
  expect((await addClient("Steven Dann")).statusCode).toBe(201);
  const saved = await update("steven-dann", (current) => ({
    ...current,
    profile: { ...current.profile, timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: metricId } },
    businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01SDBR", displayName: "Business Review", accountLabel },
    sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" },
  }));
  expect(saved.statusCode).toBe(200);
}
const createReport = (clientId: string, month: number, sections: Record<string, string> = { executive_summary: "required" }) =>
  app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: { client: { id: clientId }, reportMonth: { year: 2026, month }, sections } });
async function withExecutiveSummaryCapture(created: ReportDraft): Promise<ReportDraft> {
  const storageKey = `reports/${created.id}/overview/shot.png`;
  const asset = await screenshotStorage.put(storageKey, PNG);
  const screenshot: ScreenshotRecord = {
    id: "11111111-1111-4111-8111-111111111111", clientId: created.client.id, reportMonth: created.reportMonth, type: "overview",
    capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard", width: 1, height: 1, approved: false,
    storageKey, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, captureOrigin: "live_acceptance_import",
    approvedAt: null, periodConfirmed: true, sourceProof: createScreenshotSourceProof("overview", created.period, undefined, null, null, { ...SUMMARY_EVIDENCE, visiblePeriodText: "Oct 1, 2026 - Oct 31, 2026" }),
  };
  return repository.save(upsertScreenshotMetadata(created, screenshot, "overview", { now: NOW }), created.version);
}
const autoGenerate = (draft: ReportDraft) => app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/auto-generate`, payload: { expectedVersion: draft.version, expectedReportMonth: draft.reportMonth } });

describe("adding a client", () => {
  it("creates one permanent profile from the name alone, INCOMPLETE with the exact missing items", async () => {
    const created = await addClient("Steven Dann");
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ clientId: "steven-dann", name: "Steven Dann", status: "INCOMPLETE" });
    expect(created.json().blockers.map(({ code }: { code: string }) => code)).toEqual([
      "KLAVIYO_ACCOUNT_NOT_VERIFIED", "TIMEZONE_NOT_CONFIGURED", "CURRENCY_NOT_CONFIGURED", "CONVERSION_METRIC_ID_NOT_CONFIGURED",
      "BUSINESS_REVIEW_SOURCE_NOT_VERIFIED", "DELIVERABILITY_SOURCE_NOT_VERIFIED", "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED",
    ]);
    expect(created.json().setup.profile).toMatchObject({ name: "Steven Dann", timezone: null, currency: null, conversionMetric: { label: "Placed Order", providerMetricId: null } });
    const listed = (await app.inject({ method: "GET", url: "/api/v1/client-setups" })).json();
    expect(listed.map(({ clientId, status }: { clientId: string; status: string }) => [clientId, status])).toEqual([["steven-dann", "INCOMPLETE"]]);
  });

  it("requires a client name and never creates the same client twice", async () => {
    expect((await addClient("")).statusCode).toBe(400);
    expect((await addClient("   ")).statusCode).toBe(400);
    expect((await addClient("!!!")).json()).toMatchObject({ error: "INVALID_CLIENT_NAME" });
    await addClient("Steven Dann");
    const again = await addClient("Steven Dann");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "CLIENT_ALREADY_EXISTS", clientId: "steven-dann" });
  });
});

describe("reports only after the client is READY", () => {
  it("an INCOMPLETE client cannot create a monthly report; the response names exactly what is missing", async () => {
    await addClient("Steven Dann");
    await update("steven-dann", (current) => ({ ...current, profile: { ...current.profile, timezone: "America/New_York" } }));
    const response = await createReport("steven-dann", 10);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "CLIENT_SETUP_INCOMPLETE", clientId: "steven-dann" });
    expect(response.json().blockers.map(({ code }: { code: string }) => code)).toEqual([
      "KLAVIYO_ACCOUNT_NOT_VERIFIED", "CURRENCY_NOT_CONFIGURED", "CONVERSION_METRIC_ID_NOT_CONFIGURED",
      "BUSINESS_REVIEW_SOURCE_NOT_VERIFIED", "DELIVERABILITY_SOURCE_NOT_VERIFIED", "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED",
    ]);
    expect(await repository.list()).toEqual([]);
  });

  it("a READY client creates a report for the selected month, freezing its own setup on the report", async () => {
    await completeStevenDannSetup();
    expect(await setupOf("steven-dann")).toMatchObject({ status: "READY", blockers: [] });
    const response = await createReport("steven-dann", 10);
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      client: { id: "steven-dann", name: "Steven Dann", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "SDmet1" }, klaviyoAccount: { accountLabel: "Steven Dann", providerAccountId: null } },
      reportMonth: { year: 2026, month: 10 },
      period: { startDate: "2026-10-01", endDate: "2026-10-31", previousStartDate: "2026-09-01", previousEndDate: "2026-09-30" },
    });
  });

  it("refuses an incomplete (current) month even for a READY client", async () => {
    await completeStevenDannSetup();
    expect((await createReport("steven-dann", 11)).json()).toMatchObject({ error: "REPORT_MONTH_INCOMPLETE" });
  });

  it("a new month reuses the saved client configuration: no setup is repeated", async () => {
    await completeStevenDannSetup();
    const october = (await createReport("steven-dann", 10)).json();
    const september = (await createReport("steven-dann", 9)).json();
    expect(september.client).toEqual(october.client);
    expect(september.period).toEqual({ startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" });
  });

  it("optional sections missing (signup forms, welcome flow, customer split) do not block READY or report creation", async () => {
    await completeStevenDannSetup();
    const setup = await setupOf("steven-dann");
    expect(setup.setup).toMatchObject({ welcomeFlowListing: null, customerSegment: null, nonCustomerSegment: null });
    expect(setup.status).toBe("READY");
    expect((await createReport("steven-dann", 10, { executive_summary: "required", signup_form: "optional", welcome_flow: "optional", customer_split: "optional" })).statusCode).toBe(201);
  });

  it("generates the final PDF, Drive PDF and Google Doc for a READY client; the Drive root stays global", async () => {
    await completeStevenDannSetup();
    const draft = await withExecutiveSummaryCapture((await createReport("steven-dann", 10)).json());
    const response = await autoGenerate(draft);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ report: { status: "generated" }, artifact: { driveDelivery: { driveUploadStatus: "uploaded", driveFileName: "Steven Dann - October 2026.pdf" }, googleDoc: { googleDocStatus: "synced" } } });
    // Only year, month, name and bytes reach Drive: the root folder comes from the global Google configuration.
    expect(drive.deliver).toHaveBeenCalledWith({ year: 2026, month: 10, fileName: "Steven Dann - October 2026.pdf", bytes: renderedPdf });
    expect(JSON.stringify(await setupOf("steven-dann"))).not.toMatch(/drive|folder/i);
  });
});

describe("generation is blocked whenever the client is not READY", () => {
  it("blocks final PDF, Drive and Google Doc after the setup becomes incomplete, without rendering or uploading", async () => {
    await completeStevenDannSetup();
    const draft = await withExecutiveSummaryCapture((await createReport("steven-dann", 10)).json());
    await update("steven-dann", (current) => ({ ...current, sourceUrls: { subscriberGrowthUrl: current.sourceUrls.subscriberGrowthUrl } }));
    const blocked = await autoGenerate(draft);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: "CLIENT_SETUP_INCOMPLETE", blockers: [{ code: "DELIVERABILITY_SOURCE_NOT_VERIFIED" }] });
    for (const path of ["pdf-artifact/drive-delivery", "pdf-artifact/google-doc"]) {
      expect((await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/${path}`, payload: {} })).json()).toMatchObject({ error: "CLIENT_SETUP_INCOMPLETE" });
    }
    expect(renderer.render).not.toHaveBeenCalled();
    expect(drive.deliver).not.toHaveBeenCalled();
    expect(docs.syncGoogleDoc).not.toHaveBeenCalled();
    expect((await repository.getById(draft.id))).toMatchObject({ status: "draft", version: draft.version });
  });
});

describe("client configuration is per client and never rewrites history", () => {
  it("another client's provider metric ID is never reused", async () => {
    await addClient("Club Furniture");
    await update("club-furniture", (current) => ({ ...current, profile: { ...current.profile, timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "KyqTnx" } } }));
    await addClient("Steven Dann");
    const copied = await update("steven-dann", (current) => ({ ...current, profile: { ...current.profile, conversionMetric: { label: "Placed Order", providerMetricId: "KyqTnx" } } }));
    expect(copied.statusCode).toBe(409);
    expect(copied.json()).toMatchObject({ error: "CONVERSION_METRIC_ID_ALREADY_BOUND" });
    expect((await targetsOf("steven-dann")).profile.conversionMetric.providerMetricId).toBeNull();
  });

  it("stores only a well-formed metric ID (trimmed), so a manual entry can never smuggle in a URL", async () => {
    await addClient("Steven Dann");
    const withId = (providerMetricId: string) => update("steven-dann", (current) => ({ ...current, profile: { ...current.profile, conversionMetric: { label: "Placed Order", providerMetricId } } }));
    expect((await withId("https://www.klaviyo.com/metric/QuWhQ9/placed-order")).statusCode).toBe(400);
    expect((await withId("Qu WhQ9")).statusCode).toBe(400);
    expect((await targetsOf("steven-dann")).profile.conversionMetric.providerMetricId).toBeNull();
    expect((await withId("  QuWhQ9 ")).json().profile.conversionMetric).toEqual({ label: "Placed Order", providerMetricId: "QuWhQ9" });
  });

  it("corrects the saved account label to the real Klaviyo name only when it is the same account", async () => {
    // Bound as onboarding first stored it, with the avatar initials.
    await completeStevenDannSetup("SDmet1", "ST Steven Dann");
    await addClient("Club Furniture");
    await update("club-furniture", (current) => ({ ...current, businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01CF", displayName: "Business Review", accountLabel: "CL Club Furniture" } }));
    const before = await targetsOf("steven-dann");
    const relabel = (label: string) => update("steven-dann", (current) => ({ ...current, businessReview: { ...current.businessReview, accountLabel: label } }));
    expect((await relabel("Club Furniture")).json()).toMatchObject({ error: "CLIENT_ACCOUNT_BINDING_IMMUTABLE" });
    expect((await relabel("CL Club Furniture")).json()).toMatchObject({ error: "CLIENT_ACCOUNT_BINDING_IMMUTABLE" });
    const corrected = await relabel("Steven Dann");
    expect(corrected.statusCode).toBe(200);
    const after = await targetsOf("steven-dann");
    expect(after.businessReview.accountLabel).toBe("Steven Dann");
    // Only the label changed: profile, metric, sources and the dashboard stay exactly as they were.
    expect({ ...after, businessReview: { ...after.businessReview, accountLabel: null }, updatedAt: null }).toEqual({ ...before, businessReview: { ...before.businessReview, accountLabel: null }, updatedAt: null });
    expect((await targetsOf("club-furniture")).businessReview.accountLabel).toBe("CL Club Furniture");
    expect(await setupOf("steven-dann")).toMatchObject({ status: "READY" });
  });

  it("a later change to timezone, currency, metric ID or sources applies to new reports only", async () => {
    await completeStevenDannSetup();
    const october = await withExecutiveSummaryCapture((await createReport("steven-dann", 10)).json());
    expect((await update("steven-dann", (current) => ({ ...current, profile: { ...current.profile, timezone: "America/Chicago", currency: "CAD", conversionMetric: { label: "Placed Order", providerMetricId: "SDmet2" } } }))).statusCode).toBe(200);
    const historical = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${october.id}` })).json();
    expect(historical.client).toEqual(october.client);
    expect(historical.client).toMatchObject({ timezone: "America/New_York", currency: "USD", conversionMetric: { providerMetricId: "SDmet1" } });
    // The October report still generates with its own frozen USD definition (its cover was captured in USD).
    expect((await autoGenerate(october)).json()).toMatchObject({ report: { status: "generated", client: { currency: "USD" } } });
    const september = (await createReport("steven-dann", 9)).json();
    expect(september.client).toMatchObject({ timezone: "America/Chicago", currency: "CAD", conversionMetric: { providerMetricId: "SDmet2" } });
  });
});
