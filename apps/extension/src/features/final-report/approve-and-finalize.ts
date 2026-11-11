import type { ApiClient } from "@tention/api-client";
import type { ReportDraft, ReportPdfArtifact, ScreenshotType } from "@tention/report-schema";

/**
 * Optional QA: one explicit human approval of every saved capture, then — with no further clicks — submit for review and generate
 * the final report. Generation is the existing single backend call: canonical PDF, then Drive PDF, then Google Doc; a
 * Drive or Doc failure is recorded on the artifact and never removes the PDF or the screenshots.
 *
 * Every step runs against the version the previous step returned, and the first failure stops the chain: nothing is
 * generated unless every listed capture is confirmed approved by the backend.
 */
export type FinalizeStage = "approving" | "submitting" | "generating";
export interface FinalizeProgress { stage: FinalizeStage; approved: number; total: number }
export interface FinalizeResult { report: ReportDraft; artifact: ReportPdfArtifact }

export class FinalizeError extends Error {
  constructor(readonly stage: FinalizeStage, message: string, readonly report: ReportDraft, override readonly cause?: unknown) {
    super(message); this.name = "FinalizeError";
  }
}

type FinalizeApi = Pick<ApiClient, "approveImportedScreenshot" | "applyEvent" | "generatePdf" | "autoGenerateFinalReport">;

/** Statuses from which SUBMIT_FOR_REVIEW is the next step; later statuses are already reviewed. */
const SUBMITTABLE: ReadonlySet<ReportDraft["status"]> = new Set(["draft", "data_ready", "captures_incomplete"]);
/** Statuses the backend accepts for final generation (a failed generation may be retried). */
const GENERATABLE: ReadonlySet<ReportDraft["status"]> = new Set(["ready_for_review", "approved", "failed"]);

/**
 * Why automatic final generation must not start; empty when every client-side gate passes. Human approval is not a
 * gate. The backend re-verifies everything (stored bytes, hash, dimensions, client, month, period, source proof).
 */
export function autoGenerationBlockers(report: ReportDraft, types: readonly ScreenshotType[], expectedCount: number, dataBlockerCodes: readonly string[]): string[] {
  return approveAllBlockers(report, types, expectedCount, dataBlockerCodes);
}

/** Why Approve All must stay disabled; empty when every gate passes. Server-side checks still apply on each step. */
export function approveAllBlockers(report: ReportDraft, types: readonly ScreenshotType[], expectedCount: number, dataBlockerCodes: readonly string[]): string[] {
  const blockers: string[] = [];
  if (types.length !== expectedCount) blockers.push(`Expected ${expectedCount} automatic sections, found ${types.length}.`);
  const missing = types.filter((type) => !report.screenshots.some((shot) => shot.type === type));
  if (missing.length) blockers.push(`Missing captures: ${missing.join(", ")}.`);
  for (const type of types) {
    const shot = report.screenshots.find((candidate) => candidate.type === type);
    if (!shot || shot.approved) continue;
    if (shot.captureOrigin !== "live_acceptance_import" || !shot.sha256 || !shot.periodConfirmed || !shot.sourceProof) blockers.push(`${type} has no verified saved capture to approve.`);
    if (shot.clientId !== report.client.id || shot.reportMonth.year !== report.reportMonth.year || shot.reportMonth.month !== report.reportMonth.month) blockers.push(`${type} belongs to another client or month.`);
  }
  if (dataBlockerCodes.length) blockers.push(`Data blockers: ${dataBlockerCodes.join(", ")}.`);
  if (report.status === "generating") blockers.push("A final report is already being generated.");
  return blockers;
}

export async function approveAllAndFinalize(api: FinalizeApi, initial: ReportDraft, types: readonly ScreenshotType[], onProgress: (progress: FinalizeProgress) => void = () => undefined): Promise<FinalizeResult> {
  let report = initial;
  const total = types.length;
  const approvedCount = () => types.filter((type) => report.screenshots.some((shot) => shot.type === type && shot.approved)).length;
  for (const type of types) {
    const shot = report.screenshots.find((candidate) => candidate.type === type);
    if (!shot) throw new FinalizeError("approving", `The ${type} capture is missing; nothing was generated.`, report);
    if (shot.approved) continue;
    onProgress({ stage: "approving", approved: approvedCount(), total });
    if (!shot.sha256 || shot.captureOrigin !== "live_acceptance_import") throw new FinalizeError("approving", `The ${type} capture has no verified saved evidence; nothing was generated.`, report);
    try { report = await api.approveImportedScreenshot(report.id, type, { expectedVersion: report.version, expectedSha256: shot.sha256 }); }
    catch (error) { throw new FinalizeError("approving", `Approval of ${type} was not confirmed (${messageOf(error)}); nothing was generated.`, report, error); }
  }
  if (approvedCount() !== total) throw new FinalizeError("approving", `Only ${approvedCount()} / ${total} captures are approved; nothing was generated.`, report);
  onProgress({ stage: "approving", approved: total, total });
  if (SUBMITTABLE.has(report.status)) {
    onProgress({ stage: "submitting", approved: total, total });
    try { report = await api.applyEvent(report.id, "SUBMIT_FOR_REVIEW", report.version); }
    catch (error) { throw new FinalizeError("submitting", `Submitting for review failed (${messageOf(error)}); approvals are kept and nothing was generated.`, report, error); }
  }
  // Already machine-validated or generated (optional QA after the automatic report): the backend returns the existing
  // artifact for unchanged captures and never renders, uploads or writes a Doc twice.
  const automatic = report.status === "auto_validated" || report.status === "generated";
  if (!GENERATABLE.has(report.status) && !automatic) throw new FinalizeError("submitting", `The report is ${report.status}, not ready for final generation.`, report);
  onProgress({ stage: "generating", approved: total, total });
  try { return automatic ? await api.autoGenerateFinalReport(report.id, report.version, report.reportMonth) : await api.generatePdf(report.id, report.version, report.reportMonth); }
  catch (error) { throw new FinalizeError("generating", `Final PDF generation failed (${messageOf(error)}); approved screenshots are kept.`, report, error); }
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return `${error.code}${error instanceof Error && error.message ? `: ${error.message}` : ""}`;
  return error instanceof Error && error.message ? error.message : "unknown error";
}
