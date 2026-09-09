import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";

const NOW = new Date("2026-09-09T12:00:00Z");
let app: FastifyInstance;

beforeEach(() => { app = buildApp({ now: () => new Date(NOW) }); });
afterEach(async () => app.close());

const body = (overrides: Record<string, unknown> = {}) => ({
  client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata" },
  reportMonth: { year: 2026, month: 8 },
  sections: { executive_summary: "optional" },
  ...overrides,
});

async function create(overrides: Record<string, unknown> = {}) {
  return app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: body(overrides) });
}

function shot(overrides: Record<string, unknown> = {}) {
  return {
    id: "shot-1", clientId: "client-1", reportMonth: { year: 2026, month: 8 }, type: "overview",
    capturedAt: NOW.toISOString(), sourceUrl: "https://example.com/report", width: 1440, height: 720,
    approved: true, storageLocation: null, ...overrides,
  };
}

describe("report draft API", () => {
  it("creates a completed-month draft with a backend-derived period", async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      reportMonth: { year: 2026, month: 8 },
      period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
    });
  });
  it.each([
    [{ year: 2026, month: 9 }, "current"],
    [{ year: 2026, month: 10 }, "future"],
  ])("rejects a %s report month", async (reportMonth) => {
    const response = await create({ reportMonth });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("REPORT_MONTH_INCOMPLETE");
  });
  it("rejects an invalid timezone", async () => {
    const response = await create({ client: { id: "client-1", name: "Orion", timezone: "Mars/Base" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_CLIENT_TIMEZONE");
  });
  it("evaluates completion in the client's timezone", async () => {
    await app.close();
    app = buildApp({ now: () => new Date("2026-08-31T20:00:00Z") });
    const india = await create({ reportMonth: { year: 2026, month: 8 } });
    const newYork = await create({
      client: { id: "client-2", name: "New York Client", timezone: "America/New_York" },
      reportMonth: { year: 2026, month: 8 },
    });
    expect(india.statusCode).toBe(201);
    expect(newYork.statusCode).toBe(400);
    expect(newYork.json().error).toBe("REPORT_MONTH_INCOMPLETE");
  });
  it("does not accept caller-supplied period boundaries", async () => {
    const response = await create({ period: { startDate: "1999-01-01" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_REQUEST");
  });
  it("gets an existing draft and returns 404 for an unknown ID", async () => {
    const created = (await create()).json();
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts/missing" })).statusCode).toBe(404);
  });
  it("validates missing and unapproved required screenshots", async () => {
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    let response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().errors.map(({ code }: { code: string }) => code)).toContain("REQUIRED_SCREENSHOT_MISSING");
    await app.inject({ method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview`, payload: shot({ approved: false }) });
    response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().errors.map(({ code }: { code: string }) => code)).toContain("REQUIRED_SCREENSHOT_UNAPPROVED");
  });
  it("allows a missing optional screenshot", async () => {
    const created = (await create()).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().status).toBe("valid");
  });
  it("warns for metadata attached to a disabled section", async () => {
    const created = (await create({ sections: { executive_summary: "disabled" } })).json();
    await app.inject({ method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview`, payload: shot() });
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().warnings.map(({ code }: { code: string }) => code)).toContain("DISABLED_SECTION_SCREENSHOT_PRESENT");
  });
  it.each([
    ["overview", { type: "overview", clientId: "other" }, "SCREENSHOT_CLIENT_MISMATCH"],
    ["overview", { type: "overview", reportMonth: { year: 2026, month: 7 } }, "SCREENSHOT_MONTH_MISMATCH"],
    ["overview", { type: "top_flows" }, "SCREENSHOT_TYPE_MISMATCH"],
  ])("rejects inconsistent screenshot metadata", async (routeType, overrides, error) => {
    const created = (await create()).json();
    const response = await app.inject({ method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/${routeType}`, payload: shot(overrides) });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe(error);
  });
  it("rejects illegal lifecycle events", async () => {
    const created = (await create()).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: { event: "GENERATION_SUCCEEDED" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("ILLEGAL_REPORT_TRANSITION");
  });
  it("blocks invalid review submission and accepts a valid one", async () => {
    const blocked = (await create({ sections: { executive_summary: "required" } })).json();
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED"]) {
      await app.inject({ method: "POST", url: `/api/v1/report-drafts/${blocked.id}/events`, payload: { event } });
    }
    let response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${blocked.id}/events`, payload: { event: "SUBMIT_FOR_REVIEW" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("REPORT_VALIDATION_FAILED");

    const valid = (await create({ sections: { executive_summary: "required" } })).json();
    await app.inject({ method: "PUT", url: `/api/v1/report-drafts/${valid.id}/screenshots/overview`, payload: shot() });
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW"]) {
      response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${valid.id}/events`, payload: { event } });
    }
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ready_for_review");
  });
});
