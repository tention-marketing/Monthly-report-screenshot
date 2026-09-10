import {
  applyReportEvent, createReportDraft, ReportDomainError, ReportPersistenceError,
  upsertScreenshotMetadata, validateReportDraft, type ReportDraftRepository, type ReportEvent,
} from "@tention/report-domain";
import {
  reportMonthSchema, screenshotRecordSchema, screenshotTypeSchema, sectionConfigurationSchema,
} from "@tention/report-schema";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { z, ZodError } from "zod";
import { inspectPng } from "../storage/png.js";
import { ScreenshotStorageError, type ScreenshotStorage } from "../storage/screenshot-storage.js";

interface RouteOptions { repository: ReportDraftRepository; screenshotStorage: ScreenshotStorage; now: () => Date }

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
const imageUploadHeadersSchema = z.object({
  "x-expected-version": z.coerce.number().int().positive(),
  "x-period-confirmed": z.literal("true"),
  "x-source-url": z.string().url().optional(),
}).passthrough();
const listQuerySchema = z.object({
  clientId: z.string().min(1).optional(),
  year: z.coerce.number().int().min(2000).max(9999).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
}).strict();

export const reportDraftRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get("/report-drafts", async (request, reply) => {
    try {
      const query = listQuerySchema.parse(request.query);
      const drafts = (await options.repository.list())
        .filter((draft) => query.clientId === undefined || draft.client.id === query.clientId)
        .filter((draft) => query.year === undefined || draft.reportMonth.year === query.year)
        .filter((draft) => query.month === undefined || draft.reportMonth.month === query.month)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
      return drafts;
    } catch (error) { return sendError(reply, error); }
  });

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

  app.put<{ Params: { id: string; type: string }; Body: Buffer }>("/report-drafts/:id/screenshots/:type/image", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const routeType = parseScreenshotType(request.params.type);
      const headers = imageUploadHeadersSchema.parse(request.headers);
      if (!Buffer.isBuffer(request.body)) throw new ScreenshotStorageError("INVALID_SCREENSHOT_CONTENT", "Screenshot upload must contain PNG bytes.");
      const dimensions = inspectPng(request.body);
      const expectedVersion = headers["x-expected-version"];
      ensureExpectedVersion(draft.version, expectedVersion);
      const capturedAt = options.now().toISOString();
      const assetId = crypto.randomUUID();
      const storageKey = `reports/${draft.id}/${routeType}/${assetId}.png`;
      const previous = draft.screenshots.find(({ type }) => type === routeType);
      let savedStorageKey: string | null = null;
      try {
        const asset = await options.screenshotStorage.put(storageKey, request.body);
        savedStorageKey = asset.storageKey;
        const screenshot = screenshotRecordSchema.parse({
          id: assetId, clientId: draft.client.id, reportMonth: draft.reportMonth, type: routeType,
          capturedAt, sourceUrl: normalizeSourceUrl(headers["x-source-url"]),
          width: dimensions.width, height: dimensions.height, approved: true, approvedAt: capturedAt,
          periodConfirmed: true, storageKey: asset.storageKey, mimeType: "image/png",
          byteSize: asset.byteSize, sha256: asset.sha256,
        });
        const updated = upsertScreenshotMetadata(draft, screenshot, routeType, { now: options.now() });
        const saved = await options.repository.save(updated, expectedVersion);
        if (previous?.storageKey && previous.storageKey !== asset.storageKey) {
          void options.screenshotStorage.delete(previous.storageKey).catch(() => undefined);
        }
        return saved;
      } catch (error) {
        if (savedStorageKey) await options.screenshotStorage.delete(savedStorageKey).catch(() => undefined);
        throw error;
      }
    } catch (error) { return sendError(reply, error); }
  });

  app.get<{ Params: { id: string; type: string } }>("/report-drafts/:id/screenshots/:type/image", async (request, reply) => {
    try {
      const draft = await options.repository.getById(request.params.id);
      if (!draft) return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      const routeType = parseScreenshotType(request.params.type);
      const screenshot = draft.screenshots.find(({ type }) => type === routeType);
      if (!screenshot?.approved || !screenshot.periodConfirmed || !screenshot.storageKey || screenshot.mimeType !== "image/png" || !screenshot.sha256 || !screenshot.byteSize) {
        throw new ScreenshotStorageError("SCREENSHOT_NOT_FOUND", "Screenshot image was not found.");
      }
      const asset = await options.screenshotStorage.get(screenshot.storageKey);
      if (!asset) throw new ScreenshotStorageError("SCREENSHOT_NOT_FOUND", "Screenshot image was not found.");
      if (asset.sha256 !== screenshot.sha256 || asset.byteSize !== screenshot.byteSize) {
        throw new ScreenshotStorageError("STORAGE_ERROR", "Stored screenshot asset does not match its metadata.");
      }
      return reply.type("image/png").header("cache-control", "no-store").send(asset.bytes);
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
  if (error instanceof ScreenshotStorageError) {
    const status = error.code === "SCREENSHOT_TOO_LARGE" ? 413
      : error.code === "SCREENSHOT_NOT_FOUND" ? 404
        : error.code === "STORAGE_ERROR" ? 500 : 400;
    const message = error.code === "STORAGE_ERROR" ? "Screenshot storage is unavailable." : error.message;
    return reply.code(status).send({ error: error.code, message });
  }
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

function parseScreenshotType(value: string) {
  const parsed = screenshotTypeSchema.safeParse(value);
  if (!parsed.success) throw new ScreenshotStorageError("INVALID_SCREENSHOT_TYPE", "Screenshot type is not recognized.");
  return parsed.data;
}

function normalizeSourceUrl(value: string | undefined): string | null {
  if (!value) return null;
  const source = new URL(value);
  source.search = "";
  source.hash = "";
  return source.toString();
}

function ensureExpectedVersion(currentVersion: number, expectedVersion: number): void {
  if (currentVersion !== expectedVersion) {
    throw new ReportPersistenceError(
      "REPORT_VERSION_CONFLICT", "Report draft has changed since it was read.",
      { expectedVersion, currentVersion },
    );
  }
}
