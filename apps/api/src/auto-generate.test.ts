import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_EVIDENCE } from "./test-support/business-performance.js";
import type { FastifyInstance } from "fastify";
import { createReportDraft, InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository, upsertScreenshotMetadata, validateReportDraft } from "@tention/report-domain";
import { clientReportTargetsInputSchema, createScreenshotSourceProof, type ReportDraft, type ScreenshotRecord } from "@tention/report-schema";
import { buildApp } from "./app.js";
import { InMemoryScreenshotStorage } from "./storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage } from "./storage/pdf-artifact-storage.js";

/** Automatic capture → machine validation → final PDF, with no human approval and no fake approval records. */
const NOW = new Date("2026-09-09T12:00:00Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const renderedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
let app: FastifyInstance;
let repository: InMemoryReportDraftRepository;
let screenshotStorage: InMemoryScreenshotStorage;
let pdfStorage: InMemoryPdfArtifactStorage;
let pdfRenderer: { render: ReturnType<typeof vi.fn>; close: () => Promise<void> };

async function start(currency: string | null = "USD", providerMetricId: string | null = "KyqTnx") {
  const targets = new InMemoryClientReportTargetsRepository();
  await targets.save("client-1", clientReportTargetsInputSchema.parse({ profile: { name: "Club Furniture", timezone: "America/New_York", currency, conversionMetric: { label: "Placed Order", providerMetricId }, sections: null } }), NOW);
  app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), screenshotStorage, pdfArtifactStorage: pdfStorage, pdfRenderer, repository, clientReportTargetsRepository: targets });
}
beforeEach(() => { repository = new InMemoryReportDraftRepository(); screenshotStorage = new InMemoryScreenshotStorage(); pdfStorage = new InMemoryPdfArtifactStorage(); pdfRenderer = { render: vi.fn().mockResolvedValue(renderedPdf), close: async () => undefined }; });
afterEach(async () => app?.close());

/** One required automatic section with a pending (unapproved) automatic capture, as an automatic run imports it. */
async function capturedDraft(options: { proofPeriodOf?: ReportDraft["period"]; withCapture?: boolean; withoutCoverValues?: boolean } = {}) {
  const created = (await app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: { client: { id: "client-1", name: "Club Furniture", timezone: "America/New_York" }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } } })).json() as ReportDraft;
  if (options.withCapture === false) return { draft: created, storageKey: "" };
  const storageKey = `reports/${created.id}/overview/11111111-1111-4111-8111-111111111111.png`;
  const asset = await screenshotStorage.put(storageKey, PNG);
  const screenshot: ScreenshotRecord = {
    id: "11111111-1111-4111-8111-111111111111", clientId: created.client.id, reportMonth: created.reportMonth, type: "overview",
    capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard", width: 1, height: 1, approved: false,
    storageKey, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, captureOrigin: "live_acceptance_import",
    approvedAt: null, periodConfirmed: true, sourceProof: createScreenshotSourceProof("overview", options.proofPeriodOf ?? created.period, undefined, null, null, options.withoutCoverValues ? null : SUMMARY_EVIDENCE),
  };
  const draft = await repository.save(upsertScreenshotMetadata(created, screenshot, "overview", { now: NOW }), created.version);
  return { draft, storageKey };
}
const autoGenerate = (draft: ReportDraft, expectedVersion = draft.version) => app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/auto-generate`, payload: { expectedVersion, expectedReportMonth: draft.reportMonth } });
const historyOf = async (id: string) => (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${id}/history` })).json().map(({ eventType, fromStatus, toStatus }: Record<string, string>) => `${eventType}:${fromStatus}->${toStatus}`);

describe("automatic final report without human approval", () => {
  it("machine-validates the automatic captures and generates the final PDF in one call, never recording a human approval", async () => {
    await start();
    const { draft } = await capturedDraft();
    const response = await autoGenerate(draft);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ report: { status: "generated" }, artifact: { mimeType: "application/pdf", byteSize: renderedPdf.length } });
    const shot = response.json().report.screenshots[0];
    expect(shot).toMatchObject({ approved: false, approvedAt: null, automatedValidatedAt: NOW.toISOString() });
    expect(pdfRenderer.render).toHaveBeenCalledTimes(1);
    expect(await historyOf(draft.id)).toEqual(["REPORT_CREATED:null->draft", "AUTO_VALIDATE:draft->auto_validated", "START_GENERATION:auto_validated->generating", "GENERATION_SUCCEEDED:generating->generated"]);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draft.id}/pdf-artifact` })).statusCode).toBe(200);
  });

  it("is idempotent once generated: the same captures return the existing artifact without rendering again", async () => {
    await start();
    const { draft } = await capturedDraft();
    const first = (await autoGenerate(draft)).json();
    const second = await autoGenerate(first.report);
    expect(second.statusCode).toBe(200);
    expect(second.json().artifact.id).toBe(first.artifact.id);
    expect(pdfRenderer.render).toHaveBeenCalledTimes(1);
  });

  it("refuses when a stored capture's bytes no longer match its hash: nothing is validated, rendered or changed", async () => {
    await start();
    const { draft, storageKey } = await capturedDraft();
    await screenshotStorage.put(storageKey, Buffer.concat([PNG, Buffer.from("tampered")]));
    const response = await autoGenerate(draft);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json().message).toMatch(/overview failed stored-byte verification/);
    expect(pdfRenderer.render).not.toHaveBeenCalled();
    const unchanged = (await repository.getById(draft.id))!;
    expect(unchanged).toMatchObject({ status: "draft", version: draft.version });
    expect(unchanged.screenshots[0]!.automatedValidatedAt ?? null).toBeNull();
    expect(await historyOf(draft.id)).toEqual(["REPORT_CREATED:null->draft"]);
  });

  it("refuses when a required automatic capture is missing", async () => {
    await start();
    const { draft } = await capturedDraft({ withCapture: false });
    const response = await autoGenerate(draft);
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(pdfRenderer.render).not.toHaveBeenCalled();
    expect(await repository.getById(draft.id)).toMatchObject({ status: "draft", version: draft.version });
  });

  it("refuses a capture whose source proof is for another period", async () => {
    await start();
    const { draft } = await capturedDraft({ proofPeriodOf: { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" } });
    const response = await autoGenerate(draft);
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("REPORT_VALIDATION_FAILED");
    expect(pdfRenderer.render).not.toHaveBeenCalled();
    expect(await repository.getById(draft.id)).toMatchObject({ status: "draft", version: draft.version });
  });

  it.each([
    ["currency", null, "KyqTnx", "CURRENCY_NOT_CONFIGURED"],
    ["conversion metric ID", "USD", null, "CONVERSION_METRIC_ID_NOT_CONFIGURED"],
  ] as const)("fails closed before any state change when the %s is not configured", async (_label, currency, metricId, code) => {
    await start(currency, metricId);
    const { draft } = await capturedDraft();
    const response = await autoGenerate(draft);
    expect(response.statusCode).toBe(409);
    expect(response.json().blockers.map(({ code: value }: { code: string }) => value)).toContain(code);
    expect(pdfRenderer.render).not.toHaveBeenCalled();
    expect(await repository.getById(draft.id)).toMatchObject({ status: "draft", version: draft.version });
  });

  it("keeps the machine validation after a render failure, and a retry generates without recapturing", async () => {
    await start();
    pdfRenderer.render.mockRejectedValueOnce(new Error("renderer offline"));
    const { draft } = await capturedDraft();
    const failed = await autoGenerate(draft);
    expect(failed.statusCode).toBe(500);
    const after = (await repository.getById(draft.id))!;
    expect(after).toMatchObject({ status: "failed", screenshots: [expect.objectContaining({ approved: false, automatedValidatedAt: NOW.toISOString() })] });
    const retried = await autoGenerate(after);
    expect(retried.statusCode).toBe(200);
    expect(retried.json().report.status).toBe("generated");
    expect(retried.json().report.screenshots[0].sha256).toBe(draft.screenshots[0]!.sha256);
  });

  it("cannot be reached through the generic lifecycle events endpoint, which would skip byte verification", async () => {
    await start();
    const { draft } = await capturedDraft();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/events`, payload: { event: "AUTO_VALIDATE", expectedVersion: draft.version } });
    expect(response.statusCode).toBe(400);
    expect(await repository.getById(draft.id)).toMatchObject({ status: "draft", version: draft.version });
  });

  it("does not carry machine validation over to a retaken capture", () => {
    const base = createReportDraft({ client: { id: "client-1", name: "Club Furniture", timezone: "America/New_York", currency: "USD" }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } }, { now: NOW });
    const shot = (automatedValidatedAt: string | null): ScreenshotRecord => ({ id: "x", clientId: "client-1", reportMonth: base.reportMonth, type: "overview", capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard", width: 1, height: 1, approved: false, storageKey: "k", mimeType: "image/png", byteSize: 1, sha256: "a".repeat(64), captureOrigin: "live_acceptance_import", approvedAt: null, periodConfirmed: true, sourceProof: createScreenshotSourceProof("overview", base.period), automatedValidatedAt });
    expect(validateReportDraft({ ...base, screenshots: [shot(NOW.toISOString())] }, { now: NOW }).errors).toEqual([]);
    expect(validateReportDraft({ ...base, screenshots: [shot(null)] }, { now: NOW }).errors.map(({ code }) => code)).toEqual(["REQUIRED_SCREENSHOT_UNAPPROVED"]);
    // A manual capture is never accepted by machine validation alone.
    expect(validateReportDraft({ ...base, screenshots: [{ ...shot(NOW.toISOString()), captureOrigin: "extension_manual" }] }, { now: NOW }).errors.map(({ code }) => code)).toEqual(["REQUIRED_SCREENSHOT_UNAPPROVED"]);
  });
});
