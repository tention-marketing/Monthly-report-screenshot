import { mkdtempSync, writeFileSync } from "node:fs";
import { SUMMARY_EVIDENCE } from "./test-support/business-performance.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository } from "@tention/report-domain";
import { clientReportTargetsInputSchema, createScreenshotSourceProof } from "@tention/report-schema";
import { buildApp } from "./app.js";
import { InMemoryPdfArtifactStorage } from "./storage/pdf-artifact-storage.js";
import { InMemoryScreenshotStorage } from "./storage/screenshot-storage.js";
import {
  createConfiguredPdfDriveDelivery, driveFileName, DriveDeliveryError, GoogleDrivePdfDelivery, googleDocName, type PdfDriveDelivery, type ReportGoogleDocSync,
} from "./delivery/google-drive-delivery.js";
import { renderReportGoogleDocHtml } from "./reports/report-google-doc.js";
import type { ReportDocumentModel } from "./reports/report-document.js";

const ROOT = "root-folder";
const FOLDER = "application/vnd.google-apps.folder";
const GOOGLE_DOC = "application/vnd.google-apps.document";

/** Minimal in-memory Google Drive implementing exactly the REST calls the delivery makes. */
class FakeDrive {
  files = new Map<string, { id: string; name: string; mimeType: string; parents: string[]; size: number; version: number; modifiedTime: string; html?: string; appProperties?: Record<string, string> }>([[ROOT, { id: ROOT, name: "Root", mimeType: FOLDER, parents: [], size: 0, version: 1, modifiedTime: "2026-11-01T00:00:00.000Z" }]]);
  failAuth = false; rootWritable = true; private next = 0; private clock = Date.parse("2026-11-05T06:00:00.000Z");
  /** Drive's modifiedTime moves only for real modifications; `version` also moves for invisible processing. */
  tick() { this.clock += 1_000; return new Date(this.clock).toISOString(); }
  readonly now = () => new Date(this.clock);
  invisibleProcessing(id: string) { this.files.get(id)!.version += 3; }
  editInDrive(id: string) { const file = this.files.get(id)!; file.version += 1; file.modifiedTime = this.tick(); file.html = "<p>edited by a person</p>"; }
  readonly fetch = vi.fn(async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input)); const method = init.method ?? "GET";
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.host === "oauth2.googleapis.com") return this.failAuth ? json(400, { error: "unauthorized_client" }) : json(200, { access_token: "test-access" });
    const fileId = url.pathname.match(/\/files\/([^/]+)$/)?.[1];
    if (method === "GET" && fileId) {
      const file = this.files.get(decodeURIComponent(fileId));
      if (!file) return json(404, { error: { message: "File not found" } });
      return json(200, { ...file, size: String(file.size), version: String(file.version), webViewLink: `https://drive.google.com/file/d/${file.id}/view`, capabilities: { canAddChildren: file.id !== ROOT || this.rootWritable, canEdit: true } });
    }
    if (method === "GET") {
      const [, parent, name, mimeType] = url.searchParams.get("q")!.match(/^'(.+?)' in parents and name = '(.+?)' and mimeType = '(.+?)' and trashed = false$/)!;
      return json(200, { files: [...this.files.values()].filter((file) => file.parents.includes(parent!) && file.name === name && file.mimeType === mimeType).map(({ id }) => ({ id })) });
    }
    if (method === "POST" && url.pathname === "/drive/v3/files") return json(200, { id: this.add(JSON.parse(String(init.body)), 0) });
    if (method === "POST" && url.pathname === "/upload/drive/v3/files") {
      const text = Buffer.from(init.body as Uint8Array).toString("latin1");
      const metadata = JSON.parse(text.split("\r\n\r\n")[1]!.split("\r\n--")[0]!);
      const contentStart = text.indexOf("\r\n\r\n", text.indexOf(metadata.mimeType === GOOGLE_DOC ? "text/html" : "application/pdf\r\n")) + 4;
      const contentEnd = text.lastIndexOf("\r\n--");
      const id = this.add(metadata, contentEnd - contentStart);
      if (metadata.mimeType === GOOGLE_DOC) this.files.get(id)!.html = Buffer.from(init.body as Uint8Array).subarray(contentStart, contentEnd).toString("utf8");
      return json(200, { id });
    }
    if (method === "PATCH" && fileId) {
      const file = this.files.get(fileId)!; file.version += 1; file.modifiedTime = this.tick();
      if (url.searchParams.get("uploadType") === "multipart") {
        const bytes = Buffer.from(init.body as Uint8Array); const text = bytes.toString("latin1");
        const metadata = JSON.parse(text.split("\r\n\r\n")[1]!.split("\r\n--")[0]!) as { appProperties?: Record<string, string> };
        if (metadata.appProperties) file.appProperties = { ...file.appProperties, ...metadata.appProperties };
        file.html = bytes.subarray(text.indexOf("\r\n\r\n", text.indexOf("text/html")) + 4, text.lastIndexOf("\r\n--")).toString("utf8");
      } else file.size = (init.body as Uint8Array).byteLength;
      return json(200, { id: fileId });
    }
    return json(400, { error: { message: `unexpected ${method} ${url.pathname}` } });
  });
  add(metadata: { name: string; mimeType: string; parents: string[]; appProperties?: Record<string, string> }, size: number): string {
    const id = `id-${++this.next}`; this.files.set(id, { id, ...metadata, size, version: 1, modifiedTime: this.tick() }); return id;
  }
  named(name: string) { return [...this.files.values()].filter((file) => file.name === name); }
}

const CONFIG = { clientId: "client", clientSecret: "secret", refreshToken: "refresh", rootFolderId: ROOT };
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}\n%%EOF\n`);

describe("Google Drive PDF delivery", () => {
  it("finds or creates ROOT/<year>/<Month>, then creates once and updates the same file on regeneration", async () => {
    const drive = new FakeDrive();
    const delivery = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch);
    const first = await delivery.deliver({ year: 2026, month: 10, fileName: "Club Furniture - October 2026.pdf", bytes: pdf("v1") });
    const [year] = drive.named("2026"); const [october] = drive.named("October");
    expect(year!.parents).toEqual([ROOT]); expect(october!.parents).toEqual([year!.id]);
    expect(first).toMatchObject({ folderId: october!.id, action: "created", webViewLink: expect.stringContaining(first.fileId) });

    const second = await delivery.deliver({ year: 2026, month: 10, fileName: "Club Furniture - October 2026.pdf", bytes: pdf("version two") });
    expect(second).toMatchObject({ fileId: first.fileId, folderId: october!.id, action: "updated" });
    expect(drive.named("Club Furniture - October 2026.pdf")).toHaveLength(1);
    expect(drive.named("2026")).toHaveLength(1); expect(drive.named("October")).toHaveLength(1);
    expect(drive.named("November")).toHaveLength(0);
  });

  it("derives year and month folders from the report month, e.g. January 2027", async () => {
    const drive = new FakeDrive();
    await new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch).deliver({ year: 2027, month: 1, fileName: "Alpha - January 2027.pdf", bytes: pdf("jan") });
    const [year] = drive.named("2027"); const [january] = drive.named("January");
    expect(year!.parents).toEqual([ROOT]); expect(january!.parents).toEqual([year!.id]);
    expect(drive.named("Alpha - January 2027.pdf")[0]!.parents).toEqual([january!.id]);
  });

  it("refuses to guess between duplicate copies, an unwritable root, or failed authorization", async () => {
    const drive = new FakeDrive();
    const delivery = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch);
    await delivery.deliver({ year: 2026, month: 10, fileName: "Beta - October 2026.pdf", bytes: pdf("one") });
    drive.add({ name: "Beta - October 2026.pdf", mimeType: "application/pdf", parents: [drive.named("October")[0]!.id] }, 3);
    await expect(delivery.deliver({ year: 2026, month: 10, fileName: "Beta - October 2026.pdf", bytes: pdf("two") })).rejects.toMatchObject({ code: "DRIVE_DUPLICATE_FILES" });
    drive.rootWritable = false;
    await expect(delivery.deliver({ year: 2026, month: 10, fileName: "Gamma - October 2026.pdf", bytes: pdf("g") })).rejects.toMatchObject({ code: "DRIVE_ROOT_NOT_WRITABLE" });
    drive.failAuth = true;
    const failure = await delivery.deliver({ year: 2026, month: 10, fileName: "Gamma - October 2026.pdf", bytes: pdf("g") }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DriveDeliveryError);
    expect(String((failure as Error).message)).not.toMatch(/secret|refresh|test-access/);
  });

  it("names the Drive copy deterministically per client and report month", () => {
    expect(driveFileName({ client: { id: "c", name: "  Club   Furniture ", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 10 } })).toBe("Club Furniture - October 2026.pdf");
    expect(driveFileName({ client: { id: "c", name: "A/B Goods", timezone: "UTC", currency: null }, reportMonth: { year: 2027, month: 1 } })).toBe("A B Goods - January 2027.pdf");
  });

  it("is enabled only when all four Google settings exist, reading only those keys from the env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "drive-config-"));
    const envFile = join(dir, ".env");
    writeFileSync(envFile, "DATABASE_URL=postgresql://ignored\nGOOGLE_OAUTH_CLIENT_ID=id\nGOOGLE_OAUTH_CLIENT_SECRET=\"secret\"\nGOOGLE_OAUTH_REFRESH_TOKEN=token\n");
    expect(createConfiguredPdfDriveDelivery({}, envFile)).toBeNull();
    writeFileSync(envFile, "GOOGLE_OAUTH_CLIENT_ID=id\nGOOGLE_OAUTH_CLIENT_SECRET=secret\nGOOGLE_OAUTH_REFRESH_TOKEN=token\nGOOGLE_DRIVE_ROOT_FOLDER_ID=root\n");
    expect(createConfiguredPdfDriveDelivery({}, envFile)).toBeInstanceOf(GoogleDrivePdfDelivery);
    expect(createConfiguredPdfDriveDelivery({}, join(dir, "missing.env"))).toBeNull();
  });
});

describe("Drive delivery of the canonical PDF artifact", () => {
  const NOW = new Date("2026-09-09T12:00:00Z");
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
  const renderedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
  let app: FastifyInstance; let repository: InMemoryReportDraftRepository; let pdfStorage: InMemoryPdfArtifactStorage;
  let renderer: { render: ReturnType<typeof vi.fn>; close: () => Promise<void> };
  let delivery: { deliver: ReturnType<typeof vi.fn> };
  let docSync: { syncGoogleDoc: ReturnType<typeof vi.fn> };
  function start(pdfDriveDelivery: PdfDriveDelivery | null, googleDocSync: ReportGoogleDocSync | null = docSync) {
    // Final generation requires a configured currency and conversion metric ID.
    const clientReportTargetsRepository = new InMemoryClientReportTargetsRepository();
    void clientReportTargetsRepository.save("orion", clientReportTargetsInputSchema.parse({ profile: { name: "Orion", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "TEST01" }, sections: null } }), new Date(NOW));
    app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), repository, clientReportTargetsRepository, screenshotStorage: new InMemoryScreenshotStorage(), pdfArtifactStorage: pdfStorage, pdfRenderer: renderer, pdfDriveDelivery, googleDocSync });
  }
  beforeEach(() => {
    repository = new InMemoryReportDraftRepository(); pdfStorage = new InMemoryPdfArtifactStorage();
    renderer = { render: vi.fn().mockResolvedValue(renderedPdf), close: async () => undefined };
    delivery = { deliver: vi.fn().mockResolvedValue({ fileId: "drive-file", folderId: "october-folder", webViewLink: "https://drive.google.com/file/d/drive-file/view", action: "created" }) };
    docSync = { syncGoogleDoc: vi.fn().mockResolvedValue({ docId: "doc-1", folderId: "october-folder", webViewLink: "https://docs.google.com/document/d/doc-1/edit", version: "7", action: "created" }) };
    start(delivery);
  });
  afterEach(async () => app.close());

  async function generatedReport() {
    const created = (await app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: { client: { id: "orion", name: "Orion", timezone: "America/New_York" }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } } })).json();
    const uploaded = (await app.inject({ method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image`, payload: PNG, headers: {
      "content-type": "image/png", "x-expected-version": "1", "x-period-confirmed": "true", "x-source-url": "https://www.klaviyo.com/dashboard",
      "x-capture-proof": JSON.stringify(createScreenshotSourceProof("overview", created.period, undefined, null, null, SUMMARY_EVIDENCE)),
    } })).json().report;
    const reviewed = (await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: { expectedVersion: uploaded.version, event: "SUBMIT_FOR_REVIEW" } })).json();
    return { created, generate: () => app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/generate`, payload: { expectedVersion: reviewed.version } }) };
  }

  it("uploads the persisted canonical PDF and records Drive metadata, without tokens, on the artifact", async () => {
    const { created, generate } = await generatedReport();
    const generated = await generate();
    expect(generated.statusCode).toBe(200);
    expect(delivery.deliver).toHaveBeenCalledWith({ year: 2026, month: 8, fileName: "Orion - August 2026.pdf", bytes: renderedPdf });
    expect(generated.json().artifact.driveDelivery).toEqual({ driveUploadStatus: "uploaded", driveFileName: "Orion - August 2026.pdf", driveFileId: "drive-file", driveFolderId: "october-folder", driveWebViewLink: "https://drive.google.com/file/d/drive-file/view", driveUploadedAt: NOW.toISOString(), driveUploadAction: "created", driveErrorCode: null, driveAttemptedAt: NOW.toISOString() });
    const artifact = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/pdf-artifact` })).json();
    expect(artifact).toMatchObject({ id: generated.json().artifact.id, driveDelivery: { driveUploadStatus: "uploaded" } });
    expect(JSON.stringify(artifact)).not.toMatch(/secret|refresh|access_token/i);
    const download = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/pdf?download=1` });
    expect(download.statusCode).toBe(200); expect(download.rawPayload.equals(renderedPdf)).toBe(true);
  });

  it("fails closed with REPORT_MONTH_MISMATCH when the panel's month differs: nothing is rendered, uploaded or synced", async () => {
    const { created } = await generatedReport();
    const current = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/generate`, payload: { expectedVersion: current.version, expectedReportMonth: { year: 2026, month: 9 } } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "REPORT_MONTH_MISMATCH" });
    expect(renderer.render).not.toHaveBeenCalled(); expect(delivery.deliver).not.toHaveBeenCalled(); expect(docSync.syncGoogleDoc).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ status: "ready_for_review", version: current.version });
    const matching = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/generate`, payload: { expectedVersion: current.version, expectedReportMonth: { year: 2026, month: 8 } } });
    expect(matching.statusCode).toBe(200);
    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ year: 2026, month: 8, fileName: "Orion - August 2026.pdf" }));
  });

  it("keeps the canonical PDF when Drive fails and retries from it without re-rendering or recapturing", async () => {
    delivery.deliver.mockRejectedValueOnce(new DriveDeliveryError("DRIVE_REQUEST_FAILED", "Drive is down"));
    const { created, generate } = await generatedReport();
    const generated = await generate();
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({ report: { status: "generated" }, artifact: { driveDelivery: { driveUploadStatus: "failed", driveErrorCode: "DRIVE_REQUEST_FAILED", driveFileId: null } } });
    expect(await repository.listArtifacts(created.id)).toHaveLength(1);
    const pdf = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/pdf` });
    expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.equals(renderedPdf)).toBe(true);

    const retried = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/pdf-artifact/drive-delivery` });
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toMatchObject({ id: generated.json().artifact.id, driveDelivery: { driveUploadStatus: "uploaded", driveFileId: "drive-file" } });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(delivery.deliver).toHaveBeenLastCalledWith(expect.objectContaining({ bytes: renderedPdf }));
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ status: "generated" });
  });

  it("leaves generation unchanged when Drive is not configured, and says so on retry", async () => {
    await app.close(); start(null, null);
    const { created, generate } = await generatedReport();
    const generated = await generate();
    expect(generated.statusCode).toBe(200);
    expect(generated.json().artifact.driveDelivery).toBeUndefined();
    const retry = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/pdf-artifact/drive-delivery` });
    expect(retry.statusCode).toBe(503); expect(retry.json().error).toBe("DRIVE_NOT_CONFIGURED");
  });

  it("writes the editable Google Doc from the same approved model as the PDF, with its metadata kept separately", async () => {
    const { created, generate } = await generatedReport();
    const generated = (await generate()).json();
    expect(docSync.syncGoogleDoc).toHaveBeenCalledTimes(1);
    const input = docSync.syncGoogleDoc.mock.calls[0]![0];
    expect(input).toMatchObject({ year: 2026, month: 8, name: "Orion - August 2026", expected: null, force: false });
    expect(input.html).toContain("<h1>Orion</h1>"); expect(input.html).toContain("1. Executive Summary");
    expect(input.html).toContain(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(generated.artifact).toMatchObject({ driveDelivery: { driveUploadStatus: "uploaded" }, googleDoc: { googleDocStatus: "synced", googleDocId: "doc-1", googleDocWebViewLink: "https://docs.google.com/document/d/doc-1/edit", googleDocUpdatedAt: NOW.toISOString(), googleDocVersion: "7", googleDocAction: "created" } });
    expect(JSON.stringify(generated.artifact.googleDoc)).not.toMatch(/secret|refresh|access_token/i);

    // A retry updates that same Doc, expecting the version Tention last wrote.
    const retried = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/pdf-artifact/google-doc` });
    expect(retried.statusCode).toBe(200);
    expect(docSync.syncGoogleDoc).toHaveBeenLastCalledWith(expect.objectContaining({ expected: expect.objectContaining({ docId: "doc-1", version: "7", writtenAt: expect.any(String) }), force: false }));
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it("keeps the PDF and screenshots when the Google Doc fails, and retries from the existing approved report", async () => {
    docSync.syncGoogleDoc.mockRejectedValueOnce(new DriveDeliveryError("GOOGLE_DOC_EDITED_IN_DRIVE", "edited"));
    const { created, generate } = await generatedReport();
    const generated = await generate();
    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({ report: { status: "generated" }, artifact: { driveDelivery: { driveUploadStatus: "uploaded" }, googleDoc: { googleDocStatus: "failed", googleDocErrorCode: "GOOGLE_DOC_EDITED_IN_DRIVE", googleDocId: null } } });
    const pdf = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/pdf` });
    expect(pdf.statusCode).toBe(200); expect(pdf.rawPayload.equals(renderedPdf)).toBe(true);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json().screenshots).toHaveLength(1);

    const forced = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/pdf-artifact/google-doc`, payload: { force: true } });
    expect(forced.statusCode).toBe(200);
    expect(forced.json()).toMatchObject({ googleDoc: { googleDocStatus: "synced", googleDocId: "doc-1" } });
    expect(docSync.syncGoogleDoc).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }));
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it("records a found-but-unverified Doc as a candidate to open, and adopts only that exact Doc on request", async () => {
    docSync.syncGoogleDoc.mockRejectedValueOnce(new DriveDeliveryError("GOOGLE_DOC_NOT_TENTION_MANAGED", "Existing Google Doc found but not verified as Tention-managed.", { docId: "found-doc", webViewLink: "https://docs.google.com/document/d/found-doc/edit", folderId: "october-folder" }));
    const { created, generate } = await generatedReport();
    const generated = (await generate()).json();
    expect(generated.artifact.googleDoc).toMatchObject({ googleDocStatus: "failed", googleDocErrorCode: "GOOGLE_DOC_NOT_TENTION_MANAGED", googleDocId: null,
      googleDocCandidateId: "found-doc", googleDocCandidateWebViewLink: "https://docs.google.com/document/d/found-doc/edit", googleDocFolderId: "october-folder" });
    const wrong = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/pdf-artifact/google-doc/adopt`, payload: { docId: "another-doc" } });
    expect(wrong.statusCode).toBe(409); expect(wrong.json().error).toBe("GOOGLE_DOC_ADOPTION_REFUSED");
    docSync.syncGoogleDoc.mockResolvedValueOnce({ docId: "found-doc", folderId: "october-folder", webViewLink: "https://docs.google.com/document/d/found-doc/edit", version: "9", modifiedTime: "2026-11-05T08:00:00.000Z", action: "updated", managedBy: "adopted" });
    const adopted = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/pdf-artifact/google-doc/adopt`, payload: { docId: "found-doc" } });
    expect(adopted.statusCode).toBe(200);
    expect(docSync.syncGoogleDoc).toHaveBeenLastCalledWith(expect.objectContaining({ adoptDocId: "found-doc", clientId: "orion", force: false }));
    expect(adopted.json().googleDoc).toMatchObject({ googleDocStatus: "synced", googleDocId: "found-doc", googleDocManagedBy: "adopted", googleDocCandidateId: null });
    expect(renderer.render).toHaveBeenCalledTimes(1); // adopting never re-renders the PDF
  });

  it("creates no Google Doc before a canonical PDF exists for the approved report", async () => {
    const created = (await app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: { client: { id: "orion", name: "Orion", timezone: "America/New_York" }, reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" } } })).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/pdf-artifact/google-doc` });
    expect(response.statusCode).toBe(400); expect(response.json().error).toBe("REPORT_RENDER_INPUT_INVALID");
    expect(docSync.syncGoogleDoc).not.toHaveBeenCalled();
  });
});

describe("editable Google Doc", () => {
  const image = (key: string) => `data:image/png;base64,${Buffer.from(key).toString("base64")}`;
  const section = (key: string, title: string, periodNote: string | null = null) => ({ key, layoutSlotKey: key, title, required: true, preferredSize: "full", width: 1248, height: 600, imageDataUrl: image(key), periodNote });
  // Sections deliberately in the PDF's page order, which differs from the Doc's 1–10 order.
  const model = {
    reportId: "r", clientName: "Club <Furniture>", reportMonthLabel: "October 2026", reportTitle: "Performance Report", reportingPeriodHeading: "Reporting Period: October 2026", coverTitle: "Performance Report — October 1–31, 2026", reportingPeriodLabel: "October 1 - October 31, 2026", previousComparisonPeriodLabel: "September 1 - September 30, 2026",
    sourceFingerprint: "f", templateVersion: "v", layout: {}, content: { headlineMetrics: {}, analysisBlocks: [], nextMonthPlan: null },
    cover: { ok: true, cover: { currency: "USD", reportMonthLabel: "October 2026", metrics: {
      totalRevenue: { label: "Total Revenue", formatted: "$584,032.35" }, emailAttributedRevenue: { label: "Email Attributed Revenue", formatted: "$156,674.44" },
      campaignRevenue: { label: "Revenue from Campaigns", formatted: "$56,527.51" }, flowRevenue: { label: "Revenue from Flows", formatted: "$117,321.75" } } } },
    pages: [
      { sections: [section("executive_summary", "Overview"), section("top_campaigns", "Top 5 Campaigns")] },
      { sections: [section("top_flows", "Top Flows"), section("month_comparison", "Comparison to Previous Month")] },
      { sections: [section("campaign_performance", "Campaigns"), section("flow_performance", "Flows")] },
      { sections: [section("deliverability", "Deliverability Score", "Klaviyo rolling last-30-days view")] },
      { sections: [section("campaign_metrics", "Metric Performance - Campaigns")] },
      { sections: [section("flow_metrics", "Metric Performance - Flows")] },
      { sections: [section("email_subscriber_growth", "Subscriber Growth - Email", "Oct 1–31, 2026 · Email subscribers 1,234")] },
    ],
  } as unknown as ReportDocumentModel;

  it("has the title block, the ten sections in report order, and every screenshot embedded unchanged", () => {
    const html = renderReportGoogleDocHtml(model);
    // The cover comes first: client, title, report month, then the four verified values as editable text.
    expect(html).toContain('<p style="text-align:right"><b>Performance Report — October 1–31, 2026</b></p><h1>Club &lt;Furniture&gt;</h1>'
      + "<p>Total Revenue: <b>$584,032.35</b></p><p>Email Attributed Revenue: <b>$156,674.44</b></p><p>Revenue from Campaigns: <b>$56,527.51</b></p><p>Revenue from Flows: <b>$117,321.75</b></p><h2>1. Executive Summary</h2>");
    // Only the month is shown to the client; the exact and previous ranges stay internal.
    expect(html).not.toMatch(/Compared with|October 1 - October 31|September 1 - September 30/i);
    const headings = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map(([, heading]) => heading);
    expect(headings).toEqual(["1. Executive Summary", "2. Top 5 Flows", "3. Top 5 Campaigns", "4. Month Comparison", "5. Campaign Performance", "6. Campaign Metrics", "7. Flow Performance", "8. Flow Metrics", "9. Deliverability Score", "10. Subscriber Growth", "Notes and Recommendations"]);
    for (const page of model.pages) for (const shown of page.sections) expect(html).toContain(`src="${shown.imageDataUrl}" width="624" height="300"`);
    expect(html.match(/<img /g)).toHaveLength(10);
    expect(html).toContain("<i>Klaviyo rolling last-30-days view</i>"); expect(html).toContain("Email subscribers 1,234");
  });

  describe("Tention-managed Doc reconciliation (report deleted and created again)", () => {
    const name = "Club Furniture - October 2026";
    const doc = (drive: FakeDrive) => drive.named(name)[0]!;
    it("marks the Doc it creates with client and month, in the same write", async () => {
      const drive = new FakeDrive(); const sync = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch, drive.now);
      const created = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false, clientId: "club-furniture" });
      expect(created).toMatchObject({ action: "created", managedBy: "created" });
      expect(doc(drive).appProperties).toMatchObject({ tentionManaged: "true", tentionClientId: "club-furniture", tentionReportMonth: "2026-10" });
      expect(doc(drive).version).toBe(1);
    });
    it("a recreated report with no record recognises its marked Doc and updates it in place — same ID, no copy", async () => {
      const drive = new FakeDrive(); const sync = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch, drive.now);
      const first = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false, clientId: "club-furniture" });
      drive.invisibleProcessing(first.docId);
      const again = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v2</p>", expected: null, force: false, clientId: "club-furniture" });
      expect(again).toMatchObject({ docId: first.docId, action: "updated", managedBy: "marker" });
      expect(drive.named(name)).toHaveLength(1); expect(doc(drive).html).toBe("<p>v2</p>");
    });
    it("refuses a marked Doc that a person edited after Tention's write, and keeps it openable", async () => {
      const drive = new FakeDrive(); const sync = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch, drive.now);
      const first = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false, clientId: "club-furniture" });
      for (let i = 0; i < 300; i += 1) drive.tick();
      drive.editInDrive(first.docId);
      await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v2</p>", expected: null, force: false, clientId: "club-furniture" })).rejects.toMatchObject({ code: "GOOGLE_DOC_EDITED_IN_DRIVE", details: { docId: first.docId } });
      expect(doc(drive).html).toBe("<p>edited by a person</p>");
    });
    it.each([
      ["an unmarked Doc", undefined],
      ["a Doc marked for another client", { tentionManaged: "true", tentionClientId: "another-client", tentionReportMonth: "2026-10", tentionWrittenAt: "2026-11-05T06:00:00.000Z" }],
      ["a Doc marked for another month", { tentionManaged: "true", tentionClientId: "club-furniture", tentionReportMonth: "2026-09", tentionWrittenAt: "2026-11-05T06:00:00.000Z" }],
    ])("never overwrites %s automatically; offers it to open and adopt", async (_case, appProperties) => {
      const drive = new FakeDrive(); const sync = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch, drive.now);
      await sync.deliver({ year: 2026, month: 10, fileName: `${name}.pdf`, bytes: pdf("x") });
      const [october] = drive.named("October");
      const id = drive.add({ name, mimeType: GOOGLE_DOC, parents: [october!.id], ...(appProperties ? { appProperties } : {}) }, 0); drive.files.get(id)!.html = "<p>someone's doc</p>";
      await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false, clientId: "club-furniture" }))
        .rejects.toMatchObject({ code: "GOOGLE_DOC_NOT_TENTION_MANAGED", message: expect.stringContaining("not verified as Tention-managed"), details: { docId: id, folderId: october!.id, webViewLink: expect.stringContaining(id) } });
      expect(drive.files.get(id)!.html).toBe("<p>someone's doc</p>"); expect(drive.named(name)).toHaveLength(1);
      // Explicit adoption of that exact Doc: same ID, this report's content, Tention's marker from now on.
      await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false, clientId: "club-furniture", adoptDocId: "some-other-doc" })).rejects.toMatchObject({ code: "GOOGLE_DOC_ADOPTION_REFUSED" });
      const adopted = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false, clientId: "club-furniture", adoptDocId: id });
      expect(adopted).toMatchObject({ docId: id, action: "updated", managedBy: "adopted" });
      expect(drive.files.get(id)).toMatchObject({ html: "<p>v1</p>", appProperties: expect.objectContaining({ tentionClientId: "club-furniture", tentionReportMonth: "2026-10" }) });
      expect(drive.named(name)).toHaveLength(1);
      // From now on it is recognised by its marker.
      await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v2</p>", expected: null, force: false, clientId: "club-furniture" })).resolves.toMatchObject({ docId: id, managedBy: "marker" });
    });
  });

  it("for a Doc written before modifiedTime was recorded, uses Tention's own write time: invisible processing passes, a later edit blocks", async () => {
    const drive = new FakeDrive();
    const sync = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch);
    const name = "Club Furniture - October 2026";
    const first = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false });
    const writtenAt = new Date(Date.parse(first.modifiedTime!) + 5_000).toISOString(); // recorded by Tention just after the write
    drive.invisibleProcessing(first.docId);
    await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v2</p>", expected: { docId: first.docId, version: first.version, modifiedTime: null, writtenAt }, force: false })).resolves.toMatchObject({ action: "updated" });
    const { version: secondVersion, modifiedTime: secondWrite } = { ...drive.files.get(first.docId)! };
    for (let i = 0; i < 10; i += 1) drive.tick();
    drive.editInDrive(first.docId);
    await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v3</p>", expected: { docId: first.docId, version: String(secondVersion), modifiedTime: null, writtenAt: new Date(Date.parse(secondWrite) + 2_000).toISOString() }, force: false })).rejects.toMatchObject({ code: "GOOGLE_DOC_EDITED_IN_DRIVE" });
    expect(drive.named(name)).toHaveLength(1);
  });

  it("is created once, updated in place, and never overwrites a Doc edited in Drive or one Tention did not create", async () => {
    const drive = new FakeDrive();
    const sync = new GoogleDrivePdfDelivery(CONFIG, drive.fetch as unknown as typeof fetch);
    const name = googleDocName({ client: { id: "c", name: "Club Furniture", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 10 } });
    expect(name).toBe("Club Furniture - October 2026");
    const first = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v1</p>", expected: null, force: false });
    const [october] = drive.named("October");
    expect(first).toMatchObject({ folderId: october!.id, action: "created", version: "1" });
    expect(drive.files.get(first.docId)).toMatchObject({ mimeType: GOOGLE_DOC, parents: [october!.id], html: "<p>v1</p>" });

    // Live Oct/Sep 2026: Drive bumped `version` right after conversion with nobody editing; that is not an edit.
    drive.invisibleProcessing(first.docId);
    const second = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v2</p>", expected: { docId: first.docId, version: first.version, modifiedTime: first.modifiedTime }, force: false });
    expect(second).toMatchObject({ docId: first.docId, action: "updated", version: "5" });
    expect(drive.named(name)).toHaveLength(1); expect(drive.files.get(first.docId)!.html).toBe("<p>v2</p>");

    drive.editInDrive(first.docId); // a person edits the Doc in Drive
    await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v3</p>", expected: { docId: first.docId, version: second.version, modifiedTime: second.modifiedTime }, force: false })).rejects.toMatchObject({ code: "GOOGLE_DOC_EDITED_IN_DRIVE" });
    expect(drive.files.get(first.docId)!.html).toBe("<p>edited by a person</p>");
    await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v3</p>", expected: null, force: false })).rejects.toMatchObject({ code: "GOOGLE_DOC_NOT_TENTION_MANAGED" });
    const forced = await sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v3</p>", expected: null, force: true });
    expect(forced).toMatchObject({ docId: first.docId, action: "updated" }); expect(drive.named(name)).toHaveLength(1);

    drive.add({ name, mimeType: GOOGLE_DOC, parents: [october!.id] }, 0);
    await expect(sync.syncGoogleDoc({ year: 2026, month: 10, name, html: "<p>v4</p>", expected: null, force: true })).rejects.toMatchObject({ code: "GOOGLE_DOC_DUPLICATES" });
    expect(drive.named("November")).toHaveLength(0);
    // The PDF and the Doc share the month folder without colliding: different names and types.
    await sync.deliver({ year: 2026, month: 10, fileName: `${name}.pdf`, bytes: pdf("x") });
    expect(drive.named(`${name}.pdf`)[0]!.parents).toEqual([october!.id]);
  });
});
