import {
  applyReportEvent, createReportDraft, ReportDomainError, upsertScreenshotMetadata,
  validateReportDraft, type ReportDraftRepository, type ReportEvent,
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
]) }).strict();

export const reportDraftRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/report-drafts", async (request, reply) => {
    try {
      const body = createRequestSchema.parse(request.body);
      const draft = createReportDraft({ ...body, client: { ...body.client, currency: null } }, { now: options.now() });
      const creationBlocker = draft.validation.errors.find(({ code }) =>
        code === "REPORT_MONTH_INCOMPLETE" || code === "INVALID_CLIENT_TIMEZONE");
      if (creationBlocker) return reply.code(400).send({ error: creationBlocker.code, message: creationBlocker.message });
      await options.repository.create(draft);
      return reply.code(201).send(draft);
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string } }>("/report-drafts/:id", async (request, reply) => {
    const draft = await options.repository.getById(request.params.id);
    return draft ?? reply.code(404).send({ error: "REPORT_DRAFT_NOT_FOUND" });
  });

  app.post<{ Params: { id: string } }>("/report-drafts/:id/validate", async (request, reply) => {
    const draft = await options.repository.getById(request.params.id);
    if (!draft) return reply.code(404).send({ error: "REPORT_DRAFT_NOT_FOUND" });
    return validateReportDraft(draft, { now: options.now() });
  });

  app.put<{ Params: { id: string; type: string } }>("/report-drafts/:id/screenshots/:type", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_DRAFT_NOT_FOUND" });
      const routeType = screenshotTypeSchema.parse(request.params.type);
      const screenshot = screenshotRecordSchema.parse(request.body);
      const updated = upsertScreenshotMetadata(draft, screenshot, routeType, { now: options.now() });
      await options.repository.save(updated);
      return updated;
    } catch (error) { return sendError(reply, error); }
  });

  app.post<{ Params: { id: string } }>("/report-drafts/:id/events", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_DRAFT_NOT_FOUND" });
      const { event } = eventRequestSchema.parse(request.body);
      const updated = applyReportEvent(draft, event as ReportEvent, { now: options.now() });
      await options.repository.save(updated);
      return updated;
    } catch (error) { return sendError(reply, error); }
  });
};

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) return reply.code(400).send({ error: "INVALID_REQUEST", issues: error.issues });
  if (error instanceof ReportDomainError) {
    return reply.code(400).send({ error: error.code, message: error.message, validation: error.validation });
  }
  throw error;
}
