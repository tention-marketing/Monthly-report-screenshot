import Fastify from "fastify";
import cors from "@fastify/cors";
import { InMemoryReportDraftRepository, type ReportDraftRepository } from "@tention/report-domain";
import { healthRoutes } from "./routes/health.js";
import { reportDraftRoutes } from "./routes/report-drafts.js";

export interface AppOptions {
  logger?: boolean;
  repository?: ReportDraftRepository;
  now?: () => Date;
  allowedOrigins?: readonly string[];
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
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
    now: options.now ?? (() => new Date()),
  });
  return app;
}
