import Fastify from "fastify";
import cors from "@fastify/cors";
import { InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository, type ClientReportTargetsRepository, type ReportDraftRepository } from "@tention/report-domain";
import { clientReportTargetRoutes } from "./routes/client-report-targets.js";
import { healthRoutes } from "./routes/health.js";
import { reportDraftRoutes } from "./routes/report-drafts.js";
import { localDevelopmentRoutes } from "./routes/local-development.js";
import { InMemoryScreenshotStorage, MAX_SCREENSHOT_BYTE_SIZE, type ScreenshotStorage } from "./storage/screenshot-storage.js";
import { InMemoryPdfArtifactStorage, type PdfArtifactStorage } from "./storage/pdf-artifact-storage.js";
import { PlaywrightPdfRenderer, type PdfRenderer } from "./reports/pdf-renderer.js";
import type { PdfDriveDelivery, ReportGoogleDocSync } from "./delivery/google-drive-delivery.js";

export interface AppOptions {
  logger?: boolean;
  repository?: ReportDraftRepository;
  clientReportTargetsRepository?: ClientReportTargetsRepository;
  now?: () => Date;
  allowedOrigins?: readonly string[];
  screenshotStorage?: ScreenshotStorage;
  pdfArtifactStorage?: PdfArtifactStorage;
  pdfRenderer?: PdfRenderer;
  /** Optional Google Drive archive copy of each generated PDF; absent means Drive delivery is not configured. */
  pdfDriveDelivery?: PdfDriveDelivery | null;
  /** Optional editable Google Doc copy of each generated report; absent means it is not configured. */
  googleDocSync?: ReportGoogleDocSync | null;
  enableLocalDevelopmentImports?: boolean;
  localImportRequiresPersistentStorage?: boolean;
  repositoryRoot?: string;
  /**
   * Reports, final PDFs, Drive and Doc delivery require a READY client setup. Defaults to true; only test fixtures that
   * exercise pre-onboarding report behaviour pass false.
   */
  requireClientSetupReady?: boolean;
}

export function buildApp(options: AppOptions = {}) {
  const clientReportTargetsRepository = options.clientReportTargetsRepository ?? new InMemoryClientReportTargetsRepository();
  const repository = options.repository ?? new InMemoryReportDraftRepository();
  const screenshotStorage = options.screenshotStorage ?? new InMemoryScreenshotStorage();
  const pdfArtifactStorage = options.pdfArtifactStorage ?? new InMemoryPdfArtifactStorage();
  const pdfRenderer = options.pdfRenderer ?? new PlaywrightPdfRenderer(process.env.REPORT_PDF_BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.REPORT_PDF_BROWSER_EXECUTABLE_PATH } : {});
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: MAX_SCREENSHOT_BYTE_SIZE });
  app.addContentTypeParser("image/png", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error, _request, reply) => {
    if (isBodyTooLargeError(error)) {
      return reply.code(413).send({ error: "SCREENSHOT_TOO_LARGE", message: "Screenshot image exceeds the 10 MB limit." });
    }
    if (isUnsupportedImageContentType(error)) {
      return reply.code(400).send({ error: "INVALID_SCREENSHOT_CONTENT", message: "Screenshot upload must use image/png." });
    }
    return reply.send(error);
  });
  const configuredOrigins = new Set(options.allowedOrigins ?? []);
  app.register(cors, {
    origin(origin, callback) {
      const allowed = origin === undefined || origin.startsWith("chrome-extension://") || configuredOrigins.has(origin);
      callback(null, allowed);
    },
  });
  app.get("/health", async () => ({ ok: true as const }));
  app.register(healthRoutes, { prefix: "/api/v1" });
  app.register(reportDraftRoutes, {
    prefix: "/api/v1",
    repository,
    clientReportTargetsRepository,
    screenshotStorage,
    pdfArtifactStorage,
    pdfRenderer,
    pdfDriveDelivery: options.pdfDriveDelivery ?? null,
    googleDocSync: options.googleDocSync ?? null,
    now: options.now ?? (() => new Date()),
    requireClientSetupReady: options.requireClientSetupReady ?? true,
  });
  app.register(clientReportTargetRoutes, {
    prefix: "/api/v1",
    repository: clientReportTargetsRepository,
    now: options.now ?? (() => new Date()),
  });
  if (options.enableLocalDevelopmentImports) {
    app.register(localDevelopmentRoutes, {
      prefix: "/api/v1/dev", repository,
      targetsRepository: clientReportTargetsRepository,
      screenshotStorage,
      persistentStorage: options.localImportRequiresPersistentStorage ?? false,
      pdfRenderer,
      pdfArtifactStorage,
      repositoryRoot: options.repositoryRoot ?? process.cwd(), now: options.now ?? (() => new Date()),
    });
  }
  return app;
}

function isBodyTooLargeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}
function isUnsupportedImageContentType(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
}
