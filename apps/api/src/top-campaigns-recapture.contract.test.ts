import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ApiError, createApiClient } from "@tention/api-client";
import { InMemoryReportDraftRepository, upsertScreenshotMetadata } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotRecord, type ScreenshotSourceProof, type ScreenshotType } from "@tention/report-schema";
import { buildApp } from "./app.js";
import { InMemoryScreenshotStorage } from "./storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage } from "./storage/pdf-artifact-storage.js";

/**
 * Contract between the extension's real API client and the real API for a
 * stale Top Campaigns recapture: real HTTP, real header encoding, real
 * acknowledgement and canonical-reload checks.
 */
const NOW = new Date("2026-10-27T12:00:00Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const CORE_SECTIONS = {
  executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", campaign_performance: "required",
  campaign_metrics: "required", flow_performance: "required", flow_metrics: "required", deliverability: "required",
} as const;
const OTHER_TYPES: Array<[ScreenshotType, string]> = [
  ["overview", "https://www.klaviyo.com/dashboard"], ["top_flows", "https://www.klaviyo.com/dashboard"],
  ["month_comparison", "https://www.klaviyo.com/analytics/dashboards/business-review"], ["campaign_performance", "https://www.klaviyo.com/analytics/dashboards/business-review"],
  ["campaign_metrics", "https://www.klaviyo.com/analytics/dashboards/business-review"], ["flow_performance", "https://www.klaviyo.com/analytics/dashboards/business-review"],
  ["flow_metrics", "https://www.klaviyo.com/analytics/dashboards/business-review"], ["deliverability", "https://www.klaviyo.com/analytics/deliverability/email/score"],
];
const CAMPAIGNS_URL = "https://www.klaviyo.com/omnicampaigns?appBarNav=true&startDate=2026-08-01&endDate=2026-08-31";

let app: FastifyInstance;
let repository: InMemoryReportDraftRepository;
let screenshotStorage: InMemoryScreenshotStorage;
let fetchSpy: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
let client: ReturnType<typeof createApiClient>;

beforeEach(async () => {
  repository = new InMemoryReportDraftRepository(); screenshotStorage = new InMemoryScreenshotStorage();
  app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), repository, screenshotStorage, pdfArtifactStorage: new InMemoryPdfArtifactStorage(), pdfRenderer: { render: vi.fn(), close: async () => undefined } });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  fetchSpy = vi.fn<typeof globalThis.fetch>((input, init) => globalThis.fetch(input, init));
  client = createApiClient({ baseUrl: address, fetch: fetchSpy });
});
afterEach(async () => app.close());

const png = (tag: string) => new Blob([Buffer.concat([PNG, Buffer.from(tag)])], { type: "image/png" });
const putCount = () => fetchSpy.mock.calls.filter(([, init]) => init?.method === "PUT").length;

/** Exactly what the Campaigns adapter emits: its own row key order and real campaign names. */
function adapterEvidence(sendDate = "2026-08-14") {
  const row = (name: string, type: string, placedOrderValue: number, day: string) => ({ name, status: "Sent", type, sendDate: day, openRate: "40%", clickRate: "2%", placedOrderValue });
  return {
    accountIdentity: "Account Menu Acme Home", clientTimezone: "America/New_York", visibleMetricLabel: "Conversion metric Shopify Placed Order",
    rankingMethod: "klaviyo-native-sort", eligibleRowCount: 4, includedRowCount: 4,
    rows: [row("Summer Clearance 🛋️", "Email", 9800, sendDate), row("Labor Day — Early Access", "Email", 4210.5, "2026-08-28"), row("SMS Flash", "SMS", 1050.25, "2026-08-05"), row("Old blast", "Email", 300, "2026-08-02")],
  } as unknown as NonNullable<ScreenshotSourceProof["campaigns"]>;
}

/** Nine approved core captures where Top Campaigns is the retired Business Review evidence. */
async function staleReport(): Promise<ReportDraft> {
  let draft = await client.createReportDraft({ client: { id: "acme", name: "Acme Home", timezone: "America/New_York" }, reportMonth: { year: 2026, month: 8 }, sections: CORE_SECTIONS });
  for (const [type, sourceUrl] of OTHER_TYPES) {
    draft = await client.uploadScreenshotImage(draft.id, type, { expectedVersion: draft.version, periodConfirmed: true, sourceUrl, sourceProof: createScreenshotSourceProof(type, draft.period), image: png(type) });
  }
  const storageKey = `reports/${draft.id}/top_campaigns/legacy.png`;
  const asset = await screenshotStorage.put(storageKey, Buffer.concat([PNG, Buffer.from("legacy")]));
  const legacy: ScreenshotRecord = {
    id: "29404700-f248-48b6-9c19-1f97e7e932c5", clientId: draft.client.id, reportMonth: draft.reportMonth, type: "top_campaigns",
    capturedAt: "2026-10-25T06:35:46.808Z", sourceUrl: "https://www.klaviyo.com/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1", width: 1, height: 1,
    approved: true, approvedAt: "2026-10-25T06:58:18.858Z", captureOrigin: "live_acceptance_import", periodConfirmed: true,
    storageKey, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256,
    sourceProof: { ...createScreenshotSourceProof("top_campaigns", draft.period), sourceFamily: "business-review", semanticCard: "campaign-performance", semanticTab: "top-performing", sourceIdentity: "business-review|campaign-performance|top-performing" },
  };
  return repository.save(upsertScreenshotMetadata(draft, legacy, "top_campaigns", { now: NOW }), draft.version);
}
const others = (report: ReportDraft) => report.screenshots.filter(({ type }) => type !== "top_campaigns").map(({ id, type, sha256, storageKey }) => ({ id, type, sha256, storageKey }));
const recapture = (report: ReportDraft, campaigns = adapterEvidence(), expectedVersion = report.version) => client.uploadScreenshotImage(report.id, "top_campaigns", {
  expectedVersion, periodConfirmed: true, sourceUrl: CAMPAIGNS_URL, image: png("campaigns"),
  sourceProof: createScreenshotSourceProof("top_campaigns", report.period, undefined, campaigns),
});

describe("stale Top Campaigns recapture persistence contract", () => {
  it("replaces the Business Review record with the Campaigns capture and leaves the other eight untouched", async () => {
    const stale = await staleReport();
    expect(stale.screenshots).toHaveLength(9);
    const before = others(stale);
    const canonical = await recapture(stale);

    const reloaded = await client.getReportDraft(stale.id);
    expect(reloaded).toEqual(canonical);
    expect(reloaded.version).toBeGreaterThan(stale.version);
    const record = reloaded.screenshots.find(({ type }) => type === "top_campaigns")!;
    expect(record.id).not.toBe("29404700-f248-48b6-9c19-1f97e7e932c5");
    expect(reloaded.screenshots.filter(({ type }) => type === "top_campaigns")).toHaveLength(1);
    expect(new URL(record.sourceUrl!).pathname).toBe("/omnicampaigns");
    expect(record).toMatchObject({ approved: true, periodConfirmed: true, capturedAt: NOW.toISOString(), clientId: "acme", reportMonth: { year: 2026, month: 8 } });
    expect(record.sourceProof).toMatchObject({ sourceFamily: "klaviyo-campaigns", sourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc", observedPeriod: { startDate: "2026-08-01", endDate: "2026-08-31" } });
    expect(record.sourceProof?.campaigns?.visibleMetricLabel).toMatch(/placed order/i);
    expect(record.sourceProof?.campaigns?.rows.map(({ name, placedOrderValue }) => [name, placedOrderValue])).toEqual([["Summer Clearance 🛋️", 9800], ["Labor Day — Early Access", 4210.5], ["SMS Flash", 1050.25], ["Old blast", 300]]);
    expect(record.sourceProof?.campaigns?.rows.every(({ status }) => status === "Sent")).toBe(true);
    expect(others(reloaded)).toEqual(before);
    expect(await screenshotStorage.get(stale.screenshots.find(({ type }) => type === "top_campaigns")!.storageKey!)).toBeNull();
  });

  it("rejects a raw Klaviyo send date before any request instead of reporting success", async () => {
    const stale = await staleReport(); const puts = putCount();
    await expect(recapture(stale, adapterEvidence("Aug 14, 2026 9:00 AM"))).rejects.toMatchObject({ code: "SCREENSHOT_SOURCE_PROOF_INVALID" });
    expect(putCount()).toBe(puts);
    expect(await client.getReportDraft(stale.id)).toEqual(stale);
  });

  it("surfaces a version conflict and keeps the canonical report unchanged", async () => {
    const stale = await staleReport();
    await expect(recapture(stale, adapterEvidence(), stale.version - 1)).rejects.toMatchObject({ code: "REPORT_VERSION_CONFLICT" });
    expect(await client.getReportDraft(stale.id)).toEqual(stale);
  });

  it.each([
    ["image upload", () => vi.spyOn(screenshotStorage, "put").mockRejectedValueOnce(new Error("disk full"))],
    ["metadata save", () => vi.spyOn(repository, "save").mockRejectedValueOnce(new Error("database unavailable"))],
  ])("does not report success when the %s fails", async (_stage, fail) => {
    const stale = await staleReport();
    fail();
    const error = await recapture(stale).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(await client.getReportDraft(stale.id)).toEqual(stale);
  });
});
