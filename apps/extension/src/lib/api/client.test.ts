import { describe, expect, it, vi } from "vitest";
import { Blob as NodeBlob } from "node:buffer";
import { createApiClient } from "@tention/api-client";
import { localApiBaseUrl, resolveApiBaseUrl } from "./client.js";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotType } from "@tention/report-schema";

const reportId = "f577d631-a1f6-4cc0-9052-68e30460876d";
const screenshotId = "0e529e6d-0ebf-4a28-a87f-02a47cc0b74c";
const reportMonth = { year: 2026, month: 8 };
const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
const png = new NodeBlob(["generated local screenshot fixture"], { type: "image/png" }) as Blob;
async function hash(blob: Blob) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map((value) => value.toString(16).padStart(2, "0")).join("");
}
function makeDraft(type: ScreenshotType, imageHash: string, proof = createScreenshotSourceProof(type, period, type === "signup_form" ? { scope: "all_forms" } : undefined)): ReportDraft {
  const capturedAt = "2026-10-09T01:00:00.000Z";
  return {
    id: reportId, client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth, period,
    status: "draft", sections: { [type === "signup_form" ? "signup_form" : "welcome_flow"]: "optional" },
    screenshots: [{ id: screenshotId, clientId: "autoledtech", reportMonth, type, capturedAt, sourceUrl: "https://www.klaviyo.com/forms", width: 10, height: 10,
      approved: true, approvedAt: capturedAt, periodConfirmed: true, captureOrigin: "extension_manual", storageKey: `reports/${reportId}/${type}/${screenshotId}.png`, mimeType: "image/png", byteSize: png.size, sha256: imageHash, sourceProof: proof }],
    validation: { status: "valid", errors: [], warnings: [] }, version: 2, createdAt: capturedAt, updatedAt: capturedAt,
  };
}

describe("extension API configuration", () => {
  it("uses the local API on port 4000 unless VITE_API_BASE_URL is configured at build time", () => {
    expect(localApiBaseUrl).toBe("http://127.0.0.1:4000");
    expect(resolveApiBaseUrl(undefined)).toBe(localApiBaseUrl);
  });

  it("leaves environment-configured production origins unchanged", () => {
    expect(resolveApiBaseUrl("https://api.example.com")).toBe("https://api.example.com");
  });

  it("uploads bytes with report identity, section, version and proof, verifies the acknowledgement and reloads canonical state", async () => {
    const sha256 = await hash(png);
    const proof = createScreenshotSourceProof("signup_form", period, { scope: "all_forms" });
    const report = makeDraft("signup_form", sha256, proof);
    const acknowledgement = { reportId, screenshotType: "signup_form", screenshotRecordId: screenshotId, approvalStatus: "approved", sha256, sourceProofAccepted: true, report };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(acknowledgement), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(report), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });

    const canonical = await api.uploadScreenshotImage(reportId, "signup_form", { expectedVersion: 1, periodConfirmed: true, sourceUrl: "https://www.klaviyo.com/forms", sourceProof: proof, image: png });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${localApiBaseUrl}/api/v1/report-drafts/${reportId}/screenshots/signup_form/image`);
    const uploadInit = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(uploadInit.method).toBe("PUT");
    expect(uploadInit.headers).toMatchObject({ "content-type": "image/png", "x-expected-version": "1", "x-period-confirmed": "true", "x-source-url": "https://www.klaviyo.com/forms", "x-capture-proof": JSON.stringify(proof) });
    expect(uploadInit.body).toBe(png);
    expect(fetch.mock.calls[1]?.[0]).toBe(`${localApiBaseUrl}/api/v1/report-drafts/${reportId}`);
    expect(canonical.id).toBe(reportId);
    expect(canonical.screenshots[0]).toMatchObject({ id: screenshotId, type: "signup_form", approved: true, sha256 });
  });

  it("does not accept an acknowledgement for a different report identity", async () => {
    const sha256 = await hash(png);
    const report = makeDraft("signup_form", sha256);
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ reportId: "00000000-0000-4000-8000-000000000001", screenshotType: "signup_form", screenshotRecordId: screenshotId, approvalStatus: "approved", sha256, sourceProofAccepted: true, report }), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    await expect(api.uploadScreenshotImage(reportId, "signup_form", { expectedVersion: 1, periodConfirmed: true, sourceUrl: null, sourceProof: createScreenshotSourceProof("signup_form", period, { scope: "all_forms" }), image: png }))
      .rejects.toMatchObject({ code: "SCREENSHOT_UPLOAD_ACK_MISMATCH", status: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP errors and API-offline failures typed instead of reporting an upload success", async () => {
    const conflictFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "REPORT_VERSION_CONFLICT", message: "stale" }), { status: 409 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch: conflictFetch });
    await expect(api.uploadScreenshotImage(reportId, "signup_form", { expectedVersion: 1, periodConfirmed: true, sourceUrl: null, sourceProof: createScreenshotSourceProof("signup_form", period, { scope: "all_forms" }), image: png }))
      .rejects.toMatchObject({ code: "REPORT_VERSION_CONFLICT", status: 409 });
    const offline = createApiClient({ baseUrl: localApiBaseUrl, fetch: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(offline.uploadScreenshotImage(reportId, "signup_form", { expectedVersion: 1, periodConfirmed: true, sourceUrl: null, sourceProof: createScreenshotSourceProof("signup_form", period, { scope: "all_forms" }), image: png }))
      .rejects.toMatchObject({ code: "NETWORK_ERROR", status: null });
  });

  it("rejects a server SHA that does not match uploaded screenshot bytes", async () => {
    const report = makeDraft("signup_form", "a".repeat(64));
    const ack = { reportId, screenshotType: "signup_form", screenshotRecordId: screenshotId, approvalStatus: "approved", sha256: "a".repeat(64), sourceProofAccepted: true, report };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(ack), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    await expect(api.uploadScreenshotImage(reportId, "signup_form", { expectedVersion: 1, periodConfirmed: true, sourceUrl: null, sourceProof: createScreenshotSourceProof("signup_form", period, { scope: "all_forms" }), image: png }))
      .rejects.toMatchObject({ code: "SCREENSHOT_SHA256_MISMATCH", status: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not return success when the canonical draft cannot be reloaded after upload acknowledgement", async () => {
    const sha256 = await hash(png);
    const report = makeDraft("signup_form", sha256);
    const acknowledgement = { reportId, screenshotType: "signup_form", screenshotRecordId: screenshotId, approvalStatus: "approved", sha256, sourceProofAccepted: true, report };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(acknowledgement), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "REPORT_NOT_FOUND", message: "missing" }), { status: 404 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    await expect(api.uploadScreenshotImage(reportId, "signup_form", { expectedVersion: 1, periodConfirmed: true, sourceUrl: null, sourceProof: createScreenshotSourceProof("signup_form", period, { scope: "all_forms" }), image: png }))
      .rejects.toMatchObject({ code: "CANONICAL_DRAFT_RELOAD_FAILED", status: 404 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("loads only the pending image matching the report, section, and saved hash", async () => {
    const sha256 = await hash(png);
    const imageFetch = vi.fn().mockResolvedValue(new Response(png, { status: 200, headers: {
      "content-type": "image/png", "x-report-id": reportId, "x-screenshot-type": "signup_form", "x-screenshot-sha256": sha256,
    } }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch: imageFetch });
    await expect(api.getPendingImportedScreenshotImage(reportId, "signup_form", sha256)).resolves.toMatchObject({ type: "image/png", size: png.size });
    expect(imageFetch.mock.calls[0]?.[0]).toBe(`${localApiBaseUrl}/api/v1/dev/report-drafts/${reportId}/screenshots/signup_form/pending-image`);
    const mismatched = createApiClient({ baseUrl: localApiBaseUrl, fetch: vi.fn().mockResolvedValue(new Response(png, { status: 200, headers: {
      "content-type": "image/png", "x-report-id": "other", "x-screenshot-type": "signup_form", "x-screenshot-sha256": sha256,
    } })) });
    await expect(mismatched.getPendingImportedScreenshotImage(reportId, "signup_form", sha256)).rejects.toMatchObject({ code: "IMPORTED_REVIEW_IMAGE_ACK_MISMATCH" });
  });

  it("approves imported evidence only after acknowledgement and canonical reload", async () => {
    const sha256 = await hash(png);
    const pending = makeDraft("signup_form", sha256);
    pending.version = 2;
    pending.screenshots[0] = { ...pending.screenshots[0]!, approved: false, approvedAt: null, captureOrigin: "live_acceptance_import" };
    const reviewed = structuredClone(pending);
    reviewed.version = 3;
    reviewed.screenshots[0] = { ...reviewed.screenshots[0]!, approved: true, approvedAt: "2026-10-09T02:00:00.000Z" };
    const acknowledgement = { reportId, screenshotType: "signup_form", screenshotRecordId: screenshotId, approvalStatus: "approved", sha256, sourceProofAccepted: true, report: reviewed };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(acknowledgement), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(reviewed), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    const canonical = await api.approveImportedScreenshot(reportId, "signup_form", { expectedVersion: 2, expectedSha256: sha256 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${localApiBaseUrl}/api/v1/dev/report-drafts/${reportId}/screenshots/signup_form/review`);
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ expectedVersion: 2, expectedSha256: sha256 });
    expect(fetch.mock.calls[1]?.[0]).toBe(`${localApiBaseUrl}/api/v1/report-drafts/${reportId}`);
    expect(canonical.screenshots[0]).toMatchObject({ approved: true, captureOrigin: "live_acceptance_import", sha256 });
  });

  it("generates and reloads only a development review PDF bound to the canonical report", async () => {
    const generated = {
      status: "DEVELOPMENT_PARTIAL_REVIEW_READY", developmentOnly: true, finalClientArtifact: false, canonicalReportId: reportId,
      reportLifecycle: { persisted: true, status: "draft", version: 2, transitionedToGenerated: false },
      pdf: { path: "/local-only/not-consumed-by-extension.pdf", byteSize: 12345, sha256: "a".repeat(64), physicalPageCount: 7 },
    };
    const status = { reportId, reportVersion: 2, fileName: "AutoLEDTech-2026-08-Performance-Review.pdf", byteSize: 12345, sha256: "a".repeat(64), physicalPageCount: 7, developmentOnly: true };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(generated), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(status), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    await expect(api.generateDevelopmentReviewPdf(reportId, 2)).resolves.toMatchObject({ reportId, reportVersion: 2, developmentOnly: true });
    await expect(api.getDevelopmentReviewPdfStatus(reportId, 2)).resolves.toMatchObject(status);
    expect(fetch.mock.calls[0]?.[0]).toBe(`${localApiBaseUrl}/api/v1/dev/report-drafts/${reportId}/partial-review`);
    expect((fetch.mock.calls[0]?.[1] as RequestInit).method).toBe("POST");
    expect(fetch.mock.calls[1]?.[0]).toBe(`${localApiBaseUrl}/api/v1/dev/report-drafts/${reportId}/partial-review/status`);
    expect(api.developmentReviewPdfUrl(reportId)).toBe(`${localApiBaseUrl}/api/v1/dev/report-drafts/${reportId}/partial-review/pdf`);
    expect(api.developmentReviewPdfUrl(reportId, true)).toBe(`${localApiBaseUrl}/api/v1/dev/report-drafts/${reportId}/partial-review/pdf?download=1`);
  });

  it("rejects development review PDF acknowledgements that are final, stale, malformed, or for another report", async () => {
    const base = { reportId, reportVersion: 2, fileName: "AutoLEDTech-2026-08-Performance-Review.pdf", byteSize: 123, sha256: "b".repeat(64), physicalPageCount: 7, developmentOnly: true };
    for (const bad of [
      { ...base, reportId: "another-report" },
      { ...base, developmentOnly: false },
      { ...base, reportVersion: 1 },
      { ...base, sha256: "bad" },
    ]) {
      const api = createApiClient({ baseUrl: localApiBaseUrl, fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify(bad), { status: 200 })) });
      await expect(api.getDevelopmentReviewPdfStatus(reportId, 2)).rejects.toMatchObject({ code: "PARTIAL_REVIEW_ACK_INVALID", status: 200 });
    }
  });

  it("persists local automatic-run state and verifies each backend acknowledgement", async () => {
    const runId = "d5b98faf-955e-4474-8c8c-7c8a9a2f83a5";
    const sha256 = await hash(png);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId, reportId, clientId: "autoledtech", status: "running" }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId, section: "top_campaigns", status: "running", attemptNumber: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId, section: "top_campaigns", kind: "capture", byteSize: png.size, sha256 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ runId, status: "completed", durationMs: 12 }), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    await api.startLocalAutomaticCaptureRun({ runId, reportId, clientId: "autoledtech", reportMonth: { year: 2026, month: 8 }, startedAt: "2026-10-09T12:00:00.000Z" });
    await api.saveLocalAutomaticCaptureSection(runId, "top_campaigns", { status: "running", attemptNumber: 1, startedAt: "2026-10-09T12:00:00.000Z", finishedAt: null, durationMs: null, expectedUrl: "https://www.klaviyo.com/analytics/dashboards/example", observedUrl: null, expectedSourceIdentity: "business-review|campaign-performance|top-performing", observedSourceIdentity: null, expectedPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" }, observedPeriod: null, expectedSemanticCard: "Campaign Performance Summary", expectedView: "Top performing messages", visibleControls: [], usableRowCount: null, screenshotResult: "pending", sourceProofResult: "pending", sha256: null, errorCode: null, errorMessage: null, diagnostics: null });
    await expect(api.saveLocalAutomaticCaptureEvidence(runId, "top_campaigns", "capture", png, 1)).resolves.toEqual({ sha256, byteSize: png.size });
    await api.finishLocalAutomaticCaptureRun(runId, { status: "completed", finishedAt: "2026-10-09T12:00:01.000Z", durationMs: 12 });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${localApiBaseUrl}/api/v1/dev/automatic-capture-runs`,
      `${localApiBaseUrl}/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns`,
      `${localApiBaseUrl}/api/v1/dev/automatic-capture-runs/${runId}/sections/top_campaigns/evidence/capture?attempt=1`,
      `${localApiBaseUrl}/api/v1/dev/automatic-capture-runs/${runId}/finish`,
    ]);
    expect((fetch.mock.calls[2]?.[1] as RequestInit).body).toBe(png);
  });

  it("imports the completed run only after a canonical report reload confirms all nine pending records", async () => {
    const runId = "f0e9f891-8365-455f-adc8-46d74d6c5b2f";
    const types: ScreenshotType[] = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"];
    const base = makeDraft("signup_form", "a".repeat(64));
    const canonical = { ...base, version: 3, sections: { executive_summary: "required" as const }, screenshots: types.map((type, index) => ({
      ...base.screenshots[0]!, id: `0e529e6d-0ebf-4a28-a87f-02a47cc0b7${String(index).padStart(2, "0")}`, type,
      approved: false, approvedAt: null, captureOrigin: "live_acceptance_import" as const, sha256: String(index + 1).repeat(64),
    })) };
    const summary = { runId, reportId, clientId: "autoledtech", reportMonth, reportVersion: 3, capturedCount: 9, pendingReviewCount: 9, approvedCount: 0, missingAutomaticCount: 0,
      captures: canonical.screenshots.map((shot) => ({ type: shot.type, screenshotRecordId: shot.id, sha256: shot.sha256, reviewStatus: "pending_review", captureOrigin: "live_acceptance_import" })) };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(canonical), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    const result = await api.importLocalAutomaticCaptureRun(runId, canonical);
    expect(result.id).toBe(reportId);
    expect(result.screenshots).toHaveLength(9);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${localApiBaseUrl}/api/v1/dev/automatic-capture-runs/${runId}/import`,
      `${localApiBaseUrl}/api/v1/report-drafts/${reportId}`,
    ]);
  });

  it.each([
    ["accepts any configured client and month", { client: { id: "acme-home", name: "Acme Home", timezone: "Europe/London", currency: null }, reportMonth: { year: 2027, month: 1 } }, null],
    ["rejects an import bound to another client", { client: { id: "acme-home", name: "Acme Home", timezone: "Europe/London", currency: null }, reportMonth: { year: 2027, month: 1 } }, { clientId: "other-client" }],
  ] as const)("local automatic-run import %s without client-specific rules", async (_case, identity, summaryOverride) => {
    const runId = "a1e9f891-8365-455f-adc8-46d74d6c5b2f";
    const types: ScreenshotType[] = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"];
    const base = makeDraft("signup_form", "a".repeat(64));
    const canonical = { ...base, ...identity, version: 3, sections: { executive_summary: "required" as const }, screenshots: types.map((type, index) => ({
      ...base.screenshots[0]!, clientId: identity.client.id, reportMonth: identity.reportMonth, id: `1e529e6d-0ebf-4a28-a87f-02a47cc0b7${String(index).padStart(2, "0")}`, type,
      approved: false, approvedAt: null, captureOrigin: "live_acceptance_import" as const, sha256: String(index + 1).repeat(64),
    })) };
    const summary = { runId, reportId, clientId: identity.client.id, reportMonth: identity.reportMonth, reportVersion: 3, capturedCount: 9, pendingReviewCount: 9, approvedCount: 0, missingAutomaticCount: 0,
      captures: canonical.screenshots.map((shot) => ({ type: shot.type, screenshotRecordId: shot.id, sha256: shot.sha256, reviewStatus: "pending_review", captureOrigin: "live_acceptance_import" })), ...(summaryOverride ?? {}) };
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(canonical), { status: 200 }));
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch });
    if (summaryOverride) await expect(api.importLocalAutomaticCaptureRun(runId, canonical)).rejects.toMatchObject({ code: "AUTOMATIC_RUN_IMPORT_ACK_MISMATCH" });
    else expect((await api.importLocalAutomaticCaptureRun(runId, canonical)).client.id).toBe("acme-home");
  });
  it("rejects a local automatic-run response that does not bind to the requested report", async () => {
    const api = createApiClient({ baseUrl: localApiBaseUrl, fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ runId: "other", reportId, clientId: "autoledtech", status: "running" }), { status: 201 })) });
    await expect(api.startLocalAutomaticCaptureRun({ runId: "d5b98faf-955e-4474-8c8c-7c8a9a2f83a5", reportId, clientId: "autoledtech", reportMonth: { year: 2026, month: 8 }, startedAt: "2026-10-09T12:00:00.000Z" })).rejects.toMatchObject({ code: "AUTOMATIC_RUN_START_ACK_MISMATCH" });
  });

  it("does not report imported evidence approved on HTTP failure, bad acknowledgement, or unconfirmed reload", async () => {
    const sha256 = await hash(png);
    const pending = makeDraft("signup_form", sha256);
    pending.version = 2;
    pending.screenshots[0] = { ...pending.screenshots[0]!, approved: false, approvedAt: null, captureOrigin: "live_acceptance_import" };
    const reviewed = structuredClone(pending);
    reviewed.version = 3;
    reviewed.screenshots[0] = { ...reviewed.screenshots[0]!, approved: true };
    const ack = { reportId, screenshotType: "signup_form", screenshotRecordId: screenshotId, approvalStatus: "approved", sha256, sourceProofAccepted: true, report: reviewed };
    const offline = createApiClient({ baseUrl: localApiBaseUrl, fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "REPORT_VERSION_CONFLICT", message: "stale" }), { status: 409 })) });
    await expect(offline.approveImportedScreenshot(reportId, "signup_form", { expectedVersion: 2, expectedSha256: sha256 })).rejects.toMatchObject({ code: "REPORT_VERSION_CONFLICT", status: 409 });
    const noReload = createApiClient({ baseUrl: localApiBaseUrl, fetch: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(ack), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify({ error: "offline" }), { status: 503 })) });
    await expect(noReload.approveImportedScreenshot(reportId, "signup_form", { expectedVersion: 2, expectedSha256: sha256 })).rejects.toMatchObject({ code: "offline", status: 503 });
    const unconfirmed = createApiClient({ baseUrl: localApiBaseUrl, fetch: vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(ack), { status: 200 })).mockResolvedValueOnce(new Response(JSON.stringify(pending), { status: 200 })) });
    await expect(unconfirmed.approveImportedScreenshot(reportId, "signup_form", { expectedVersion: 2, expectedSha256: sha256 })).rejects.toMatchObject({ code: "IMPORTED_REVIEW_PERSISTENCE_NOT_CONFIRMED", status: 200 });
  });
});
