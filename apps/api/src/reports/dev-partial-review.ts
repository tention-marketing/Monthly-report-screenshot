import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createReportDraft, upsertScreenshotMetadata } from "@tention/report-domain";
import { createScreenshotSourceProof, reportCaptureSpecByScreenshotType, screenshotSectionMapping, type ReportDraft, type ScreenshotType, type SectionConfiguration } from "@tention/report-schema";
import { InMemoryScreenshotStorage } from "../storage/screenshot-storage.js";
import { PlaywrightPdfRenderer } from "./pdf-renderer.js";
import { buildReportDocumentModel, renderReportHtml } from "./report-document.js";
import { REPORT_LAYOUT_V1, type ReportLayoutPage, type ReportLayoutPageKey, type ReportLayoutSlot } from "./report-layout.js";
import { rasterizePdfForQa } from "./pdf-page-qa.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const LIVE_PARTIAL_SECTION_TYPES = ["overview", "month_comparison", "top_campaigns", "top_flows", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"] as const satisfies readonly ScreenshotType[];
const expectedIdentity: Readonly<Record<typeof LIVE_PARTIAL_SECTION_TYPES[number], string>> = Object.fromEntries(
  LIVE_PARTIAL_SECTION_TYPES.map((type) => [type, reportCaptureSpecByScreenshotType[type].sourceIdentity]),
) as Record<typeof LIVE_PARTIAL_SECTION_TYPES[number], string>;

interface LiveAcceptanceResult {
  status: string;
  client: { id: string; name: string; timezone: string };
  month: { year: number; month: number };
  period: { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string };
  automatedSections: Array<{ key: string; ok: boolean; sha256?: string; byteSize?: number; usableRowCount?: number; includedRowCount?: number }>;
  pendingSections: Array<{ key: string; status: string }>;
  duplicateHashes: string[];
}
interface LiveCaptureDiagnostic {
  canonicalSourceIdentity: string;
  expectedPeriod: { startDate: string; endDate: string; comparisonStartDate?: string; comparisonEndDate?: string };
  sourceUrl: string;
  screenshot: { file: string; byteSize: number; sha256: string };
}
export interface VerifiedLiveRun {
  directory: string;
  results: LiveAcceptanceResult;
  diagnostics: Record<typeof LIVE_PARTIAL_SECTION_TYPES[number], LiveCaptureDiagnostic>;
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(`Partial review preflight failed: ${message}`); }
function pngDimensions(bytes: Buffer): { width: number; height: number } {
  assert(bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "capture is not a PNG image");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

export async function verifyLatestLiveRun(root = repositoryRoot): Promise<VerifiedLiveRun> {
  const acceptanceRoot = join(root, "output/local-acceptance");
  const candidates = (await readdir(acceptanceRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name).sort().reverse();
  let latestFailure = "No successful live acceptance run was found.";
  for (const name of candidates) {
    const directory = join(acceptanceRoot, name);
    try {
      const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8")) as LiveAcceptanceResult;
      if (results.status !== "PARTIAL_PASS_MANUAL_EVIDENCE_REQUIRED") continue;
      assert(results.client.name === "AutoLEDTech.com" && results.client.id === "autoledtech", "client is not the authorized AutoLEDTech profile");
      assert(results.month.year === 2026 && results.month.month === 8, "report month is not August 2026");
      assert(results.period.startDate === "2026-08-01" && results.period.endDate === "2026-08-31", "verified current period is not August 1-31, 2026");
      assert(results.automatedSections.length === LIVE_PARTIAL_SECTION_TYPES.length, "live run does not contain the complete supported capture set");
      assert(LIVE_PARTIAL_SECTION_TYPES.every((type) => results.automatedSections.some((result) => result.key === type && result.ok)), "one or more supported captures did not pass");
      const hashes = results.automatedSections.map(({ sha256 }) => sha256);
      assert(new Set(hashes).size === LIVE_PARTIAL_SECTION_TYPES.length && results.duplicateHashes.length === 0, "capture hashes are missing or duplicated");
      const campaigns = results.automatedSections.find(({ key }) => key === "top_campaigns")!;
      const flows = results.automatedSections.find(({ key }) => key === "top_flows")!;
      assert(campaigns.includedRowCount === 3 && (campaigns.usableRowCount ?? 0) >= 3, "Top Campaigns does not contain exactly its first three rows");
      assert((flows.usableRowCount ?? 0) >= 1 && flows.includedRowCount === Math.min(5, flows.usableRowCount ?? 0), "Top Flows does not contain exactly its first min(5, usable) rows");
      assert(results.pendingSections.every(({ key }) => key !== "month_comparison"), "Month Comparison is still pending despite exact current and previous period evidence");
      const diagnostics = {} as VerifiedLiveRun["diagnostics"];
      for (const type of LIVE_PARTIAL_SECTION_TYPES) {
        const entry = JSON.parse(await readFile(join(directory, `${type}-diagnostics.json`), "utf8")) as LiveCaptureDiagnostic;
        const result = results.automatedSections.find(({ key }) => key === type)!;
        assert(entry.canonicalSourceIdentity === expectedIdentity[type], `${type} source identity does not match REPORT_CAPTURE_SPEC_V1`);
        if (type !== "deliverability") assert(entry.expectedPeriod.startDate === results.period.startDate && entry.expectedPeriod.endDate === results.period.endDate, `${type} diagnostic period differs from the verified report month`);
        if (type === "month_comparison") assert(entry.expectedPeriod.comparisonStartDate === results.period.previousStartDate && entry.expectedPeriod.comparisonEndDate === results.period.previousEndDate, "Month Comparison diagnostic does not bind the exact immediately previous calendar month");
        assert(entry.screenshot.sha256 === result.sha256 && entry.screenshot.byteSize === result.byteSize && entry.screenshot.file === `${type}.png`, `${type} screenshot metadata differs from acceptance results`);
        const bytes = await readFile(join(directory, entry.screenshot.file));
        assert(bytes.length === entry.screenshot.byteSize && createHash("sha256").update(bytes).digest("hex") === entry.screenshot.sha256, `${type} capture file hash does not match the successful run`);
        pngDimensions(bytes);
        diagnostics[type] = entry;
      }
      const localClients = JSON.parse(await readFile(join(root, "data/local-clients.json"), "utf8")) as { clients: Array<{ name: string; overviewUrl: string; businessReviewUrl: string }> };
      const client = localClients.clients.find(({ name }) => name === "AutoLEDTech.com");
      assert(Boolean(client), "ignored local AutoLEDTech configuration is unavailable");
      for (const type of LIVE_PARTIAL_SECTION_TYPES) {
        const expectedUrl = type === "overview" ? client!.overviewUrl : client!.businessReviewUrl;
        assert(diagnostics[type].sourceUrl === expectedUrl, `${type} source URL does not match the authorized client configuration`);
      }
      return { directory, results, diagnostics };
    } catch (error) {
      latestFailure = error instanceof Error ? error.message : "Latest live acceptance artifacts could not be verified.";
    }
  }
  throw new Error(latestFailure);
}

function sectionConfigForDevelopmentPreview(): SectionConfiguration {
  const sections: SectionConfiguration = Object.fromEntries(Object.values(screenshotSectionMapping).map((key) => [key, "optional"])) as SectionConfiguration;
  for (const type of LIVE_PARTIAL_SECTION_TYPES) sections[screenshotSectionMapping[type]] = "required";
  return sections;
}

function placeholder(slot: ReportLayoutSlot): string {
  return `<article class="visual size-${slot.preferredSize} partial-review-slot" data-layout-slot="${slot.key}"><h2>${slot.title}</h2><div class="review-placeholder">Not yet captured</div></article>`;
}
function placeholderPage(page: ReportLayoutPage, slots: readonly ReportLayoutSlot[], clientName: string, monthLabel: string): string {
  const visualClass = slots.map(({ preferredSize }) => preferredSize).join(" ");
  return `<section class="report-page page-${page.key}"><div class="development-review-banner">DEVELOPMENT REVIEW — INCOMPLETE REPORT</div><header><div class="context"><span>${clientName}</span><span>${monthLabel}</span></div><h1>${page.title}</h1></header><div class="visuals ${visualClass}">${slots.map(placeholder).join("")}</div><footer><div class="context"><span>${clientName}</span><span>${monthLabel}</span></div><span>Page ${page.canonicalPage}</span></footer></section>`;
}

export function renderPartialReviewHtml(baseHtml: string, model: Awaited<ReturnType<typeof buildReportDocumentModel>>): string {
  let html = baseHtml.replace(/<\/style>/, `
    .report-page{position:relative}
    .development-review-banner{position:absolute;top:1mm;left:12mm;right:12mm;height:6mm;line-height:6mm;margin:0;padding:0;background:#8a3b12;color:#fff;font-size:8pt;font-weight:800;letter-spacing:.08em;text-align:center}
    .context{gap:3mm}
    .review-placeholder{display:grid;min-height:52mm;place-items:center;border:1px dashed #b5662b;border-radius:1mm;background:#fff8f0;color:#75320e;font-size:12pt;font-weight:700}
    .size-half .review-placeholder{min-height:105mm}
    .size-quarter .review-placeholder{min-height:51mm}
    .page-supporting_performance .visuals{grid-template-columns:repeat(2,minmax(0,1fr))}
  </style>`);
  const comparisonPage = REPORT_LAYOUT_V1.pages.find(({ key }) => key === "flows_and_comparison")!;
  const comparisonSlot = comparisonPage.slots.find(({ key }) => key === "month_comparison")!;
  const comparisonCaptured = model.pages.some((page) => page.sections.some((section) => section.layoutSlotKey === "month_comparison"));
  if (!comparisonCaptured) html = html.replace(/(<section class="report-page[^>]*page-flows_and_comparison">[\s\S]*?<div class="visuals [^"]*">[\s\S]*?<\/article>)(<\/div>)/, `$1${placeholder(comparisonSlot)}$2`);
  const presentPageKeys = new Set(model.pages.map(({ key }) => key));
  for (const pageKey of ["supporting_performance"] as const) {
    if (presentPageKeys.has(pageKey)) continue;
    const page = REPORT_LAYOUT_V1.pages.find(({ key }) => key === pageKey)!;
    const relevantSlots = page.slots.filter(({ contentType }) => contentType === "screenshot");
    const missingPage = placeholderPage(page, relevantSlots, model.clientName, model.reportMonthLabel);
    html = html.replace("</body>", `${missingPage}</body>`);
  }
  html = html.replace(/(<section class="report-page[^>]*>)(?!<div class="development-review-banner">)/g, "$1<div class=\"development-review-banner\">DEVELOPMENT REVIEW — INCOMPLETE REPORT</div>");
  const bodyStart = html.indexOf("<body");
  const bodyContentStart = html.indexOf(">", bodyStart) + 1;
  const bodyEnd = html.indexOf("</body>", bodyContentStart);
  const bodyMarkup = html.slice(bodyContentStart, bodyEnd);
  const pageBlocks = [...bodyMarkup.matchAll(/<section class="report-page[^>]*>[\s\S]*?(?=<section class="report-page[^>]*>|$)/g)].map(([block]) => block.trim());
  pageBlocks.sort((left, right) => {
    const pageNumber = (block: string) => {
      const key = /\bpage-([a-z_]+)"/.exec(block)?.[1] as ReportLayoutPageKey | undefined;
      return REPORT_LAYOUT_V1.pages.find((page) => page.key === key)?.canonicalPage ?? Number.MAX_SAFE_INTEGER;
    };
    return pageNumber(left) - pageNumber(right);
  });
  assert(bodyEnd > bodyContentStart && pageBlocks.length > 0, "development preview pages could not be ordered by REPORT_LAYOUT_V1");
  html = `${html.slice(0, bodyContentStart)}\n${pageBlocks.join("\n")}\n${html.slice(bodyEnd)}`;
  return html;
}

async function run(): Promise<void> {
  const live = await verifyLatestLiveRun();
  const reviewDirectory = resolve(repositoryRoot, "output/live-review/autoledtech/2026-08");
  await mkdir(reviewDirectory, { recursive: true });
  const assets = new InMemoryScreenshotStorage();
  const now = new Date();
  const sections = sectionConfigForDevelopmentPreview();
  let draft: ReportDraft = createReportDraft({ client: { id: "autoledtech", name: "AutoLEDTech.com", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, sections }, { now });
  const capturedAt = (await stat(join(live.directory, "results.json"))).mtime.toISOString();
  for (const type of LIVE_PARTIAL_SECTION_TYPES) {
    const diagnostic = live.diagnostics[type];
    const bytes = await readFile(join(live.directory, diagnostic.screenshot.file));
    const dimensions = pngDimensions(bytes);
    const id = randomUUID();
    const storageKey = `reports/${draft.id}/${type}/${id}.png`;
    const asset = await assets.put(storageKey, bytes);
    draft = upsertScreenshotMetadata(draft, {
      id, clientId: draft.client.id, reportMonth: draft.reportMonth, type,
      capturedAt, sourceUrl: diagnostic.sourceUrl, ...dimensions,
      approved: true, approvedAt: now.toISOString(), periodConfirmed: true,
      storageKey, mimeType: "image/png", byteSize: asset.byteSize, sha256: asset.sha256,
      sourceProof: createScreenshotSourceProof(type, draft.period),
    }, type, { now });
  }
  assert(draft.status === "draft", "development review preparation must not change report lifecycle");
  assert(draft.validation.errors.length === 0, "available captures do not pass existing source-proof validation");
  const model = await buildReportDocumentModel(draft, assets, now);
  assert(Object.values(model.content.headlineMetrics).every((value) => value === null), "unresolved headline metrics must remain null");
  const html = renderPartialReviewHtml(renderReportHtml(model), model);
  const watermarkCount = html.match(/DEVELOPMENT REVIEW — INCOMPLETE REPORT/g)?.length ?? 0;
  const documentPageCount = html.match(/<section class="report-page/g)?.length ?? 0;
  assert(watermarkCount === documentPageCount && documentPageCount > 0, "every development review page must carry its incomplete-report mark");
  assert(!html.includes("$0.00"), "partial review must not invent zero-valued financial metrics");
  const renderer = new PlaywrightPdfRenderer();
  try {
    const pdfPath = join(reviewDirectory, "AutoLEDTech-2026-08-PARTIAL-REVIEW.pdf");
    const pdf = await renderer.render(html);
    await writeFile(join(reviewDirectory, "review-render.html"), html);
    await writeFile(pdfPath, pdf);
    const pageQa = await rasterizePdfForQa(pdfPath, reviewDirectory);
    assert(pageQa.pageCount === documentPageCount, "physical PDF page count differs from the rendered REPORT_LAYOUT_V1 page set");
    assert(pageQa.blankPages.length === 0, "partial review PDF contains an entirely blank page");
    const results = {
      status: "DEVELOPMENT_PARTIAL_REVIEW_READY",
      developmentOnly: true,
      finalClientArtifact: false,
      reportLifecycle: { persisted: false, status: draft.status, transitionedToGenerated: false },
      sourceAcceptance: { directory: live.directory, client: live.results.client, period: { startDate: live.results.period.startDate, endDate: live.results.period.endDate }, verifiedCaptureTypes: LIVE_PARTIAL_SECTION_TYPES, hashesDistinct: true, topCampaignRows: 3, topFlowRows: 5 },
      pdf: { path: pdfPath, byteSize: pdf.byteLength, sha256: createHash("sha256").update(pdf).digest("hex"), templateVersion: model.templateVersion, layoutVersion: model.layout.version, physicalPageCount: pageQa.pageCount, pageQa },
      canonicalPageSequence: [1, 2, 3, 4, 5, 6, 8],
      includedSections: LIVE_PARTIAL_SECTION_TYPES,
      missingSections: live.results.pendingSections.map((section) => section.key === "month_comparison" ? {
        ...section,
        reason: "Klaviyo can display both exact ranges through its Custom comparison-period control, but the isolated live probe did not render comparison data content suitable for semantic capture. Manual capture remains review-gated.",
      } : section),
      headlineMetrics: model.content.headlineMetrics,
      approvedAnalysisBlocks: model.content.analysisBlocks.length,
      notes: ["This local, non-persisted development preview uses only the verified live acceptance PNGs.", "Absent sections appear only as Not yet captured placeholders and are not marked complete.", "The report remained in draft state; no production generation endpoint or lifecycle transition was invoked.", "Financial headline metrics remain null because authoritative structured values were not supplied."],
    };
    await writeFile(join(reviewDirectory, "review-results.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(JSON.stringify(results, null, 2));
  } finally {
    await renderer.close();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (invokedPath === import.meta.url) void run().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
