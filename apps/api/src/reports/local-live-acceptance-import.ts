import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
  createReportDraft, deriveClientId, replacementInvalidatesCaptureReview, replaceScreenshotAndInvalidateCaptureReview, ReportDomainError, ReportPersistenceError,
  upsertScreenshotMetadataBatch, validateReportDraft, type ClientReportTargetsRepository, type ReportDraftRepository,
} from "@tention/report-domain";
import {
  clientReportTargetsInputSchema, REPORT_CAPTURE_SPEC_V1,
  matchesReportCaptureSpec, screenshotRecordSchema, screenshotSectionMapping, type ReportStatus, type ScreenshotType, type SectionConfiguration,
} from "@tention/report-schema";
import { readLocalClient, verifyLatestLiveAcceptanceRun } from "./live-acceptance-artifacts.js";
import type { ScreenshotStorage } from "../storage/screenshot-storage.js";
import { inspectPng } from "../storage/png.js";


export interface LocalLiveAcceptanceImportOptions {
  repository: ReportDraftRepository;
  targetsRepository: ClientReportTargetsRepository;
  screenshotStorage: ScreenshotStorage;
  repositoryRoot: string;
  now: () => Date;
  clientId: string;
  reportMonth: { year: number; month: number };
}

export interface LocalLiveAcceptanceImportResult {
  reportId: string;
  clientId: string;
  reportMonth: { year: number; month: number };
  importedCaptureCount: number;
  pendingReviewCount: number;
  reusedCaptureCount: number;
  storageVerifiedCount: number;
  sourceProofVerifiedCount: number;
  distinctSha256Count: number;
  importedTypes: string[];
  missingTypes: string[];
  validation: ReturnType<typeof validateReportDraft>;
}

export async function importLatestLiveAcceptance(options: LocalLiveAcceptanceImportOptions): Promise<LocalLiveAcceptanceImportResult> {
  const { clientId, reportMonth, repositoryRoot, now } = options;
  const live = await verifyLatestLiveAcceptanceRun(repositoryRoot, clientId, reportMonth);
  return importVerifiedLiveAcceptance(options, live);
}

/** Imports just a newly captured Score card without touching the other eight
 * verified capture records. The replacement still enters pending review. */
export async function importLatestLiveDeliverabilityScore(options: LocalLiveAcceptanceImportOptions): Promise<LocalLiveAcceptanceImportResult> {
  return importLatestLiveSection(options, "deliverability");
}

/** Imports one recaptured section without touching the other verified capture
 * records. The replacement enters pending review; a report already in review or
 * generated returns to captures_incomplete, so its prior PDF is never reused. */
export async function importLatestLiveSection(options: LocalLiveAcceptanceImportOptions, section: ScreenshotType): Promise<LocalLiveAcceptanceImportResult> {
  const { clientId, reportMonth, repositoryRoot } = options;
  const live = await verifyLatestLiveAcceptanceRun(repositoryRoot, clientId, reportMonth, [section]);
  return importVerifiedLiveAcceptance(options, live, singleSectionReplacementStatuses, section);
}

const singleSectionReplacementStatuses: readonly ReportStatus[] = ["draft", "captures_incomplete", "ready_for_review", "generated"];

async function importVerifiedLiveAcceptance(options: LocalLiveAcceptanceImportOptions, live: Awaited<ReturnType<typeof verifyLatestLiveAcceptanceRun>>, importableStatuses: readonly ReportStatus[] = ["draft"], replaceableSection: ScreenshotType | null = null): Promise<LocalLiveAcceptanceImportResult> {
  const { clientId, reportMonth, repositoryRoot, now } = options;
  const clientConfig = await readLocalClient(repositoryRoot, clientId);
  // Preserve a previously verified provider-account binding and unrelated
  // configured targets. A local capture file proves its own source URL; it
  // must never silently downgrade account identity or erase another section's
  // configuration while being imported.
  const existingTargets = await options.targetsRepository.get(clientId);
  const targetInput = clientReportTargetsInputSchema.parse({
    businessReview: existingTargets.businessReview
      ? { ...existingTargets.businessReview, dashboardUrl: clientConfig.businessReviewUrl }
      : { dashboardUrl: clientConfig.businessReviewUrl },
    sourceUrls: {
      ...(existingTargets.sourceUrls ?? {}),
      overviewUrl: clientConfig.overviewUrl,
      businessReviewUrl: clientConfig.businessReviewUrl,
      ...(clientConfig.signupFormsUrl ? { signupFormsUrl: clientConfig.signupFormsUrl } : {}),
      ...(clientConfig.flowsUrl ? { flowsUrl: clientConfig.flowsUrl } : {}),
      ...(clientConfig.segmentsUrl ? { segmentsUrl: clientConfig.segmentsUrl } : {}),
      ...(clientConfig.deliverabilityUrl ? { deliverabilityUrl: clientConfig.deliverabilityUrl } : {}),
    },
    signupForms: clientConfig.signupForms ?? existingTargets.signupForms,
    welcomeFlowListing: clientConfig.welcomeFlowListing ?? existingTargets.welcomeFlowListing,
    primaryEmailList: existingTargets.primaryEmailList,
    primarySmsList: existingTargets.primarySmsList,
    welcomeFlow: existingTargets.welcomeFlow,
    customerSegment: existingTargets.customerSegment,
    nonCustomerSegment: existingTargets.nonCustomerSegment,
  });

  let draft = await findOrCreateCanonicalDraft(options.repository, clientConfig, reportMonth, now());
  if (!importableStatuses.includes(draft.status)) throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", `Local acceptance evidence can only be imported into a canonical report in state ${importableStatuses.join(", ")}.`);
  await options.targetsRepository.save(clientId, targetInput, now());
  const storedTargets = await options.targetsRepository.get(clientId);
  verifyPersistedTargets(storedTargets, clientConfig, existingTargets);

  const existingByType = new Map(draft.screenshots.map((shot) => [shot.type, shot]));
  const existingHashes = new Map(draft.screenshots.filter(({ sha256 }) => sha256).map((shot) => [shot.sha256!, shot]));
  const pendingRecords = [];
  const newAssets: string[] = [];
  let reusedCaptureCount = 0;
  try {
    for (const capture of live.captures) {
      const existing = existingByType.get(capture.type);
      if (existing) {
        if (existing.captureOrigin !== "live_acceptance_import" || existing.sha256 !== capture.sha256 || existing.sourceProof?.sourceIdentity !== capture.sourceIdentity) {
          // A capture contract revision can legitimately replace a single source. The prior
          // stored object remains addressable by its historical generated artifact; the
          // draft moves back through normal review rather than silently claiming approval.
          if (capture.type !== replaceableSection) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `Refusing to replace existing ${capture.type} evidence while importing acceptance output.`);
          const id = randomUUID(); const storageKey = `reports/${draft.id}/${capture.type}/${id}.png`;
          const stored = await options.screenshotStorage.put(storageKey, capture.bytes); newAssets.push(stored.storageKey);
          if (stored.sha256 !== capture.sha256 || stored.byteSize !== capture.byteSize) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${capture.type} changed while entering canonical screenshot storage.`);
          const record = screenshotRecordSchema.parse({ id, clientId, reportMonth, type: capture.type, capturedAt: (await stat(join(live.directory, "results.json"))).mtime.toISOString(), sourceUrl: capture.sourceUrl, width: capture.width, height: capture.height, approved: false, approvedAt: null, periodConfirmed: true, captureOrigin: "live_acceptance_import", storageKey, mimeType: "image/png", byteSize: stored.byteSize, sha256: stored.sha256, sourceProof: capture.sourceProof });
          await verifyStoredCapture(options.screenshotStorage, record, clientId, reportMonth, live.period); pendingRecords.push(record); continue;
        }
        await verifyStoredCapture(options.screenshotStorage, existing, clientId, reportMonth, live.period);
        reusedCaptureCount += 1;
        continue;
      }
      if (existingHashes.has(capture.sha256)) throw new ReportDomainError("DUPLICATE_SCREENSHOT_SOURCE", `${capture.type} duplicates a screenshot already stored in this report.`);
      const id = randomUUID();
      const storageKey = `reports/${draft.id}/${capture.type}/${id}.png`;
      const stored = await options.screenshotStorage.put(storageKey, capture.bytes);
      newAssets.push(stored.storageKey);
      if (stored.sha256 !== capture.sha256 || stored.byteSize !== capture.byteSize) throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${capture.type} changed while entering canonical screenshot storage.`);
      const record = screenshotRecordSchema.parse({
        id, clientId, reportMonth, type: capture.type, capturedAt: (await stat(join(live.directory, "results.json"))).mtime.toISOString(),
        sourceUrl: capture.sourceUrl, width: capture.width, height: capture.height,
        approved: false, approvedAt: null, periodConfirmed: true, captureOrigin: "live_acceptance_import",
        storageKey, mimeType: "image/png", byteSize: stored.byteSize, sha256: stored.sha256, sourceProof: capture.sourceProof,
      });
      await verifyStoredCapture(options.screenshotStorage, record, clientId, reportMonth, live.period);
      pendingRecords.push(record);
    }
    if (pendingRecords.length === 1 && replacementInvalidatesCaptureReview(draft, pendingRecords[0]!.type)) {
      // Same atomic path as the product's screenshot replacement route.
      const expectedVersion = draft.version;
      const updated = replaceScreenshotAndInvalidateCaptureReview(draft, pendingRecords[0]!, pendingRecords[0]!.type, { now: now() });
      assertOnlyPendingReviewValidation(updated.validation.errors);
      draft = await options.repository.saveWithLifecycleEvent(updated, expectedVersion, "MARK_CAPTURES_INCOMPLETE");
    } else if (pendingRecords.length) {
      if (draft.status !== "draft" && draft.status !== "captures_incomplete") throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", "A multi-section import cannot replace evidence in a reviewed or generated report.");
      draft = upsertScreenshotMetadataBatch(draft, pendingRecords, { now: now() });
      assertOnlyPendingReviewValidation(draft.validation.errors);
      draft = await options.repository.save(draft, draft.version - 1);
    }
    const importedScreenshots = draft.screenshots.filter(({ captureOrigin }) => captureOrigin === "live_acceptance_import");
    return {
      reportId: draft.id, clientId, reportMonth, importedCaptureCount: pendingRecords.length,
      storageVerifiedCount: importedScreenshots.length, sourceProofVerifiedCount: importedScreenshots.length,
      distinctSha256Count: new Set(importedScreenshots.map(({ sha256 }) => sha256)).size,
      pendingReviewCount: draft.screenshots.filter(({ captureOrigin, approved }) => captureOrigin === "live_acceptance_import" && !approved).length,
      reusedCaptureCount, importedTypes: draft.screenshots.filter(({ captureOrigin }) => captureOrigin === "live_acceptance_import").map(({ type }) => type),
      missingTypes: live.missingTypes.filter((type) => !draft.screenshots.some(({ type: present }) => present === type)),
      validation: draft.validation,
    };
  } catch (error) {
    await Promise.all(newAssets.map((key) => options.screenshotStorage.delete(key).catch(() => undefined)));
    throw error;
  }
}

function verifyPersistedTargets(
  storedTargets: Awaited<ReturnType<ClientReportTargetsRepository["get"]>>,
  clientConfig: Awaited<ReturnType<typeof readLocalClient>>,
  existingTargets: Awaited<ReturnType<ClientReportTargetsRepository["get"]>>,
): void {
  const expectedWelcomeFlows = (clientConfig.welcomeFlowListing ?? existingTargets.welcomeFlowListing)?.flows ?? [];
  const actualWelcomeFlows = storedTargets.welcomeFlowListing?.flows ?? [];
  if (storedTargets.businessReview?.dashboardUrl !== clientConfig.businessReviewUrl
    || storedTargets.businessReview?.accountLabel !== existingTargets.businessReview?.accountLabel
    || storedTargets.businessReview?.providerAccountId !== existingTargets.businessReview?.providerAccountId
    || storedTargets.businessReview?.providerIdentityKind !== existingTargets.businessReview?.providerIdentityKind
    || storedTargets.sourceUrls?.overviewUrl !== clientConfig.overviewUrl
    || storedTargets.sourceUrls?.businessReviewUrl !== clientConfig.businessReviewUrl
    || (clientConfig.signupForms ? storedTargets.signupForms?.mode !== clientConfig.signupForms.mode : storedTargets.signupForms?.mode !== existingTargets.signupForms?.mode)
    || (clientConfig.welcomeFlowListing ? storedTargets.welcomeFlowListing?.mode !== "email_welcome_flows" : storedTargets.welcomeFlowListing?.mode !== existingTargets.welcomeFlowListing?.mode)
    || actualWelcomeFlows.length !== expectedWelcomeFlows.length
    || expectedWelcomeFlows.some((expected) => !actualWelcomeFlows.some((actual) => actual.id === expected.id && actual.name === expected.name && actual.channel === "email"))) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Persisted listing targets do not match the evidence-backed local client configuration.");
  }
}

async function verifyStoredCapture(storage: ScreenshotStorage, record: ReturnType<typeof screenshotRecordSchema.parse>, clientId: string, reportMonth: { year: number; month: number }, period: Awaited<ReturnType<typeof verifyLatestLiveAcceptanceRun>>["period"]): Promise<void> {
  const proof = record.sourceProof;
  const expectedPeriod = record.type === "deliverability" ? null : record.type === "month_comparison"
    ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate }
    : { startDate: period.startDate, endDate: period.endDate };
  if (record.clientId !== clientId || record.reportMonth.year !== reportMonth.year || record.reportMonth.month !== reportMonth.month
    || record.captureOrigin !== "live_acceptance_import" || record.approved || record.approvedAt !== null || !record.periodConfirmed
    || !proof || !matchesReportCaptureSpec(record.type, proof)
    || JSON.stringify(proof.expectedPeriod) !== JSON.stringify(expectedPeriod) || JSON.stringify(proof.observedPeriod) !== JSON.stringify(expectedPeriod)) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${record.type} persisted metadata or source proof failed independent verification.`);
  }
  const asset = await storage.get(record.storageKey ?? "");
  if (!asset || asset.byteSize !== record.byteSize || asset.sha256 !== record.sha256
    || createHash("sha256").update(asset.bytes).digest("hex") !== record.sha256
    || asset.bytes.length !== record.byteSize
    || JSON.stringify(inspectPng(asset.bytes)) !== JSON.stringify({ width: record.width, height: record.height })) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", `${record.type} backend screenshot asset does not match its persisted hash, size, or dimensions.`);
  }
}

async function findOrCreateCanonicalDraft(
  repository: ReportDraftRepository,
  client: { name: string; timezone: string },
  reportMonth: { year: number; month: number },
  timestamp: Date,
) {
  const clientId = deriveClientId(client.name);
  const matches = (await repository.list()).filter((draft) => draft.client.id === clientId && draft.reportMonth.year === reportMonth.year && draft.reportMonth.month === reportMonth.month);
  if (matches.length > 1) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "More than one report draft exists for this client and report month.");
  if (matches.length === 1) {
    const existing = matches[0]!;
    if (existing.client.name !== client.name || existing.client.timezone !== client.timezone) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "The existing report identity does not match local client configuration.");
    return existing;
  }
  const sections: SectionConfiguration = Object.fromEntries([
    ...REPORT_CAPTURE_SPEC_V1.filter((spec) => !spec.reportOptIn).map((spec) => [screenshotSectionMapping[spec.screenshotType], spec.defaultRequirement] as const),
    ["analysis", "optional"], ["next_month_plan", "optional"],
  ]);
  return repository.create(createReportDraft({ client: { id: clientId, name: client.name, timezone: client.timezone, currency: null }, reportMonth, sections }, { now: timestamp }));
}

function assertOnlyPendingReviewValidation(errors: ReturnType<typeof validateReportDraft>["errors"]): void {
  const allowed = new Set(["REQUIRED_SCREENSHOT_MISSING", "REQUIRED_SCREENSHOT_UNAPPROVED"]);
  const blocking = errors.filter(({ code }) => !allowed.has(code));
  if (blocking.length) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Imported live captures failed Phase A source, period, identity, or duplicate validation.", { status: "invalid", errors: blocking, warnings: [] });
}
