import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository, upsertScreenshotMetadata } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotRecord } from "@tention/report-schema";
import { buildApp } from "./app.js";
import { InMemoryScreenshotStorage } from "./storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage } from "./storage/pdf-artifact-storage.js";
import { SUMMARY_EVIDENCE } from "./test-support/business-performance.js";

/** Delete Report inside a client's Reports list: one month's report only; the client, its setup and other months stay. */
const NOW = new Date("2026-11-06T12:00:00Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const renderedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const CLIENT = "faceables-decorative-brick-stone-coverings-llc";
let app: FastifyInstance;
let repository: InMemoryReportDraftRepository;
let targets: InMemoryClientReportTargetsRepository;
let screenshotStorage: InMemoryScreenshotStorage;
let pdfStorage: InMemoryPdfArtifactStorage;
let drive: { deliver: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
let docs: { syncGoogleDoc: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

beforeEach(() => {
  repository = new InMemoryReportDraftRepository(); targets = new InMemoryClientReportTargetsRepository(); screenshotStorage = new InMemoryScreenshotStorage(); pdfStorage = new InMemoryPdfArtifactStorage();
  drive = { deliver: vi.fn().mockResolvedValue({ fileId: "drive-file", folderId: "october-folder", webViewLink: "https://drive.google.com/file/d/drive-file/view", action: "created" }), delete: vi.fn() };
  docs = { syncGoogleDoc: vi.fn().mockResolvedValue({ docId: "doc-1", folderId: "october-folder", webViewLink: "https://docs.google.com/document/d/doc-1/edit", version: "1", action: "created" }), delete: vi.fn() };
  // Production default: reports require a READY client.
  app = buildApp({ now: () => new Date(NOW), repository, clientReportTargetsRepository: targets, screenshotStorage, pdfArtifactStorage: pdfStorage, pdfRenderer: { render: vi.fn().mockResolvedValue(renderedPdf), close: async () => undefined }, pdfDriveDelivery: drive, googleDocSync: docs });
});
afterEach(async () => app.close());

const setupOf = async (clientId = CLIENT) => (await app.inject({ method: "GET", url: `/api/v1/clients/${clientId}/setup` })).json();
const targetsOf = async (clientId = CLIENT) => (await app.inject({ method: "GET", url: `/api/v1/clients/${clientId}/report-targets` })).json();
async function readyClient(name = "Faceables Decorative Brick & Stone Coverings LLC", clientId = CLIENT) {
  expect((await app.inject({ method: "POST", url: "/api/v1/clients", payload: { name } })).statusCode).toBe(201);
  const { clientId: _id, createdAt: _c, updatedAt: _u, ...current } = await targetsOf(clientId);
  const saved = await app.inject({ method: "PUT", url: `/api/v1/clients/${clientId}/report-targets`, payload: {
    ...current,
    profile: { ...current.profile, timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: clientId === CLIENT ? "FCmet1" : "SDmet1" } },
    businessReview: { dashboardUrl: `https://www.klaviyo.com/analytics/dashboards/01${clientId === CLIENT ? "FCBR" : "SDBR"}`, displayName: "Business Review", accountLabel: name },
    sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" },
  } });
  expect(saved.statusCode).toBe(200);
  expect(await setupOf(clientId)).toMatchObject({ status: "READY" });
}
const createReport = async (month: number, clientId = CLIENT): Promise<ReportDraft> => {
  const response = await app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: { client: { id: clientId }, reportMonth: { year: 2026, month }, sections: { executive_summary: "required" } } });
  expect(response.statusCode).toBe(201);
  return response.json();
};
async function withCapture(report: ReportDraft): Promise<ReportDraft> {
  const storageKey = `reports/${report.id}/overview/shot.png`;
  const asset = await screenshotStorage.put(storageKey, PNG);
  const monthLabel = report.reportMonth.month === 10 ? "Oct 1, 2026 - Oct 31, 2026" : "Sep 1, 2026 - Sep 30, 2026";
  const screenshot: ScreenshotRecord = {
    id: "11111111-1111-4111-8111-111111111111", clientId: report.client.id, reportMonth: report.reportMonth, type: "overview",
    capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard", width: 1, height: 1, approved: false,
    storageKey, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, captureOrigin: "live_acceptance_import",
    approvedAt: null, periodConfirmed: true, sourceProof: createScreenshotSourceProof("overview", report.period, undefined, null, null, { ...SUMMARY_EVIDENCE, visiblePeriodText: monthLabel }),
  };
  return repository.save(upsertScreenshotMetadata(report, screenshot, "overview", { now: NOW }), report.version);
}
const withStatus = async (report: ReportDraft, status: ReportDraft["status"]) => repository.save({ ...report, status, version: report.version + 1 }, report.version);
async function generated(month: number): Promise<ReportDraft> {
  const draft = await withCapture(await createReport(month));
  const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/auto-generate`, payload: { expectedVersion: draft.version, expectedReportMonth: draft.reportMonth } });
  expect(response.json()).toMatchObject({ report: { status: "generated" }, artifact: { driveDelivery: { driveUploadStatus: "uploaded" }, googleDoc: { googleDocStatus: "synced" } } });
  return response.json().report;
}
const deleteReport = (reportId: string, clientId = CLIENT) => app.inject({ method: "DELETE", url: `/api/v1/clients/${clientId}/reports/${reportId}` });
const listed = async (clientId = CLIENT) => ((await app.inject({ method: "GET", url: `/api/v1/report-drafts?clientId=${clientId}` })).json() as ReportDraft[]).map(({ reportMonth }) => reportMonth.month).sort();

describe("DELETE /api/v1/clients/:clientId/reports/:reportId", () => {
  it("1. deletes a draft report", async () => {
    await readyClient();
    const draft = await createReport(10);
    const response = await deleteReport(draft.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: true, reportId: draft.id, clientId: CLIENT, reportMonth: { year: 2026, month: 10 }, driveFilesDeleted: false, driveFilesRetained: 0 });
    expect(await repository.getById(draft.id)).toBeNull();
  });

  it("2. deletes an in-progress report with its screenshot metadata, stored screenshots and lifecycle history", async () => {
    await readyClient();
    const inProgress = await withCapture(await createReport(10));
    const storageKey = inProgress.screenshots[0]!.storageKey!;
    expect(await screenshotStorage.get(storageKey)).not.toBeNull();
    expect((await deleteReport(inProgress.id)).statusCode).toBe(200);
    expect(await repository.getById(inProgress.id)).toBeNull();
    expect(await screenshotStorage.get(storageKey)).toBeNull();
    // Its lifecycle history went with it (the repository no longer knows the report at all).
    await expect(repository.getHistory(inProgress.id)).rejects.toMatchObject({ code: "REPORT_NOT_FOUND" });
  });

  it("3. deletes a failed report", async () => {
    await readyClient();
    const failed = await withStatus(await createReport(10), "failed");
    expect((await deleteReport(failed.id)).statusCode).toBe(200);
    expect(await repository.getById(failed.id)).toBeNull();
  });

  it("4 + 15. deletes a generated report and its local PDF, but never deletes Drive files and says so", async () => {
    await readyClient();
    const report = await generated(10);
    const [artifact] = await repository.listArtifacts(report.id);
    expect(await pdfStorage.get(artifact!.storageKey)).not.toBeNull();
    const response = await deleteReport(report.id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ deleted: true, driveFilesDeleted: false, driveFilesRetained: 2 });
    expect(await repository.listArtifacts(report.id)).toEqual([]);
    expect(await pdfStorage.get(artifact!.storageKey)).toBeNull();
    // Nothing reaches Google: no delete of any kind, and no further upload.
    expect(drive.delete).not.toHaveBeenCalled(); expect(docs.delete).not.toHaveBeenCalled();
    expect(drive.deliver).toHaveBeenCalledTimes(1); expect(docs.syncGoogleDoc).toHaveBeenCalledTimes(1);
  });

  it("5. refuses a report that is generating, and keeps it", async () => {
    await readyClient();
    const generating = await withStatus(await createReport(10), "generating");
    const response = await deleteReport(generating.id);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "REPORT_DELETE_BLOCKED_GENERATING", message: "This report is currently generating. Try again after generation finishes." });
    expect(await repository.getById(generating.id)).toMatchObject({ status: "generating", version: generating.version });
  });

  it("6–9. removes only the selected month: other months, client setup and READY status are unchanged", async () => {
    await readyClient();
    const october = await withCapture(await createReport(10));
    const september = await withCapture(await createReport(9));
    const august = await createReport(8);
    const setupBefore = await setupOf(); const targetsBefore = await targetsOf();
    expect((await deleteReport(october.id)).statusCode).toBe(200);
    expect(await listed()).toEqual([8, 9]);
    expect(await repository.getById(september.id)).toEqual(september);
    expect(await repository.getById(august.id)).toEqual(august);
    expect(await screenshotStorage.get(september.screenshots[0]!.storageKey!)).not.toBeNull();
    expect(await targetsOf()).toEqual(targetsBefore);
    expect(await setupOf()).toEqual(setupBefore);
    expect(setupBefore).toMatchObject({ status: "READY", blockers: [] });
  });

  it("10. the same month can be created again from the client's current READY setup", async () => {
    await readyClient();
    const first = await createReport(10);
    expect((await deleteReport(first.id)).statusCode).toBe(200);
    // The setup changed after the first report: the recreated report must freeze the current setup, not the old one.
    const { clientId: _id, createdAt: _c, updatedAt: _u, ...current } = await targetsOf();
    expect((await app.inject({ method: "PUT", url: `/api/v1/clients/${CLIENT}/report-targets`, payload: { ...current, profile: { ...current.profile, conversionMetric: { label: "Placed Order", providerMetricId: "FCmet2" } } } })).statusCode).toBe(200);
    const again = await createReport(10);
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ status: "draft", reportMonth: { year: 2026, month: 10 }, client: { id: CLIENT, conversionMetric: { providerMetricId: "FCmet2" } }, period: { startDate: "2026-10-01", endDate: "2026-10-31" } });
  });

  it("14. refuses a report that belongs to another client, and deletes nothing", async () => {
    await readyClient();
    await readyClient("Steven Dann", "steven-dann");
    const theirs = await createReport(10, "steven-dann");
    const response = await deleteReport(theirs.id, CLIENT);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "REPORT_CLIENT_MISMATCH" });
    expect(await repository.getById(theirs.id)).toEqual(theirs);
  });

  it("returns REPORT_NOT_FOUND for a report that does not exist", async () => {
    await readyClient();
    const response = await deleteReport("00000000-0000-4000-8000-000000000099");
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "REPORT_NOT_FOUND" });
  });
});
