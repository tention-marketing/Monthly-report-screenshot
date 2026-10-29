import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReportDomainError, validateReportDraft, type ReportDraftRepository } from "@tention/report-domain";
import { automaticCaptureTypesForSections, createScreenshotSourceProof, matchesReportCaptureSpec, reportCaptureSpecByScreenshotType, screenshotSectionMapping, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import type { ScreenshotStorage } from "../storage/screenshot-storage.js";
import type { PdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import type { PdfRenderer } from "./pdf-renderer.js";
import { rasterizePdfForQa } from "./pdf-page-qa.js";
import { buildReportDocumentModel, renderReportHtml } from "./report-document.js";
import { renderPartialReviewHtml } from "./dev-partial-review.js";
import { inspectPng } from "../storage/png.js";

const CORE_REVIEW_BANNER = "DEVELOPMENT REVIEW — 9 CORE SECTIONS VERIFIED";
const SUBSCRIBER_GROWTH_REVIEW_BANNER = "DEVELOPMENT REVIEW — 9 CORE SECTIONS + SUBSCRIBER GROWTH VERIFIED";
const FINAL_ONLY_TYPES: readonly ScreenshotType[] = ["signup_form", "welcome_flow", "customer_split"];

/** Renders a dev-only PDF from the persisted canonical draft without mutating its review lifecycle. */
export async function renderCanonicalPartialReview(options: {
  repository: ReportDraftRepository;
  screenshotStorage: ScreenshotStorage;
  pdfArtifactStorage: PdfArtifactStorage;
  pdfRenderer: PdfRenderer;
  repositoryRoot: string;
  reportId: string;
  now?: Date;
}) {
  const draft = await options.repository.getById(options.reportId);
  if (!draft) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Canonical report draft was not found.");
  assert(draft.status === "draft", "development review rendering requires the unchanged draft lifecycle state");
  // The nine core sections, plus Section 10 only when this report includes it.
  const AUTOMATIC_TYPES: readonly ScreenshotType[] = automaticCaptureTypesForSections(draft.sections);
  const REVIEW_BANNER = AUTOMATIC_TYPES.includes("email_subscriber_growth") ? SUBSCRIBER_GROWTH_REVIEW_BANNER : CORE_REVIEW_BANNER;

  const captures = draft.screenshots.filter((record) => AUTOMATIC_TYPES.includes(record.type));
  assert(captures.length === AUTOMATIC_TYPES.length && AUTOMATIC_TYPES.every((type) => captures.filter((record) => record.type === type).length === 1), "canonical report does not contain exactly one of each supported automatic capture");
  assert(new Set(captures.map(({ sha256 }) => sha256)).size === captures.length, "canonical report contains duplicate automatic screenshot hashes");
  assert(captures.every(({ approved, approvedAt, captureOrigin }) => captureOrigin === "extension_manual" || captureOrigin === "live_acceptance_import") && captures.every(({ approved, approvedAt, captureOrigin }) => approved ? Boolean(approvedAt) : captureOrigin === "live_acceptance_import" && approvedAt === null), "automatic screenshot review state is invalid; only pending imported evidence may use a development-only review override");
  for (const record of captures) {
    const spec = reportCaptureSpecByScreenshotType[record.type];
    const proof = record.sourceProof;
    const expected = createScreenshotSourceProof(record.type, draft.period).expectedPeriod;
    const asset = record.storageKey ? await options.screenshotStorage.get(record.storageKey) : null;
    assert(Boolean(spec && proof && matchesReportCaptureSpec(record.type, proof) && proof.sourceIdentity === spec.sourceIdentity), `${record.type} canonical source proof is invalid`);
    assert(JSON.stringify(proof!.expectedPeriod) === JSON.stringify(expected) && JSON.stringify(proof!.observedPeriod) === JSON.stringify(expected), `${record.type} period proof is stale`);
    assert(record.clientId === draft.client.id && record.reportMonth.year === draft.reportMonth.year && record.reportMonth.month === draft.reportMonth.month, `${record.type} client/month metadata does not match the report`);
    assert(Boolean(asset && record.sha256 && asset.sha256 === record.sha256 && createHash("sha256").update(asset.bytes).digest("hex") === record.sha256 && asset.byteSize === record.byteSize), `${record.type} stored screenshot hash is invalid`);
    assert(JSON.stringify(inspectPng(asset!.bytes)) === JSON.stringify({ width: record.width, height: record.height }), `${record.type} screenshot dimensions are invalid`);
  }
  const runDiagnostic = await readRunImportDiagnostic(options.repositoryRoot, captures.filter(({ captureOrigin }) => captureOrigin === "live_acceptance_import"));

  // The ordinary renderer must reject unapproved evidence. Only this isolated render copy
  // marks imports renderable; nothing is written back to the report repository.
  const sections = { ...draft.sections, ...Object.fromEntries(FINAL_ONLY_TYPES.map((type) => [screenshotSectionMapping[type], "optional" as const])) };
  const renderDraft: ReportDraft = {
    ...draft,
    sections,
    screenshots: draft.screenshots.map((record) => AUTOMATIC_TYPES.includes(record.type) && record.captureOrigin === "live_acceptance_import" && !record.approved
      ? { ...record, approved: true, approvedAt: record.capturedAt }
      : record),
  };
  renderDraft.validation = validateReportDraft(renderDraft, { now: options.now ?? new Date() });
  if (renderDraft.validation.errors.length) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Canonical imported evidence did not pass source, period, stale, or duplicate Phase A checks for the development preview.", renderDraft.validation);

  const model = await buildReportDocumentModel(renderDraft, options.screenshotStorage, options.now ?? new Date());
  assert(Object.values(model.content.headlineMetrics).every((value) => value === null), "unresolved authoritative financial metrics must remain null");
  let html = renderPartialReviewHtml(renderReportHtml(model), model)
    .replaceAll("DEVELOPMENT REVIEW — INCOMPLETE REPORT", REVIEW_BANNER)
    .replaceAll("approved report screenshot", "unapproved live acceptance evidence shown for development review only");
  assert(html.includes(REVIEW_BANNER), "development-only imported-evidence warning is missing");
  assert(!html.includes("$0.00"), "development preview must not introduce fake financial zeros");

  const clientSlug = safePathSegment(draft.client.id);
  const monthSlug = `${draft.reportMonth.year}-${String(draft.reportMonth.month).padStart(2, "0")}`;
  const outputDirectory = join(options.repositoryRoot, "output/live-review", clientSlug, monthSlug);
  await mkdir(outputDirectory, { recursive: true });
  const pdfPath = join(outputDirectory, `${safeFileLabel(draft.client.name)}-${monthSlug}-PARTIAL-REVIEW.pdf`);
  const htmlSha256 = createHash("sha256").update(html).digest("hex");
  const storageKey = `reports/${draft.id}/artifacts/${uuidFromFingerprint(htmlSha256)}.pdf`;
  const cachedArtifact = await options.pdfArtifactStorage.get(storageKey);
  const pdf = cachedArtifact?.bytes ?? await options.pdfRenderer.render(html);
  const storedArtifact = cachedArtifact ?? await options.pdfArtifactStorage.put(storageKey, pdf);
  assert(storedArtifact.byteSize === pdf.byteLength && storedArtifact.sha256 === createHash("sha256").update(pdf).digest("hex"), "development review PDF storage acknowledgement did not match the rendered bytes");
  await writeFile(join(outputDirectory, "review-render.html"), html);
  await writeFile(pdfPath, pdf);
  const pageQa = await rasterizePdfForQa(pdfPath, outputDirectory);
  const documentPageCount = (html.match(/<section class="report-page/g) ?? []).length;
  assert(pageQa.pageCount === documentPageCount, "physical page count differs from the rendered REPORT_LAYOUT_V1 page set");
  assert(pageQa.blankPages.length === 0, "development preview contains a blank physical PDF page");

  const pendingReviewCount = captures.filter(({ approved }) => !approved).length;
  const missingSections = FINAL_ONLY_TYPES.filter((type) => !draft.screenshots.some((record) => record.type === type));
  const result = {
    status: "DEVELOPMENT_PARTIAL_REVIEW_READY" as const,
    developmentOnly: true,
    finalClientArtifact: false,
    reportId: draft.id, clientId: draft.client.id, clientName: draft.client.name, reportMonth: draft.reportMonth,
    reportLifecycle: { persisted: true, status: draft.status, version: draft.version, transitionedToGenerated: false },
    captureReview: { automaticCaptureCount: captures.length, pendingReviewCount, approvedCount: captures.length - pendingReviewCount, previewOnlyApprovalOverride: captures.some(({ captureOrigin, approved }) => captureOrigin === "live_acceptance_import" && !approved) },
    sourceAcceptance: { directory: runDiagnostic?.directory ?? null, runId: runDiagnostic?.runId ?? null, verifiedCaptureTypes: captures.map(({ type }) => type), hashesDistinct: true, topCampaignRows: 3, topFlowRows: 5 },
    pdf: { path: pdfPath, fileName: `${safeFileLabel(draft.client.name)}-${monthSlug}-Performance-Review.pdf`, storageKey, sourceFingerprint: model.sourceFingerprint, htmlSha256, byteSize: pdf.byteLength, sha256: storedArtifact.sha256, templateVersion: model.templateVersion, layoutVersion: model.layout.version, physicalPageCount: pageQa.pageCount, pageQa },
    includedSections: captures.map(({ type }) => type),
    missingSections,
    headlineMetrics: model.content.headlineMetrics,
    notes: ["Rendered from this client's canonical persisted report draft and normal screenshot storage.", "Pending live-acceptance imports are made renderable only in an ephemeral preview copy; persisted records remain unapproved and the report remains draft.", "This local development-only artifact does not change report lifecycle; normal production preview/final-generation gates are unchanged.", "Missing final-only sections are not fabricated; unresolved financial headline metrics remain null."],
  };
  await writeFile(join(outputDirectory, "review-results.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function safePathSegment(value: string): string {
  const safe = value.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!safe) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Client identity cannot form a safe development artifact path.");
  return safe;
}
function safeFileLabel(value: string): string {
  const withoutDomainSuffix = value.replace(/\.com$/i, "");
  const safe = withoutDomainSuffix.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!safe) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Client name cannot form a safe development artifact filename.");
  return safe;
}

async function readRunImportDiagnostic(root: string, records: ReportDraft["screenshots"]) {
  const candidates = await readdir(join(root, "output/extension-automatic-acceptance"), { withFileTypes: true }).catch(() => []);
  for (const candidate of candidates.filter((entry) => entry.isDirectory()).reverse()) {
    try {
      const directory = join(root, "output/extension-automatic-acceptance", candidate.name);
      const run = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
      if (run.canonicalImport?.captures?.length === records.length && run.canonicalImport.captures.every((capture: { type: string; sha256: string }) => records.some((record) => record.type === capture.type && record.sha256 === capture.sha256))) return { directory, runId: run.runId };
    } catch { /* ignore incomplete diagnostic folders */ }
  }
  return null;
}

function uuidFromFingerprint(fingerprint: string): string {
  const value = fingerprint.slice(0, 32);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ReportDomainError("REPORT_VALIDATION_FAILED", message);
}
