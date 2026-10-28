import {
  applyReportEvent, createReportDraft, ReportDomainError, ReportPersistenceError,
  replacementInvalidatesCaptureReview, replaceScreenshotAndInvalidateCaptureReview,
  upsertScreenshotMetadata, validateReportDraft, type ClientReportTargetsRepository, type ReportDraftRepository, type ReportEvent,
} from "@tention/report-domain";
import {
  reportMonthSchema, screenshotRecordSchema, screenshotSourceProofSchema, screenshotTypeSchema, sectionConfigurationSchema,
} from "@tention/report-schema";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { inspectPng } from "../storage/png.js";
import { ScreenshotStorageError, type ScreenshotStorage } from "../storage/screenshot-storage.js";
import { PdfArtifactStorageError, type PdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import { buildReportDocumentModel, ReportDocumentError, renderReportHtml } from "../reports/report-document.js";
import { PdfRendererError, type PdfRenderer } from "../reports/pdf-renderer.js";
import { reportPdfArtifactSchema } from "@tention/report-schema";

interface RouteOptions { repository: ReportDraftRepository; clientReportTargetsRepository: ClientReportTargetsRepository; screenshotStorage: ScreenshotStorage; pdfArtifactStorage: PdfArtifactStorage; pdfRenderer: PdfRenderer; now: () => Date }

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
      const client = await resolveReportClient(body.client, options.clientReportTargetsRepository);
      if (!client.ok) return reply.code(client.status).send({ error: client.error, message: client.message });
      const draft = createReportDraft({ ...body, client: client.value }, { now: options.now() });
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
      const storageKeys = [...new Set(draft.screenshots.flatMap(({ storageKey }) => storageKey ? [storageKey] : []))];
      const artifactStorageKeys = (await options.repository.listArtifacts(draft.id)).map(({ storageKey }) => storageKey);
      await options.repository.delete(draft.id, expectedVersion);
      await Promise.all(storageKeys.map(async (storageKey) => {
        try { await options.screenshotStorage.delete(storageKey); }
        catch (error) { app.log.warn({ error, reportId: draft.id, storageKey }, "Report screenshot asset cleanup failed."); }
      }));
      await Promise.all(artifactStorageKeys.map((storageKey) => options.pdfArtifactStorage.delete(storageKey).catch((error) => app.log.warn({ error, reportId: draft.id, storageKey }, "Report PDF artifact cleanup failed."))));
      return { deleted: true };
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
      return reply.type("application/pdf").header("cache-control", "no-store").header("content-disposition", `${disposition}; filename="${pdfFilename(draft)}"`).send(bytes.bytes);
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/report-drafts/:id/generate", async (request, reply) => {
    let savedStorageKey: string | null = null;
    try {
      const body = z.object({ expectedVersion: z.number().int().positive() }).strict().parse(request.body);
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      ensureExpectedVersion(draft.version, body.expectedVersion);
      if (draft.status !== "ready_for_review" && draft.status !== "approved" && draft.status !== "failed") throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", "PDF generation is available only after capture review is complete.");
      const model = await buildReportDocumentModel(draft, options.screenshotStorage, options.now());
      const started = applyReportEvent(draft, "START_GENERATION", { now: options.now() });
      const generating = await options.repository.saveWithLifecycleEvent(started, body.expectedVersion, "START_GENERATION");
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
      return { report: stored, artifact };
    } catch (error) {
      if (savedStorageKey) await options.pdfArtifactStorage.delete(savedStorageKey).catch(() => undefined);
      return sendError(reply, error);
    }
  });

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
  if (draft.status !== "ready_for_review" && draft.status !== "generated") throw new ReportDomainError("ILLEGAL_REPORT_TRANSITION", "Report preview is available after capture review is complete.");
  return draft;
}
function pdfFilename(draft: { client: { name: string }; reportMonth: { year: number; month: number } }): string {
  const name = draft.client.name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Client";
  const month = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(draft.reportMonth.year, draft.reportMonth.month - 1, 1)));
  return `${name}-${month}-${draft.reportMonth.year}-Monthly-Report.pdf`;
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
  if (profile) {
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
