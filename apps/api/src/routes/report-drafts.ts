import {
  applyAutomatedValidation, applyClientProfileCurrency, applyReportEvent, createReportDraft, finalGenerationDataBlockers, ReportDomainError, ReportPersistenceError,
  replacementInvalidatesCaptureReview, replaceScreenshotAndInvalidateCaptureReview,
  upsertScreenshotMetadata, validateReportDraft, type ClientReportTargetsRepository, type ReportDraftRepository, type ReportEvent,
} from "@tention/report-domain";
import {
  clientReportSnapshot, clientSetupBlockers, type ClientSetupBlocker,
  reportMonthSchema, screenshotRecordSchema, screenshotSourceProofSchema, screenshotTypeSchema, sectionConfigurationSchema,
} from "@tention/report-schema";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { inspectPng } from "../storage/png.js";
import { ScreenshotStorageError, type ScreenshotStorage } from "../storage/screenshot-storage.js";
import { PdfArtifactStorageError, type PdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import { buildReportDocumentModel, ReportDocumentError, renderReportHtml, type ReportDocumentModel } from "../reports/report-document.js";
import { PdfRendererError, type PdfRenderer } from "../reports/pdf-renderer.js";
import { createHash } from "node:crypto";
import { reportCover, type CoverIssue } from "@tention/report-schema";
import { REPORT_CAPTURE_SPEC_V1, reportPdfArtifactSchema, screenshotSectionMapping, type ReportDraft, type ReportPdfArtifact, type ScreenshotType } from "@tention/report-schema";
import { deliverArtifactToDrive, syncArtifactGoogleDoc, type PdfDriveDelivery, type ReportGoogleDocSync } from "../delivery/google-drive-delivery.js";
import { renderReportGoogleDocHtml } from "../reports/report-google-doc.js";
import { assertReportMonthConsistent, finalPdfFilename, ReportMonthMismatchError } from "../reports/report-month-safety.js";

interface RouteOptions {
  repository: ReportDraftRepository; clientReportTargetsRepository: ClientReportTargetsRepository; screenshotStorage: ScreenshotStorage; pdfArtifactStorage: PdfArtifactStorage; pdfRenderer: PdfRenderer; pdfDriveDelivery?: PdfDriveDelivery | null; googleDocSync?: ReportGoogleDocSync | null; now: () => Date;
  /**
   * Monthly reports, final PDFs, Drive and Google Doc delivery exist only for a client whose setup is READY
   * (`clientSetupBlockers`). Production always enforces it; only fixtures for pre-onboarding behaviour turn it off.
   */
  requireClientSetupReady: boolean;
}

/** The client's setup is not READY: the exact missing items, never a partial report. */
export class ClientSetupIncompleteError extends Error {
  readonly code = "CLIENT_SETUP_INCOMPLETE";
  constructor(readonly clientId: string, readonly blockers: ClientSetupBlocker[]) {
    super(`Client setup is incomplete. Missing: ${blockers.map(({ message }) => message).join(" ")}`);
  }
}

/** Name and timezone may be omitted when the client has a canonical profile; they are then taken from it. */
const clientRequestSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).optional(), timezone: z.string().min(1).optional(),
}).strict();
const createRequestSchema = z.object({
  client: clientRequestSchema, reportMonth: reportMonthSchema, sections: sectionConfigurationSchema,
}).strict();
const eventRequestSchema = z.object({ event: z.enum([
  "START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "DATA_FETCH_FAILED", "MARK_CAPTURES_INCOMPLETE",
  "SUBMIT_FOR_REVIEW", "APPROVE", "START_GENERATION", "GENERATION_SUCCEEDED",
  "GENERATION_FAILED", "RESET_TO_DRAFT", "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW",
]), expectedVersion: z.number().int().positive() }).strict();
const deleteRequestSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
const captureProofHeaderSchema = z.string().min(2).transform((value, context) => {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "x-capture-proof must contain JSON." });
    return z.NEVER;
  }
  const proof = screenshotSourceProofSchema.safeParse(parsed);
  if (!proof.success) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "x-capture-proof does not match the capture proof contract." });
    return z.NEVER;
  }
  return proof.data;
});
const imageUploadHeadersSchema = z.object({
  "x-expected-version": z.coerce.number().int().positive(),
  "x-period-confirmed": z.literal("true"),
  "x-source-url": z.string().url().optional(),
  "x-capture-proof": captureProofHeaderSchema,
}).passthrough();
const listQuerySchema = z.object({
  clientId: z.string().min(1).optional(),
  year: z.coerce.number().int().min(2000).max(9999).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
}).strict();

export const reportDraftRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/report-drafts", async (request, reply) => {
    try {
      const query = listQuerySchema.parse(request.query);
      const drafts = (await options.repository.list())
        .filter((draft) => query.clientId === undefined || draft.client.id === query.clientId)
        .filter((draft) => query.year === undefined || draft.reportMonth.year === query.year)
        .filter((draft) => query.month === undefined || draft.reportMonth.month === query.month)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
      return drafts;
    } catch (error) { return sendError(reply, error); }
  });

  app.post("/report-drafts", async (request, reply) => {
    try {
      const body = createRequestSchema.parse(request.body);
      // A READY client's report freezes the client setup it was created with (conversion metric, Klaviyo account).
      const ready = await ensureClientSetupReady(body.client.id);
      const client = await resolveReportClient(body.client, options.clientReportTargetsRepository);
      if (!client.ok) return reply.code(client.status).send({ error: client.error, message: client.message });
      const draft = createReportDraft({ ...body, client: ready ? clientReportSnapshot(ready) : client.value }, { now: options.now() });
      const creationBlocker = draft.validation.errors.find(({ code }) =>
        code === "REPORT_MONTH_INCOMPLETE" || code === "INVALID_CLIENT_TIMEZONE");
      if (creationBlocker) return reply.code(400).send({ error: creationBlocker.code, message: creationBlocker.message });
      const stored = await options.repository.create(draft);
      return reply.code(201).send(stored);
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/report-drafts/:id", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      return draft ?? reply.code(404).send({ error: "REPORT_NOT_FOUND" });
    } catch (error) { return sendError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/report-drafts/:id", async (request, reply) => {
    try {
      const { expectedVersion } = deleteRequestSchema.parse(request.body);
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      ensureExpectedVersion(draft.version, expectedVersion);
      await deleteReportOwnedData(draft, expectedVersion);
      return { deleted: true };
    } catch (error) { return sendError(reply, error); }
  });

  // Deletes one report and only what that report owns: its row, lifecycle history, screenshot metadata and files, local
  // PDF artifacts and their delivery metadata (rows cascade). The client, its setup and sources, and every other
  // month's report are separate records and are never touched. Google Drive/Docs files are never deleted here: no safe
  // Drive delete contract exists, so the response says which Drive files were left in place.
  app.delete<{ Params: { clientId: string; reportId: string } }>("/clients/:clientId/reports/:reportId", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.reportId);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND", message: "This report no longer exists." });
      if (draft.client.id !== request.params.clientId) return reply.code(409).send({ error: "REPORT_CLIENT_MISMATCH", message: "This report belongs to another client." });
      if (draft.status === "generating") return reply.code(409).send({ error: "REPORT_DELETE_BLOCKED_GENERATING", message: "This report is currently generating. Try again after generation finishes." });
      const driveFilesRetained = await deleteReportOwnedData(draft, draft.version);
      return { deleted: true, reportId: draft.id, clientId: draft.client.id, reportMonth: draft.reportMonth, driveFilesDeleted: false, driveFilesRetained };
    } catch (error) { return sendError(reply, error); }
  });

  /** Removes the report (version-checked, so a report that started generating meanwhile is refused) and its local assets; returns the Drive files left untouched. */
  async function deleteReportOwnedData(draft: ReportDraft, expectedVersion: number): Promise<number> {
    const storageKeys = [...new Set(draft.screenshots.flatMap(({ storageKey }) => storageKey ? [storageKey] : []))];
    const artifacts = await options.repository.listArtifacts(draft.id);
    const driveFilesRetained = artifacts.reduce((count, artifact) => count + (artifact.driveDelivery?.driveFileId ? 1 : 0) + (artifact.googleDoc?.googleDocId ? 1 : 0), 0);
    await options.repository.delete(draft.id, expectedVersion);
    await Promise.all(storageKeys.map(async (storageKey) => {
      try { await options.screenshotStorage.delete(storageKey); }
      catch (error) { app.log.warn({ error, reportId: draft.id, storageKey }, "Report screenshot asset cleanup failed."); }
    }));
    await Promise.all(artifacts.map(({ storageKey }) => options.pdfArtifactStorage.delete(storageKey).catch((error) => app.log.warn({ error, reportId: draft.id, storageKey }, "Report PDF artifact cleanup failed."))));
    return driveFilesRetained;
  }

  // Applies the client's saved, verified profile currency to this report's frozen currency. The value is never taken
  // from the request; the reload must show that nothing but the currency (and version) changed.
  app.post<{ Params: { id: string } }>("/report-drafts/:id/client-currency", async (request, reply) => {
    try {
      const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body);
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      ensureExpectedVersion(draft.version, expectedVersion);
      const profile = (await options.clientReportTargetsRepository.get(draft.client.id)).profile;
      if (!profile || profile.name !== draft.client.name || profile.timezone !== draft.client.timezone) return reply.code(409).send({ error: "CLIENT_CONFIGURATION_MISMATCH", message: "The report's client does not match the saved client profile." });
      const updated = applyClientProfileCurrency(draft, profile.currency, { now: options.now() });
      if (updated === draft) return draft;
      const saved = await options.repository.save(updated, expectedVersion);
      const unchanged = (value: ReportDraft) => JSON.stringify({ id: value.id, client: { ...value.client, currency: null }, reportMonth: value.reportMonth, period: value.period, status: value.status, sections: value.sections, screenshots: value.screenshots, createdAt: value.createdAt });
      if (saved.client.currency !== profile.currency || unchanged(saved) !== unchanged(draft)) throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "The saved report changed more than its currency.");
      return saved;
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/report-drafts/:id/validate", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      return validateReportDraft(draft, { now: options.now() });
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/report-drafts/:id/history", async (request, reply) => {
    try {
      return await options.repository.getHistory(request.params.id);
    } catch (error) { return sendError(reply, error); }
  });

  app.put<{ Params: { id: string; type: string }; Body: Buffer }>("/report-drafts/:id/screenshots/:type/image", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const routeType = parseScreenshotType(request.params.type);
      const headers = imageUploadHeadersSchema.parse(request.headers);
      await verifyListingScopeTarget(routeType, draft.client.id, headers["x-capture-proof"], options.clientReportTargetsRepository);
      if (!Buffer.isBuffer(request.body)) throw new ScreenshotStorageError("INVALID_SCREENSHOT_CONTENT", "Screenshot upload must contain PNG bytes.");
      const dimensions = inspectPng(request.body);
      const expectedVersion = headers["x-expected-version"];
      ensureExpectedVersion(draft.version, expectedVersion);
      const capturedAt = options.now().toISOString();
      const assetId = crypto.randomUUID();
      const storageKey = `reports/${draft.id}/${routeType}/${assetId}.png`;
      const previous = draft.screenshots.find(({ type }) => type === routeType);
      let savedStorageKey: string | null = null;
      let metadataSaveCompleted = false;
      try {
        const asset = await options.screenshotStorage.put(storageKey, request.body);
        savedStorageKey = asset.storageKey;
        const screenshot = screenshotRecordSchema.parse({
          id: assetId, clientId: draft.client.id, reportMonth: draft.reportMonth, type: routeType,
          capturedAt, sourceUrl: normalizeSourceUrl(headers["x-source-url"]),
          width: dimensions.width, height: dimensions.height, approved: true, approvedAt: capturedAt, captureOrigin: "extension_manual",
          periodConfirmed: true, storageKey: asset.storageKey, mimeType: "image/png",
          byteSize: asset.byteSize, sha256: asset.sha256,
          sourceProof: headers["x-capture-proof"],
        });
        const invalidatesCaptureReview = replacementInvalidatesCaptureReview(draft, routeType);
        const updated = invalidatesCaptureReview
          ? replaceScreenshotAndInvalidateCaptureReview(draft, screenshot, routeType, { now: options.now() })
          : upsertScreenshotMetadata(draft, screenshot, routeType, { now: options.now() });
        ensureCaptureSourceAccepted(updated.validation);
        const saved = invalidatesCaptureReview
          ? await options.repository.saveWithLifecycleEvent(updated, expectedVersion, "MARK_CAPTURES_INCOMPLETE")
          : await options.repository.save(updated, expectedVersion);
        metadataSaveCompleted = true;
        const persistedScreenshot = saved.screenshots.find(({ type }) => type === routeType);
        if (!persistedScreenshot || persistedScreenshot.id !== screenshot.id || persistedScreenshot.sha256 !== screenshot.sha256
          || !persistedScreenshot.approved || !persistedScreenshot.periodConfirmed
          || JSON.stringify(persistedScreenshot.sourceProof) !== JSON.stringify(screenshot.sourceProof)) {
          throw new ReportPersistenceError("PERSISTENCE_DATA_INVALID", "Saved screenshot could not be confirmed in the canonical report draft.");
        }
        if (previous?.storageKey && previous.storageKey !== asset.storageKey) {
          void options.screenshotStorage.delete(previous.storageKey).catch(() => undefined);
        }
        return {
          reportId: saved.id,
          screenshotType: routeType,
          screenshotRecordId: persistedScreenshot.id,
          approvalStatus: "approved" as const,
          sha256: persistedScreenshot.sha256!,
          sourceProofAccepted: true as const,
          report: saved,
        };
      } catch (error) {
        if (savedStorageKey && !metadataSaveCompleted) await options.screenshotStorage.delete(savedStorageKey).catch(() => undefined);
        throw error;
      }
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string; type: string } }>("/report-drafts/:id/screenshots/:type/image", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const routeType = parseScreenshotType(request.params.type);
      const screenshot = draft.screenshots.find(({ type }) => type === routeType);
      if (!screenshot?.approved || !screenshot.periodConfirmed || !screenshot.storageKey || screenshot.mimeType !== "image/png" || !screenshot.sha256 || !screenshot.byteSize) {
        throw new ScreenshotStorageError("SCREENSHOT_NOT_FOUND", "Screenshot image was not found.");
      }
      const asset = await options.screenshotStorage.get(screenshot.storageKey);
      if (!asset) throw new ScreenshotStorageError("SCREENSHOT_NOT_FOUND", "Screenshot image was not found.");
      if (asset.sha256 !== screenshot.sha256 || asset.byteSize !== screenshot.byteSize) {
        throw new ScreenshotStorageError("STORAGE_ERROR", "Stored screenshot asset does not match its metadata.");
      }
      return reply.type("image/png").header("cache-control", "no-store").send(asset.bytes);
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/report-drafts/:id/preview", async (request, reply) => {
    try {
      const draft = await requirePreviewableDraft(options.repository, request.params.id);
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      return reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("content-security-policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'").send(renderReportHtml(model));
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/report-drafts/:id/pdf-artifact", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      const artifact = await options.repository.getArtifactForFingerprint(draft.id, model.sourceFingerprint);
      if (!artifact) return reply.code(404).send({ error: "PDF_ARTIFACT_STALE", message: "No current generated PDF exists for the reviewed screenshot set." });
      return artifact;
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/report-drafts/:id/pdf", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      const artifact = await options.repository.getArtifactForFingerprint(draft.id, model.sourceFingerprint);
      if (!artifact) return reply.code(404).send({ error: "PDF_ARTIFACT_STALE", message: "No current generated PDF exists for the reviewed screenshot set." });
      const bytes = await options.pdfArtifactStorage.get(artifact.storageKey);
      if (!bytes || bytes.sha256 !== artifact.sha256 || bytes.byteSize !== artifact.byteSize) throw new PdfArtifactStorageError("PDF_ARTIFACT_STORAGE_ERROR", "Generated PDF artifact is unavailable.");
      const disposition = request.query.download === "1" ? "attachment" : "inline";
      return reply.type("application/pdf").header("cache-control", "no-store").header("content-disposition", `${disposition}; filename="${finalPdfFilename(draft)}"`).send(bytes.bytes);
    } catch (error) { return sendError(reply, error); }
  });

  // Retries the Google Drive archive copy from the already-generated canonical PDF; never re-renders or recaptures.
  app.post<{ Params: { id: string } }>("/report-drafts/:id/pdf-artifact/drive-delivery", async (request, reply) => {
    try {
      if (!options.pdfDriveDelivery) return reply.code(503).send({ error: "DRIVE_NOT_CONFIGURED", message: "Google Drive delivery is not configured." });
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      await ensureClientSetupReady(draft.client.id);
      assertReportMonthConsistent(draft);
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      const artifact = await options.repository.getArtifactForFingerprint(draft.id, model.sourceFingerprint);
      if (!artifact) return reply.code(404).send({ error: "PDF_ARTIFACT_STALE", message: "No current generated PDF exists for the reviewed screenshot set." });
      const bytes = await options.pdfArtifactStorage.get(artifact.storageKey);
      if (!bytes || bytes.sha256 !== artifact.sha256 || bytes.byteSize !== artifact.byteSize) throw new PdfArtifactStorageError("PDF_ARTIFACT_STORAGE_ERROR", "Generated PDF artifact is unavailable.");
      return await deliverToDrive(draft, artifact, bytes.bytes);
    } catch (error) { return sendError(reply, error); }
  });

  // Writes (or, with force, overwrites an edited) editable Google Doc from the current approved report model. The
  // canonical PDF for that exact model must already exist; nothing is re-rendered, recaptured, or regenerated.
  app.post<{ Params: { id: string }; Body: { force?: boolean } | undefined }>("/report-drafts/:id/pdf-artifact/google-doc", async (request, reply) => {
    try {
      if (!options.googleDocSync) return reply.code(503).send({ error: "GOOGLE_DOC_NOT_CONFIGURED", message: "Google Doc delivery is not configured." });
      const { force } = z.object({ force: z.boolean().optional() }).strict().parse(request.body ?? {});
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      await ensureClientSetupReady(draft.client.id);
      assertReportMonthConsistent(draft);
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      const artifact = await options.repository.getArtifactForFingerprint(draft.id, model.sourceFingerprint);
      if (!artifact) return reply.code(404).send({ error: "PDF_ARTIFACT_STALE", message: "Generate the PDF for the approved report before creating its Google Doc." });
      return await syncGoogleDoc(draft, artifact, model, force ?? false);
    } catch (error) { return sendError(reply, error); }
  });

  /**
   * Explicit adoption of an existing same-named Doc that Tention found in the month folder but could not prove was its
   * own. Only the exact candidate recorded on the current artifact can be adopted; the sync re-verifies its name, month
   * folder, native Google Docs type and that it is the only copy, then writes this report and Tention's marker into it.
   */
  app.post<{ Params: { id: string }; Body: { docId?: string } }>("/report-drafts/:id/pdf-artifact/google-doc/adopt", async (request, reply) => {
    try {
      if (!options.googleDocSync) return reply.code(503).send({ error: "GOOGLE_DOC_NOT_CONFIGURED", message: "Google Doc delivery is not configured." });
      const { docId } = z.object({ docId: z.string().min(1).max(200) }).strict().parse(request.body ?? {});
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      await ensureClientSetupReady(draft.client.id);
      assertReportMonthConsistent(draft);
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      const artifact = await options.repository.getArtifactForFingerprint(draft.id, model.sourceFingerprint);
      if (!artifact) return reply.code(404).send({ error: "PDF_ARTIFACT_STALE", message: "Generate the PDF for this report before adopting its Google Doc." });
      if (artifact.googleDoc?.googleDocCandidateId !== docId) return reply.code(409).send({ error: "GOOGLE_DOC_ADOPTION_REFUSED", message: "Only the existing Doc Tention found for this report's client and month can be adopted." });
      return await syncGoogleDoc(draft, artifact, model, false, docId);
    } catch (error) { return sendError(reply, error); }
  });

  async function syncGoogleDoc(draft: ReportDraft, artifact: ReportPdfArtifact, model: ReportDocumentModel, force = false, adoptDocId: string | null = null): Promise<ReportPdfArtifact> {
    if (!options.googleDocSync) return artifact;
    const synced = await syncArtifactGoogleDoc(options.repository, options.googleDocSync, draft, artifact, renderReportGoogleDocHtml(model), options.now, force, adoptDocId).catch(() => artifact);
    if (synced.googleDoc?.googleDocStatus === "failed") app.log.warn({ reportId: draft.id, artifactId: artifact.id, googleDocErrorCode: synced.googleDoc.googleDocErrorCode }, "Google Doc copy failed; the canonical PDF and screenshots are unaffected and it can be retried.");
    return synced;
  }

  /** Drive delivery after the canonical artifact is persisted: its outcome is recorded, and it never fails generation. */
  async function deliverToDrive(draft: ReportDraft, artifact: ReportPdfArtifact, bytes: Buffer): Promise<ReportPdfArtifact> {
    if (!options.pdfDriveDelivery) return artifact;
    const delivered = await deliverArtifactToDrive(options.repository, options.pdfDriveDelivery, draft, artifact, bytes, options.now).catch(() => artifact);
    if (delivered.driveDelivery?.driveUploadStatus === "failed") app.log.warn({ reportId: draft.id, artifactId: artifact.id, driveErrorCode: delivered.driveDelivery.driveErrorCode }, "Google Drive delivery failed; the canonical PDF is unaffected and delivery can be retried.");
    return delivered;
  }

  const generateRequestSchema = z.object({ expectedVersion: z.number().int().positive(), expectedReportMonth: reportMonthSchema.optional() }).strict();

  /**
   * Canonical PDF, then Drive PDF, then Google Doc, from a report whose captures already passed review or machine
   * validation. Data blockers fail closed before any state change; Drive/Doc failures are recorded, never fatal.
   */
  async function generateFinal(reply: FastifyReply, draft: ReportDraft, expectedVersion: number) {
    let savedStorageKey: string | null = null;
    try {
      if (draft.status !== "ready_for_review" && draft.status !== "approved" && draft.status !== "auto_validated" && draft.status !== "failed") throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", "PDF generation is available only after capture review or automated validation is complete.");
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      // Fails closed before the report changes state or anything is rendered, uploaded, or written to a Doc: the report's
      // currency and the conversion metric's provider ID must be configured, never inferred.
      const dataBlockers = finalGenerationDataBlockers(draft, (await options.clientReportTargetsRepository.get(draft.client.id)).profile);
      if (dataBlockers.length) return reply.code(409).send({ error: "REPORT_DATA_DEFINITION_INCOMPLETE", message: `Final report generation is blocked: ${dataBlockers.map(({ message }) => message).join(" ")}`, blockers: dataBlockers });
      if (!model.cover.ok) return coverBlocked(reply, model.cover.issues);
      const started = applyReportEvent(draft, "START_GENERATION", { now: options.now() });
      const generating = await options.repository.saveWithLifecycleEvent(started, expectedVersion, "START_GENERATION");
      let pdf: Buffer;
      try { pdf = await options.pdfRenderer.render(renderReportHtml(model)); }
      catch {
        const failed = applyReportEvent(generating, "GENERATION_FAILED", { now: options.now() });
        await options.repository.saveWithLifecycleEvent(failed, generating.version, "GENERATION_FAILED");
        throw new PdfRendererError("PDF rendering failed.");
      }
      const artifactId = crypto.randomUUID();
      const asset = await options.pdfArtifactStorage.put(`reports/${draft.id}/artifacts/${artifactId}.pdf`, pdf);
      savedStorageKey = asset.storageKey;
      const artifact = reportPdfArtifactSchema.parse({ id: artifactId, reportId: draft.id, storageKey: asset.storageKey, mimeType: "application/pdf", byteSize: asset.byteSize, sha256: asset.sha256, sourceFingerprint: model.sourceFingerprint, templateVersion: model.templateVersion, generatedAt: options.now().toISOString() });
      const generated = applyReportEvent(generating, "GENERATION_SUCCEEDED", { now: options.now() });
      const stored = await options.repository.saveGeneratedArtifact(generated, generating.version, artifact);
      savedStorageKey = null;
      // The canonical PDF is now persisted; nothing after this point may remove it.
      const delivered = await deliverToDrive(stored, artifact, pdf);
      return { report: stored, artifact: await syncGoogleDoc(stored, delivered, model) };
    } catch (error) {
      if (savedStorageKey) await options.pdfArtifactStorage.delete(savedStorageKey).catch(() => undefined);
      return sendError(reply, error);
    }
  }

  app.post<{ Params: { id: string } }>("/report-drafts/:id/generate", async (request, reply) => {
    try {
      const body = generateRequestSchema.parse(request.body);
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      ensureExpectedVersion(draft.version, body.expectedVersion);
      // Fails closed before rendering, Drive or the Doc are touched when any month reference disagrees.
      assertReportMonthConsistent(draft, body.expectedReportMonth);
      await ensureClientSetupReady(draft.client.id);
      return await generateFinal(reply, draft, body.expectedVersion);
    } catch (error) { return sendError(reply, error); }
  });

  /**
   * Automatic capture → final report with no human approval step. Re-verifies every automatic capture's stored bytes
   * (SHA-256, size, PNG dimensions), records machine validation (never `approved`), requires the whole report to
   * validate (all required captures present, correct client, month, period and source proof, no duplicates) and the
   * data definition to be complete, then runs the normal generation. Nothing changes when any check fails.
   */
  app.post<{ Params: { id: string } }>("/report-drafts/:id/auto-generate", async (request, reply) => {
    try {
      const body = generateRequestSchema.parse(request.body);
      let draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      ensureExpectedVersion(draft.version, body.expectedVersion);
      assertReportMonthConsistent(draft, body.expectedReportMonth);
      await ensureClientSetupReady(draft.client.id);
      if (draft.status === "generating") throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", "A final report is already being generated.");
      if (draft.status === "ready_for_review" || draft.status === "approved") return await generateFinal(reply, draft, draft.version);
      if (draft.status === "generated") {
        // Same captures already generated: return the existing artifact; never render, upload or write a Doc twice.
        const current = await currentArtifactFor(draft);
        if (current) return { report: draft, artifact: current };
      }
      const dataBlockers = finalGenerationDataBlockers(draft, (await options.clientReportTargetsRepository.get(draft.client.id)).profile);
      if (dataBlockers.length) return reply.code(409).send({ error: "REPORT_DATA_DEFINITION_INCOMPLETE", message: `Final report generation is blocked: ${dataBlockers.map(({ message }) => message).join(" ")}`, blockers: dataBlockers });
      const verifiedTypes = await verifyAutomaticCaptureBytes(draft);
      const validated = applyAutomatedValidation(draft, verifiedTypes, { now: options.now() });
      // The cover values must be verified before the report changes state; nothing is saved or rendered otherwise.
      const cover = reportCover(validated);
      if (!cover.ok) return coverBlocked(reply, cover.issues);
      draft = await options.repository.saveWithLifecycleEvent(validated, draft.version, "AUTO_VALIDATE");
      return await generateFinal(reply, draft, draft.version);
    } catch (error) { return sendError(reply, error); }
  });

  /**
   * Throws ClientSetupIncompleteError unless the client's setup is READY; returns its configuration when enforced.
   * Uses the same shared validator the extension displays (`clientSetupBlockers`).
   */
  async function ensureClientSetupReady(clientId: string) {
    if (!options.requireClientSetupReady) return null;
    const [targets, all] = await Promise.all([options.clientReportTargetsRepository.get(clientId), options.clientReportTargetsRepository.list()]);
    const blockers = clientSetupBlockers(targets, all);
    if (blockers.length) throw new ClientSetupIncompleteError(clientId, blockers);
    return targets;
  }

  /** The front cover cannot be trusted: say exactly which value failed, and change nothing. */
  function coverBlocked(reply: FastifyReply, issues: readonly CoverIssue[]) {
    return reply.code(409).send({ error: "REPORT_COVER_METRICS_UNVERIFIED", message: `Final report generation is blocked until the cover values are verified: ${issues.map(({ metric, message }) => metric ? `${metric} — ${message}` : message).join(" ")}`, issues });
  }

  async function currentArtifactFor(draft: ReportDraft): Promise<ReportPdfArtifact | null> {
    try {
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      return await options.repository.getArtifactForFingerprint(draft.id, model.sourceFingerprint);
    } catch { return null; }
  }

  /** Re-reads every enabled automatic capture's stored PNG; any mismatch fails closed with the section named. */
  async function verifyAutomaticCaptureBytes(draft: ReportDraft): Promise<ScreenshotType[]> {
    const automatic = new Set(REPORT_CAPTURE_SPEC_V1.filter((spec) => spec.automationStatus === "auto" && spec.screenshotType && draft.sections[spec.key] !== undefined && draft.sections[spec.key] !== "disabled").map((spec) => spec.screenshotType as ScreenshotType));
    const verified: ScreenshotType[] = [];
    for (const type of automatic) {
      const shot = draft.screenshots.find((candidate) => candidate.type === type);
      if (!shot) throw new ReportDomainError("REQUIRED_SCREENSHOT_MISSING", `Automatic capture ${type} is missing; nothing was generated.`);
      if (shot.approved) continue;
      if (shot.captureOrigin !== "live_acceptance_import" || !shot.storageKey || !shot.sha256 || !shot.byteSize || !shot.periodConfirmed || !shot.sourceProof || draft.sections[screenshotSectionMapping[type]] === "disabled") {
        throw new ReportDomainError("REPORT_VALIDATION_FAILED", `Automatic capture ${type} has no verified saved evidence; nothing was generated.`);
      }
      const stored = await options.screenshotStorage.get(shot.storageKey);
      const bytes = stored?.bytes;
      const dimensions = bytes ? (() => { try { return inspectPng(bytes); } catch { return null; } })() : null;
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== shot.sha256 || bytes.length !== shot.byteSize || !dimensions || dimensions.width !== shot.width || dimensions.height !== shot.height) {
        throw new ReportDomainError("REQUIRED_SCREENSHOT_ASSET_MISSING", `Automatic capture ${type} failed stored-byte verification (hash, size or dimensions); nothing was generated.`);
      }
      verified.push(type);
    }
    return verified;
  }

  app.post<{ Params: { id: string } }>("/report-drafts/:id/events", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const { event, expectedVersion } = eventRequestSchema.parse(request.body);
      if (["START_GENERATION", "GENERATION_SUCCEEDED", "GENERATION_FAILED", "APPROVE"].includes(event)) {
        return reply.code(400).send({ error: "GENERATION_EVENT_MANAGED", message: "PDF generation lifecycle events are managed by the PDF generation endpoint." });
      }
      ensureExpectedVersion(draft.version, expectedVersion);
      if ((event === "SUBMIT_FOR_REVIEW" || event === "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW") && draft.status === "ready_for_review") return draft;
      const updated = applyReportEvent(draft, event as ReportEvent, { now: options.now() });
      return await options.repository.saveWithLifecycleEvent(updated, expectedVersion, event as ReportEvent);
    } catch (error) { return sendError(reply, error); }
  });
};

async function verifyListingScopeTarget(type: ReturnType<typeof parseScreenshotType>, clientId: string, proof: z.infer<typeof captureProofHeaderSchema>, repository: ClientReportTargetsRepository): Promise<void> {
  if (type !== "signup_form" && type !== "welcome_flow") return;
  const targets = await repository.get(clientId);
  const valid = type === "signup_form"
    ? targets.signupForms?.mode === "all" && proof.listingScope === "all_forms" && proof.configuredEntities.length === 0
    : targets.welcomeFlowListing?.mode === "email_welcome_flows" && proof.listingScope === "email_welcome_flows"
      && proof.configuredEntities.length === targets.welcomeFlowListing.flows.length
      && targets.welcomeFlowListing.flows.every((target) => proof.configuredEntities.some((entity) => entity.id === target.id && entity.name === target.name && entity.channel === "email"));
  if (!valid) throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Listing screenshot scope does not match the saved client targets.");
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ClientSetupIncompleteError) return reply.code(409).send({ error: error.code, message: error.message, clientId: error.clientId, blockers: error.blockers });
  if (error instanceof ZodError) return reply.code(400).send({ error: "INVALID_REQUEST", issues: error.issues });
  if (error instanceof ScreenshotStorageError) {
    const status = error.code === "SCREENSHOT_TOO_LARGE" ? 413
      : error.code === "SCREENSHOT_NOT_FOUND" ? 404
        : error.code === "STORAGE_ERROR" ? 500 : 400;
    const message = error.code === "STORAGE_ERROR" ? "Screenshot storage is unavailable." : error.message;
    return reply.code(status).send({ error: error.code, message });
  }
  if (error instanceof PdfArtifactStorageError) {
    const status = error.code === "PDF_ARTIFACT_NOT_FOUND" ? 404 : error.code === "PDF_ARTIFACT_INVALID" ? 400 : 500;
    return reply.code(status).send({ error: error.code, message: status === 500 ? "PDF artifact storage is unavailable." : error.message });
  }
  if (error instanceof ReportMonthMismatchError) return reply.code(409).send({ error: error.code, message: error.message, mismatches: error.mismatches });
  if (error instanceof ReportDocumentError) return reply.code(400).send({ error: error.code, message: error.message });
  if (error instanceof PdfRendererError) return reply.code(500).send({ error: "PDF_GENERATION_FAILED", message: "PDF generation failed. Please retry." });
  if (error instanceof ReportDomainError) {
    return reply.code(400).send({ error: error.code, message: error.message, validation: error.validation });
  }
  if (error instanceof ReportPersistenceError) {
    const status = error.code === "REPORT_NOT_FOUND" ? 404
      : error.code === "REPORT_VERSION_CONFLICT" || error.code === "REPORT_DRAFT_ALREADY_EXISTS" ? 409 : 500;
    const payload = status === 500
      ? { error: error.code, message: error.code === "DATABASE_UNAVAILABLE" ? "Report storage is unavailable."
        : error.code === "REPORT_DELETE_FAILED" ? "Report could not be deleted." : "Stored report data could not be processed." }
      : { error: error.code, message: error.message, ...error.details };
    return reply.code(status).send(payload);
  }
  throw error;
}

async function requirePreviewableDraft(repository: ReportDraftRepository, id: string) {
  const draft = await repository.getById(id);
  if (!draft) throw new ReportPersistenceError("REPORT_NOT_FOUND", "Report draft was not found.");
  if (draft.status !== "ready_for_review" && draft.status !== "generated" && draft.status !== "auto_validated") throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", "Report preview is available after capture review is complete.");
  return draft;
}

function parseScreenshotType(value: string) {
  const parsed = screenshotTypeSchema.safeParse(value);
  if (!parsed.success) throw new ScreenshotStorageError("INVALID_SCREENSHOT_TYPE", "Screenshot type is not recognized.");
  return parsed.data;
}

function normalizeSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  const source = new URL(value);
  source.search = "";
  source.hash = "";
  return source.toString();
}

function ensureExpectedVersion(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) {
    throw new ReportPersistenceError(
      "REPORT_VERSION_CONFLICT", "Report draft has changed since it was read.",
      { expectedVersion, currentVersion },
    );
  }
}

/** The canonical client profile is the only source of a report's client identity, timezone, and currency. */
async function resolveReportClient(requested: z.infer<typeof clientRequestSchema>, targets: ClientReportTargetsRepository) {
  const profile = (await targets.get(requested.id)).profile;
  if (profile && !profile.timezone) {
    return { ok: false as const, status: 400, error: "CLIENT_CONFIGURATION_REQUIRED", message: `Finish ${profile.name}'s client setup (timezone) before creating reports.` };
  }
  if (profile?.timezone) {
    if ((requested.name !== undefined && requested.name !== profile.name) || (requested.timezone !== undefined && requested.timezone !== profile.timezone)) {
      return { ok: false as const, status: 409, error: "CLIENT_CONFIGURATION_MISMATCH", message: `This client is configured as ${profile.name} (${profile.timezone}); a report cannot use different client details.` };
    }
    return { ok: true as const, value: { id: requested.id, name: profile.name, timezone: profile.timezone, currency: profile.currency } };
  }
  if (!requested.name || !requested.timezone) {
    return { ok: false as const, status: 400, error: "CLIENT_CONFIGURATION_REQUIRED", message: "Save the client's name and timezone once before creating reports." };
  }
  return { ok: true as const, value: { id: requested.id, name: requested.name, timezone: requested.timezone, currency: null } };
}

function ensureCaptureSourceAccepted(validation: ReturnType<typeof validateReportDraft>): void {
  const blockingCodes = new Set([
    "DUPLICATE_SCREENSHOT_SOURCE",
    "SCREENSHOT_SOURCE_PROOF_MISSING",
    "SCREENSHOT_SOURCE_IDENTITY_MISMATCH",
    "SCREENSHOT_SOURCE_PERIOD_MISMATCH",
  ]);
  if (validation.errors.some(({ code }) => blockingCodes.has(code))) {
    throw new ReportDomainError("REPORT_VALIDATION_FAILED", "Screenshot capture does not satisfy the capture correctness specification.", validation);
  }
}
