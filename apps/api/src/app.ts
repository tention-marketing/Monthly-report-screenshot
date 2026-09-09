import Fastify from "fastify";
import { InMemoryReportDraftRepository, type ReportDraftRepository } from "@tention/report-domain";
import { healthRoutes } from "./routes/health.js";
import { reportDraftRoutes } from "./routes/report-drafts.js";

export interface AppOptions {
  logger?: boolean;
  repository?: ReportDraftRepository;
  now?: () => Date;
}

export function buildApp(options: AppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  app.get("/health", async () => ({ ok: true as const }));
  app.register(healthRoutes, { prefix: "/api/v1" });
  app.register(reportDraftRoutes, {
    prefix: "/api/v1",
    repository: options.repository ?? new InMemoryReportDraftRepository(),
    now: options.now ?? (() => new Date()),
  });
  return app;
}
