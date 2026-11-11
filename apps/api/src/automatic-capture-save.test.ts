import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import { buildApp } from "./app.js";
import { InMemoryScreenshotStorage } from "./storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage } from "./storage/pdf-artifact-storage.js";
import { SUMMARY_EVIDENCE } from "./test-support/business-performance.js";

/**
 * Automatic capture persists each passed section on the canonical report at once, as machine-validated evidence (never a
 * human approval). The report keeps every passed section when a later one fails; final generation needs no approval.
 */
const NOW = new Date("2026-11-11T12:00:00Z");
const CLIENT = "purely-nutrient";
const renderedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
const SECTIONS = { executive_summary: "required", top_flows: "required", month_comparison: "required", deliverability: "required", email_subscriber_growth: "required" } as const;
const TYPES: ScreenshotType[] = ["overview", "top_flows", "month_comparison", "deliverability", "email_subscriber_growth"];
const SOURCE: Partial<Record<ScreenshotType, string>> = { overview: "https://www.klaviyo.com/dashboard", top_flows: "https://www.klaviyo.com/dashboard", month_comparison: "https://www.klaviyo.com/analytics/dashboards/01PNBR", deliverability: "https://www.klaviyo.com/analytics/deliverability/email/score", email_subscriber_growth: "https://www.klaviyo.com/people/subscribers" };
let app: FastifyInstance;
let repository: InMemoryReportDraftRepository;
let targets: InMemoryClientReportTargetsRepository;
let screenshotStorage: InMemoryScreenshotStorage;
let drive: { deliver: ReturnType<typeof vi.fn> };
let docs: { syncGoogleDoc: ReturnType<typeof vi.fn> };

/** A valid 1×1 PNG whose pixel colour differs per section, so no two sections share bytes. */
function png(seed: number): Buffer {
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type), data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([length, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, seed & 255, (seed * 7) & 255, (seed * 13) & 255]))), chunk("IEND", Buffer.alloc(0))]);
}
const subscriberGrowth = { channel: "email" as const, view: "growth" as const, emailSubscribers: 34_487, newSubscribers: 882, exclusions: 44, changes: { emailSubscribers: null, newSubscribers: null, exclusions: null }, charts: { subscriberGrowthLine: true as const, newSubscribersExclusionsBar: true as const }, visiblePeriodText: "Oct 1 – 31, 2026" };
const proofFor = (type: ScreenshotType, period: ReportDraft["period"]) => createScreenshotSourceProof(type, period, undefined, null, type === "email_subscriber_growth" ? subscriberGrowth : null, type === "overview" ? { ...SUMMARY_EVIDENCE, visiblePeriodText: "Oct 1, 2026 - Oct 31, 2026" } : null);

beforeEach(() => {
  repository = new InMemoryReportDraftRepository(); targets = new InMemoryClientReportTargetsRepository(); screenshotStorage = new InMemoryScreenshotStorage();
  drive = { deliver: vi.fn().mockResolvedValue({ fileId: "drive-file", folderId: "october-folder", webViewLink: "https://drive.google.com/file/d/drive-file/view", action: "created" }) };
  docs = { syncGoogleDoc: vi.fn().mockResolvedValue({ docId: "doc-1", folderId: "october-folder", webViewLink: "https://docs.google.com/document/d/doc-1/edit", version: "1", action: "created" }) };
  // Production defaults: a READY client is required for reports and generation.
  app = buildApp({ now: () => new Date(NOW), repository, clientReportTargetsRepository: targets, screenshotStorage, pdfArtifactStorage: new InMemoryPdfArtifactStorage(), pdfRenderer: { render: vi.fn().mockResolvedValue(renderedPdf), close: async () => undefined }, pdfDriveDelivery: drive as never, googleDocSync: docs as never });
});
afterEach(async () => app.close());

async function freshReport(): Promise<ReportDraft> {
  expect((await app.inject({ method: "POST", url: "/api/v1/clients", payload: { name: "Purely Nutrient" } })).statusCode).toBe(201);
  const { clientId: _id, createdAt: _c, updatedAt: _u, ...current } = (await app.inject({ method: "GET", url: `/api/v1/clients/${CLIENT}/report-targets` })).json();
  expect((await app.inject({ method: "PUT", url: `/api/v1/clients/${CLIENT}/report-targets`, payload: {
    ...current, profile: { ...current.profile, timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "PNmet1" } },
    businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01PNBR", displayName: "Business Review", accountLabel: "Purely Nutrient" },
    sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" },
  } })).statusCode).toBe(200);
  const created = await app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: { client: { id: CLIENT }, reportMonth: { year: 2026, month: 10 }, sections: SECTIONS } });
  expect(created.statusCode).toBe(201);
  return created.json();
}
function save(report: ReportDraft, type: ScreenshotType, overrides: { client?: string; month?: string; version?: number; proof?: unknown; sourceUrl?: string; bytes?: Buffer } = {}) {
  return app.inject({ method: "PUT", url: `/api/v1/report-drafts/${report.id}/screenshots/${type}/automatic-image`, headers: {
    "content-type": "image/png", "x-expected-version": String(overrides.version ?? report.version), "x-period-confirmed": "true",
    "x-capture-proof": JSON.stringify(overrides.proof ?? proofFor(type, report.period)), "x-source-url": overrides.sourceUrl ?? SOURCE[type] ?? "https://www.klaviyo.com/analytics/dashboards/01PNBR",
    "x-expected-client-id": overrides.client ?? report.client.id, "x-expected-report-month": overrides.month ?? "2026-10",
  }, payload: overrides.bytes ?? png(TYPES.indexOf(type) + 1) });
}
const autoGenerate = (report: ReportDraft) => app.inject({ method: "POST", url: `/api/v1/report-drafts/${report.id}/auto-generate`, payload: { expectedVersion: report.version, expectedReportMonth: report.reportMonth } });
const stored = async (id: string) => (await repository.getById(id))!;

describe("PUT /report-drafts/:id/screenshots/:type/automatic-image", () => {
  it("saves a passed section on the report at once as machine-validated automatic evidence, never as a human approval", async () => {
    const report = await freshReport();
    const response = await save(report, "overview");
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ reportId: report.id, clientId: CLIENT, screenshotType: "overview", captureStatus: "automatic_pass", sha256: createHash("sha256").update(png(1)).digest("hex") });
    const record = (await stored(report.id)).screenshots.find((shot) => shot.type === "overview")!;
    expect(record).toMatchObject({ approved: false, approvedAt: null, captureOrigin: "live_acceptance_import", periodConfirmed: true, clientId: CLIENT, reportMonth: { year: 2026, month: 10 }, sourceUrl: "https://www.klaviyo.com/dashboard" });
    expect((await stored(report.id)).version).toBe(report.version + 1);
    expect((await screenshotStorage.get(record.storageKey!))?.sha256).toBe(record.sha256);
  });

  it.each([
    ["wrong client", { client: "another-client" }, "REPORT_CLIENT_MISMATCH"],
    ["wrong month", { month: "2026-09" }, "REPORT_MONTH_MISMATCH"],
    ["previous month's period proof", { proof: "previous" }, "REPORT_PERIOD_NOT_CONFIRMED"],
    ["a non-Klaviyo source", { sourceUrl: "https://example.com/dashboard" }, "SCREENSHOT_SOURCE_URL_INVALID"],
    ["a stale report version", { version: 99 }, "REPORT_VERSION_CONFLICT"],
  ] as const)("refuses %s and stores nothing", async (_label, override, code) => {
    const report = await freshReport();
    const previous = { ...report.period, startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" };
    const response = await save(report, "top_flows", "proof" in override ? { proof: proofFor("top_flows", previous) } : override);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe(code);
    expect(await stored(report.id)).toMatchObject({ version: report.version, screenshots: [] });
  });

  it("refuses a section the report does not enable, bytes duplicated from another section, and any save while generating", async () => {
    const report = await freshReport();
    expect((await save(report, "campaign_metrics")).json().error).toBe("AUTOMATIC_SECTION_NOT_ENABLED");
    const first = (await save(report, "overview")).json().report as ReportDraft;
    const duplicate = await save(first, "top_flows", { bytes: png(1) });
    expect(duplicate.statusCode).toBeGreaterThanOrEqual(400);
    expect(duplicate.json().error).toBe("DUPLICATE_SCREENSHOT_SOURCE");
    const generating = await repository.save({ ...first, status: "generating", version: first.version + 1 }, first.version);
    expect((await save(generating, "top_flows")).json().error).toBe("REPORT_GENERATING");
  });

  it("keeps every passed section when a later one fails; finalization waits for all; then PDF, Drive and Doc with zero approvals", async () => {
    let report = await freshReport();
    for (const type of TYPES.slice(0, -1)) report = (await save(report, type)).json().report;
    // Section 10 fails (nothing is sent for it): sections 1–4 stay on the report and nothing is generated from them.
    expect((await stored(report.id)).screenshots.map((shot) => shot.type)).toEqual(TYPES.slice(0, -1));
    const early = await autoGenerate(report);
    expect(early.statusCode).toBeGreaterThanOrEqual(400);
    expect(early.json().error).toBe("REQUIRED_SCREENSHOT_MISSING");
    expect(drive.deliver).not.toHaveBeenCalled(); expect(docs.syncGoogleDoc).not.toHaveBeenCalled();
    // Resume: only the missing section is saved; the others are untouched.
    const before = (await stored(report.id)).screenshots.map(({ id, sha256 }) => ({ id, sha256 }));
    report = (await save(report, "email_subscriber_growth")).json().report;
    expect((await stored(report.id)).screenshots.filter((shot) => shot.type !== "email_subscriber_growth").map(({ id, sha256 }) => ({ id, sha256 }))).toEqual(before);
    const generated = await autoGenerate(report);
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({ report: { status: "generated" }, artifact: { driveDelivery: { driveUploadStatus: "uploaded" }, googleDoc: { googleDocStatus: "synced" } } });
    expect(generated.json().report.screenshots.every((shot: { approved: boolean; automatedValidatedAt: string | null }) => !shot.approved && shot.automatedValidatedAt === NOW.toISOString())).toBe(true);
    expect(drive.deliver).toHaveBeenCalledTimes(1); expect(docs.syncGoogleDoc).toHaveBeenCalledTimes(1);
  });

  it("keeps human review optional in production: a saved capture can be viewed and approved, but nothing requires it", async () => {
    const report = await freshReport();
    const saved = (await save(report, "overview")).json() as { report: ReportDraft; sha256: string };
    const image = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${report.id}/screenshots/overview/pending-image` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["x-screenshot-sha256"]).toBe(saved.sha256);
    const approved = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${report.id}/screenshots/overview/review`, payload: { expectedVersion: saved.report.version, expectedSha256: saved.sha256 } });
    expect(approved.statusCode).toBe(200);
    expect((await stored(report.id)).screenshots[0]).toMatchObject({ approved: true, captureOrigin: "live_acceptance_import", sha256: saved.sha256 });
  });
});
