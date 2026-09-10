import Fastify from "fastify";
import cors from "@fastify/cors";
import { InMemoryReportDraftRepository, type ReportDraftRepository } from "@tention/report-domain";
import { healthRoutes } from "./routes/health.js";
import { reportDraftRoutes } from "./routes/report-drafts.js";
import { InMemoryScreenshotStorage, MAX_SCREENSHOT_BYTE_SIZE, type ScreenshotStorage } from "./storage/screenshot-storage.js";

export interface AppOptions {
  logger?: boolean;
  repository?: ReportDraftRepository;
  now?: () => Date;
  allowedOrigins?: readonly string[];
  screenshotStorage?: ScreenshotStorage;
}

export function buildApp(options: AppOptions = {}) {
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
    repository: options.repository ?? new InMemoryReportDraftRepository(),
    screenshotStorage: options.screenshotStorage ?? new InMemoryScreenshotStorage(),
    now: options.now ?? (() => new Date()),
  });
  return app;
}

function isBodyTooLargeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_BODY_TOO_LARGE";
}
function isUnsupportedImageContentType(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE";
}
