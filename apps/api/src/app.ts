import Fastify from "fastify";
import { healthRoutes } from "./routes/health.js";

export function buildApp(options: { logger?: boolean } = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  app.get("/health", async () => ({ ok: true as const }));
  app.register(healthRoutes, { prefix: "/api/v1" });
  return app;
}
