import { deriveClientId, getReportReadiness, ReportPersistenceError, type ClientReportTargetsRepository } from "@tention/report-domain";
import {
  clientReportTargetsInputSchema, clientSetupBlockers, clientSetupStatus, sectionConfigurationSchema,
  type ClientReportTargets, type ClientSetupSummary,
} from "@tention/report-schema";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z, ZodError } from "zod";

interface RouteOptions { repository: ClientReportTargetsRepository; now: () => Date }
const paramsSchema = z.object({ clientId: z.string().trim().min(1) }).strict();
const readinessBodySchema = z.object({ sections: sectionConfigurationSchema }).strict();
const newClientSchema = z.object({ name: z.string().trim().min(1, "Enter the client name.").max(120) }).strict();

/** Server-side setup status from the one shared validator; `all` is every saved client, for the metric-ID ownership check. */
function setupSummary(targets: ClientReportTargets, all: readonly ClientReportTargets[]): ClientSetupSummary {
  const blockers = clientSetupBlockers(targets, all);
  return { clientId: targets.clientId, name: targets.profile?.name ?? targets.clientId, status: clientSetupStatus(blockers), blockers, setup: targets };
}

export const clientReportTargetRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  /** Clients with a saved one-time profile, for monthly report selection. */
  app.get("/clients", async (_request, reply) => {
    try {
      const configured = (await options.repository.list()).filter(({ profile }) => profile !== null);
      return configured.sort((left, right) => left.profile!.name.localeCompare(right.profile!.name));
    } catch (error) { return sendError(reply, error); }
  });
  /** Every client with its setup status (READY / INCOMPLETE / ERROR) and the exact missing items. */
  app.get("/client-setups", async (_request, reply) => {
    try {
      const all = await options.repository.list();
      return all.filter(({ profile }) => profile !== null).map((targets) => setupSummary(targets, all)).sort((left, right) => left.name.localeCompare(right.name));
    } catch (error) { return sendError(reply, error); }
  });
  app.get<{ Params: { clientId: string } }>("/clients/:clientId/setup", async (request, reply) => {
    try {
      const clientId = paramsSchema.parse(request.params).clientId;
      const [targets, all] = await Promise.all([options.repository.get(clientId), options.repository.list()]);
      if (!targets.profile) return reply.code(404).send({ error: "CLIENT_NOT_FOUND", message: "This client has not been added." });
      return setupSummary(targets, all);
    } catch (error) { return sendError(reply, error); }
  });
  /** Step 1 of onboarding: one permanent client profile from its name. Everything else is verified afterwards. */
  app.post("/clients", async (request, reply) => {
    try {
      const { name } = newClientSchema.parse(request.body);
      let clientId: string;
      try { clientId = deriveClientId(name); } catch { return reply.code(400).send({ error: "INVALID_CLIENT_NAME", message: "Client name must contain at least one letter or number." }); }
      const existing = await options.repository.get(clientId);
      if (existing.profile) return reply.code(409).send({ error: "CLIENT_ALREADY_EXISTS", message: `${existing.profile.name} already exists.`, clientId });
      const saved = await options.repository.save(clientId, clientReportTargetsInputSchema.parse({
        businessReview: existing.businessReview, sourceUrls: existing.sourceUrls, primaryEmailList: existing.primaryEmailList, primarySmsList: existing.primarySmsList,
        welcomeFlow: existing.welcomeFlow, welcomeFlowListing: existing.welcomeFlowListing, customerSegment: existing.customerSegment, nonCustomerSegment: existing.nonCustomerSegment, signupForms: existing.signupForms,
        profile: { name, timezone: null, currency: null, conversionMetric: { label: "Placed Order", providerMetricId: null }, sections: null },
      }), options.now());
      return reply.code(201).send(setupSummary(saved, await options.repository.list()));
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
    const status = error.code === "DATABASE_UNAVAILABLE" ? 500 : error.code === "CONVERSION_METRIC_ID_ALREADY_BOUND" ? 409 : 400;
    return reply.code(status).send({ error: error.code, message: status === 500 ? "Client report target storage is unavailable." : error.message });
  }
  throw error;
}
