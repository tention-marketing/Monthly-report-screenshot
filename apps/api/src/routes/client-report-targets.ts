import { getReportReadiness, ReportPersistenceError, type ClientReportTargetsRepository } from "@tention/report-domain";
import { clientReportTargetsInputSchema, sectionConfigurationSchema } from "@tention/report-schema";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z, ZodError } from "zod";

interface RouteOptions { repository: ClientReportTargetsRepository; now: () => Date }
const paramsSchema = z.object({ clientId: z.string().trim().min(1) }).strict();
const readinessBodySchema = z.object({ sections: sectionConfigurationSchema }).strict();

export const clientReportTargetRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  /** Clients with a saved one-time profile, for monthly report selection. */
  app.get("/clients", async (_request, reply) => {
    try {
      const configured = (await options.repository.list()).filter(({ profile }) => profile !== null);
      return configured.sort((left, right) => left.profile!.name.localeCompare(right.profile!.name));
    } catch (error) { return sendError(reply, error); }
  });
  app.get<{ Params: { clientId: string } }>("/clients/:clientId/report-targets", async (request, reply) => {
    try { return await options.repository.get(paramsSchema.parse(request.params).clientId); }
    catch (error) { return sendError(reply, error); }
  });
  app.put<{ Params: { clientId: string } }>("/clients/:clientId/report-targets", async (request, reply) => {
    try {
      const clientId = paramsSchema.parse(request.params).clientId;
      const input = clientReportTargetsInputSchema.parse(request.body);
      return await options.repository.save(clientId, input, options.now());
    } catch (error) { return sendError(reply, error); }
  });
  app.post<{ Params: { clientId: string } }>("/clients/:clientId/report-readiness", async (request, reply) => {
    try {
      const clientId = paramsSchema.parse(request.params).clientId;
      const { sections } = readinessBodySchema.parse(request.body);
      return getReportReadiness(await options.repository.get(clientId), sections);
    } catch (error) { return sendError(reply, error); }
  });
};

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return reply.code(400).send({ error: "INVALID_REPORT_TARGETS", message: "Client report targets are invalid.", issues: error.issues });
  if (error instanceof ReportPersistenceError) {
    const status = error.code === "DATABASE_UNAVAILABLE" ? 500 : 400;
    return reply.code(status).send({ error: error.code, message: status === 500 ? "Client report target storage is unavailable." : error.message });
  }
  throw error;
}
