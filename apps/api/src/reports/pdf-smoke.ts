import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportDraft, upsertScreenshotMetadata } from "@tention/report-domain";
import { createScreenshotSourceProof, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import { LocalFilesystemPdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import { LocalFilesystemScreenshotStorage } from "../storage/screenshot-storage.js";
import { buildReportDocumentModel, renderReportHtml } from "./report-document.js";
import { PlaywrightPdfRenderer } from "./pdf-renderer.js";

const NOW = new Date("2026-09-09T12:00:00Z");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const types = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "flow_performance", "signup_form", "welcome_flow", "customer_split", "deliverability", "campaign_metrics", "flow_metrics"] as const satisfies readonly ScreenshotType[];
const sectionByType = { overview: "executive_summary", top_campaigns: "top_campaigns", top_flows: "top_flows", month_comparison: "month_comparison", campaign_performance: "campaign_performance", flow_performance: "flow_performance", signup_form: "signup_form", welcome_flow: "welcome_flow", customer_split: "customer_split", deliverability: "deliverability", campaign_metrics: "campaign_metrics", flow_metrics: "flow_metrics" } as const;
const root = await mkdtemp(join(tmpdir(), "tention-pdf-smoke-"));
const screenshots = new LocalFilesystemScreenshotStorage(join(root, "screenshots"));
const artifacts = new LocalFilesystemPdfArtifactStorage(join(root, "artifacts"));
const renderer = new PlaywrightPdfRenderer();
function smokeProof(type: ScreenshotType, period: Parameters<typeof createScreenshotSourceProof>[1]) {
  return createScreenshotSourceProof(type, period, type === "signup_form" ? { scope: "all_forms" }
    : type === "welcome_flow" ? { scope: "email_welcome_flows", entities: [{ id: "fixture-email-1", name: "Fixture Email Welcome 1", channel: "email" }, { id: "fixture-email-2", name: "Fixture Email Welcome 2", channel: "email" }] } : undefined);
}
try {
  let report: ReportDraft = createReportDraft({
    client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 7 },
    sections: Object.fromEntries(types.map((type) => [sectionByType[type], "required"])),
  }, { now: NOW });
  for (const type of types) {
    const id = crypto.randomUUID(); const storageKey = `reports/${report.id}/${type}/${id}.png`; const asset = await screenshots.put(storageKey, Buffer.concat([PNG, Buffer.from(type)]));
    report = upsertScreenshotMetadata(report, { id, clientId: report.client.id, reportMonth: report.reportMonth, type, capturedAt: NOW.toISOString(), sourceUrl: null, width: 1, height: 1, approved: true, approvedAt: NOW.toISOString(), periodConfirmed: true, storageKey, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, sourceProof: smokeProof(type, report.period) }, type, { now: NOW });
  }
  const model = await buildReportDocumentModel(report, screenshots, NOW, {
    headlineMetrics: { totalRevenue: null, emailAttributedRevenue: null, campaignRevenue: null, flowRevenue: null },
    analysisBlocks: Array.from({ length: 30 }, (_, index) => ({ heading: index === 0 ? "Approved fixture analysis" : null, paragraphs: ["Approved fixture analysis content verifies that continuation pagination has no fixed paragraph height."], source: "manual_approved" as const, approved: true })),
    nextMonthPlan: { body: "Approved fixture plan.", approved: true },
  });
  const bytes = await renderer.render(renderReportHtml(model));
  const stored = await artifacts.put(`reports/${report.id}/artifacts/${crypto.randomUUID()}.pdf`, bytes);
  const saved = await readFile(join(root, "artifacts", stored.storageKey));
  const pageCount = (saved.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? []).length;
  if (saved.subarray(0, 5).toString() !== "%PDF-" || saved.length < 1_000 || pageCount < 8) throw new Error("PDF smoke assertions failed.");
  console.log(JSON.stringify({ output: join(root, "artifacts", stored.storageKey), byteSize: saved.length, pageCount, client: report.client.name, month: "July 2026" }));
} finally { await renderer.close(); }
