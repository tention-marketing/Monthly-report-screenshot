import { createHash } from "node:crypto";
import type { CoverResult, ReportDraft, ReportSectionKey, ScreenshotRecord } from "@tention/report-schema";
import { COVER_METRICS, isAcceptedCapture, reportCaptureSpecByScreenshotType, reportCover, screenshotSectionMapping } from "@tention/report-schema";
import { validateReportDraft } from "@tention/report-domain";
import { REPORT_LAYOUT_V1, REPORT_LAYOUT_VERSION, type ReportLayoutPage, type ReportLayoutPageKey, type ReportLayoutSize, type ReportLayoutSlotKey } from "./report-layout.js";
import type { ScreenshotStorage } from "../storage/screenshot-storage.js";

/** The PDF template version is the canonical layout version stored with each artifact. */
export const REPORT_TEMPLATE_VERSION = REPORT_LAYOUT_VERSION;
export { REPORT_LAYOUT_V1, REPORT_LAYOUT_VERSION } from "./report-layout.js";

export type HeadlineMetricKey = "totalRevenue" | "emailAttributedRevenue" | "campaignRevenue" | "flowRevenue";
export interface ReportHeadlineMetric { amount: number; currency: string }
export type ReportHeadlineMetrics = Readonly<Record<HeadlineMetricKey, ReportHeadlineMetric | null>>;
export interface ReportAnalysisBlock { heading: string | null; paragraphs: readonly string[]; source: "authoritative_structured" | "manual_approved"; approved: boolean }
export interface ReportNextMonthPlan { body: string; approved: boolean }
export interface ReportDocumentContent { headlineMetrics: ReportHeadlineMetrics; analysisBlocks: readonly ReportAnalysisBlock[]; nextMonthPlan: ReportNextMonthPlan | null }
export interface ReportDocumentSection { key: ReportSectionKey; layoutSlotKey: ReportLayoutSlotKey; title: string; required: boolean; preferredSize: ReportLayoutSize; width: number; height: number; imageDataUrl: string; periodNote: string | null }
export interface ReportDocumentPage {
  key: Exclude<ReportLayoutPageKey, "analysis_continuation">; canonicalPage: number; title: string; sections: ReportDocumentSection[];
  headlineMetrics: ReportHeadlineMetrics | null; analysisBlocks: readonly ReportAnalysisBlock[]; nextMonthPlan: ReportNextMonthPlan | null;
}
export interface ReportDocumentModel {
  reportId: string; clientName: string; reportMonthLabel: string; reportTitle: string;
  /** Client-facing heading, from reportMonth only: "Reporting Period: September 2026". */
  reportingPeriodHeading: string;
  /** Cover title, from the report's stored period: "Performance Report — October 1–31, 2026". */
  coverTitle: string;
  /** Exact current and previous calendar-month ranges, kept for internal use; not shown in the client-facing header. */
  reportingPeriodLabel: string; previousComparisonPeriodLabel: string;
  sourceFingerprint: string; templateVersion: typeof REPORT_TEMPLATE_VERSION; layout: typeof REPORT_LAYOUT_V1; content: ReportDocumentContent; pages: ReportDocumentPage[];
  /**
   * The front cover: the report's verified Business performance summary values (DOM text of its own period-verified
   * Executive Summary capture), or why they are not verified. Final generation requires `ok`.
   */
  cover: CoverResult;
}

const headlineLabels: Readonly<Record<HeadlineMetricKey, string>> = {
  totalRevenue: "Total Revenue", emailAttributedRevenue: "Total Email Attributed Revenue", campaignRevenue: "Total Revenue from Campaign", flowRevenue: "Total Revenue from Flows",
};
const emptyHeadlineMetrics: ReportHeadlineMetrics = { totalRevenue: null, emailAttributedRevenue: null, campaignRevenue: null, flowRevenue: null };
const emptyContent: ReportDocumentContent = { headlineMetrics: emptyHeadlineMetrics, analysisBlocks: [], nextMonthPlan: null };

export class ReportDocumentError extends Error {
  constructor(public readonly code: "REPORT_RENDER_INPUT_INVALID" | "REPORT_SCREENSHOT_ASSET_MISSING", message: string) { super(message); this.name = "ReportDocumentError"; }
}

/** Builds a report from validated capture evidence plus already-approved typed content. It never derives content from screenshot pixels. */
export async function buildReportDocumentModel(report: ReportDraft, screenshotStorage: ScreenshotStorage, now = new Date(), suppliedContent: Partial<ReportDocumentContent> = emptyContent): Promise<ReportDocumentModel> {
  const validation = validateReportDraft(report, { now });
  if (validation.errors.length) throw new ReportDocumentError("REPORT_RENDER_INPUT_INVALID", "Report cannot be rendered until required approved screenshots are valid.");
  const included = new Map<ReportSectionKey, Omit<ReportDocumentSection, "layoutSlotKey" | "title" | "preferredSize">>();
  for (const screenshot of report.screenshots) {
    const section = screenshotSectionMapping[screenshot.type];
    if (report.sections[section] === "disabled" || !isRenderable(screenshot)) continue;
    const asset = await screenshotStorage.get(screenshot.storageKey);
    if (!asset || asset.sha256 !== screenshot.sha256 || asset.byteSize !== screenshot.byteSize) {
      if (report.sections[section] === "required") throw new ReportDocumentError("REPORT_SCREENSHOT_ASSET_MISSING", `Required ${section} screenshot asset is unavailable.`);
      continue;
    }
    // Rolling provider views (e.g. Deliverability Score) are not calendar-month data; say so beside the image.
    const growth = screenshot.type === "email_subscriber_growth" ? screenshot.sourceProof?.subscriberGrowth : undefined;
    const periodNote = reportCaptureSpecByScreenshotType[screenshot.type].datePolicy === "ROLLING_30_DAY"
      ? `Klaviyo rolling last-30-days view as of ${formatInstant(screenshot.capturedAt, report.client.timezone)}; not limited to ${formatMonth(report.reportMonth.year, report.reportMonth.month)}.`
      // Section 10 states its exact month and the exact counts its adapter read from the page (never from pixels).
      : growth ? `${formatRange(report.period.startDate, report.period.endDate)} · Email subscribers ${formatCount(growth.emailSubscribers)} · New subscribers ${formatCount(growth.newSubscribers)} · Exclusions ${formatCount(growth.exclusions)}`
      : null;
    included.set(section, { key: section, required: report.sections[section] === "required", width: screenshot.width, height: screenshot.height, imageDataUrl: `data:image/png;base64,${asset.bytes.toString("base64")}`, periodNote });
  }
  const content = normalizeContent(suppliedContent);
  const pages: ReportDocumentPage[] = REPORT_LAYOUT_V1.pages.filter(isRenderedLayoutPage).flatMap((layoutPage) => {
    const sections = layoutPage.slots.flatMap((slot) => {
      if (slot.contentType !== "screenshot" || !slot.sectionKey) return [];
      const section = included.get(slot.sectionKey);
      return section ? [{ ...section, layoutSlotKey: slot.key, title: slot.title, preferredSize: slot.preferredSize }] : [];
    });
    const headlineMetrics = layoutPage.slots.some(({ key }) => key === "headline_metrics") && hasHeadlineMetrics(content.headlineMetrics) ? content.headlineMetrics : null;
    const analysisBlocks = layoutPage.slots.some(({ key }) => key === "analysis") ? content.analysisBlocks : [];
    const nextMonthPlan = layoutPage.slots.some(({ key }) => key === "next_month_plan") ? content.nextMonthPlan : null;
    if (!sections.length && !headlineMetrics && !analysisBlocks.length && !nextMonthPlan) return [];
    return [{ key: layoutPage.key, canonicalPage: layoutPage.canonicalPage, title: layoutPage.title, sections, headlineMetrics, analysisBlocks, nextMonthPlan }];
  });
  const sectionFingerprint = [...included.values()].map((section) => {
    const screenshot = report.screenshots.find((value) => screenshotSectionMapping[value.type] === section.key)!;
    return { key: section.key, id: screenshot.id, sha256: screenshot.sha256, width: section.width, height: section.height, periodNote: section.periodNote };
  });
  const cover = reportCover(report);
  // headerRevision 2: the client-facing header shows "Reporting Period: <Month Year>"; coverRevision 1 adds the verified
  // front cover. Earlier artifacts are superseded; the cover values and currency are part of the fingerprint.
  const coverFingerprint = cover.ok ? { currency: cover.cover.currency, values: COVER_METRICS.map(({ key }) => cover.cover.metrics[key].amount), screenshotId: cover.cover.screenshotId } : null;
  const sourceFingerprint = fingerprint({ reportId: report.id, client: { id: report.client.id, name: report.client.name }, reportMonth: report.reportMonth, period: report.period, sections: sectionFingerprint, content, layoutVersion: REPORT_LAYOUT_VERSION, headerRevision: 2, coverRevision: 2, cover: coverFingerprint });
  const reportMonthLabel = formatMonth(report.reportMonth.year, report.reportMonth.month);
  return { reportId: report.id, clientName: report.client.name, reportMonthLabel, reportTitle: "Performance Report", reportingPeriodHeading: `Reporting Period: ${reportMonthLabel}`, coverTitle: `Performance Report — ${formatCoverRange(report.period.startDate, report.period.endDate)}`, reportingPeriodLabel: formatRange(report.period.startDate, report.period.endDate), previousComparisonPeriodLabel: formatRange(report.period.previousStartDate, report.period.previousEndDate), sourceFingerprint, templateVersion: REPORT_TEMPLATE_VERSION, layout: REPORT_LAYOUT_V1, content, pages, cover };
}

/**
 * Front cover (page 1, unnumbered): client, title, report month, then the four verified revenue values as native text.
 * No screenshot, no day-level date range, no comparison period. Unverified values are never printed as numbers.
 */
export function renderCoverHtml(model: ReportDocumentModel): string {
  const values = model.cover.ok
    ? COVER_METRICS.map(({ key, label }) => `<p class="cover-metric">${escape(label)}: <strong>${escape(model.cover.ok ? model.cover.cover.metrics[key].formatted : "")}</strong></p>`).join("")
    : COVER_METRICS.map(({ label }) => `<p class="cover-metric unverified">${escape(label)}: <strong>Not verified</strong></p>`).join("");
  return `<section class="report-page cover-page" data-cover="${model.cover.ok ? "verified" : "unverified"}"><div class="cover">`
    + `<div class="cover-top"><h1 class="cover-client">${escape(model.clientName)}</h1><p class="cover-title">${escape(model.coverTitle)}</p></div>`
    + `<div class="cover-metrics">${values}</div></div></section>`;
}

/** "October 1–31, 2026" from the stored period; a range across months or years names both ends. */
export function formatCoverRange(start: string, end: string): string {
  const part = (iso: string) => ({ month: new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`)), day: Number(iso.slice(8, 10)), year: iso.slice(0, 4) });
  const from = part(start); const to = part(end);
  if (from.year !== to.year) return `${from.month} ${from.day}, ${from.year} – ${to.month} ${to.day}, ${to.year}`;
  return from.month === to.month ? `${from.month} ${from.day}–${to.day}, ${to.year}` : `${from.month} ${from.day} – ${to.month} ${to.day}, ${to.year}`;
}

export function renderReportHtml(model: ReportDocumentModel): string {
  const context = `<div class="context"><span>${escape(model.clientName)}</span><span>${escape(model.reportMonthLabel)}</span></div>`;
  const pages = model.pages.map((page, index) => {
    const isSummary = page.key === "summary";
    const visualClass = page.sections.map(({ preferredSize }) => preferredSize).join(" ");
    return `<section class="report-page ${index === model.pages.length - 1 ? "last" : ""} page-${page.key}">
      <header>${isSummary ? `<p class="brand">${escape(model.clientName)}</p><h1>${escape(model.reportTitle)}</h1><p class="reporting-period">${escape(model.reportingPeriodHeading)}</p>` : `${context}<h1>${escape(page.title)}</h1>`}</header>
      ${page.headlineMetrics ? renderHeadlineMetrics(page.headlineMetrics) : ""}
      ${page.sections.length ? `<div class="visuals ${visualClass}">${page.sections.map(renderSection).join("")}</div>` : ""}
      ${page.analysisBlocks.length ? renderAnalysis(page.analysisBlocks) : ""}
      ${page.nextMonthPlan ? renderNextMonthPlan(page.nextMonthPlan) : ""}
      <footer>${context}<span>Page ${page.canonicalPage}</span></footer>
    </section>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(model.clientName)} ${escape(model.reportMonthLabel)} Monthly Report</title><style>${REPORT_CSS}</style></head><body data-report-layout="${REPORT_LAYOUT_VERSION}">${renderCoverHtml(model)}\n${pages}</body></html>`;
}

function renderSection(section: ReportDocumentSection): string { return `<article class="visual size-${section.preferredSize}" data-layout-slot="${section.layoutSlotKey}"><h2>${escape(section.title)}</h2><div class="image-frame"><img src="${section.imageDataUrl}" width="${section.width}" height="${section.height}" alt="${escape(section.title)} approved report screenshot" /></div>${section.periodNote ? `<p class="period-note">${escape(section.periodNote)}</p>` : ""}</article>`; }
function renderHeadlineMetrics(metrics: ReportHeadlineMetrics): string {
  const rows = (Object.keys(headlineLabels) as HeadlineMetricKey[]).flatMap((key) => { const metric = metrics[key]; return metric ? [`<article><span>${headlineLabels[key]}</span><strong>${formatCurrency(metric)}</strong></article>`] : []; });
  return rows.length ? `<section class="headline-metrics" data-layout-slot="headline_metrics">${rows.join("")}</section>` : "";
}
function renderAnalysis(blocks: readonly ReportAnalysisBlock[]): string { return `<section class="analysis" data-layout-slot="analysis"><h2>Analysis</h2>${blocks.map((block) => `<article class="analysis-block">${block.heading ? `<h3>${escape(block.heading)}</h3>` : ""}${block.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}</article>`).join("")}</section>`; }
function renderNextMonthPlan(plan: ReportNextMonthPlan): string { return `<section class="next-month-plan" data-layout-slot="next_month_plan"><h2>Next Month's Plan</h2><p>${escape(plan.body)}</p></section>`; }
function normalizeContent(content: Partial<ReportDocumentContent>): ReportDocumentContent {
  const headlineMetrics = (Object.keys(emptyHeadlineMetrics) as HeadlineMetricKey[]).reduce<MutableHeadlineMetrics>((normalized, key) => {
    const metric = content.headlineMetrics?.[key]; normalized[key] = metric && Number.isFinite(metric.amount) && /^[A-Z]{3}$/.test(metric.currency) ? { amount: metric.amount, currency: metric.currency } : null; return normalized;
  }, { ...emptyHeadlineMetrics });
  const analysisBlocks = (content.analysisBlocks ?? []).flatMap((block) => { const paragraphs = block.paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean); return block.approved && paragraphs.length ? [{ ...block, heading: block.heading?.trim() || null, paragraphs }] : []; });
  const nextMonthPlan = content.nextMonthPlan?.approved && content.nextMonthPlan.body.trim() ? { body: content.nextMonthPlan.body.trim(), approved: true } : null;
  return { headlineMetrics, analysisBlocks, nextMonthPlan };
}
type MutableHeadlineMetrics = { -readonly [Key in HeadlineMetricKey]: ReportHeadlineMetric | null };
function isRenderedLayoutPage(page: ReportLayoutPage): page is ReportLayoutPage & { key: Exclude<ReportLayoutPageKey, "analysis_continuation"> } { return page.key !== "analysis_continuation"; }
function hasHeadlineMetrics(metrics: ReportHeadlineMetrics): boolean { return Object.values(metrics).some((metric) => metric !== null); }
function isRenderable(screenshot: ScreenshotRecord): screenshot is ScreenshotRecord & { storageKey: string; sha256: string; byteSize: number } { return isAcceptedCapture(screenshot) && screenshot.periodConfirmed && screenshot.mimeType === "image/png" && Boolean(screenshot.storageKey && screenshot.sha256 && screenshot.byteSize); }
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function escape(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function formatInstant(value: string, timeZone: string): string { return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone }).format(new Date(value)); }
function formatCount(value: number): string { return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value); }
function formatMonth(year: number, month: number): string { return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1))); }
function formatRange(start: string, end: string): string { const date = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)); return `${date(start)} - ${date(end)}`; }
function formatCurrency(metric: ReportHeadlineMetric): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: metric.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(metric.amount); }

const REPORT_CSS = `@page{size:A4 landscape;margin:11mm}*{box-sizing:border-box}body{margin:0;background:#eef1ee;color:#172026;font-family:Arial,sans-serif}.report-page{display:flex;min-height:185mm;flex-direction:column;padding:10mm 12mm;background:#f7f8f6;break-after:page;page-break-after:always}.report-page.last{break-after:auto;page-break-after:auto}header{margin-bottom:4mm}.brand{margin:0 0 2mm;color:#1e6148;font-size:10pt;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.report-page h1{margin:0;color:#172026;font-size:20pt;line-height:1.1}.periods{display:flex;gap:4mm;margin-top:5mm}.periods span{min-width:62mm;padding:3mm;border-left:3px solid #1e6148;background:#fff;color:#647068;font-size:7pt;text-transform:uppercase;letter-spacing:.06em}.periods strong{display:block;margin-top:1mm;color:#172026;font-size:9pt;letter-spacing:0;text-transform:none}.cover-page{min-height:185mm}.cover{display:flex;flex-direction:column;gap:18mm;padding:6mm 4mm}.cover-top{display:flex;justify-content:space-between;align-items:flex-start;gap:12mm}.report-page h1.cover-client{margin:0;color:#172026;font-size:30pt;font-weight:800;line-height:1.1}.cover-title{margin:2mm 0 0;color:#1e6148;font-size:13pt;font-weight:700;text-align:right;white-space:nowrap}.cover-metrics{display:flex;flex-direction:column;gap:5mm}.cover-metric{margin:0;color:#3d4a42;font-size:15pt}.cover-metric strong{color:#172026;font-weight:800}.cover-metric.unverified strong{color:#9a3b2e}.reporting-period{margin:2mm 0 0;color:#5b685f;font-size:11pt;font-weight:700}.context{display:flex;justify-content:space-between;color:#5b685f;font-size:8pt;font-weight:700;text-transform:uppercase;letter-spacing:.08em}.headline-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3mm;margin:0 0 4mm}.headline-metrics article{min-width:0;padding:3mm;border-left:3px solid #1e6148;background:#fff}.headline-metrics span{display:block;color:#647068;font-size:7pt;font-weight:700;line-height:1.25;text-transform:uppercase}.headline-metrics strong{display:block;margin-top:1mm;font-size:12pt;white-space:nowrap}.visuals{display:grid;gap:4mm;align-items:stretch}.visuals.half{grid-template-columns:repeat(2,minmax(0,1fr))}.visuals.quarter{grid-template-columns:repeat(2,minmax(0,1fr))}.visuals.full{grid-template-columns:minmax(0,1fr)}.visual{min-width:0;padding:3mm;border:1px solid #dce2dd;border-radius:2mm;background:#fff;break-inside:avoid;page-break-inside:avoid}.visual h2,.analysis h2,.next-month-plan h2{margin:0 0 2mm;font-size:10pt}.image-frame{display:grid;min-height:102mm;place-items:center;border-radius:1mm;background:#f4f6f4}.size-half .image-frame{min-height:110mm}.size-quarter .image-frame{min-height:51mm}.page-summary .size-half .image-frame,.page-flows_and_comparison .size-half .image-frame,.page-campaigns_and_flows .size-half .image-frame{min-height:105mm}.image-frame img{display:block;max-width:100%;max-height:112mm;width:auto;height:auto;object-fit:contain}.size-quarter .image-frame img{max-height:54mm}.analysis{margin-top:5mm;padding:4mm;border:1px solid #dce2dd;border-radius:2mm;background:#fff}.analysis-block{break-inside:avoid;page-break-inside:avoid}.analysis-block+.analysis-block{margin-top:3mm}.analysis h3{margin:0 0 1mm;font-size:9pt}.analysis p,.next-month-plan p{margin:0 0 2mm;font-size:9pt;line-height:1.45;white-space:pre-line}.next-month-plan{margin-top:5mm;padding:4mm;border:1px solid #dce2dd;border-radius:2mm;background:#fff;break-inside:avoid;page-break-inside:avoid}footer{display:flex;justify-content:space-between;align-items:center;margin-top:auto;padding-top:5mm;color:#69746d;font-size:8pt}footer .context{gap:3mm}.period-note{margin:2mm 0 0;color:#5b685f;font-size:7.5pt;line-height:1.35}`;
