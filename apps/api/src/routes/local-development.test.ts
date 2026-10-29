import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportDraftRepository } from "@tention/report-domain";
import { createReportDraft, InMemoryReportDraftRepository, upsertScreenshotMetadata } from "@tention/report-domain";
import { createScreenshotSourceProof, screenshotRecordSchema } from "@tention/report-schema";
import { buildApp } from "../app.js";
import { InMemoryPdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import { InMemoryScreenshotStorage } from "../storage/screenshot-storage.js";

const apps: ReturnType<typeof buildApp>[] = [];
const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function draft(version = 2) {
  return {
    id: "f577d631-a1f6-4cc0-9052-68e30460876d",
    client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null },
    reportMonth: { year: 2026, month: 8 }, status: "draft", version,
  };
}

describe("local development review PDF retrieval", () => {
  it("serves a development review PDF for another client identity without changing its draft lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-generic-review-route-")); temporaryRoots.push(root);
    const reportId = "c1234567-1234-4234-8234-123456789012";
    const report = { ...draft(), id: reportId, client: { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency: null } };
    const directory = join(root, "output/live-review/club-furniture/2026-08"); await mkdir(directory, { recursive: true });
    const pdf = Buffer.from("%PDF-1.4\ngeneric development review\n%%EOF");
    const pdfPath = join(directory, "Club-Furniture-2026-08-PARTIAL-REVIEW.pdf");
    const sha256 = createHash("sha256").update(pdf).digest("hex"); await writeFile(pdfPath, pdf);
    const pdfArtifactStorage = new InMemoryPdfArtifactStorage();
    const storageKey = `reports/${reportId}/artifacts/11111111-2222-3333-4444-555555555555.pdf`; await pdfArtifactStorage.put(storageKey, pdf);
    await writeFile(join(directory, "review-results.json"), JSON.stringify({
      reportId, clientId: report.client.id, clientName: report.client.name, reportMonth: report.reportMonth,
      developmentOnly: true, finalClientArtifact: false, reportLifecycle: { status: "draft", version: 2 },
      pdf: { path: pdfPath, fileName: "Club-Furniture-2026-08-Performance-Review.pdf", storageKey, byteSize: pdf.length, sha256, physicalPageCount: 7 },
    }));
    const repository = { getById: vi.fn().mockResolvedValue(report) } as unknown as ReportDraftRepository;
    const app = buildApp({ repository, pdfArtifactStorage, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);
    const status = await app.inject({ method: "GET", url: `/api/v1/dev/report-drafts/${reportId}/partial-review/status` });
    expect(status.statusCode, JSON.stringify(status.json())).toBe(200);
    expect(status.json()).toMatchObject({ reportId, reportVersion: 2, fileName: "Club-Furniture-2026-08-Performance-Review.pdf", sha256, developmentOnly: true });
    const download = await app.inject({ method: "GET", url: `/api/v1/dev/report-drafts/${reportId}/partial-review/pdf?download=1` });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe('attachment; filename="Club-Furniture-2026-08-Performance-Review.pdf"');
    expect(download.rawPayload).toEqual(pdf);
  });

  it("serves only the current report-version PDF and provides an attachment filename", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-review-route-")); temporaryRoots.push(root);
    const directory = join(root, "output/live-review/autoledtech/2026-08"); await mkdir(directory, { recursive: true });
    const pdf = Buffer.from("%PDF-1.4\nlocal development review\n%%EOF");
    const pdfPath = join(directory, "AutoLEDTech-2026-08-PARTIAL-REVIEW.pdf");
    const sha256 = createHash("sha256").update(pdf).digest("hex");
    await writeFile(pdfPath, pdf);
    const pdfArtifactStorage = new InMemoryPdfArtifactStorage();
    const storageKey = "reports/f577d631-a1f6-4cc0-9052-68e30460876d/artifacts/11111111-2222-3333-4444-555555555555.pdf";
    await pdfArtifactStorage.put(storageKey, pdf);
    await writeFile(join(directory, "review-results.json"), JSON.stringify({
      canonicalReportId: "f577d631-a1f6-4cc0-9052-68e30460876d", developmentOnly: true, finalClientArtifact: false,
      reportLifecycle: { status: "draft", version: 2 }, pdf: { path: pdfPath, storageKey, byteSize: pdf.length, sha256, physicalPageCount: 7 },
    }));
    const repository = { getById: vi.fn().mockResolvedValue(draft()) } as unknown as ReportDraftRepository;
    const app = buildApp({ repository, pdfArtifactStorage, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);

    const status = await app.inject({ method: "GET", url: "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/status" });
    expect(status.statusCode, JSON.stringify(status.json())).toBe(200);
    expect(status.json()).toMatchObject({ reportId: draft().id, reportVersion: 2, fileName: "AutoLEDTech-2026-08-Performance-Review.pdf", byteSize: pdf.length, sha256, physicalPageCount: 7, developmentOnly: true });

    const inline = await app.inject({ method: "GET", url: "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/pdf" });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-type"]).toContain("application/pdf");
    expect(inline.headers["content-disposition"]).toContain("inline");
    expect(inline.headers["x-review-pdf-sha256"]).toBe(sha256);
    expect(inline.rawPayload).toEqual(pdf);

    const download = await app.inject({ method: "GET", url: "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/pdf?download=1" });
    expect(download.headers["content-disposition"]).toBe('attachment; filename="AutoLEDTech-2026-08-Performance-Review.pdf"');
    expect(download.rawPayload).toEqual(pdf);

    repository.getById = vi.fn().mockResolvedValue(draft(3));
    const stale = await app.inject({ method: "GET", url: "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/pdf" });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "PDF_REVIEW_STALE" });
  });

  it("rejects a modified or checksum-mismatched saved review PDF", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-review-corrupt-")); temporaryRoots.push(root);
    const directory = join(root, "output/live-review/autoledtech/2026-08"); await mkdir(directory, { recursive: true });
    const pdfPath = join(directory, "AutoLEDTech-2026-08-PARTIAL-REVIEW.pdf");
    const pdf = Buffer.from("%PDF-1.4\nchanged\n%%EOF"); await writeFile(pdfPath, pdf);
    const pdfArtifactStorage = new InMemoryPdfArtifactStorage();
    const storageKey = "reports/f577d631-a1f6-4cc0-9052-68e30460876d/artifacts/11111111-2222-3333-4444-555555555555.pdf";
    await pdfArtifactStorage.put(storageKey, pdf);
    await writeFile(join(directory, "review-results.json"), JSON.stringify({
      canonicalReportId: draft().id, developmentOnly: true, finalClientArtifact: false,
      reportLifecycle: { status: "draft", version: 2 },
      pdf: { path: pdfPath, storageKey, byteSize: pdf.length, sha256: "0".repeat(64), physicalPageCount: 7 },
    }));
    const repository = { getById: vi.fn().mockResolvedValue(draft()) } as unknown as ReportDraftRepository;
    const app = buildApp({ repository, pdfArtifactStorage, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/pdf" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "PDF_REVIEW_ARTIFACT_INVALID" });
  });
});

describe("local automatic-capture acceptance diagnostics", () => {
  it("persists a report-bound run, redacted section results, and hashed PNG evidence without changing the report", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-automatic-run-")); temporaryRoots.push(root);
    const repository = new InMemoryReportDraftRepository();
    const now = new Date("2026-10-09T12:00:00.000Z");
    const report = createReportDraft({
      client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 },
      sections: { executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", campaign_performance: "required", campaign_metrics: "required", flow_performance: "required", flow_metrics: "required", deliverability: "required", signup_form: "optional", welcome_flow: "optional", customer_split: "optional", list_growth: "optional", analysis: "optional", next_month_plan: "optional" },
    }, { now, id: "f577d631-a1f6-4cc0-9052-68e30460876d" });
    await repository.create(report);
    const app = buildApp({ repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);
    const runId = "d5b98faf-955e-4474-8c8c-7c8a9a2f83a5";
    const startedAt = now.toISOString();
    const started = await app.inject({ method: "POST", url: "/api/v1/dev/automatic-capture-runs", payload: { runId, reportId: report.id, clientId: "autoledtech", reportMonth: { year: 2026, month: 8 }, startedAt } });
    expect(started.statusCode).toBe(201);
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); Buffer.from("IHDR").copy(png, 12); png.writeUInt32BE(480, 16); png.writeUInt32BE(320, 20);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const section = { status: "pass", attemptNumber: 1, startedAt, finishedAt: startedAt, durationMs: 20, expectedUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true&token=do-not-save", observedUrl: "https://www.klaviyo.com/omnicampaigns?appBarNav=true&session=private", expectedSourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc", observedSourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc", expectedPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" }, observedPeriod: "Aug 1, 2026 – Aug 31, 2026", expectedSemanticCard: "Campaigns", expectedView: "Placed Order revenue descending", visibleControls: [{ text: "Placed Order", tag: "button", ariaSelected: "true" }], usableRowCount: 5, screenshotResult: "fresh_semantic_crop_saved", sourceProofResult: "PASS", sha256, errorCode: null, errorMessage: null, diagnostics: { currentUrl: "https://www.klaviyo.com/omnicampaigns", observedPeriodProof: { startDate: "2026-08-01", endDate: "2026-08-31" }, pageHtml: "<main>account person@example.com</main>", authorization: "should redact", targetBounds: { includedRowCount: 5, availableRowCount: 5 } } };
    const startedSection = await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns`, payload: { ...section, status: "running", finishedAt: null, durationMs: null, screenshotResult: "pending", sourceProofResult: "pending", sha256: null } });
    expect(startedSection.statusCode).toBe(200);
    const prematurePass = await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns`, payload: section });
    expect(prematurePass.statusCode).toBe(409);
    expect(prematurePass.json()).toMatchObject({ error: "AUTOMATIC_RUN_PASS_NOT_VERIFIED" });
    const evidence = await app.inject({ method: "PUT", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns/evidence/capture?attempt=1`, headers: { "content-type": "image/png" }, payload: png });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json()).toMatchObject({ runId, section: "top_campaigns", kind: "capture", byteSize: png.length, sha256 });
    // Ranked rows: never zero, and never a count other than min(limit, usable) — no padding, no over-inclusion.
    for (const [usableRowCount, includedRowCount] of [[0, 0], [5, 2], [5, 4], [2, 3]] as const) {
      const rejected = await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns`, payload: { ...section, usableRowCount, diagnostics: { ...section.diagnostics, targetBounds: { includedRowCount, availableRowCount: usableRowCount } } } });
      expect(rejected.statusCode, `${usableRowCount}/${includedRowCount}`).toBe(409);
    }
    const twoRealRows = await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns`, payload: { ...section, usableRowCount: 2, diagnostics: { ...section.diagnostics, targetBounds: { includedRowCount: 2, availableRowCount: 2 } } } });
    expect(twoRealRows.statusCode).toBe(200);
    const saved = await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns`, payload: section });
    expect(saved.statusCode).toBe(200);
    // Top 5 Flows with only one real Home row is a valid capture of that one row.
    expect((await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_flows`, payload: { ...section, status: "running", finishedAt: null, durationMs: null, screenshotResult: "pending", sourceProofResult: "pending" } })).statusCode).toBe(200);
    const flowsEvidence = await app.inject({ method: "PUT", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_flows/evidence/capture?attempt=1`, headers: { "content-type": "image/png" }, payload: png });
    expect(flowsEvidence.statusCode).toBe(200);
    const flowsSection = { ...section, expectedUrl: "https://www.klaviyo.com/dashboard", observedUrl: "https://www.klaviyo.com/dashboard", expectedSourceIdentity: "klaviyo-home|top-performing-flows|default", observedSourceIdentity: "klaviyo-home|top-performing-flows|default", expectedSemanticCard: "Top performing flows", expectedView: "Default", diagnostics: { ...section.diagnostics, currentUrl: "https://www.klaviyo.com/dashboard" } };
    for (const [usableRowCount, includedRowCount, status] of [[1, 1, 200], [9, 5, 200], [3, 5, 409], [9, 9, 409]] as const) {
      const response = await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/top_flows`, payload: { ...flowsSection, usableRowCount, diagnostics: { ...flowsSection.diagnostics, targetBounds: { includedRowCount, availableRowCount: usableRowCount } } } });
      expect(response.statusCode, `flows ${usableRowCount}/${includedRowCount}`).toBe(status);
    }
    // Live run 51a52ed4 lost its typed failure code to token redaction; codes stay readable, tokens do not.
    const failed = { ...section, status: "fail", sha256: null, screenshotResult: "failure_viewport_saved", sourceProofResult: "not_created_or_unverified", errorCode: "CAMPAIGNS_DATE_CONTROL_NOT_FOUND", errorMessage: "The Campaigns date-range control was not uniquely available.", diagnostics: { failureCode: "CAMPAIGNS_DATE_CONTROL_NOT_FOUND", observedText: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd" } };
    expect((await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/deliverability`, payload: failed })).statusCode).toBe(200);
    const failedRecord = (await app.inject({ method: "GET", url: `/api/v1/dev/automatic-capture-runs/${runId}` })).json().sections.find(({ section }: { section: string }) => section === "deliverability");
    expect(failedRecord).toMatchObject({ errorCode: "CAMPAIGNS_DATE_CONTROL_NOT_FOUND", diagnostics: { failureCode: "CAMPAIGNS_DATE_CONTROL_NOT_FOUND", observedText: "[redacted-token]" } });
    const finish = await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/finish`, payload: { status: "completed", finishedAt: startedAt, durationMs: 20 } });
    expect(finish.statusCode).toBe(200);
    const loaded = await app.inject({ method: "GET", url: `/api/v1/dev/automatic-capture-runs/${runId}` });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json()).toMatchObject({ runId, reportId: report.id, clientId: "autoledtech", reportMonth: { year: 2026, month: 8 }, status: "completed" });
    expect(loaded.json().sections.find(({ section }: { section: string }) => section === "top_campaigns")).toMatchObject({ section: "top_campaigns", status: "pass", attemptNumber: 1, sha256, attempts: [{ attemptNumber: 1, status: "pass" }], evidence: { file: "sections/top_campaigns-attempt-1-capture.png", byteSize: png.length, sha256 }, diagnostics: { pageHtml: expect.stringContaining("[redacted-email]"), authorization: "[redacted]" }, expectedUrl: "https://www.klaviyo.com/omnicampaigns", observedUrl: "https://www.klaviyo.com/omnicampaigns" });
    expect((await repository.getById(report.id))?.screenshots).toHaveLength(0);
  });

  it("refuses a run from an extension build other than the one currently built, so stale Chrome code is never tested", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-automatic-run-build-")); temporaryRoots.push(root);
    await mkdir(join(root, "apps/extension/dist"), { recursive: true });
    await writeFile(join(root, "apps/extension/dist/build.json"), JSON.stringify({ build: "2026-10-27T08:35:48.561Z" }));
    const repository = new InMemoryReportDraftRepository();
    const report = createReportDraft({ client: { id: "alpha-goods", name: "Alpha Goods", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } }, { now: new Date("2026-10-09T12:00:00.000Z") });
    await repository.create(report);
    const app = buildApp({ repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);
    const start = (runId: string, extensionBuild?: string) => app.inject({ method: "POST", url: "/api/v1/dev/automatic-capture-runs", payload: { runId, reportId: report.id, clientId: "alpha-goods", reportMonth: { year: 2026, month: 8 }, startedAt: "2026-10-09T12:00:00.000Z", ...(extensionBuild ? { extensionBuild } : {}) } });
    for (const [runId, build] of [["0d9f3f43-58a8-4a8f-9a55-1b8f0e1f0a01", undefined], ["0d9f3f43-58a8-4a8f-9a55-1b8f0e1f0a02", "2026-10-27T07:36:00.000Z"]] as const) {
      const stale = await start(runId, build);
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "EXTENSION_BUILD_STALE", builtExtension: "2026-10-27T08:35:48.561Z", runningBuild: build ?? null });
      expect((await app.inject({ method: "GET", url: `/api/v1/dev/automatic-capture-runs/${runId}` })).statusCode).not.toBe(200);
    }
    const current = await start("0d9f3f43-58a8-4a8f-9a55-1b8f0e1f0a03", "2026-10-27T08:35:48.561Z");
    expect(current.statusCode).toBe(201);
    expect(current.json()).toMatchObject({ extensionBuild: "2026-10-27T08:35:48.561Z", status: "running" });
  });

  it("passes a rolling-30-day Deliverability capture on its stated window, and never on a missing or calendar-month period", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-automatic-run-rolling-")); temporaryRoots.push(root);
    const repository = new InMemoryReportDraftRepository();
    const now = new Date("2026-10-09T12:00:00.000Z");
    const report = createReportDraft({ client: { id: "alpha-goods", name: "Alpha Goods", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required", deliverability: "required" } }, { now });
    await repository.create(report);
    const app = buildApp({ repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);
    const runId = "0d9f3f43-58a8-4a8f-9a55-1b8f0e1f0b01"; const startedAt = now.toISOString();
    expect((await app.inject({ method: "POST", url: "/api/v1/dev/automatic-capture-runs", payload: { runId, reportId: report.id, clientId: "alpha-goods", reportMonth: { year: 2026, month: 8 }, startedAt } })).statusCode).toBe(201);
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); Buffer.from("IHDR").copy(png, 12); png.writeUInt32BE(640, 16); png.writeUInt32BE(620, 20);
    const sha256 = createHash("sha256").update(png).digest("hex");
    const identity = "klaviyo-deliverability|deliverability-score|email";
    const pass = { status: "pass", attemptNumber: 1, startedAt, finishedAt: startedAt, durationMs: 20, expectedUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", observedUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", expectedSourceIdentity: identity, observedSourceIdentity: identity, expectedPeriod: null, observedPeriod: "Based on last 30 days of data", expectedSemanticCard: "Deliverability Score", expectedView: "Email", visibleControls: [], usableRowCount: null, screenshotResult: "fresh_semantic_crop_saved", sourceProofResult: "PASS", sha256, errorCode: null, errorMessage: null, diagnostics: { sourceProof: createScreenshotSourceProof("deliverability", report.period), observedPeriodProof: null } };
    const post = (body: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/deliverability`, payload: body });
    // As the runner does: the attempt is recorded as running before its evidence and pass.
    expect((await post({ ...pass, status: "running", finishedAt: null, durationMs: null, screenshotResult: "pending", sourceProofResult: "pending", sha256: null })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/deliverability/evidence/capture?attempt=1`, headers: { "content-type": "image/png" }, payload: png })).statusCode).toBe(200);
    expect((await post({ ...pass, observedPeriod: "Aug 1, 2026 – Aug 31, 2026" })).json()).toMatchObject({ error: "AUTOMATIC_RUN_PASS_NOT_VERIFIED" });
    expect((await post({ ...pass, expectedPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" } })).json()).toMatchObject({ error: "AUTOMATIC_RUN_PASS_NOT_VERIFIED" });
    expect((await post({ ...pass, diagnostics: { observedPeriodProof: null } })).json()).toMatchObject({ error: "AUTOMATIC_RUN_PASS_NOT_VERIFIED" });
    const accepted = await post(pass);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ section: "deliverability", status: "pass" });
    // A calendar-month section still requires its exact month.
    const overviewIdentity = "klaviyo-home|business-performance-summary|default";
    const overview = { ...pass, expectedSourceIdentity: overviewIdentity, observedSourceIdentity: overviewIdentity, diagnostics: { sourceProof: createScreenshotSourceProof("overview", report.period), observedPeriodProof: null } };
    const postOverview = (body: Record<string, unknown>) => app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/overview`, payload: body });
    expect((await postOverview({ ...overview, status: "running", finishedAt: null, durationMs: null, screenshotResult: "pending", sourceProofResult: "pending", sha256: null })).statusCode).toBe(200);
    expect((await app.inject({ method: "PUT", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/overview/evidence/capture?attempt=1`, headers: { "content-type": "image/png" }, payload: png })).statusCode).toBe(200);
    expect((await postOverview(overview)).json()).toMatchObject({ error: "AUTOMATIC_RUN_PASS_NOT_VERIFIED" });
    const month = { startDate: "2026-08-01", endDate: "2026-08-31" };
    expect((await postOverview({ ...overview, expectedPeriod: month, observedPeriod: "Aug 1, 2026 – Aug 31, 2026", diagnostics: { ...overview.diagnostics, observedPeriodProof: month } })).statusCode).toBe(200);
  });

  it("rejects a mismatched report identity and malformed evidence without saving it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-automatic-run-reject-")); temporaryRoots.push(root);
    const repository = new InMemoryReportDraftRepository();
    const app = buildApp({ repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);
    const runId = "d5b98faf-955e-4474-8c8c-7c8a9a2f83a5";
    const mismatch = await app.inject({ method: "POST", url: "/api/v1/dev/automatic-capture-runs", payload: { runId, reportId: draft().id, clientId: "wrong-client", reportMonth: { year: 2026, month: 8 }, startedAt: "2026-10-09T12:00:00.000Z" } });
    expect(mismatch.statusCode).toBe(409);
    const badEvidence = await app.inject({ method: "PUT", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/overview/evidence/capture`, headers: { "content-type": "image/png" }, payload: Buffer.from("not a png") });
    expect(badEvidence.statusCode).toBe(400);
  });
});

describe("Section 10 and the retired List Growth route", () => {
  const sections = { executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", campaign_performance: "required", flow_performance: "required", deliverability: "required", campaign_metrics: "required", flow_metrics: "required" } as const;
  const makeDraft = (extra: Record<string, "required" | "optional"> = {}, id = "d1234567-1234-4234-8234-123456789012") => createReportDraft({ client: { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: { ...sections, ...extra } }, { id, now: new Date("2026-10-10T07:00:00Z") });

  it("still retires legacy List Growth exactly as before and never adds Subscriber Growth", async () => {
    const repository = new InMemoryReportDraftRepository();
    await repository.create(makeDraft({ list_growth: "optional" }));
    const app = buildApp({ repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/dev/retire-list-growth" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ retiredCount: 1 });
    const saved = await repository.getById("d1234567-1234-4234-8234-123456789012");
    expect(saved?.sections).not.toHaveProperty("list_growth");
    expect(saved?.sections).not.toHaveProperty("email_subscriber_growth");
  });

  it("enables Subscriber Growth on an existing draft only by explicit, version-checked request", async () => {
    const repository = new InMemoryReportDraftRepository();
    await repository.create(makeDraft());
    const app = buildApp({ repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true }); apps.push(app);
    const url = "/api/v1/dev/report-drafts/d1234567-1234-4234-8234-123456789012/sections/email_subscriber_growth/enable";
    const wrong = await app.inject({ method: "POST", url, payload: { expectedVersion: 99 } });
    expect(wrong.statusCode).toBe(409); expect(wrong.json()).toMatchObject({ error: "REPORT_VERSION_CONFLICT" });
    const enabled = await app.inject({ method: "POST", url, payload: { expectedVersion: 1 } });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ version: 2, sections: { ...sections, email_subscriber_growth: "required" } });
    // Enabling incremented the version: the old version is now stale and still conflicts; the returned one succeeds.
    const stale = await app.inject({ method: "POST", url, payload: { expectedVersion: 1 } });
    expect(stale.statusCode).toBe(409); expect(stale.json()).toMatchObject({ error: "REPORT_VERSION_CONFLICT" });
    const current = await app.inject({ method: "POST", url, payload: { expectedVersion: enabled.json().version } });
    expect(current.statusCode).toBe(200); expect(current.json()).toMatchObject({ version: 2 });
    expect((await app.inject({ method: "POST", url: "/api/v1/dev/report-drafts/00000000-0000-4000-8000-000000000000/sections/email_subscriber_growth/enable", payload: { expectedVersion: 1 } })).statusCode).toBe(404);
  });

  it("refuses to pass a Subscriber Growth section for a report that does not include it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tention-subscriber-growth-route-")); temporaryRoots.push(root);
    const repository = new InMemoryReportDraftRepository();
    const report = makeDraft(); await repository.create(report);
    const app = buildApp({ repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true, repositoryRoot: root }); apps.push(app);
    const runId = "0f6b2a51-6d4f-4c3e-9a1b-2c3d4e5f6a7b";
    const start = { runId, reportId: report.id, clientId: report.client.id, reportMonth: report.reportMonth, startedAt: "2026-10-10T07:00:00.000Z" };
    // A resume run must declare which sections it captures.
    expect((await app.inject({ method: "POST", url: "/api/v1/dev/automatic-capture-runs", payload: { ...start, mode: "resume" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/dev/automatic-capture-runs", payload: { ...start, mode: "resume", plannedSections: ["email_subscriber_growth"] } })).json()).toMatchObject({ mode: "resume", plannedSections: ["email_subscriber_growth"] });
    const bytes = Buffer.alloc(25); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(13, 8); bytes.write("IHDR", 12, "ascii"); bytes.writeUInt32BE(100, 16); bytes.writeUInt32BE(80, 20);
    const running = { status: "running", attemptNumber: 1, startedAt: "2026-10-10T07:00:01.000Z", finishedAt: null, durationMs: null, expectedUrl: null, observedUrl: null, expectedSourceIdentity: null, observedSourceIdentity: null, expectedPeriod: null, observedPeriod: null, expectedSemanticCard: null, expectedView: null, visibleControls: [], usableRowCount: null, screenshotResult: "pending", sourceProofResult: "pending", sha256: null, errorCode: null, errorMessage: null, diagnostics: null };
    expect((await app.inject({ method: "POST", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/email_subscriber_growth`, payload: running })).statusCode).toBe(200);
    const evidence = await app.inject({ method: "PUT", url: `/api/v1/dev/automatic-capture-runs/${runId}/sections/email_subscriber_growth/evidence/capture?attempt=1`, headers: { "content-type": "image/png" }, payload: bytes });
    expect(evidence.statusCode).toBe(200);
    const period = report.period;
    const proof = createScreenshotSourceProof("email_subscriber_growth", period, undefined, null, { channel: "email", view: "growth", emailSubscribers: 17698, newSubscribers: 943, exclusions: 499, changes: { emailSubscribers: null, newSubscribers: null, exclusions: null }, charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true }, visiblePeriodText: "Aug 1 – Aug 31, 2026" });
    const pass = { status: "pass", attemptNumber: 1, startedAt: "2026-10-10T07:00:01.000Z", finishedAt: "2026-10-10T07:00:02.000Z", durationMs: 1000, expectedUrl: "https://www.klaviyo.com/configured", observedUrl: "https://www.klaviyo.com/configured", expectedSourceIdentity: "klaviyo-subscriber-growth|email|growth", observedSourceIdentity: "klaviyo-subscriber-growth|email|growth", expectedPeriod: { startDate: period.startDate, endDate: period.endDate }, observedPeriod: "Aug 1 – Aug 31, 2026", expectedSemanticCard: "Subscriber growth", expectedView: "Email → Growth", visibleControls: [], usableRowCount: null, screenshotResult: "fresh_semantic_crop_saved", sourceProofResult: "PASS", sha256: evidence.json().sha256, errorCode: null, errorMessage: null, diagnostics: { sourceProof: proof, observedPeriodProof: { startDate: period.startDate, endDate: period.endDate } } };
    const url = `/api/v1/dev/automatic-capture-runs/${runId}/sections/email_subscriber_growth`;
    // Evidence attaches only to an existing section record, which is why the "running" record above is posted first.
    const notIncluded = await app.inject({ method: "POST", url, payload: pass });
    expect(notIncluded.statusCode).toBe(409); expect(notIncluded.json()).toMatchObject({ error: "AUTOMATIC_RUN_PASS_NOT_VERIFIED" });
    await repository.save({ ...report, sections: { ...report.sections, email_subscriber_growth: "required" }, version: 2 }, 1);
    expect((await app.inject({ method: "POST", url, payload: { ...pass, diagnostics: { ...pass.diagnostics, sourceProof: createScreenshotSourceProof("email_subscriber_growth", period) } } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url, payload: pass })).statusCode).toBe(200);
  });
});
