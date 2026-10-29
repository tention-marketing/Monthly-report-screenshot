import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { automaticCaptureTypesForSections, createScreenshotSourceProof, matchesReportCaptureSpec, REPORT_CAPTURE_SPEC_V1, TOP_CAMPAIGNS_LIMIT, TOP_FLOWS_LIMIT, screenshotRecordSchema, screenshotSourceProofSchema, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import { deriveClientId, ReportDomainError, ReportPersistenceError, upsertScreenshotMetadataBatch, validateReportDraft, type ReportDraftRepository } from "@tention/report-domain";
import { getReportPeriod } from "@tention/report-core";
import type { ScreenshotStorage } from "../storage/screenshot-storage.js";
import { inspectPng } from "../storage/png.js";

/** The frozen nine-section core. A report that enables Section 10 (Subscriber Growth) also requires it; see automaticCaptureTypesForSections. */
export const AUTOMATIC_RUN_CAPTURE_TYPES = ["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"] as const satisfies readonly ScreenshotType[];

export async function importCompletedAutomaticCaptureRun(options: { repository: ReportDraftRepository; screenshotStorage: ScreenshotStorage; repositoryRoot: string; runId: string; now: () => Date }) {
  if (!/^[0-9a-f-]{36}$/i.test(options.runId)) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Automatic capture run ID is invalid.");
  const directory = join(options.repositoryRoot, "output/extension-automatic-acceptance", options.runId);
  const file = join(directory, "results.json");
  const run = JSON.parse(await readFile(file, "utf8")) as Record<string, any>;
  const reportMonth = run.reportMonth;
  if (!Number.isInteger(reportMonth?.year) || !Number.isInteger(reportMonth?.month) || reportMonth.month < 1 || reportMonth.month > 12) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Automatic capture run does not identify a valid report month.");
  }
  const period = getReportPeriod(reportMonth);
  if (run.kind !== "tention_local_automatic_capture" || run.runId !== options.runId || run.status !== "completed"
    || typeof run.clientId !== "string" || typeof run.clientName !== "string" || typeof run.timezone !== "string"
    || deriveClientId(run.clientName) !== run.clientId
    || run.reportMonth?.year !== reportMonth.year || run.reportMonth?.month !== reportMonth.month
    || JSON.stringify(run.period) !== JSON.stringify(period) || !Array.isArray(run.sections)) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Automatic capture run identity, status, client, or exact calendar periods are not eligible for local import.");
  }
  const byType = new Map<string, any>();
  for (const section of run.sections) {
    if (!section || typeof section.section !== "string" || byType.has(section.section)) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Automatic run contains duplicate or malformed section results.");
    byType.set(section.section, section);
  }
  const source = await options.repository.getById(run.reportId);
  if (!source || source.client.id !== run.clientId || source.client.name !== run.clientName || source.client.timezone !== run.timezone
    || source.reportMonth.year !== reportMonth.year || source.reportMonth.month !== reportMonth.month || source.period.startDate !== period.startDate || source.period.endDate !== period.endDate
    || source.period.previousStartDate !== period.previousStartDate || source.period.previousEndDate !== period.previousEndDate || source.status !== "draft") {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", "The automatic run no longer resolves to the expected canonical client/month draft.");
  }
  // Exactly the report's own automatic sections: the nine core sections, plus Section 10 only when the report includes it.
  const automaticTypes = automaticCaptureTypesForSections(source.sections);
  const isAutomaticType = (type: ScreenshotType) => automaticTypes.includes(type);
  // A full run carries every automatic section. A resume run carries exactly its declared missing/stale sections; each
  // section it does not carry must already be valid canonical evidence for this client and month, which is kept as is.
  const resume = run.mode === "resume";
  const runTypes: ScreenshotType[] = resume ? (Array.isArray(run.plannedSections) ? run.plannedSections : []) : automaticTypes;
  if (!runTypes.length || runTypes.some((type) => !isAutomaticType(type)) || new Set(runTypes).size !== runTypes.length
    || byType.size !== runTypes.length || runTypes.some((type) => !byType.has(type))) throw new ReportDomainError("REPORT_VALIDATION_FAILED", resume ? "Resume run sections do not match its declared plan for this report." : `Automatic run does not contain exactly the ${automaticTypes.length} sections this report includes.`);
  const keptTypes = automaticTypes.filter((type) => !runTypes.includes(type));
  for (const type of keptTypes) {
    const kept = source.screenshots.filter((record) => record.type === type);
    const record = kept[0];
    if (kept.length !== 1 || !record || record.clientId !== source.client.id || record.reportMonth.year !== reportMonth.year || record.reportMonth.month !== reportMonth.month
      || !record.sha256 || !record.storageKey || !record.periodConfirmed || !matchesReportCaptureSpec(type, record.sourceProof)
      || JSON.stringify(record.sourceProof?.expectedPeriod) !== JSON.stringify(createScreenshotSourceProof(type, period).expectedPeriod)) {
      throw new ReportDomainError("REPORT_VALIDATION_FAILED", `A resume run may only skip ${type} when the report already holds its valid evidence for this client and month.`);
    }
  }
  const existingLogical = (await options.repository.list()).filter((draft) => draft.client.id === run.clientId && draft.reportMonth.year === reportMonth.year && draft.reportMonth.month === reportMonth.month);
  if (existingLogical.length !== 1 || existingLogical[0]!.id !== source.id) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Automatic run import requires exactly one matching client and report-month draft.");

  const captures: Array<{ type: ScreenshotType; bytes: Buffer; sha256: string; width: number; height: number; sourceUrl: string; sourceProof: ReturnType<typeof createScreenshotSourceProof>; capturedAt: string }> = [];
  const seenHashes = new Set<string>();
  for (const type of runTypes) {
    const result = byType.get(type)!;
    const spec = REPORT_CAPTURE_SPEC_V1.find((entry) => entry.screenshotType === type)!;
    const diagnostic = result.diagnostics;
    const proof = screenshotSourceProofSchema.parse(withUnprovenCampaignTypes(diagnostic?.sourceProof));
    const expectedPeriod = createScreenshotSourceProof(type, period).expectedPeriod;
    const expectedRecordPeriod = type === "deliverability" ? null : type === "month_comparison"
      ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate }
      : { startDate: period.startDate, endDate: period.endDate };
    // Top Flows captures min(5, usable rows) and requires at least one usable row; it never pads missing rows.
    const rowLimit = type === "top_campaigns" ? TOP_CAMPAIGNS_LIMIT : type === "top_flows" ? TOP_FLOWS_LIMIT : null;
    const expectedRows = rowLimit === null ? null : (result.usableRowCount ?? 0) >= 1 ? Math.min(rowLimit, result.usableRowCount) : rowLimit;
    if (result.status !== "pass" || result.screenshotResult !== "fresh_semantic_crop_saved" || result.sourceProofResult !== "PASS"
      || result.expectedSourceIdentity !== spec.sourceIdentity || result.observedSourceIdentity !== spec.sourceIdentity
      || typeof result.expectedUrl !== "string" || result.expectedUrl !== result.observedUrl
      || !matchesReportCaptureSpec(type, proof) || proof.sourceIdentity !== spec.sourceIdentity
      || JSON.stringify(proof.expectedPeriod) !== JSON.stringify(expectedPeriod) || JSON.stringify(proof.observedPeriod) !== JSON.stringify(expectedPeriod)
      || JSON.stringify(result.expectedPeriod) !== JSON.stringify(expectedRecordPeriod)
      || (type === "deliverability" && !/^https:\/\/www\.klaviyo\.com\/analytics\/deliverability\/email\/score\/?$/i.test(result.observedUrl ?? ""))
      || (expectedRows !== null && (diagnostic?.targetBounds?.includedRowCount !== expectedRows || (result.usableRowCount ?? 0) < expectedRows))) {
      throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${type} did not pass independent source, period, ranking, and capture proof checks.`);
    }
    if (type === "month_comparison" && (proof.expectedPeriod?.comparisonStartDate !== period.previousStartDate || proof.expectedPeriod?.comparisonEndDate !== period.previousEndDate || result.diagnostics?.observedPeriodProof?.comparisonStartDate !== period.previousStartDate || result.diagnostics?.observedPeriodProof?.comparisonEndDate !== period.previousEndDate)) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Month Comparison lacks exact current and previous calendar-month proof.");
    const evidence = result.evidenceByAttempt?.find((item: any) => item.kind === "capture" && item.attemptNumber === result.attemptNumber);
    const expectedFile = `${type}-attempt-${result.attemptNumber}-capture.png`;
    if (!evidence || evidence.file !== `sections/${expectedFile}` || !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? "")
      || evidence.sha256 !== result.sha256 || !Number.isInteger(evidence.byteSize) || evidence.byteSize <= 0) {
      throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${type} screenshot evidence acknowledgement is missing or inconsistent.`);
    }
    const bytes = await readFile(join(directory, "sections", expectedFile));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const dimensions = inspectPng(bytes);
    if (sha256 !== result.sha256 || sha256 !== evidence.sha256 || bytes.length !== evidence.byteSize || dimensions.width !== evidence.width || dimensions.height !== evidence.height) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${type} PNG bytes, recorded SHA-256, size, or dimensions do not match.`);
    if (seenHashes.has(sha256)) throw new ReportDomainError("DUPLICATE_SCREENSHOT_SOURCE", `${type} duplicates another successful automatic capture.`);
    seenHashes.add(sha256);
    const sourceUrl = result.observedUrl;
    if (typeof sourceUrl !== "string" || !sourceUrl.startsWith("https://www.klaviyo.com/")) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${type} source URL is not a verified Klaviyo reporting source.`);
    captures.push({ type, bytes, sha256, ...dimensions, sourceUrl, sourceProof: proof, capturedAt: result.finishedAt });
  }
  for (const record of source.screenshots) {
    if (runTypes.includes(record.type)) {
      const capture = captures.find((item) => item.type === record.type)!;
      // Unapproved evidence from an earlier automatic run is superseded by a newer complete run (a retake);
      // approved or manually captured evidence is never replaced.
      const supersedes = record.captureOrigin === "live_acceptance_import" && !record.approved && Date.parse(capture.capturedAt) > Date.parse(record.capturedAt);
      if (record.captureOrigin !== "live_acceptance_import" || record.approved || (record.sha256 !== capture.sha256 && !supersedes)) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `Refusing to replace existing ${record.type} report evidence with different automatic-run bytes.`);
    }
    if (record.sha256 && seenHashes.has(record.sha256) && !captures.some((capture) => capture.sha256 === record.sha256 && capture.type === record.type)) throw new ReportDomainError("DUPLICATE_SCREENSHOT_SOURCE", `${record.type} duplicates an existing report screenshot.`);
  }

  let draft = source;
  const newAssets: string[] = [];
  const newRecords = [];
  try {
    for (const capture of captures) {
      const existing = draft.screenshots.find(({ type }) => type === capture.type);
      if (existing && existing.sha256 === capture.sha256) {
        if (existing.sha256 !== capture.sha256 || existing.captureOrigin !== "live_acceptance_import") throw new ReportDomainError("REPORT_VALIDATION_FAILED", `Refusing to overwrite existing ${capture.type} evidence.`);
        const saved = existing.storageKey ? await options.screenshotStorage.get(existing.storageKey) : null;
        if (!saved || saved.sha256 !== capture.sha256 || createHash("sha256").update(saved.bytes).digest("hex") !== capture.sha256) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `Existing ${capture.type} imported evidence failed stored-byte verification.`);
        continue;
      }
      const id = randomUUID();
      const storageKey = `reports/${draft.id}/${capture.type}/${id}.png`;
      const stored = await options.screenshotStorage.put(storageKey, capture.bytes);
      newAssets.push(storageKey);
      if (stored.sha256 !== capture.sha256 || stored.byteSize !== capture.bytes.length) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${capture.type} storage acknowledgement did not match the verified diagnostic PNG.`);
      newRecords.push(screenshotRecordSchema.parse({ id, clientId: draft.client.id, reportMonth: draft.reportMonth, type: capture.type, capturedAt: capture.capturedAt, sourceUrl: capture.sourceUrl, width: capture.width, height: capture.height, approved: false, storageKey, mimeType: "image/png", byteSize: stored.byteSize, sha256: stored.sha256, captureOrigin: "live_acceptance_import", approvedAt: null, periodConfirmed: true, sourceProof: capture.sourceProof }));
    }
    if (newRecords.length) {
      const updated = upsertScreenshotMetadataBatch(draft, newRecords, { now: options.now() });
      const allowedPending = new Set(["REQUIRED_SCREENSHOT_MISSING", "REQUIRED_SCREENSHOT_UNAPPROVED"]);
      if (updated.validation.errors.some(({ code }) => !allowedPending.has(code))) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Imported automatic captures did not pass Phase A validation.");
      draft = await options.repository.save(updated, draft.version);
    }
    const byTypeAfter = new Map(draft.screenshots.map((entry) => [entry.type, entry]));
    if (runTypes.some((type) => byTypeAfter.get(type)?.sha256 !== captures.find((capture) => capture.type === type)?.sha256)
      || keptTypes.some((type) => byTypeAfter.get(type)?.sha256 !== source.screenshots.find((record) => record.type === type)?.sha256)) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `Canonical report reload did not preserve all ${automaticTypes.length} automatic capture hashes.`);
    const runWithImport = { ...run, reportId: draft.id, canonicalImport: { status: "persisted", reportId: draft.id, reportVersion: draft.version, capturedCount: automaticTypes.length, pendingReviewCount: draft.screenshots.filter((item) => isAutomaticType(item.type) && !item.approved).length, approvedCount: draft.screenshots.filter((item) => isAutomaticType(item.type) && item.approved).length, importedAt: options.now().toISOString(), captures: captures.map((capture) => ({ type: capture.type, sha256: capture.sha256, screenshotRecordId: byTypeAfter.get(capture.type)!.id })) } };
    await writeFile(file, `${JSON.stringify(runWithImport, null, 2)}\n`);
    return { runId: options.runId, reportId: draft.id, clientId: draft.client.id, reportMonth: draft.reportMonth, reportVersion: draft.version, captures: captures.map((capture) => ({ type: capture.type, screenshotRecordId: byTypeAfter.get(capture.type)!.id, sha256: capture.sha256, reviewStatus: byTypeAfter.get(capture.type)!.approved ? "approved" : "pending_review", captureOrigin: byTypeAfter.get(capture.type)!.captureOrigin })), capturedCount: automaticTypes.length, pendingReviewCount: draft.screenshots.filter((item) => isAutomaticType(item.type) && !item.approved).length, approvedCount: draft.screenshots.filter((item) => isAutomaticType(item.type) && item.approved).length, missingAutomaticCount: 0, validation: validateReportDraft(draft, { now: options.now() }) };
  } catch (error) {
    await Promise.all(newAssets.map((key) => options.screenshotStorage.delete(key).catch(() => undefined)));
    throw error;
  }
}

/**
 * Builds before the Type-column fix recorded an icon-only Type cell as "" — no channel was read. That is the
 * same fact the schema represents as null, so it is imported as null; any other value is left for the schema.
 */
function withUnprovenCampaignTypes(proof: unknown): unknown {
  const campaigns = (proof as { campaigns?: { rows?: unknown } } | null)?.campaigns;
  if (!campaigns || !Array.isArray(campaigns.rows)) return proof;
  return { ...(proof as object), campaigns: { ...campaigns, rows: campaigns.rows.map((row) => row && typeof row === "object" && (row as { type?: unknown }).type === "" ? { ...row, type: null } : row) } };
}
