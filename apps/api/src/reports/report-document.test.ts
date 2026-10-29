import { describe, expect, it } from "vitest";
import { createReportDraft, upsertScreenshotMetadata } from "@tention/report-domain";
import { createScreenshotSourceProof, screenshotSectionMapping, type ReportDraft, type ScreenshotType, type SectionConfiguration } from "@tention/report-schema";
import { InMemoryScreenshotStorage } from "../storage/screenshot-storage.js";
import { REPORT_LAYOUT_V1 } from "./report-layout.js";
import { buildReportDocumentModel, renderReportHtml, type ReportDocumentContent } from "./report-document.js";

const now = new Date("2026-09-09T12:00:00Z");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
const allTypes = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "flow_performance", "signup_form", "welcome_flow", "customer_split", "deliverability", "campaign_metrics", "flow_metrics"] as const satisfies readonly ScreenshotType[];
const fullSections: SectionConfiguration = Object.fromEntries(allTypes.map((type) => [screenshotSectionMapping[type], "required"])) as SectionConfiguration;
const approvedContent: ReportDocumentContent = {
  headlineMetrics: { totalRevenue: { amount: 47061.15, currency: "USD" }, emailAttributedRevenue: null, campaignRevenue: { amount: 3382.57, currency: "USD" }, flowRevenue: { amount: 5076.12, currency: "USD" } },
  analysisBlocks: [{ heading: "Approved observations", paragraphs: ["Campaign performance improved against the prior month."], source: "manual_approved", approved: true }],
  nextMonthPlan: { body: "Review the approved campaign calendar.", approved: true },
};
function fixtureProof(type: ScreenshotType, period: ReportDraft["period"]) {
  return createScreenshotSourceProof(type, period, type === "signup_form" ? { scope: "all_forms" }
    : type === "welcome_flow" ? { scope: "email_welcome_flows", entities: [{ id: "fixture-email-1", name: "Fixture Email Welcome 1", channel: "email" }, { id: "fixture-email-2", name: "Fixture Email Welcome 2", channel: "email" }] } : undefined,
  type === "top_campaigns" ? { accountIdentity: "Orion", clientTimezone: "Asia/Kolkata", visibleMetricLabel: "Placed Order", rankingMethod: "complete-result-set", eligibleRowCount: 1, includedRowCount: 1, rows: [{ name: "Campaign", type: "Email", status: "Sent", sendDate: "2026-08-01", openRate: "10%", clickRate: "1%", placedOrderValue: 1 }] } : null,
  type === "email_subscriber_growth" ? { channel: "email", view: "growth", emailSubscribers: 17_698, newSubscribers: 943, exclusions: 499, changes: { emailSubscribers: null, newSubscribers: null, exclusions: null }, charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true }, visiblePeriodText: "Aug 1 – Aug 31, 2026" } : null);
}
async function fixture(types: readonly ScreenshotType[] = ["overview"], clientName = "Orion <script>", sections: SectionConfiguration = { executive_summary: "required" }, reportMonth = { year: 2026, month: 8 }) {
  const storage = new InMemoryScreenshotStorage();
  let report: ReportDraft = createReportDraft({ client: { id: "client", name: clientName, timezone: "Asia/Kolkata", currency: null }, reportMonth, sections }, { now });
  for (const type of types) {
    const id = `${type}-11111111-1111-4111-8111-111111111111`;
    const key = `reports/${report.id}/${type}/11111111-1111-4111-8111-111111111111.png`;
    const asset = await storage.put(key, Buffer.concat([png, Buffer.from(type)]));
    report = upsertScreenshotMetadata(report, { id, clientId: report.client.id, reportMonth: report.reportMonth, type, capturedAt: now.toISOString(), sourceUrl: type === "top_campaigns" ? "https://www.klaviyo.com/omnicampaigns" : type === "email_subscriber_growth" ? "https://www.klaviyo.com/configured-subscriber-growth-source" : null, width: 1440, height: 720, approved: true, approvedAt: now.toISOString(), periodConfirmed: true, storageKey: key, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256, sourceProof: fixtureProof(type, report.period) }, type, { now });
  }
  return { report, storage };
}

describe("REPORT_LAYOUT_V1", () => {
  it("freezes the supplied PDF information architecture independently from capture order", () => {
    expect(REPORT_LAYOUT_V1.version).toBe("tention-monthly-v1");
    expect(REPORT_LAYOUT_V1.pages.map(({ canonicalPage, key, slots }) => ({ canonicalPage, key, slots: slots.map((slot) => slot.key) }))).toEqual([
      { canonicalPage: 1, key: "summary", slots: ["headline_metrics", "executive_summary", "top_campaigns"] },
      { canonicalPage: 2, key: "flows_and_comparison", slots: ["top_flows", "month_comparison"] },
      { canonicalPage: 3, key: "campaigns_and_flows", slots: ["campaign_performance", "flow_performance"] },
      { canonicalPage: 4, key: "supporting_performance", slots: ["signup_form", "welcome_flow", "customer_split", "deliverability"] },
      { canonicalPage: 5, key: "campaign_metrics", slots: ["campaign_metrics"] },
      { canonicalPage: 6, key: "flow_metrics_and_analysis", slots: ["flow_metrics", "analysis"] },
      { canonicalPage: 7, key: "analysis_continuation", slots: ["analysis"] },
      { canonicalPage: 8, key: "subscriber_growth", slots: ["email_subscriber_growth"] },
    ]);
    expect(REPORT_LAYOUT_V1.pages.find(({ key }) => key === "analysis_continuation")?.pagination).toBe("flow_continuation");
  });
});

describe("ReportDocumentModel", () => {
  it.each([
    [{ year: 2026, month: 8 }, "Performance Report - August 1 - August 31, 2026", "Jul 1, 2026 - Jul 31, 2026"],
    [{ year: 2026, month: 7 }, "Performance Report - July 1 - July 31, 2026", "Jun 1, 2026 - Jun 30, 2026"],
    [{ year: 2025, month: 9 }, "Performance Report - September 1 - September 30, 2025", "Aug 1, 2025 - Aug 31, 2025"],
    [{ year: 2024, month: 2 }, "Performance Report - February 1 - February 29, 2024", "Jan 1, 2024 - Jan 31, 2024"],
  ])("renders the exact period title for %j without comparison copy", async (month, title, previousPeriod) => {
    const { report, storage } = await fixture(["overview"], "AutoLEDTech.com", { executive_summary: "required" }, month);
    const html = renderReportHtml(await buildReportDocumentModel(report, storage, now));
    const header = html.match(/<header>(.*?)<\/header>/s)?.[1] ?? "";
    expect(header).toContain(`<h1>${title}</h1>`);
    expect(header).toContain("AutoLEDTech.com");
    expect(header).not.toContain("REPORTING PERIOD");
    expect(header).not.toContain("COMPARED WITH");
    expect(header).not.toContain(previousPeriod);
  });
  it("places a complete report by REPORT_LAYOUT_V1, even when captures arrive in reverse order", async () => {
    const { report, storage } = await fixture([...allTypes].reverse(), "Orion", fullSections);
    const model = await buildReportDocumentModel(report, storage, now, approvedContent);
    expect(model.layout).toBe(REPORT_LAYOUT_V1);
    expect(model.pages.map(({ canonicalPage, key, sections }) => ({ canonicalPage, key, slots: sections.map(({ layoutSlotKey }) => layoutSlotKey) }))).toEqual([
      { canonicalPage: 1, key: "summary", slots: ["executive_summary", "top_campaigns"] },
      { canonicalPage: 2, key: "flows_and_comparison", slots: ["top_flows", "month_comparison"] },
      { canonicalPage: 3, key: "campaigns_and_flows", slots: ["campaign_performance", "flow_performance"] },
      { canonicalPage: 4, key: "supporting_performance", slots: ["signup_form", "welcome_flow", "customer_split", "deliverability"] },
      { canonicalPage: 5, key: "campaign_metrics", slots: ["campaign_metrics"] },
      { canonicalPage: 6, key: "flow_metrics_and_analysis", slots: ["flow_metrics"] },
    ]);
    const html = renderReportHtml(model);
    expect(html).toContain('data-report-layout="tention-monthly-v1"');
    expect(html).toContain("Approved observations");
    expect(html).not.toContain("Next Month&#39;s Plan");
  });
  it("renders Subscriber Growth as its own last page with the month and exact counts, leaving the nine core pages unchanged", async () => {
    const tenSections: SectionConfiguration = { ...fullSections, email_subscriber_growth: "required" };
    const { report, storage } = await fixture([...allTypes, "email_subscriber_growth"], "Club Furniture", tenSections);
    const model = await buildReportDocumentModel(report, storage, now, approvedContent);
    const nine = await fixture([...allTypes], "Club Furniture", fullSections);
    const nineModel = await buildReportDocumentModel(nine.report, nine.storage, now, approvedContent);
    expect(model.pages.slice(0, -1).map(({ key, sections }) => ({ key, slots: sections.map(({ layoutSlotKey }) => layoutSlotKey) }))).toEqual(nineModel.pages.map(({ key, sections }) => ({ key, slots: sections.map(({ layoutSlotKey }) => layoutSlotKey) })));
    const page = model.pages.at(-1)!;
    expect(page).toMatchObject({ canonicalPage: 8, key: "subscriber_growth", title: "Subscriber Growth" });
    expect(page.sections).toHaveLength(1);
    expect(page.sections[0]).toMatchObject({ key: "email_subscriber_growth", layoutSlotKey: "email_subscriber_growth", periodNote: "Aug 1, 2026 - Aug 31, 2026 · Email subscribers 17,698 · New subscribers 943 · Exclusions 499" });
    const html = renderReportHtml(model);
    expect(html).toContain('data-layout-slot="email_subscriber_growth"');
    expect(html).toContain("August 2026");
    expect(renderReportHtml(nineModel)).not.toContain("Subscriber Growth");
    expect(renderReportHtml(nineModel)).not.toContain("List Growth");
  });
  it("omits absent optional slots and pages instead of rendering blank boxes", async () => {
    const { report, storage } = await fixture(["overview", "top_campaigns", "top_flows", "month_comparison", "deliverability", "campaign_metrics", "flow_metrics"], "Orion", {
      executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", deliverability: "required", campaign_metrics: "required", flow_metrics: "required",
      signup_form: "optional", welcome_flow: "optional", customer_split: "optional",
    });
    const model = await buildReportDocumentModel(report, storage, now);
    expect(model.pages.map(({ canonicalPage }) => canonicalPage)).toEqual([1, 2, 4, 5, 6]);
    expect(model.pages.find(({ canonicalPage }) => canonicalPage === 4)?.sections.map(({ layoutSlotKey }) => layoutSlotKey)).toEqual(["deliverability"]);
    expect(renderReportHtml(model)).not.toContain('data-layout-slot="campaign_performance"');
  });
  it("keeps null headline metrics unavailable rather than replacing them with fake zeroes", async () => {
    const { report, storage } = await fixture(["overview"]);
    const model = await buildReportDocumentModel(report, storage, now, { headlineMetrics: { totalRevenue: null, emailAttributedRevenue: null, campaignRevenue: null, flowRevenue: null } });
    const html = renderReportHtml(model);
    expect(model.content.headlineMetrics).toEqual({ totalRevenue: null, emailAttributedRevenue: null, campaignRevenue: null, flowRevenue: null });
    expect(html).not.toContain('data-layout-slot="headline_metrics"');
    expect(html).not.toContain("$0.00");
  });
  it("renders only approved typed analysis and next-month-plan content", async () => {
    const { report, storage } = await fixture(["overview"]);
    const model = await buildReportDocumentModel(report, storage, now, {
      headlineMetrics: approvedContent.headlineMetrics,
      analysisBlocks: [{ heading: "Unapproved", paragraphs: ["Do not show."], source: "manual_approved", approved: false }],
      nextMonthPlan: { body: "Do not show.", approved: false },
    });
    const html = renderReportHtml(model);
    expect(html).not.toContain("Do not show.");
    expect(html).toContain("$47,061.15");
  });
  it("labels rolling 30-day evidence as not limited to the report month, and only that evidence", async () => {
    const { report, storage } = await fixture(["overview", "deliverability"]);
    const model = await buildReportDocumentModel(report, storage, now);
    const sections = model.pages.flatMap(({ sections: pageSections }) => pageSections);
    expect(sections.find(({ key }) => key === "deliverability")?.periodNote).toMatch(/rolling last-30-days view as of .+; not limited to [A-Z][a-z]+ \d{4}\.$/);
    expect(sections.find(({ key }) => key === "executive_summary")?.periodNote).toBeNull();
    expect(renderReportHtml(model).match(/class="period-note"/g)).toHaveLength(1);
  });
  it("preserves approved screenshot aspect ratios without renderer cropping", async () => {
    const { report, storage } = await fixture(["overview"]);
    const html = renderReportHtml(await buildReportDocumentModel(report, storage, now));
    expect(html).toMatch(/<img [^>]*width="1440" height="720"/);
    expect(html).toContain("object-fit:contain");
    expect(html).toContain("width:auto;height:auto");
    expect(html).not.toContain("object-fit:cover");
  });
  it("escapes HTML and changes the artifact fingerprint when a source hash changes", async () => {
    const { report, storage } = await fixture();
    const first = await buildReportDocumentModel(report, storage, now);
    const overview = report.screenshots.find(({ type }) => type === "overview")!;
    const replacement = await storage.put(overview.storageKey!, Buffer.concat([png, Buffer.from("replacement")]));
    const changed = { ...report, screenshots: report.screenshots.map((shot) => shot.type === "overview" ? { ...shot, sha256: replacement.sha256, byteSize: replacement.byteSize } : shot) };
    expect(renderReportHtml(first)).toContain("Orion &lt;script&gt;");
    expect((await buildReportDocumentModel(changed, storage, now)).sourceFingerprint).not.toBe(first.sourceFingerprint);
  });
  it("does not render when Phase A source-proof or duplicate-source validation fails", async () => {
    const { report, storage } = await fixture(["overview", "campaign_performance"], "Orion", { executive_summary: "required", campaign_performance: "optional" });
    const wrongSource = { ...report, screenshots: report.screenshots.map((shot) => ({ ...shot, sourceProof: createScreenshotSourceProof("top_campaigns", report.period) })) };
    await expect(buildReportDocumentModel(wrongSource, storage, now)).rejects.toMatchObject({ code: "REPORT_RENDER_INPUT_INVALID" });
    const overview = report.screenshots.find(({ type }) => type === "overview")!;
    const duplicate = { ...report, screenshots: report.screenshots.map((shot) => shot.type === "campaign_performance" ? { ...shot, sha256: overview.sha256, byteSize: overview.byteSize } : shot) };
    await expect(buildReportDocumentModel(duplicate, storage, now)).rejects.toMatchObject({ code: "REPORT_RENDER_INPUT_INVALID" });
  });
  it.each([
    ["overview", "executive_summary", "business-review", "growth-overview", "summary", "business-review|growth-overview|summary"],
    ["top_campaigns", "top_campaigns", "campaigns", "campaigns-list", "default", "campaigns|campaigns-list|default"],
    ["top_flows", "top_flows", "business-review", "flow-performance", "top-performing", "business-review|flow-performance|top-performing"],
  ] as const)("does not render stale old C1 %s evidence", async (type, section, sourceFamily, semanticCard, semanticTab, sourceIdentity) => {
    const { report, storage } = await fixture([type], "Orion", { [section]: "required" });
    const invalid = { ...report, screenshots: report.screenshots.map((shot) => ({ ...shot, sourceProof: { ...shot.sourceProof!, sourceFamily, semanticCard, semanticTab, sourceIdentity } })) };
    await expect(buildReportDocumentModel(invalid, storage, now)).rejects.toMatchObject({ code: "REPORT_RENDER_INPUT_INVALID" });
  });
});
