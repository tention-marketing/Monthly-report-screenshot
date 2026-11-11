import { createHash } from "node:crypto";
import { createScreenshotSourceProof, matchesReportCaptureSpec, screenshotTypeSchema, type ScreenshotType } from "@tention/report-schema";
import type { ReportDraftRepository } from "@tention/report-domain";
import type { ScreenshotStorage } from "../storage/screenshot-storage.js";
import { inspectPng } from "../storage/png.js";

/**
 * Loads one machine-validated automatic capture that no human has approved yet, re-verifying its client, month,
 * source proof, period, uniqueness and stored bytes. Used by the optional human review (view + approve); it never
 * gates automatic capture or automatic finalization.
 */
export async function loadPendingImport(repository: ReportDraftRepository, storage: ScreenshotStorage, reportId: string, rawType: string) {
  const typeResult = screenshotTypeSchema.safeParse(rawType);
  if (!typeResult.success) throw new Error("Screenshot type is not supported.");
  const type: ScreenshotType = typeResult.data;
  const draft = await repository.getById(reportId);
  if (!draft) throw new Error("The report draft needed for imported evidence review was not found.");
  const screenshot = draft.screenshots.find((candidate) => candidate.type === type);
  if (!screenshot || screenshot.clientId !== draft.client.id || screenshot.reportMonth.year !== draft.reportMonth.year || screenshot.reportMonth.month !== draft.reportMonth.month
    || screenshot.captureOrigin !== "live_acceptance_import" || screenshot.approved || screenshot.approvedAt !== null || !screenshot.storageKey
    || screenshot.mimeType !== "image/png" || !screenshot.sha256 || !screenshot.periodConfirmed || !screenshot.sourceProof) throw new Error("No pending live-acceptance screenshot is available for review.");
  const expectedProof = createScreenshotSourceProof(type, draft.period, undefined, null, type === "email_subscriber_growth" ? screenshot.sourceProof.subscriberGrowth ?? null : null, type === "overview" ? screenshot.sourceProof.businessPerformance ?? null : null);
  if (!matchesReportCaptureSpec(type, screenshot.sourceProof) || JSON.stringify(screenshot.sourceProof) !== JSON.stringify(expectedProof)) throw new Error("Imported screenshot source proof or period is stale or invalid.");
  if (draft.screenshots.some((candidate) => candidate.type !== type && candidate.sha256 === screenshot.sha256)) throw new Error("Imported screenshot duplicates another report section.");
  const asset = await storage.get(screenshot.storageKey);
  if (!asset || asset.byteSize !== screenshot.byteSize || asset.sha256 !== screenshot.sha256 || createHash("sha256").update(asset.bytes).digest("hex") !== screenshot.sha256) throw new Error("Stored imported screenshot does not match its recorded size and SHA-256.");
  const dimensions = inspectPng(asset.bytes);
  if (dimensions.width !== screenshot.width || dimensions.height !== screenshot.height) throw new Error("Stored imported screenshot dimensions do not match its metadata.");
  return { draft, screenshot, bytes: asset.bytes };
}
