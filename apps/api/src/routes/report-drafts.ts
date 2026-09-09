import {
  applyReportEvent, createReportDraft, ReportDomainError, ReportPersistenceError,
  upsertScreenshotMetadata, validateReportDraft, type ReportDraftRepository, type ReportEvent,
} from "@tention/report-domain";
import {
  reportMonthSchema, screenshotRecordSchema, screenshotTypeSchema, sectionConfigurationSchema,
} from "@tention/report-schema";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z, ZodError } from "zod";

interface RouteOptions { repository: ReportDraftRepository; now: () => Date }

const clientRequestSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), timezone: z.string().min(1),
}).strict();
const createRequestSchema = z.object({
  client: clientRequestSchema, reportMonth: reportMonthSchema, sections: sectionConfigurationSchema,
}).strict();
const eventRequestSchema = z.object({ event: z.enum([
  "START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "DATA_FETCH_FAILED", "MARK_CAPTURES_INCOMPLETE",
  "SUBMIT_FOR_REVIEW", "APPROVE", "START_GENERATION", "GENERATION_SUCCEEDED",
  "GENERATION_FAILED", "RESET_TO_DRAFT",
]), expectedVersion: z.number().int().positive() }).strict();
const screenshotMutationSchema = z.object({
  expectedVersion: z.number().int().positive(), screenshot: screenshotRecordSchema,
}).strict();

export const reportDraftRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/report-drafts", async (request, reply) => {
    try {
      const body = createRequestSchema.parse(request.body);
      const draft = createReportDraft({ ...body, client: { ...body.client, currency: null } }, { now: options.now() });
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

  app.put<{ Params: { id: string; type: string } }>("/report-drafts/:id/screenshots/:type", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const routeType = screenshotTypeSchema.parse(request.params.type);
      const { expectedVersion, screenshot } = screenshotMutationSchema.parse(request.body);
      ensureExpectedVersion(draft.version, expectedVersion);
      const updated = upsertScreenshotMetadata(draft, screenshot, routeType, { now: options.now() });
      return await options.repository.save(updated, expectedVersion);
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/report-drafts/:id/events", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const { event, expectedVersion } = eventRequestSchema.parse(request.body);
      ensureExpectedVersion(draft.version, expectedVersion);
      const updated = applyReportEvent(draft, event as ReportEvent, { now: options.now() });
      return await options.repository.saveWithLifecycleEvent(updated, expectedVersion, event as ReportEvent);
    } catch (error) { return sendError(reply, error); }
  });
};

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return reply.code(400).send({ error: "INVALID_REQUEST", issues: error.issues });
  if (error instanceof ReportDomainError) {
    return reply.code(400).send({ error: error.code, message: error.message, validation: error.validation });
  }
  if (error instanceof ReportPersistenceError) {
    const status = error.code === "REPORT_NOT_FOUND" ? 404
      : error.code === "REPORT_VERSION_CONFLICT" || error.code === "REPORT_DRAFT_ALREADY_EXISTS" ? 409 : 500;
    const payload = status === 500
      ? { error: error.code, message: error.code === "DATABASE_UNAVAILABLE" ? "Report storage is unavailable." : "Stored report data could not be processed." }
      : { error: error.code, message: error.message, ...error.details };
    return reply.code(status).send(payload);
  }
  throw error;
}

function ensureExpectedVersion(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) {
    throw new ReportPersistenceError(
      "REPORT_VERSION_CONFLICT", "Report draft has changed since it was read.",
      { expectedVersion, currentVersion },
    );
  }
}
