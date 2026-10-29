import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createScreenshotSourceProof, matchesReportCaptureSpec, REPORT_CAPTURE_SPEC_V1, TOP_CAMPAIGNS_LIMIT, TOP_FLOWS_LIMIT, screenshotRecordSchema, screenshotTypeSchema, type ScreenshotType } from "@tention/report-schema";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { enableEmailSubscriberGrowth, ReportDomainError, ReportPersistenceError, retireLegacyListGrowth, upsertScreenshotMetadata, type ClientReportTargetsRepository, type ReportDraftRepository } from "@tention/report-domain";
import type { ScreenshotStorage } from "../storage/screenshot-storage.js";
import type { PdfArtifactStorage } from "../storage/pdf-artifact-storage.js";
import { inspectPng } from "../storage/png.js";
import { importLatestLiveAcceptance, importLatestLiveSection } from "../reports/local-live-acceptance-import.js";
import { LIVE_ACCEPTANCE_IMPORT_TYPES } from "../reports/live-acceptance-artifacts.js";
import { renderCanonicalPartialReview } from "../reports/canonical-partial-review.js";
import { importCompletedAutomaticCaptureRun } from "../reports/import-automatic-capture-run.js";
import type { PdfRenderer } from "../reports/pdf-renderer.js";

interface RouteOptions {
  repository: ReportDraftRepository;
  targetsRepository: ClientReportTargetsRepository;
  screenshotStorage: ScreenshotStorage;
  persistentStorage: boolean;
  pdfRenderer: PdfRenderer;
  pdfArtifactStorage: PdfArtifactStorage;
  repositoryRoot: string;
  now: () => Date;
}

// This development-only bridge independently revalidates the captured files
// against the selected local client configuration.  Do not bind it to one
// account: doing so would make verified evidence for another configured
// account impossible to review through the normal product workflow.
const importRequest = z.object({
  clientId: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  reportMonth: z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12) }).strict(),
  section: z.enum(LIVE_ACCEPTANCE_IMPORT_TYPES).optional(),
}).strict();
const importedReviewRequest = z.object({ expectedVersion: z.number().int().positive(), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const autoRunStart = z.object({ runId: z.string().uuid(), reportId: z.string().uuid(), clientId: z.string().min(1).max(120), reportMonth: z.object({ year: z.number().int(), month: z.number().int().min(1).max(12) }).strict(), startedAt: z.string().datetime(), extensionBuild: z.string().max(64).optional(), mode: z.enum(["full", "resume"]).optional(), plannedSections: z.array(screenshotTypeSchema).min(1).max(20).optional() }).strict();
const autoRunSection = z.object({ status: z.enum(["running", "pass", "fail"]), attemptNumber: z.number().int().min(1).max(5), startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(), durationMs: z.number().int().nonnegative().nullable(), expectedUrl: z.string().max(2048).nullable(), observedUrl: z.string().max(2048).nullable(), expectedSourceIdentity: z.string().max(240).nullable(), observedSourceIdentity: z.string().max(240).nullable(), expectedPeriod: z.record(z.string(), z.string()).nullable(), observedPeriod: z.string().max(500).nullable(), expectedSemanticCard: z.string().max(160).nullable(), expectedView: z.string().max(160).nullable(), visibleControls: z.array(z.record(z.string(), z.unknown())).max(80), usableRowCount: z.number().int().nonnegative().nullable(), screenshotResult: z.string().max(100).nullable(), sourceProofResult: z.string().max(100).nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), errorCode: z.string().max(100).nullable(), errorMessage: z.string().max(1000).nullable(), diagnostics: z.record(z.string(), z.unknown()).nullable() }).strict();
const enableSectionRequest = z.object({ expectedVersion: z.number().int().positive() }).strict();
const autoRunFinish = z.object({ status: z.enum(["completed", "failed"]), finishedAt: z.string().datetime(), durationMs: z.number().int().nonnegative() }).strict();

/** Registered only by a non-production API bound to a loopback interface. */
export const localDevelopmentRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/retire-list-growth", async (_request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "LIST_GROWTH_RETIREMENT_REQUIRES_PERSISTENT_STORAGE", message: "List Growth retirement requires the persistent local report store." });
    try {
      const updated = [] as Array<{ id: string; clientId: string; version: number }>;
      for (const draft of await options.repository.list()) {
        if (draft.status === "generated" || !("list_growth" in draft.sections)) continue;
        const retired = retireLegacyListGrowth(draft, { now: options.now() });
        const saved = await options.repository.save(retired, draft.version);
        updated.push({ id: saved.id, clientId: saved.client.id, version: saved.version });
      }
      return { retiredCount: updated.length, reports: updated };
    } catch (error) {
      return reply.code(error instanceof ReportPersistenceError && error.code === "REPORT_VERSION_CONFLICT" ? 409 : 400).send({ error: error instanceof ReportPersistenceError ? error.code : "LIST_GROWTH_RETIREMENT_FAILED", message: error instanceof Error ? error.message : "List Growth retirement failed." });
    }
  });
  // Section 10 is opt-in per report: an existing draft gains it only through this explicit request. It never touches
  // legacy List Growth (still retired above) and never migrates any existing evidence.
  app.post<{ Params: { reportId: string } }>("/report-drafts/:reportId/sections/email_subscriber_growth/enable", async (request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "SECTION_CHANGE_REQUIRES_PERSISTENT_STORAGE", message: "Enabling Subscriber Growth requires the persistent local report store." });
    try {
      const { expectedVersion } = enableSectionRequest.parse(request.body);
      const draft = await options.repository.getById(request.params.reportId);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND", message: "Report draft was not found." });
      if (draft.version !== expectedVersion) return reply.code(409).send({ error: "REPORT_VERSION_CONFLICT", message: "The report changed; reload it and try again." });
      const enabled = enableEmailSubscriberGrowth(draft, { now: options.now() });
      return enabled === draft ? draft : await options.repository.save(enabled, draft.version);
    } catch (error) {
      return reply.code(error instanceof ReportPersistenceError && error.code === "REPORT_VERSION_CONFLICT" ? 409 : 400).send({ error: error instanceof ReportPersistenceError || error instanceof ReportDomainError ? error.code : "SUBSCRIBER_GROWTH_ENABLE_FAILED", message: error instanceof Error ? error.message : "Subscriber Growth could not be enabled." });
    }
  });
  app.post("/automatic-capture-runs", async (request, reply) => {
    try {
      if (!options.persistentStorage) return reply.code(503).send({ error: "LOCAL_ACCEPTANCE_REQUIRES_PERSISTENT_STORAGE", message: "Local automatic-capture diagnostics require PostgreSQL and filesystem storage." });
      const input = autoRunStart.parse(request.body);
      const report = await options.repository.getById(input.reportId);
      if (!report || report.client.id !== input.clientId || report.reportMonth.year !== input.reportMonth.year || report.reportMonth.month !== input.reportMonth.month) return reply.code(409).send({ error: "AUTOMATIC_RUN_REPORT_MISMATCH", message: "The run identity does not match the canonical persisted report." });
      // A run from an extension that was rebuilt but not reloaded in Chrome would test old code.
      const builtExtension = await currentExtensionBuild(options.repositoryRoot);
      if (builtExtension && input.extensionBuild !== builtExtension) return reply.code(409).send({ error: "EXTENSION_BUILD_STALE", message: `Chrome is running extension build ${input.extensionBuild ?? "(unstamped)"}, but the built extension is ${builtExtension}. Reload the extension in chrome://extensions, reopen the panel, and start again.`, runningBuild: input.extensionBuild ?? null, builtExtension });
      const directory = automaticRunDirectory(options.repositoryRoot, input.runId);
      await mkdir(join(directory, "sections"), { recursive: true });
      if (input.mode === "resume" && !input.plannedSections?.length) return reply.code(400).send({ error: "INVALID_AUTOMATIC_RUN", message: "A resume run must list its planned sections." });
      const run = { kind: "tention_local_automatic_capture", runId: input.runId, extensionBuild: input.extensionBuild ?? null, mode: input.mode ?? "full", ...(input.mode === "resume" ? { plannedSections: input.plannedSections } : {}), reportId: report.id, clientId: report.client.id, clientName: report.client.name, timezone: report.client.timezone, reportMonth: report.reportMonth, period: report.period, status: "running", startedAt: input.startedAt, finishedAt: null, durationMs: null, currentStep: null, sections: [] };
      await writeFile(join(directory, "results.json"), `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
      return reply.code(201).send(run);
    } catch (error) { return reply.code(400).send({ error: "INVALID_AUTOMATIC_RUN", message: error instanceof Error ? error.message : "Automatic run could not be created." }); }
  });
  app.post<{ Params: { runId: string; section: string } }>("/automatic-capture-runs/:runId/sections/:section", async (request, reply) => {
    try {
      if (!isAutomaticSection(request.params.section)) return reply.code(400).send({ error: "INVALID_AUTOMATIC_RUN_SECTION", message: "Section is not part of the supported automatic run." });
      const input = autoRunSection.parse(request.body);
      const file = automaticRunFile(options.repositoryRoot, request.params.runId);
      const run = await readAutomaticRun(file, request.params.runId);
      const prior = run.sections.find((item: { section: string }) => item.section === request.params.section) as { evidence?: any; evidenceByAttempt?: any[]; attempts?: unknown[] } | undefined;
      if (input.status === "pass") {
        const report = await options.repository.getById(run.reportId);
        const spec = REPORT_CAPTURE_SPEC_V1.find((item) => item.screenshotType === request.params.section);
        const expectedPeriod = report ? createScreenshotSourceProof(request.params.section as ScreenshotType, report.period).expectedPeriod : null;
        const observedPeriodProof = input.diagnostics?.observedPeriodProof as Record<string, unknown> | undefined;
        const attemptEvidence = prior?.evidenceByAttempt?.find((evidence) => evidence.attemptNumber === input.attemptNumber && evidence.kind === "capture");
        const evidence = attemptEvidence ?? (prior?.evidence?.attemptNumber === input.attemptNumber && prior.evidence.kind === "capture" ? prior.evidence : null);
        // Ranked sections keep the real count: Top 5 campaigns / Top 5 flows, or every row when fewer exist; never zero, never padded.
        const rowLimit = request.params.section === "top_campaigns" ? TOP_CAMPAIGNS_LIMIT : request.params.section === "top_flows" ? TOP_FLOWS_LIMIT : null;
        const usableRows = input.usableRowCount ?? 0;
        const includedRows = (input.diagnostics?.targetBounds as { includedRowCount?: unknown } | undefined)?.includedRowCount;
        // A rolling-window source (its spec has no calendar month) is proven by its own stated window and spec-matching
        // semantic evidence; every calendar-month source must prove its exact month (and comparison month).
        const rollingWindow = spec?.datePolicy === "ROLLING_30_DAY";
        const periodVerified = rollingWindow
          ? expectedPeriod === null && input.expectedPeriod === null && /\blast 30 days\b/i.test(input.observedPeriod ?? "") && matchesReportCaptureSpec(request.params.section as ScreenshotType, input.diagnostics?.sourceProof as never)
          : Boolean(expectedPeriod && input.expectedPeriod?.startDate === expectedPeriod.startDate && input.expectedPeriod?.endDate === expectedPeriod.endDate
            && observedPeriodProof?.startDate === expectedPeriod.startDate && observedPeriodProof?.endDate === expectedPeriod.endDate
            && (request.params.section !== "month_comparison" || (input.expectedPeriod?.comparisonStartDate === expectedPeriod.comparisonStartDate && input.expectedPeriod?.comparisonEndDate === expectedPeriod.comparisonEndDate
              && observedPeriodProof?.comparisonStartDate === expectedPeriod.comparisonStartDate && observedPeriodProof?.comparisonEndDate === expectedPeriod.comparisonEndDate)));
        if (!report || report.id !== run.reportId || report.client.id !== run.clientId || report.reportMonth.year !== run.reportMonth.year || report.reportMonth.month !== run.reportMonth.month
          || !spec || input.expectedSourceIdentity !== spec.sourceIdentity || input.observedSourceIdentity !== spec.sourceIdentity
          || input.sourceProofResult !== "PASS" || input.screenshotResult !== "fresh_semantic_crop_saved"
          || !input.sha256 || !evidence || evidence.sha256 !== input.sha256
          || !periodVerified
          || (request.params.section === "email_subscriber_growth" && (report.sections.email_subscriber_growth === undefined || !matchesReportCaptureSpec("email_subscriber_growth", input.diagnostics?.sourceProof as never)))
          || (rowLimit !== null && (usableRows < 1 || includedRows !== Math.min(rowLimit, usableRows)))) {
          return reply.code(409).send({ error: "AUTOMATIC_RUN_PASS_NOT_VERIFIED", message: "The section cannot pass until matching fresh evidence, source identity, period, and required rows are confirmed." });
        }
      }
      const sections = run.sections.filter((item: { section: string }) => item.section !== request.params.section);
      const attemptLog = [...(prior?.attempts ?? []).filter((entry: any) => entry.attemptNumber !== input.attemptNumber), redactDiagnostic(input)];
      sections.push({ section: request.params.section, ...redactDiagnostic(input), attempts: attemptLog, evidence: prior?.evidence ?? null, evidenceByAttempt: (prior as { evidenceByAttempt?: unknown[] } | undefined)?.evidenceByAttempt ?? [] });
      const currentStep = input.status === "running" ? request.params.section : run.currentStep === request.params.section ? null : run.currentStep;
      await writeFile(file, `${JSON.stringify({ ...run, currentStep, sections }, null, 2)}\n`);
      return { runId: run.runId, section: request.params.section, status: input.status, attemptNumber: input.attemptNumber };
    } catch (error) { return reply.code(400).send({ error: "AUTOMATIC_RUN_SECTION_SAVE_FAILED", message: error instanceof Error ? error.message : "Section result could not be saved." }); }
  });
  app.put<{ Params: { runId: string; section: string; kind: string }; Querystring: { attempt?: string } }>("/automatic-capture-runs/:runId/sections/:section/evidence/:kind", async (request, reply) => {
    try {
      const { runId, section, kind } = request.params;
      if (!isAutomaticSection(section) || !/^(capture|viewport)$/.test(kind)) return reply.code(400).send({ error: "INVALID_AUTOMATIC_RUN_EVIDENCE_TARGET", message: "Diagnostic evidence target is invalid." });
      const attemptNumber = Number(request.query.attempt ?? 1);
      if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 5) return reply.code(400).send({ error: "INVALID_AUTOMATIC_RUN_ATTEMPT", message: "Diagnostic attempt number is invalid." });
      const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.from([]);
      if (!bytes.length || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return reply.code(400).send({ error: "INVALID_AUTOMATIC_RUN_EVIDENCE", message: "Diagnostic evidence must be a PNG." });
      const dimensions = inspectPng(bytes);
      const directory = automaticRunDirectory(options.repositoryRoot, runId);
      const file = join(directory, "results.json");
      const run = await readAutomaticRun(file, runId);
      const fileName = `${section}-attempt-${attemptNumber}-${kind}.png`;
      await writeFile(join(directory, "sections", fileName), bytes);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const evidence = { attemptNumber, kind, file: `sections/${fileName}`, byteSize: bytes.length, width: dimensions.width, height: dimensions.height, sha256: hash };
      const sections = run.sections.map((item: { section: string; evidenceByAttempt?: unknown[] }) => item.section === section ? { ...item, evidence, evidenceByAttempt: [...(item.evidenceByAttempt ?? []).filter((prior: any) => prior.attemptNumber !== attemptNumber || prior.kind !== kind), evidence] } : item);
      await writeFile(file, `${JSON.stringify({ ...run, sections }, null, 2)}\n`);
      return { runId, section, kind, byteSize: bytes.length, sha256: hash };
    } catch (error) { return reply.code(400).send({ error: "AUTOMATIC_RUN_EVIDENCE_SAVE_FAILED", message: error instanceof Error ? error.message : "Diagnostic evidence could not be saved." }); }
  });
  app.post<{ Params: { runId: string } }>("/automatic-capture-runs/:runId/finish", async (request, reply) => {
    try {
      const input = autoRunFinish.parse(request.body);
      const file = automaticRunFile(options.repositoryRoot, request.params.runId);
      const run = await readAutomaticRun(file, request.params.runId);
      const result = { ...run, status: input.status, finishedAt: input.finishedAt, durationMs: input.durationMs, currentStep: null };
      await writeFile(file, `${JSON.stringify(result, null, 2)}\n`);
      return { runId: result.runId, status: result.status, finishedAt: result.finishedAt, durationMs: result.durationMs };
    } catch (error) { return reply.code(400).send({ error: "AUTOMATIC_RUN_FINISH_FAILED", message: error instanceof Error ? error.message : "Run could not be finalized." }); }
  });
  app.get<{ Params: { runId: string } }>("/automatic-capture-runs/:runId", async (request, reply) => {
    try { return await readAutomaticRun(automaticRunFile(options.repositoryRoot, request.params.runId), request.params.runId); }
    catch { return reply.code(404).send({ error: "AUTOMATIC_RUN_NOT_FOUND", message: "Local diagnostic run was not found." }); }
  });
  app.post<{ Params: { runId: string } }>("/automatic-capture-runs/:runId/import", async (request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "AUTOMATIC_RUN_IMPORT_REQUIRES_PERSISTENT_STORAGE", message: "Canonical automatic-run import requires PostgreSQL and filesystem screenshot storage." });
    try {
      return await importCompletedAutomaticCaptureRun({ repository: options.repository, screenshotStorage: options.screenshotStorage, repositoryRoot: options.repositoryRoot, runId: request.params.runId, now: options.now });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Automatic capture run import failed.";
      return reply.code(error instanceof ReportPersistenceError && error.code === "REPORT_VERSION_CONFLICT" ? 409 : 400).send({ error: error instanceof ReportPersistenceError ? error.code : "AUTOMATIC_RUN_IMPORT_REJECTED", message });
    }
  });
  app.post("/live-acceptance/import", async (request, reply) => {
    const parsed = importRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "INVALID_LOCAL_IMPORT_REQUEST", message: "Provide a configured client ID and a valid report month." });
    if (!options.persistentStorage) return reply.code(503).send({ error: "LOCAL_IMPORT_REQUIRES_PERSISTENT_STORAGE", message: "The local import endpoint is disabled unless PostgreSQL and filesystem screenshot storage are configured." });
    try {
      const importOptions = {
        repository: options.repository, targetsRepository: options.targetsRepository,
        screenshotStorage: options.screenshotStorage, repositoryRoot: options.repositoryRoot,
        now: options.now, ...parsed.data,
      };
      return parsed.data.section
        ? await importLatestLiveSection(importOptions, parsed.data.section)
        : await importLatestLiveAcceptance(importOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Local live acceptance import failed.";
      return reply.code(400).send({ error: "LOCAL_LIVE_ACCEPTANCE_IMPORT_REJECTED", message });
    }
  });
  app.get<{ Params: { reportId: string; type: string } }>("/report-drafts/:reportId/screenshots/:type/pending-image", async (request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "LOCAL_REVIEW_REQUIRES_PERSISTENT_STORAGE", message: "Imported screenshot review requires persistent local storage." });
    try {
      const { draft, screenshot, bytes } = await loadPendingImport(options.repository, options.screenshotStorage, request.params.reportId, request.params.type);
      return reply.type("image/png").header("cache-control", "no-store").header("x-report-id", draft.id).header("x-screenshot-type", screenshot.type).header("x-screenshot-sha256", screenshot.sha256!).send(bytes);
    } catch (error) {
      return reply.code(400).send({ error: "IMPORTED_SCREENSHOT_REVIEW_REJECTED", message: error instanceof Error ? error.message : "Imported screenshot could not be reviewed." });
    }
  });
  app.post<{ Params: { reportId: string; type: string } }>("/report-drafts/:reportId/screenshots/:type/review", async (request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "LOCAL_REVIEW_REQUIRES_PERSISTENT_STORAGE", message: "Imported screenshot review requires persistent local storage." });
    try {
      const { expectedVersion, expectedSha256 } = importedReviewRequest.parse(request.body);
      const { draft, screenshot, bytes } = await loadPendingImport(options.repository, options.screenshotStorage, request.params.reportId, request.params.type);
      if (draft.version !== expectedVersion) return reply.code(409).send({ error: "REPORT_VERSION_CONFLICT", message: "The report changed while this imported screenshot was being reviewed." });
      if (screenshot.sha256 !== expectedSha256 || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) return reply.code(409).send({ error: "SCREENSHOT_SHA256_MISMATCH", message: "The imported screenshot changed while it was being reviewed." });
      const reviewedAt = options.now();
      const reviewed = { ...screenshot, approved: true, approvedAt: reviewedAt.toISOString() };
      const updated = upsertScreenshotMetadata(draft, reviewed, screenshot.type, { now: reviewedAt });
      const saved = await options.repository.save(updated, expectedVersion);
      const persisted = saved.screenshots.find(({ type }) => type === screenshot.type);
      if (!persisted || persisted.id !== screenshot.id || persisted.sha256 !== expectedSha256 || !persisted.approved || persisted.captureOrigin !== "live_acceptance_import") {
        return reply.code(500).send({ error: "IMPORTED_REVIEW_PERSISTENCE_FAILED", message: "The canonical report did not confirm the reviewed screenshot." });
      }
      return { reportId: saved.id, screenshotType: screenshot.type, screenshotRecordId: persisted.id, approvalStatus: "approved" as const, sha256: persisted.sha256!, sourceProofAccepted: true as const, report: saved };
    } catch (error) {
      if (error instanceof ReportPersistenceError && error.code === "REPORT_VERSION_CONFLICT") {
        return reply.code(409).send({ error: error.code, message: "The report changed while this imported screenshot was being reviewed. Reload the canonical report and try again." });
      }
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "INVALID_IMPORTED_REVIEW_REQUEST", message: "Review request did not include a valid report version and SHA-256." });
      return reply.code(400).send({ error: "IMPORTED_SCREENSHOT_REVIEW_REJECTED", message: error instanceof Error ? error.message : "Imported screenshot could not be approved." });
    }
  });
  app.post<{ Params: { reportId: string } }>("/report-drafts/:reportId/partial-review", async (request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "LOCAL_REVIEW_REQUIRES_PERSISTENT_STORAGE", message: "Canonical local review requires PostgreSQL and configured screenshot storage." });
    if (!/^[0-9a-f-]{36}$/i.test(request.params.reportId)) return reply.code(400).send({ error: "INVALID_REPORT_ID", message: "A canonical report UUID is required." });
    try {
      return await renderCanonicalPartialReview({ repository: options.repository, screenshotStorage: options.screenshotStorage, pdfArtifactStorage: options.pdfArtifactStorage, pdfRenderer: options.pdfRenderer, repositoryRoot: options.repositoryRoot, reportId: request.params.reportId, now: options.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Canonical partial review rendering failed.";
      return reply.code(400).send({ error: "CANONICAL_PARTIAL_REVIEW_REJECTED", message });
    }
  });
  app.get<{ Params: { reportId: string }; Querystring: { download?: string } }>("/report-drafts/:reportId/partial-review/status", async (request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "LOCAL_REVIEW_REQUIRES_PERSISTENT_STORAGE", message: "Development review PDF access requires PostgreSQL and filesystem screenshot storage." });
    try {
      const current = await readCurrentPartialReview(options.repositoryRoot, options.repository, options.pdfArtifactStorage, request.params.reportId);
      return current.status;
    } catch (error) {
      const status = error instanceof PartialReviewArtifactError ? error.status : 400;
      return reply.code(status).send({ error: error instanceof PartialReviewArtifactError ? error.code : "PARTIAL_REVIEW_STATUS_FAILED", message: error instanceof Error ? error.message : "Development review PDF status could not be loaded." });
    }
  });
  app.get<{ Params: { reportId: string }; Querystring: { download?: string } }>("/report-drafts/:reportId/partial-review/pdf", async (request, reply) => {
    if (!options.persistentStorage) return reply.code(503).send({ error: "LOCAL_REVIEW_REQUIRES_PERSISTENT_STORAGE", message: "Development review PDF access requires PostgreSQL and filesystem screenshot storage." });
    try {
      const current = await readCurrentPartialReview(options.repositoryRoot, options.repository, options.pdfArtifactStorage, request.params.reportId);
      const bytes = current.bytes;
      if (bytes.length !== current.status.byteSize || createHash("sha256").update(bytes).digest("hex") !== current.status.sha256 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
        return reply.code(409).send({ error: "PDF_REVIEW_ARTIFACT_INVALID", message: "The saved development review PDF did not match its recorded checksum." });
      }
      const disposition = request.query.download === "1" ? "attachment" : "inline";
      return reply.type("application/pdf").header("cache-control", "no-store")
        .header("content-disposition", `${disposition}; filename=\"${current.status.fileName}\"`)
        .header("x-report-id", current.status.reportId).header("x-report-version", String(current.status.reportVersion))
        .header("x-review-pdf-sha256", current.status.sha256).send(bytes);
    } catch (error) {
      const status = error instanceof PartialReviewArtifactError ? error.status : 400;
      return reply.code(status).send({ error: error instanceof PartialReviewArtifactError ? error.code : "PARTIAL_REVIEW_PDF_UNAVAILABLE", message: error instanceof Error ? error.message : "Development review PDF could not be opened." });
    }
  });
};

class PartialReviewArtifactError extends Error {
  constructor(public readonly code: "INVALID_REPORT_ID" | "REPORT_NOT_FOUND" | "PDF_REVIEW_NOT_GENERATED" | "PDF_REVIEW_STALE" | "PDF_REVIEW_ARTIFACT_INVALID", public readonly status: number, message: string) { super(message); }
}

async function readCurrentPartialReview(repositoryRoot: string, repository: ReportDraftRepository, pdfArtifactStorage: PdfArtifactStorage, reportId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(reportId)) throw new PartialReviewArtifactError("INVALID_REPORT_ID", 400, "A canonical report UUID is required.");
  const draft = await repository.getById(reportId);
  if (!draft) throw new PartialReviewArtifactError("REPORT_NOT_FOUND", 404, "The canonical report draft was not found.");
  const clientSlug = safeReviewPathSegment(draft.client.id);
  const monthSlug = `${draft.reportMonth.year}-${String(draft.reportMonth.month).padStart(2, "0")}`;
  const directory = join(repositoryRoot, "output/live-review", clientSlug, monthSlug);
  const pdfPath = join(directory, `${safeReviewFileLabel(draft.client.name)}-${monthSlug}-PARTIAL-REVIEW.pdf`);
  let result: any;
  try { result = JSON.parse(await readFile(join(directory, "review-results.json"), "utf8")); }
  catch { throw new PartialReviewArtifactError("PDF_REVIEW_NOT_GENERATED", 404, "Generate the development review PDF before opening or downloading it."); }
  if ((result.reportId ?? result.canonicalReportId) !== draft.id || (result.clientId !== undefined && result.clientId !== draft.client.id)
    || (result.reportMonth !== undefined && (result.reportMonth.year !== draft.reportMonth.year || result.reportMonth.month !== draft.reportMonth.month))
    || result.developmentOnly !== true || result.finalClientArtifact !== false || result.pdf?.path !== pdfPath) {
    throw new PartialReviewArtifactError("PDF_REVIEW_NOT_GENERATED", 404, "No development review PDF exists for this canonical report.");
  }
  if (draft.status !== "draft" || result.reportLifecycle?.status !== draft.status || result.reportLifecycle?.version !== draft.version) {
    throw new PartialReviewArtifactError("PDF_REVIEW_STALE", 409, "The report changed after this development review PDF was generated. Generate a fresh review PDF.");
  }
  const status = {
    reportId: draft.id,
    reportVersion: draft.version,
    fileName: result.pdf.fileName ?? `${safeReviewFileLabel(draft.client.name)}-${monthSlug}-Performance-Review.pdf`,
    byteSize: result.pdf.byteSize,
    sha256: result.pdf.sha256,
    physicalPageCount: result.pdf.physicalPageCount,
    developmentOnly: true as const,
  };
  if (!Number.isSafeInteger(status.byteSize) || status.byteSize <= 0 || !/^[a-f0-9]{64}$/.test(status.sha256) || !Number.isSafeInteger(status.physicalPageCount) || status.physicalPageCount <= 0) {
    throw new PartialReviewArtifactError("PDF_REVIEW_NOT_GENERATED", 404, "The saved development review PDF metadata is incomplete.");
  }
  if (typeof result.pdf.storageKey !== "string") throw new PartialReviewArtifactError("PDF_REVIEW_NOT_GENERATED", 404, "The development review PDF is not available in configured artifact storage.");
  const asset = await pdfArtifactStorage.get(result.pdf.storageKey);
  if (!asset) throw new PartialReviewArtifactError("PDF_REVIEW_NOT_GENERATED", 404, "The development review PDF is missing from configured artifact storage.");
  if (asset.byteSize !== status.byteSize || asset.sha256 !== status.sha256 || createHash("sha256").update(asset.bytes).digest("hex") !== status.sha256) throw new PartialReviewArtifactError("PDF_REVIEW_ARTIFACT_INVALID", 409, "The saved development review PDF does not match its recorded checksum.");
  return { status, pdfPath, bytes: asset.bytes };
}

function safeReviewPathSegment(value: string): string {
  const segment = value.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!segment) throw new PartialReviewArtifactError("PDF_REVIEW_NOT_GENERATED", 404, "The report identity cannot resolve a safe review artifact path.");
  return segment;
}
function safeReviewFileLabel(value: string): string {
  const withoutDomainSuffix = value.replace(/\.com$/i, "");
  const label = withoutDomainSuffix.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!label) throw new PartialReviewArtifactError("PDF_REVIEW_NOT_GENERATED", 404, "The client name cannot resolve a safe review artifact filename.");
  return label;
}

async function loadPendingImport(repository: ReportDraftRepository, storage: ScreenshotStorage, reportId: string, rawType: string) {
  const typeResult = screenshotTypeSchema.safeParse(rawType);
  if (!typeResult.success) throw new Error("Screenshot type is not supported.");
  const type: ScreenshotType = typeResult.data;
  const draft = await repository.getById(reportId);
  if (!draft) throw new Error("The report draft needed for imported evidence review was not found.");
  const screenshot = draft.screenshots.find((candidate) => candidate.type === type);
  if (!screenshot || screenshot.clientId !== draft.client.id || screenshot.reportMonth.year !== draft.reportMonth.year || screenshot.reportMonth.month !== draft.reportMonth.month
    || screenshot.captureOrigin !== "live_acceptance_import" || screenshot.approved || screenshot.approvedAt !== null || !screenshot.storageKey
    || screenshot.mimeType !== "image/png" || !screenshot.sha256 || !screenshot.periodConfirmed || !screenshot.sourceProof) throw new Error("No pending live-acceptance screenshot is available for review.");
  const expectedProof = createScreenshotSourceProof(type, draft.period, undefined, null, type === "email_subscriber_growth" ? screenshot.sourceProof.subscriberGrowth ?? null : null);
  if (!matchesReportCaptureSpec(type, screenshot.sourceProof) || JSON.stringify(screenshot.sourceProof) !== JSON.stringify(expectedProof)) throw new Error("Imported screenshot source proof or period is stale or invalid.");
  if (draft.screenshots.some((candidate) => candidate.type !== type && candidate.sha256 === screenshot.sha256)) throw new Error("Imported screenshot duplicates another report section.");
  const asset = await storage.get(screenshot.storageKey);
  if (!asset || asset.byteSize !== screenshot.byteSize || asset.sha256 !== screenshot.sha256 || createHash("sha256").update(asset.bytes).digest("hex") !== screenshot.sha256) throw new Error("Stored imported screenshot does not match its recorded size and SHA-256.");
  const dimensions = inspectPng(asset.bytes);
  if (dimensions.width !== screenshot.width || dimensions.height !== screenshot.height) throw new Error("Stored imported screenshot dimensions do not match its metadata.");
  return { draft, screenshot, bytes: asset.bytes };
}

const automaticSections = new Set(["overview", "top_campaigns", "top_flows", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability", "email_subscriber_growth"]);
function isAutomaticSection(value: string): boolean { return automaticSections.has(value); }
function automaticRunDirectory(root: string, runId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) throw new Error("Diagnostic run ID is invalid.");
  return join(root, "output", "extension-automatic-acceptance", runId);
}
function automaticRunFile(root: string, runId: string): string { return join(automaticRunDirectory(root, runId), "results.json"); }
async function readAutomaticRun(file: string, expectedRunId: string): Promise<any> {
  const run = JSON.parse(await readFile(file, "utf8"));
  if (run.kind !== "tention_local_automatic_capture" || run.runId !== expectedRunId || !Array.isArray(run.sections)) throw new Error("Diagnostic run record is invalid.");
  return run;
}
async function currentExtensionBuild(repositoryRoot: string): Promise<string | null> {
  try {
    const stamp = JSON.parse(await readFile(join(repositoryRoot, "apps/extension/dist/build.json"), "utf8")) as { build?: unknown };
    return typeof stamp.build === "string" ? stamp.build : null;
  } catch { return null; }
}

function redactDiagnostic<T>(value: T): T {
  const redactText = (text: string): string => text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    // Typed failure codes (UPPER_SNAKE_CASE) are diagnostics, not secrets; anything else this long is redacted.
    .replace(/\b(?:bearer\s+)?[A-Za-z0-9_-]{32,}\b/gi, (match) => /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(match) ? match : "[redacted-token]")
    .replace(/([?&](?:token|key|secret|code|auth|session|signature|sig)=)[^&#\s]*/gi, "$1[redacted]")
    .replace(/https:\/\/[^\s"'<>]+/gi, (url) => { try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`; } catch { return "[redacted-url]"; } });
  const visit = (item: unknown, depth: number, key = ""): unknown => {
    if (depth > 12) return "[truncated]";
    if (typeof item === "string") return (key === "sha256" ? item : redactText(item)).slice(0, 24_000);
    if (Array.isArray(item)) return item.slice(0, 100).map((child) => visit(child, depth + 1));
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item as Record<string, unknown>).slice(0, 200).map(([childKey, child]) => [childKey, /cookie|token|secret|password|authorization|localstorage|sessionstorage/i.test(childKey) ? "[redacted]" : visit(child, depth + 1, childKey)]));
    return item;
  };
  const safe = visit(value, 0);
  const serialized = JSON.stringify(safe);
  if (serialized.length > 1_500_000) throw new Error("Redacted diagnostics exceed the local storage limit.");
  return safe as T;
}
