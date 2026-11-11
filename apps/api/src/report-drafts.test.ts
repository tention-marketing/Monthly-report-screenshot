import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUMMARY_EVIDENCE } from "./test-support/business-performance.js";
import type { FastifyInstance } from "fastify";
import { applyReportEvent, createReportDraft, InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository, ReportPersistenceError, upsertScreenshotMetadata } from "@tention/report-domain";
import { clientReportTargetsInputSchema, createScreenshotSourceProof, type ReportDraft, type ScreenshotRecord, type ScreenshotType } from "@tention/report-schema";
import { buildApp } from "./app.js";
import { InMemoryScreenshotStorage } from "./storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage } from "./storage/pdf-artifact-storage.js";

const NOW = new Date("2026-09-09T12:00:00Z");
let app: FastifyInstance;
let screenshotStorage: InMemoryScreenshotStorage;
let repository: InMemoryReportDraftRepository;
let pdfStorage: InMemoryPdfArtifactStorage;
const renderedPdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
let pdfRenderer: { render: ReturnType<typeof vi.fn>; close: () => Promise<void> };

beforeEach(() => { screenshotStorage = new InMemoryScreenshotStorage(); pdfStorage = new InMemoryPdfArtifactStorage(); repository = new InMemoryReportDraftRepository(); pdfRenderer = { render: vi.fn().mockResolvedValue(renderedPdf), close: async () => undefined }; app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), screenshotStorage, pdfArtifactStorage: pdfStorage, pdfRenderer, repository }); });
afterEach(async () => app.close());

const body = (overrides: Record<string, unknown> = {}) => ({
  client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata" },
  reportMonth: { year: 2026, month: 8 },
  sections: { executive_summary: "optional" },
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: body(overrides) });
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
/** A client whose currency and conversion metric ID are configured, as final generation requires. */
async function useConfiguredClient(currency: string | null = "USD", providerMetricId: string | null = "TEST01") {
  await app.close();
  const targets = new InMemoryClientReportTargetsRepository();
  await targets.save("client-1", clientReportTargetsInputSchema.parse({ profile: { name: "Orion", timezone: "Asia/Kolkata", currency, conversionMetric: { label: "Placed Order", providerMetricId }, sections: null } }), NOW);
  app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), screenshotStorage, pdfArtifactStorage: pdfStorage, pdfRenderer, repository, clientReportTargetsRepository: targets });
  return targets;
}
async function enablePersistentLocalReview() {
  await app.close();
  app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), screenshotStorage, pdfArtifactStorage: pdfStorage, pdfRenderer, repository, enableLocalDevelopmentImports: true, localImportRequiresPersistentStorage: true });
}
async function createPendingImportedOverview() {
  const created = await create({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York" }, sections: { executive_summary: "optional" } });
  const draft = created.json() as ReportDraft;
  const storageKey = `reports/${draft.id}/overview/11111111-1111-4111-8111-111111111111.png`;
  const asset = await screenshotStorage.put(storageKey, PNG);
  const screenshot: ScreenshotRecord = {
    id: "11111111-1111-4111-8111-111111111111", clientId: draft.client.id, reportMonth: draft.reportMonth, type: "overview",
    capturedAt: NOW.toISOString(), sourceUrl: "https://www.klaviyo.com/dashboard", width: 1, height: 1, approved: false,
    storageKey, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, captureOrigin: "live_acceptance_import",
    approvedAt: null, periodConfirmed: true, sourceProof: createScreenshotSourceProof("overview", draft.period, undefined, null, null, SUMMARY_EVIDENCE),
  };
  await repository.save(upsertScreenshotMetadata(draft, screenshot, "overview", { now: NOW }), draft.version);
  return { draftId: draft.id, sha256: asset.sha256, storageKey };
}
async function upload(id: string, type = "overview", expectedVersion = 1, sourceUrl = "https://www.klaviyo.com/dashboard?token=secret") {
  const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
  const proof = type === "not-a-type" ? null : createScreenshotSourceProof(type as ScreenshotType, period, undefined, type === "top_campaigns" ? { accountIdentity: "Orion", clientTimezone: "Asia/Kolkata", visibleMetricLabel: "Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 1, includedRowCount: 1, rows: [{ name: "Campaign", type: "Email", status: "Sent", sendDate: "2026-08-01", openRate: "10%", clickRate: "1%", placedOrderValue: 1 }] } : null, null, type === "overview" ? SUMMARY_EVIDENCE : null);
  return app.inject({
    method: "PUT", url: `/api/v1/report-drafts/${id}/screenshots/${type}/image`, payload: type === "overview" ? PNG : Buffer.concat([PNG, Buffer.from(type)]),
    headers: {
      "content-type": "image/png", "x-expected-version": String(expectedVersion),
      "x-period-confirmed": "true", "x-source-url": type === "top_campaigns" && sourceUrl.startsWith("https://www.klaviyo.com/dashboard") ? "https://www.klaviyo.com/omnicampaigns?appBarNav=true" : sourceUrl,
      "x-capture-proof": type === "not-a-type" ? "{}" : JSON.stringify(proof),
    },
  });
}
const eventPayload = (expectedVersion: number, event: string) => ({ expectedVersion, event });
const deletePayload = (expectedVersion: number) => ({ expectedVersion });
const legacyRequiredCaptureSections = {
  executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required",
  deliverability: "required", campaign_metrics: "required", flow_metrics: "required", list_growth: "required",
} as const;
const legacyRequiredCaptureTypes = [
  "overview", "top_campaigns", "top_flows", "month_comparison",
  "deliverability", "campaign_metrics", "flow_metrics", "list_growth",
] as const;
async function deleteDraft(id: string, expectedVersion: number) {
  return app.inject({ method: "DELETE", url: `/api/v1/report-drafts/${id}`, payload: deletePayload(expectedVersion) });
}

describe("report draft API", () => {
  it("requires an explicit development review and persists imported approval with backend acknowledgement", async () => {
    await enablePersistentLocalReview();
    const { draftId, sha256 } = await createPendingImportedOverview();
    const image = await app.inject({ method: "GET", url: `/api/v1/dev/report-drafts/${draftId}/screenshots/overview/pending-image` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["x-report-id"]).toBe(draftId);
    expect(image.headers["x-screenshot-type"]).toBe("overview");
    expect(image.headers["x-screenshot-sha256"]).toBe(sha256);
    expect(image.rawPayload).toEqual(PNG);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draftId}` })).json().screenshots[0]).toMatchObject({ approved: false, captureOrigin: "live_acceptance_import" });

    const approved = await app.inject({ method: "POST", url: `/api/v1/dev/report-drafts/${draftId}/screenshots/overview/review`, payload: { expectedVersion: 2, expectedSha256: sha256 } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ reportId: draftId, screenshotType: "overview", screenshotRecordId: "11111111-1111-4111-8111-111111111111", approvalStatus: "approved", sha256, sourceProofAccepted: true, report: { status: "draft", version: 3, screenshots: [expect.objectContaining({ approved: true, captureOrigin: "live_acceptance_import", sha256 })] } });
    const canonical = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draftId}` });
    expect(canonical.json().screenshots[0]).toMatchObject({ approved: true, captureOrigin: "live_acceptance_import", sha256, approvedAt: NOW.toISOString() });
    expect(canonical.json().status).toBe("draft");
  });

  it("rejects stale review versions and SHA mismatches without approving imported evidence", async () => {
    await enablePersistentLocalReview();
    const { draftId, sha256 } = await createPendingImportedOverview();
    const stale = await app.inject({ method: "POST", url: `/api/v1/dev/report-drafts/${draftId}/screenshots/overview/review`, payload: { expectedVersion: 1, expectedSha256: sha256 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("REPORT_VERSION_CONFLICT");
    const mismatch = await app.inject({ method: "POST", url: `/api/v1/dev/report-drafts/${draftId}/screenshots/overview/review`, payload: { expectedVersion: 2, expectedSha256: "a".repeat(64) } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toBe("SCREENSHOT_SHA256_MISMATCH");
    const canonical = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draftId}` });
    expect(canonical.json().screenshots[0]).toMatchObject({ approved: false, approvedAt: null });
  });

  it("refuses imported review when report identity is not the canonical AutoLEDTech month", async () => {
    await enablePersistentLocalReview();
    const { draftId, sha256 } = await createPendingImportedOverview();
    const wrongReport = await app.inject({ method: "GET", url: `/api/v1/dev/report-drafts/00000000-0000-4000-8000-000000000001/screenshots/overview/pending-image` });
    expect(wrongReport.statusCode).toBe(400);
    const wrongClient = await create({ client: { id: "client-other", name: "Other", timezone: "America/New_York" } });
    const response = await app.inject({ method: "POST", url: `/api/v1/dev/report-drafts/${wrongClient.json().id}/screenshots/overview/review`, payload: { expectedVersion: 1, expectedSha256: sha256 } });
    expect(response.statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${wrongClient.json().id}` })).json().screenshots).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${draftId}` })).json().screenshots[0]).toMatchObject({ approved: false, captureOrigin: "live_acceptance_import" });
  });

  it("requires signup-form listing captures to match the saved all-forms scope", async () => {
    const created = await create();
    const id = created.json().id as string;
    const proof = createScreenshotSourceProof("signup_form", created.json().period, { scope: "all_forms" });
    const uploadResponse = () => app.inject({ method: "PUT", url: `/api/v1/report-drafts/${id}/screenshots/signup_form/image`, payload: PNG,
      headers: { "content-type": "image/png", "x-expected-version": "1", "x-period-confirmed": "true", "x-capture-proof": JSON.stringify(proof) } });
    expect((await uploadResponse()).json().error).toBe("REPORT_VALIDATION_FAILED");
    const targets = await app.inject({ method: "PUT", url: "/api/v1/clients/client-1/report-targets", payload: { signupForms: { mode: "all", ids: [], names: [] } } });
    expect(targets.statusCode).toBe(200);
    expect((await uploadResponse()).statusCode).toBe(200);
  });
  it("lists an empty repository", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/report-drafts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
  it("lists drafts deterministically and filters by safe fields", async () => {
    const first = (await create()).json();
    const second = (await create({
      client: { id: "client-2", name: "Second", timezone: "Asia/Kolkata" },
      reportMonth: { year: 2026, month: 7 },
    })).json();
    const third = (await create({
      client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata" },
      reportMonth: { year: 2025, month: 8 },
    })).json();
    const all = (await app.inject({ method: "GET", url: "/api/v1/report-drafts" })).json();
    expect(all.map(({ id }: { id: string }) => id)).toEqual([first.id, second.id, third.id].sort());
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts?clientId=client-1" })).json()).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts?year=2026" })).json()).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts?month=8" })).json()).toHaveLength(2);
    const combined = (await app.inject({ method: "GET", url: "/api/v1/report-drafts?clientId=client-2&year=2026&month=7" })).json();
    expect(combined).toHaveLength(1);
    expect(combined[0].id).toBe(second.id);
  });
  it.each(["year=not-a-year", "year=1999", "month=0", "month=13", "month=1%20OR%201=1"])(
    "rejects invalid list query %s", async (query) => {
      const response = await app.inject({ method: "GET", url: `/api/v1/report-drafts?${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("INVALID_REQUEST");
    },
  );
  it("creates a completed-month draft with a backend-derived period", async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      version: 1,
      reportMonth: { year: 2026, month: 8 },
      period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
    });
  });
  it("rejects a duplicate client and report month", async () => {
    expect((await create()).statusCode).toBe(201);
    const duplicate = await create();
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("REPORT_DRAFT_ALREADY_EXISTS");
  });
  it("releases the client/month uniqueness constraint after deleting a report", async () => {
    const original = await create();
    expect((await create()).json().error).toBe("REPORT_DRAFT_ALREADY_EXISTS");
    expect((await deleteDraft(original.json().id, 1)).statusCode).toBe(200);
    expect((await create()).statusCode).toBe(201);
  });
  it.each([
    [{ year: 2026, month: 9 }, "current"],
    [{ year: 2026, month: 10 }, "future"],
  ])("rejects a %s report month", async (reportMonth) => {
    const response = await create({ reportMonth });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("REPORT_MONTH_INCOMPLETE");
  });
  it("rejects an invalid timezone", async () => {
    const response = await create({ client: { id: "client-1", name: "Orion", timezone: "Mars/Base" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_CLIENT_TIMEZONE");
  });
  it("evaluates completion in the client's timezone", async () => {
    await app.close();
    app = buildApp({ requireClientSetupReady: false, now: () => new Date("2026-08-31T20:00:00Z") });
    const india = await create({ reportMonth: { year: 2026, month: 8 } });
    const newYork = await create({
      client: { id: "client-2", name: "New York Client", timezone: "America/New_York" },
      reportMonth: { year: 2026, month: 8 },
    });
    expect(india.statusCode).toBe(201);
    expect(newYork.statusCode).toBe(400);
    expect(newYork.json().error).toBe("REPORT_MONTH_INCOMPLETE");
  });
  it("does not accept caller-supplied period boundaries", async () => {
    const response = await create({ period: { startDate: "1999-01-01" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_REQUEST");
  });
  it("gets an existing draft and returns 404 for an unknown ID", async () => {
    const created = (await create()).json();
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts/missing" })).statusCode).toBe(404);
  });
  it("rejects a screenshot write addressed to a different reportId", async () => {
    const put = vi.spyOn(screenshotStorage, "put");
    const response = await upload("00000000-0000-4000-8000-000000000001");
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("REPORT_NOT_FOUND");
    expect(await repository.list()).toEqual([]);
    expect(put).not.toHaveBeenCalled();
  });
  it("validates a missing required screenshot until an approved stored PNG is uploaded", async () => {
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    let response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().errors.map(({ code }: { code: string }) => code)).toContain("REQUIRED_SCREENSHOT_MISSING");
    const uploaded = await upload(created.id);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json()).toMatchObject({ reportId: created.id, screenshotType: "overview", screenshotRecordId: expect.any(String), approvalStatus: "approved", sourceProofAccepted: true, sha256: expect.stringMatching(/^[a-f0-9]{64}$/), report: { screenshots: [expect.objectContaining({
      clientId: "client-1", reportMonth: { year: 2026, month: 8 }, type: "overview",
      approved: true, periodConfirmed: true, mimeType: "image/png", width: 1, height: 1,
      sourceUrl: "https://www.klaviyo.com/dashboard",
    })] } });
    const acknowledgement = uploaded.json();
    const record = acknowledgement.report.screenshots[0];
    const storedAsset = await screenshotStorage.get(record.storageKey);
    expect(storedAsset).toMatchObject({ byteSize: record.byteSize, sha256: acknowledgement.sha256, bytes: PNG });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json().screenshots[0]).toMatchObject({ id: acknowledgement.screenshotRecordId, sha256: acknowledgement.sha256, approved: true, sourceProof: record.sourceProof });
    response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().status).toBe("valid");
  });
  it("allows a missing optional non-core screenshot", async () => {
    const created = (await create({ sections: { signup_form: "optional" } })).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().status).toBe("valid");
  });
  it("warns for metadata attached to a disabled section", async () => {
    const created = (await create({ sections: { executive_summary: "disabled" } })).json();
    await upload(created.id);
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().warnings.map(({ code }: { code: string }) => code)).toContain("DISABLED_SECTION_SCREENSHOT_PRESENT");
  });
  it("rejects invalid screenshot types and non-PNG uploads", async () => {
    const created = (await create()).json();
    let response = await upload(created.id, "not-a-type");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_SCREENSHOT_TYPE");
    response = await app.inject({
      method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image`, payload: Buffer.from("not a png"),
      headers: { "content-type": "image/png", "x-expected-version": "1", "x-period-confirmed": "true", "x-source-url": "https://www.klaviyo.com/reports", "x-capture-proof": JSON.stringify(createScreenshotSourceProof("overview", { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" })) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_SCREENSHOT_CONTENT");
    response = await app.inject({ method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image`, payload: PNG, headers: { "content-type": "image/jpeg" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_SCREENSHOT_CONTENT");
    response = await app.inject({
      method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image`, payload: PNG,
      headers: { "content-type": "image/png", "x-expected-version": "1", "x-period-confirmed": "false", "x-source-url": "https://www.klaviyo.com/reports" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_REQUEST");
  });
  it("rejects mismatched proof and exact duplicate assets before they enter another enabled section", async () => {
    const created = (await create({ sections: { executive_summary: "required", top_campaigns: "required" } })).json();
    const overview = (await upload(created.id)).json().report;
    const headers = (proof: unknown) => ({
      "content-type": "image/png", "x-expected-version": String(overview.version), "x-period-confirmed": "true",
      "x-capture-proof": JSON.stringify(proof),
    });
    const mismatch = await app.inject({
      method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/top_campaigns/image`, payload: Buffer.concat([PNG, Buffer.from("different")]),
      headers: headers(createScreenshotSourceProof("overview", overview.period)),
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().validation.errors.map(({ code }: { code: string }) => code)).toContain("SCREENSHOT_SOURCE_IDENTITY_MISMATCH");
    const duplicate = await app.inject({
      method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/top_campaigns/image`, payload: PNG,
      headers: headers(createScreenshotSourceProof("top_campaigns", overview.period)),
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().validation.errors.map(({ code }: { code: string }) => code)).toContain("DUPLICATE_SCREENSHOT_SOURCE");
    const stored = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json();
    expect(stored).toMatchObject({ version: overview.version, screenshots: [expect.objectContaining({ type: "overview" })] });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).json()).toHaveLength(1);
  });
  it("rejects illegal lifecycle events", async () => {
    const created = (await create()).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(1, "GENERATION_SUCCEEDED") });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("GENERATION_EVENT_MANAGED");
  });
  it("blocks invalid review submission and accepts a valid one", async () => {
    const blocked = (await create({ sections: { executive_summary: "required" } })).json();
    let blockedVersion = 1;
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED"]) {
      const result = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${blocked.id}/events`, payload: eventPayload(blockedVersion, event) });
      blockedVersion = result.json().version;
    }
    let response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${blocked.id}/events`, payload: eventPayload(blockedVersion, "SUBMIT_FOR_REVIEW") });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("REPORT_VALIDATION_FAILED");

    const valid = (await create({
      client: { id: "client-2", name: "Second Client", timezone: "Asia/Kolkata" },
      sections: { executive_summary: "required" },
    })).json();
    const uploaded = await upload(valid.id);
    let validVersion = uploaded.json().report.version;
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW"]) {
      response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${valid.id}/events`, payload: eventPayload(validVersion, event) });
      validVersion = response.json().version;
    }
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ready_for_review");
  });
  it("persists capture-only review completion for the normal draft capture workflow", async () => {
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    const uploaded = (await upload(created.id)).json().report;
    const completed = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(uploaded.version, "SUBMIT_FOR_REVIEW") });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: "ready_for_review", version: uploaded.version + 1 });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ status: "ready_for_review", version: uploaded.version + 1 });
  });
  it("persists capture review completion, invalidates it after a required replacement, and avoids duplicate submissions", async () => {
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    let version = (await upload(created.id)).json().report.version;
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW"]) {
      const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(version, event) });
      expect(response.statusCode).toBe(200);
      version = response.json().version;
    }
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ status: "ready_for_review", version });

    const duplicate = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(version, "SUBMIT_FOR_REVIEW") });
    expect(duplicate.json()).toMatchObject({ status: "ready_for_review", version });

    const replaced = await upload(created.id, "overview", version);
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().report).toMatchObject({ status: "captures_incomplete", version: version + 1 });
    version = replaced.json().report.version;
    const history = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).json();
    expect(history.filter(({ eventType }: { eventType: string }) => eventType === "SUBMIT_FOR_REVIEW")).toHaveLength(1);
    expect(history.at(-1)).toMatchObject({ eventType: "MARK_CAPTURES_INCOMPLETE", fromStatus: "ready_for_review", toStatus: "captures_incomplete", reportVersion: version });

    const reviewedAgain = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(version, "SUBMIT_FOR_REVIEW") });
    expect(reviewedAgain.json()).toMatchObject({ status: "ready_for_review", version: version + 1 });
  });
  it("recovers a valid legacy generated eight-capture report without duplicating history", async () => {
    let legacy: ReportDraft = createReportDraft({ client: { id: "client-legacy", name: "Legacy", timezone: "Asia/Kolkata", currency: null }, reportMonth: { year: 2026, month: 8 }, sections: legacyRequiredCaptureSections }, { now: NOW });
    for (const [index, type] of legacyRequiredCaptureTypes.entries()) legacy = upsertScreenshotMetadata(legacy, {
      id: crypto.randomUUID(), clientId: legacy.client.id, reportMonth: legacy.reportMonth, type, capturedAt: NOW.toISOString(), sourceUrl: type === "top_campaigns" ? "https://www.klaviyo.com/omnicampaigns" : null,
      width: 1, height: 1, approved: true, periodConfirmed: true, storageKey: `reports/${legacy.id}/${type}/${crypto.randomUUID()}.png`, mimeType: "image/png", byteSize: PNG.length, sha256: index.toString(16).repeat(64), approvedAt: NOW.toISOString(),
      sourceProof: createScreenshotSourceProof(type, legacy.period, undefined, type === "top_campaigns" ? { accountIdentity: legacy.client.name, clientTimezone: legacy.client.timezone, visibleMetricLabel: "Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 1, includedRowCount: 1, rows: [{ name: "Campaign", type: "Email", status: "Sent", sendDate: "2026-08-01", openRate: "10%", clickRate: "1%", placedOrderValue: 1 }] } : null),
    }, type, { now: NOW });
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW", "START_GENERATION", "GENERATION_SUCCEEDED"] as const) legacy = applyReportEvent(legacy, event, { now: NOW });
    await repository.create(legacy);
    const created = legacy;
    let version = legacy.version;
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ status: "generated", version, screenshots: expect.arrayContaining([expect.objectContaining({ type: "overview", approved: true })]) });

    const rejected = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(version, "SUBMIT_FOR_REVIEW") });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toBe("ILLEGAL_REPORT_TRANSITION");

    const migrated = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(version, "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW") });
    expect(migrated.statusCode).toBe(200);
    expect(migrated.json()).toMatchObject({ status: "ready_for_review", version: version + 1 });
    version = migrated.json().version;
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ status: "ready_for_review", version, screenshots: expect.arrayContaining([expect.objectContaining({ type: "list_growth", approved: true })]) });

    const duplicate = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(version, "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW") });
    expect(duplicate.json()).toMatchObject({ status: "ready_for_review", version });
    const replacement = await upload(created.id, "overview", version);
    expect(replacement.json().report).toMatchObject({ status: "captures_incomplete", version: version + 1 });
    const history = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).json();
    expect(history.filter(({ eventType }: { eventType: string }) => eventType === "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW")).toHaveLength(1);
    expect(history.at(-1)).toMatchObject({ eventType: "MARK_CAPTURES_INCOMPLETE", fromStatus: "ready_for_review", toStatus: "captures_incomplete" });
  });
  it("previews without mutation, persists a real PDF artifact, and makes it stale after replacement", async () => {
    await useConfiguredClient();
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    const uploaded = (await upload(created.id)).json().report;
    const reviewed = (await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(uploaded.version, "SUBMIT_FOR_REVIEW") })).json();
    const beforeHistory = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).json();
    const preview = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/preview` });
    expect(preview.statusCode).toBe(200); expect(preview.headers["content-type"]).toContain("text/html"); expect(preview.body).toContain("Reporting Period: August 2026"); expect(preview.body).not.toContain("Compared with"); expect(preview.body).toContain('data-report-layout="tention-monthly-v1"');
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).json()).toEqual(beforeHistory);
    const generated = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/generate`, payload: { expectedVersion: reviewed.version } });
    expect(generated.statusCode).toBe(200); expect(generated.json()).toMatchObject({ report: { status: "generated" }, artifact: { mimeType: "application/pdf", byteSize: renderedPdf.length, sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    const artifact = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/pdf-artifact` });
    expect(artifact.statusCode).toBe(200);
    const pdf = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/pdf?download=1` });
    expect(pdf.statusCode).toBe(200); expect(pdf.headers["content-type"]).toContain("application/pdf"); expect(pdf.headers["content-disposition"]).toContain("attachment; filename=\"Orion-August-2026-Monthly-Report.pdf\""); expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    const replaced = await upload(created.id, "overview", generated.json().report.version);
    expect(replaced.json().report).toMatchObject({ status: "captures_incomplete" });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/pdf-artifact` })).json()).toMatchObject({ error: "PDF_ARTIFACT_STALE" });
  });
  it("refuses preview and generation for a persisted wrong-section capture without producing an artifact or lifecycle event", async () => {
    let invalid = createReportDraft({
      client: { id: "invalid-capture", name: "Invalid Capture", timezone: "Asia/Kolkata", currency: null },
      reportMonth: { year: 2026, month: 8 }, sections: { executive_summary: "required" },
    }, { now: NOW });
    invalid = upsertScreenshotMetadata(invalid, {
      id: crypto.randomUUID(), clientId: invalid.client.id, reportMonth: invalid.reportMonth, type: "overview", capturedAt: NOW.toISOString(), sourceUrl: null,
      width: 1, height: 1, approved: true, approvedAt: NOW.toISOString(), periodConfirmed: true, storageKey: `reports/${invalid.id}/overview/wrong.png`, mimeType: "image/png", byteSize: PNG.length, sha256: "d".repeat(64),
      sourceProof: createScreenshotSourceProof("top_campaigns", invalid.period),
    }, "overview", { now: NOW });
    invalid = { ...invalid, status: "ready_for_review" };
    await repository.create(invalid);
    const preview = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${invalid.id}/preview` });
    expect(preview.statusCode).toBe(400);
    expect(preview.json().error).toBe("REPORT_RENDER_INPUT_INVALID");
    const generation = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${invalid.id}/generate`, payload: { expectedVersion: invalid.version } });
    expect(generation.statusCode).toBe(400);
    expect(generation.json().error).toBe("REPORT_RENDER_INPUT_INVALID");
    expect(pdfRenderer.render).not.toHaveBeenCalled();
    expect(await repository.listArtifacts(invalid.id)).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${invalid.id}` })).json()).toMatchObject({ status: "ready_for_review", version: invalid.version });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${invalid.id}/history` })).json().map(({ eventType }: { eventType: string }) => eventType)).toEqual(["REPORT_CREATED"]);
  });
  it.each([
    ["the currency is not configured", null, "TEST01", ["CURRENCY_NOT_CONFIGURED"]],
    ["the Placed Order provider metric ID is not configured", "USD", null, ["CONVERSION_METRIC_ID_NOT_CONFIGURED"]],
    ["neither is configured", null, null, ["CURRENCY_NOT_CONFIGURED", "CONVERSION_METRIC_ID_NOT_CONFIGURED"]],
  ] as const)("fails closed before rendering, Drive, or the Doc when %s", async (_case, currency, metricId, codes) => {
    await useConfiguredClient(currency, metricId);
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    const uploaded = (await upload(created.id)).json().report;
    const reviewed = (await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(uploaded.version, "SUBMIT_FOR_REVIEW") })).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/generate`, payload: { expectedVersion: reviewed.version } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "REPORT_DATA_DEFINITION_INCOMPLETE" });
    expect(response.json().blockers.map(({ code }: { code: string }) => code)).toEqual(codes);
    expect(pdfRenderer.render).not.toHaveBeenCalled();
    expect(await repository.listArtifacts(created.id)).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ status: "ready_for_review", version: reviewed.version });
  });
  describe("explicit currency data-definition update", () => {
    it("fills a null frozen currency from the verified client profile and changes nothing else", async () => {
      const created = (await create({ sections: { executive_summary: "required" } })).json(); // client-1 has no profile yet: currency null
      const uploaded = (await upload(created.id)).json().report;
      const before = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json();
      expect(before.client.currency).toBeNull();
      await useConfiguredClient("USD", "TEST01");
      // useConfiguredClient rebuilt the app on the same repository; the draft is unchanged so far.
      const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/client-currency`, payload: { expectedVersion: uploaded.version } });
      expect(response.statusCode).toBe(200);
      const after = response.json();
      expect(after.client.currency).toBe("USD");
      expect(after.version).toBe(before.version + 1);
      for (const key of ["id", "reportMonth", "period", "status", "sections", "screenshots", "createdAt"]) expect(after[key]).toEqual(before[key]);
      expect({ ...after.client, currency: null }).toEqual(before.client);
      // Idempotent: applying again changes nothing.
      const again = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/client-currency`, payload: { expectedVersion: after.version } });
      expect(again.json().version).toBe(after.version);
    });
    it("refuses when the profile has no verified currency, and never replaces a different frozen currency", async () => {
      const created = (await create({ sections: { executive_summary: "required" } })).json();
      await useConfiguredClient(null, "TEST01");
      const missing = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/client-currency`, payload: { expectedVersion: created.version } });
      expect(missing.statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json()).toMatchObject({ version: created.version, client: { currency: null } });
      const frozen = { ...(await repository.getById(created.id))!, client: { ...(await repository.getById(created.id))!.client, currency: "CAD" }, version: created.version + 1 };
      await repository.save(frozen, created.version);
      await useConfiguredClient("USD", "TEST01");
      const conflict = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/client-currency`, payload: { expectedVersion: frozen.version } });
      expect(conflict.statusCode).toBe(400);
      expect((await repository.getById(created.id))!.client.currency).toBe("CAD");
    });
  });
  it("records generation failure without claiming generated or creating an artifact", async () => {
    await useConfiguredClient();
    pdfRenderer.render.mockRejectedValueOnce(new Error("renderer offline"));
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    const uploaded = (await upload(created.id)).json().report;
    const reviewed = (await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(uploaded.version, "SUBMIT_FOR_REVIEW") })).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/generate`, payload: { expectedVersion: reviewed.version } });
    expect(response.statusCode).toBe(500); expect(response.json().error).toBe("PDF_GENERATION_FAILED");
    const failed = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` });
    expect(failed.json()).toMatchObject({ status: "failed" });
    expect(await repository.listArtifacts(created.id)).toEqual([]);
  });
  it("increments versions and rejects stale screenshot and lifecycle writes", async () => {
    const created = (await create()).json();
    let response = await upload(created.id);
    expect(response.json().report.version).toBe(2);
    response = await upload(created.id, "overview", 1);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "REPORT_VERSION_CONFLICT", expectedVersion: 1, currentVersion: 2 });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image` })).statusCode).toBe(200);
    response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(2, "START_DATA_FETCH") });
    expect(response.json().version).toBe(3);
    response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(2, "DATA_FETCH_SUCCEEDED") });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("REPORT_VERSION_CONFLICT");
  });
  it("does not delete a stale report or its screenshot asset", async () => {
    const created = (await create()).json();
    const uploaded = (await upload(created.id)).json().report;
    const storageKey = uploaded.screenshots[0].storageKey;
    const response = await deleteDraft(created.id, 1);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "REPORT_VERSION_CONFLICT", expectedVersion: 1, currentVersion: 2 });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).statusCode).toBe(200);
    expect(await screenshotStorage.get(storageKey)).not.toBeNull();
  });
  it("deletes report-owned history and assets without touching unrelated assets", async () => {
    const created = (await create()).json();
    const overview = (await upload(created.id, "overview", 1)).json().report;
    const campaigns = (await upload(created.id, "top_campaigns", 2)).json().report;
    const keys = campaigns.screenshots.map(({ storageKey }: { storageKey: string }) => storageKey);
    const unrelatedKey = "reports/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/overview/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";
    await screenshotStorage.put(unrelatedKey, PNG);
    expect(overview.screenshots).toHaveLength(1);
    expect((await deleteDraft(created.id, 3)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).statusCode).toBe(404);
    await Promise.all(keys.map(async (key: string) => expect(await screenshotStorage.get(key)).toBeNull()));
    expect(await screenshotStorage.get(unrelatedKey)).not.toBeNull();
  });
  it("leaves screenshot assets intact when report deletion fails", async () => {
    await app.close();
    const repository = new InMemoryReportDraftRepository();
    vi.spyOn(repository, "delete").mockRejectedValue(new ReportPersistenceError("REPORT_DELETE_FAILED", "Report draft could not be deleted."));
    screenshotStorage = new InMemoryScreenshotStorage();
    app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), repository, screenshotStorage });
    const created = (await create()).json();
    const uploaded = (await upload(created.id)).json().report;
    const storageKey = uploaded.screenshots[0].storageKey;
    const response = await deleteDraft(created.id, 2);
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toBe("REPORT_DELETE_FAILED");
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).statusCode).toBe(200);
    expect(await screenshotStorage.get(storageKey)).not.toBeNull();
  });
  it("serves the current stored screenshot image without exposing its storage key", async () => {
    const created = (await create()).json();
    await upload(created.id);
    const image = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload).toEqual(PNG);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/screenshots/top_flows/image` })).json().error).toBe("SCREENSHOT_NOT_FOUND");
  });
  it("returns creation and transition history, and 404 for unknown history", async () => {
    const created = (await create()).json();
    await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(1, "START_DATA_FETCH") });
    const history = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` });
    expect(history.json().map(({ eventType }: { eventType: string }) => eventType)).toEqual(["REPORT_CREATED", "START_DATA_FETCH"]);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts/00000000-0000-4000-8000-000000000000/history" })).statusCode).toBe(404);
  });
  it("does not mutate status, version, or history after an illegal transition", async () => {
    const created = (await create()).json();
    await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(1, "GENERATION_SUCCEEDED") });
    const stored = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json();
    const history = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).json();
    expect(stored).toMatchObject({ status: "draft", version: 1 });
    expect(history).toHaveLength(1);
  });
});
