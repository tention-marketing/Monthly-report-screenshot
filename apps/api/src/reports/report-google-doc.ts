import { COVER_METRICS, type ReportSectionKey } from "@tention/report-schema";
import type { ReportDocumentModel, ReportDocumentSection } from "./report-document.js";

/**
 * Editable Google Doc copy of a report, rendered from the same validated ReportDocumentModel as the canonical PDF:
 * the same approved screenshots (embedded unchanged) and the same period notes. Google Drive converts this HTML into a
 * native Google Doc, so every heading and paragraph stays editable. It never derives content from screenshot pixels.
 */
export const GOOGLE_DOC_SECTION_ORDER: ReadonlyArray<{ key: ReportSectionKey; title: string }> = [
  { key: "executive_summary", title: "Executive Summary" },
  { key: "top_flows", title: "Top 5 Flows" },
  { key: "top_campaigns", title: "Top 5 Campaigns" },
  { key: "month_comparison", title: "Month Comparison" },
  { key: "campaign_performance", title: "Campaign Performance" },
  { key: "campaign_metrics", title: "Campaign Metrics" },
  { key: "flow_performance", title: "Flow Performance" },
  { key: "flow_metrics", title: "Flow Metrics" },
  { key: "deliverability", title: "Deliverability Score" },
  { key: "email_subscriber_growth", title: "Subscriber Growth" },
];

/** Google Docs' default page is 8.5in wide with 1in margins: 6.5in of content at 96 px/in. */
const DOC_CONTENT_WIDTH_PX = 624;

export function renderReportGoogleDocHtml(model: ReportDocumentModel): string {
  const sections = new Map(model.pages.flatMap((page) => page.sections).map((section) => [section.key, section] as const));
  const ordered: Array<{ title: string; section: ReportDocumentSection }> = GOOGLE_DOC_SECTION_ORDER.flatMap(({ key, title }) => {
    const section = sections.get(key);
    return section ? [{ title, section }] : [];
  });
  // Any other enabled section the report contains follows the ten core sections, so nothing approved is dropped.
  const core = new Set(GOOGLE_DOC_SECTION_ORDER.map(({ key }) => key));
  for (const section of sections.values()) if (!core.has(section.key)) ordered.push({ title: section.title, section });

  const body = ordered.map(({ title, section }, index) => {
    const height = Math.round(section.height * Math.min(1, DOC_CONTENT_WIDTH_PX / section.width));
    const width = Math.min(section.width, DOC_CONTENT_WIDTH_PX);
    return [
      `<h2>${index + 1}. ${escape(title)}</h2>`,
      section.periodNote ? `<p><i>${escape(section.periodNote)}</i></p>` : "",
      `<p><img src="${section.imageDataUrl}" width="${width}" height="${height}" alt="${escape(title)}"></p>`,
    ].join("");
  }).join("");

  const analysis = model.content.analysisBlocks.map((block) =>
    `${block.heading ? `<h3>${escape(block.heading)}</h3>` : ""}${block.paragraphs.map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}`).join("");
  const plan = model.content.nextMonthPlan ? `<h3>Next Month's Plan</h3>${model.content.nextMonthPlan.body.split(/\n{2,}/).map((paragraph) => `<p>${escape(paragraph)}</p>`).join("")}` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(model.clientName)} - ${escape(model.reportMonthLabel)}</title></head><body>`
    // Cover, as in the PDF: the report title and full period at the top right, the client name large on the left,
    // then the same verified Business performance summary values with the values in bold, as editable text.
    + `<p style="text-align:right"><b>${escape(model.coverTitle)}</b></p>`
    + `<h1>${escape(model.clientName)}</h1>`
    + (model.cover.ok ? COVER_METRICS.map(({ key, label }) => `<p>${escape(label)}: <b>${escape(model.cover.ok ? model.cover.cover.metrics[key].formatted : "")}</b></p>`).join("") : "")
    + body
    + `<h2>Notes and Recommendations</h2>${analysis}${plan}${analysis || plan ? "" : "<p>Add notes and recommendations here.</p>"}`
    + `</body></html>`;
}

function escape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
