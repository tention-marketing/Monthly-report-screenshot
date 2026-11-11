import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { createReportDraft, InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository, upsertScreenshotMetadata } from "@tention/report-domain";
import { clientReportTargetsInputSchema, createScreenshotSourceProof, type BusinessPerformanceEvidence, type ReportDraft } from "@tention/report-schema";
import { buildApp } from "../app.js";
import { InMemoryScreenshotStorage } from "../storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import { SUMMARY_EVIDENCE } from "../test-support/business-performance.js";
import { buildReportDocumentModel, formatCoverRange, renderCoverHtml, renderReportHtml } from "./report-document.js";
import { renderReportGoogleDocHtml } from "./report-google-doc.js";

/** The report cover: verified Business performance summary values on page 1 of the PDF and at the top of the Doc. */
const now = new Date("2026-11-05T12:00:00Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");

async function captured(options: { month?: { year: number; month: number }; currency?: string | null; evidence?: BusinessPerformanceEvidence | null } = {}) {
  const storage = new InMemoryScreenshotStorage();
  let report: ReportDraft = createReportDraft({ client: { id: "client-1", name: "Acme Home", timezone: "America/New_York", currency: options.currency === undefined ? "USD" : options.currency }, reportMonth: options.month ?? { year: 2026, month: 9 }, sections: { executive_summary: "required" } }, { now });
  const key = `reports/${report.id}/overview/1.png`; const asset = await storage.put(key, PNG);
  report = upsertScreenshotMetadata(report, { id: "11111111-1111-4111-8111-111111111111", clientId: report.client.id, reportMonth: report.reportMonth, type: "overview", capturedAt: now.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard", width: 1, height: 1, approved: true, approvedAt: now.toISOString(), periodConfirmed: true, storageKey: key, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, captureOrigin: "live_acceptance_import", sourceProof: createScreenshotSourceProof("overview", report.period, undefined, null, null, options.evidence === undefined ? SUMMARY_EVIDENCE : options.evidence) }, "overview", { now });
  return { report, storage };
}

describe("report cover in the canonical PDF and the Google Doc", () => {
  it("renders the cover as page 1, before every existing report page, as native text", async () => {
    const { report, storage } = await captured();
    const model = await buildReportDocumentModel(report, storage, now);
    const html = renderReportHtml(model);
    // The first page section of the document is the cover; the existing summary page follows it.
    const pageSections = [...html.matchAll(/<section class="report-page ([^"]*)"/g)].map(([, classes]) => classes!.trim());
    expect(pageSections[0]).toBe("cover-page"); expect(pageSections[1]).toContain("page-summary");
    const coverHtml = renderCoverHtml(model);
    // Client name large on the left; the title with the full period at the top right; no separate period line.
    expect(coverHtml).toContain('<div class="cover-top"><h1 class="cover-client">Acme Home</h1><p class="cover-title">Performance Report — September 1–30, 2026</p></div>');
    expect(coverHtml).not.toContain("Reporting Period");
    // Labels in regular weight, values in bold.
    for (const [label, value] of [["Total Revenue", "$584,032.35"], ["Email Attributed Revenue", "$156,674.44"], ["Revenue from Campaigns", "$56,527.51"], ["Revenue from Flows", "$117,321.75"]]) expect(coverHtml).toContain(`<p class="cover-metric">${label}: <strong>${value}</strong></p>`);
    // No screenshot, no day-level range, no comparison on the cover.
    expect(coverHtml).not.toMatch(/<img|Compared with|compared to|previous period|Sep 1|Sep 30|Aug |August/i);
    expect(coverHtml).not.toContain("$173,849.26"); // total attributed revenue is checked internally, not shown
  });

  it("leaves the existing report body unchanged after the cover is inserted", async () => {
    const withCover = await captured(); const withoutValues = await captured({ evidence: null });
    const body = async ({ report, storage }: Awaited<ReturnType<typeof captured>>) => { const model = await buildReportDocumentModel(report, storage, now); return renderReportHtml(model).replace(renderCoverHtml(model), "").replace(/data-cover="[a-z]+"/, ""); };
    const [a, b] = [await body(withCover), await body(withoutValues)];
    expect(a).toBe(b);
    expect(a).toContain('<p class="brand">Acme Home</p><h1>Performance Report</h1><p class="reporting-period">Reporting Period: September 2026</p>');
  });

  it("puts the same cover at the top of the editable Google Doc, before the report sections", async () => {
    const { report, storage } = await captured();
    const doc = renderReportGoogleDocHtml(await buildReportDocumentModel(report, storage, now));
    expect(doc).toContain('<body><p style="text-align:right"><b>Performance Report — September 1–30, 2026</b></p><h1>Acme Home</h1><p>Total Revenue: <b>$584,032.35</b></p><p>Email Attributed Revenue: <b>$156,674.44</b></p><p>Revenue from Campaigns: <b>$56,527.51</b></p><p>Revenue from Flows: <b>$117,321.75</b></p><h2>1. Executive Summary</h2>');
    expect(doc).not.toMatch(/Compared with|Reporting Period/);
  });

  it.each([
    [{ year: 2026, month: 9 }, "Performance Report — September 1–30, 2026"], [{ year: 2026, month: 10 }, "Performance Report — October 1–31, 2026"],
    [{ year: 2025, month: 11 }, "Performance Report — November 1–30, 2025"], [{ year: 2026, month: 2 }, "Performance Report — February 1–28, 2026"],
    [{ year: 2024, month: 2 }, "Performance Report — February 1–29, 2024"], [{ year: 2025, month: 12 }, "Performance Report — December 1–31, 2025"],
  ] as const)("titles the cover from the stored period for %j", async (month, heading) => {
    const { report, storage } = await captured({ month });
    expect(renderCoverHtml(await buildReportDocumentModel(report, storage, now))).toContain(heading);
  });

  it.each([
    ["2026-09-01", "2026-09-30", "September 1–30, 2026"], ["2026-10-01", "2026-10-31", "October 1–31, 2026"], ["2026-11-01", "2026-11-30", "November 1–30, 2026"],
    ["2026-02-01", "2026-02-28", "February 1–28, 2026"], ["2028-02-01", "2028-02-29", "February 1–29, 2028"],
  ])("formats the cover period %s – %s as %j", (start, end, text) => { expect(formatCoverRange(start, end)).toBe(text); });

  it("uses the client's configured currency", async () => {
    const euro: BusinessPerformanceEvidence = { totalRevenue: "€10,000.00", totalAttributedRevenue: "€3,000.00", emailAttributedRevenue: "€2,500.00", smsAttributedRevenue: "€500.00", campaignRevenue: "€1,000.00", flowRevenue: "€2,000.00", visiblePeriodText: "Sep 1, 2026 - Sep 30, 2026" };
    const { report, storage } = await captured({ currency: "EUR", evidence: euro });
    const cover = renderCoverHtml(await buildReportDocumentModel(report, storage, now));
    expect(cover).toContain("Total Revenue: <strong>€10,000.00</strong>"); expect(cover).not.toContain("$");
  });

  it("prints no number for unverified values in a preview", async () => {
    const { report, storage } = await captured({ evidence: null });
    const cover = renderCoverHtml(await buildReportDocumentModel(report, storage, now));
    expect(cover).toContain('data-cover="unverified"'); expect(cover).not.toMatch(/\$|\d{2},\d{3}/);
  });
});

describe("final generation requires verified cover values", () => {
  let app: FastifyInstance; let repository: InMemoryReportDraftRepository; let render: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    repository = new InMemoryReportDraftRepository(); render = vi.fn().mockResolvedValue(Buffer.from("%PDF-1.4\n%%EOF\n"));
    const targets = new InMemoryClientReportTargetsRepository();
    await targets.save("client-1", clientReportTargetsInputSchema.parse({ profile: { name: "Acme Home", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "TEST01" }, sections: null } }), now);
    app = buildApp({ requireClientSetupReady: false, now: () => new Date(now), repository, clientReportTargetsRepository: targets, screenshotStorage: storage, pdfArtifactStorage: new InMemoryPdfArtifactStorage(), pdfRenderer: { render, close: async () => undefined } });
  });
  let storage = new InMemoryScreenshotStorage();
  afterEach(async () => app.close());

  async function stored(evidence: BusinessPerformanceEvidence | null, status: ReportDraft["status"] = "draft") {
    const built = await captured({ evidence }); storage = built.storage;
    await app.close();
    const targets = new InMemoryClientReportTargetsRepository();
    await targets.save("client-1", clientReportTargetsInputSchema.parse({ profile: { name: "Acme Home", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "TEST01" }, sections: null } }), now);
    app = buildApp({ requireClientSetupReady: false, now: () => new Date(now), repository, clientReportTargetsRepository: targets, screenshotStorage: storage, pdfArtifactStorage: new InMemoryPdfArtifactStorage(), pdfRenderer: { render, close: async () => undefined } });
    return repository.create({ ...built.report, status });
  }

  it.each([
    ["the capture carries no values (each missing metric is named)", null, "Revenue from Flows"],
    ["Campaigns + Flows does not equal Attributed revenue", { ...SUMMARY_EVIDENCE, campaignRevenue: "$66,527.51" }, "Revenue from Campaigns + Revenue from Flows"],
    ["a value is malformed", { ...SUMMARY_EVIDENCE, totalRevenue: "$584K" }, "Total Revenue"],
  ])("blocks automatic generation when %s, naming the metric and changing nothing", async (_case, evidence, metric) => {
    const draft = await stored(evidence);
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/auto-generate`, payload: { expectedVersion: draft.version, expectedReportMonth: draft.reportMonth } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "REPORT_COVER_METRICS_UNVERIFIED", issues: expect.arrayContaining([expect.objectContaining({ metric })]) });
    expect(render).not.toHaveBeenCalled();
    expect(await repository.getById(draft.id)).toMatchObject({ status: "draft", version: draft.version });
  });

  it("blocks reviewed generation of an older capture without structured values; nothing is backfilled", async () => {
    const draft = await stored(null, "ready_for_review");
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/generate`, payload: { expectedVersion: draft.version } });
    expect(response.statusCode).toBe(409);
    expect(response.json().message).toMatch(/Total Revenue/);
    expect(render).not.toHaveBeenCalled();
  });

  it("generates with the verified cover", async () => {
    const draft = await stored(SUMMARY_EVIDENCE);
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${draft.id}/auto-generate`, payload: { expectedVersion: draft.version, expectedReportMonth: draft.reportMonth } });
    expect(response.statusCode).toBe(200);
    expect(render.mock.calls[0]![0]).toContain("Total Revenue: <strong>$584,032.35</strong>");
  });
});
