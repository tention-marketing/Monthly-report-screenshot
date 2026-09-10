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

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9J5c0AAAAASUVORK5CYII=", "base64");
async function upload(id: string, type = "overview", expectedVersion = 1, sourceUrl = "https://www.klaviyo.com/reports?token=secret") {
  return app.inject({
    method: "PUT", url: `/api/v1/report-drafts/${id}/screenshots/${type}/image`, payload: PNG,
    headers: {
      "content-type": "image/png", "x-expected-version": String(expectedVersion),
      "x-period-confirmed": "true", "x-source-url": sourceUrl,
    },
  });
}
const eventPayload = (expectedVersion: number, event: string) => ({ expectedVersion, event });

describe("report draft API", () => {
  it("lists an empty repository", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/report-drafts" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });
  it("lists drafts deterministically and filters by safe fields", async () => {
    const first = (await create()).json();
    const second = (await create({
      client: { id: "client-2", name: "Second", timezone: "Asia/Kolkata" },
      reportMonth: { year: 2026, month: 7 },
    })).json();
    const third = (await create({
      client: { id: "client-1", name: "Orion", timezone: "Asia/Kolkata" },
      reportMonth: { year: 2025, month: 8 },
    })).json();
    const all = (await app.inject({ method: "GET", url: "/api/v1/report-drafts" })).json();
    expect(all.map(({ id }: { id: string }) => id)).toEqual([first.id, second.id, third.id].sort());
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts?clientId=client-1" })).json()).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts?year=2026" })).json()).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts?month=8" })).json()).toHaveLength(2);
    const combined = (await app.inject({ method: "GET", url: "/api/v1/report-drafts?clientId=client-2&year=2026&month=7" })).json();
    expect(combined).toHaveLength(1);
    expect(combined[0].id).toBe(second.id);
  });
  it.each(["year=not-a-year", "year=1999", "month=0", "month=13", "month=1%20OR%201=1"])(
    "rejects invalid list query %s", async (query) => {
      const response = await app.inject({ method: "GET", url: `/api/v1/report-drafts?${query}` });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe("INVALID_REQUEST");
    },
  );
  it("creates a completed-month draft with a backend-derived period", async () => {
    const response = await create();
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      version: 1,
      reportMonth: { year: 2026, month: 8 },
      period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" },
    });
  });
  it("rejects a duplicate client and report month", async () => {
    expect((await create()).statusCode).toBe(201);
    const duplicate = await create();
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error).toBe("REPORT_DRAFT_ALREADY_EXISTS");
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
  it("validates a missing required screenshot until an approved stored PNG is uploaded", async () => {
    const created = (await create({ sections: { executive_summary: "required" } })).json();
    let response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().errors.map(({ code }: { code: string }) => code)).toContain("REQUIRED_SCREENSHOT_MISSING");
    const uploaded = await upload(created.id);
    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().screenshots[0]).toMatchObject({
      clientId: "client-1", reportMonth: { year: 2026, month: 8 }, type: "overview",
      approved: true, periodConfirmed: true, mimeType: "image/png", width: 1, height: 1,
      sourceUrl: "https://www.klaviyo.com/reports",
    });
    response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().status).toBe("valid");
  });
  it("allows a missing optional screenshot", async () => {
    const created = (await create()).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().status).toBe("valid");
  });
  it("warns for metadata attached to a disabled section", async () => {
    const created = (await create({ sections: { executive_summary: "disabled" } })).json();
    await upload(created.id);
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/validate` });
    expect(response.json().warnings.map(({ code }: { code: string }) => code)).toContain("DISABLED_SECTION_SCREENSHOT_PRESENT");
  });
  it("rejects invalid screenshot types and non-PNG uploads", async () => {
    const created = (await create()).json();
    let response = await upload(created.id, "not-a-type");
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_SCREENSHOT_TYPE");
    response = await app.inject({
      method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image`, payload: Buffer.from("not a png"),
      headers: { "content-type": "image/png", "x-expected-version": "1", "x-period-confirmed": "true", "x-source-url": "https://www.klaviyo.com/reports" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_SCREENSHOT_CONTENT");
    response = await app.inject({ method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image`, payload: PNG, headers: { "content-type": "image/jpeg" } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_SCREENSHOT_CONTENT");
    response = await app.inject({
      method: "PUT", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image`, payload: PNG,
      headers: { "content-type": "image/png", "x-expected-version": "1", "x-period-confirmed": "false", "x-source-url": "https://www.klaviyo.com/reports" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("INVALID_REQUEST");
  });
  it("rejects illegal lifecycle events", async () => {
    const created = (await create()).json();
    const response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(1, "GENERATION_SUCCEEDED") });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("ILLEGAL_REPORT_TRANSITION");
  });
  it("blocks invalid review submission and accepts a valid one", async () => {
    const blocked = (await create({ sections: { executive_summary: "required" } })).json();
    let blockedVersion = 1;
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED"]) {
      const result = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${blocked.id}/events`, payload: eventPayload(blockedVersion, event) });
      blockedVersion = result.json().version;
    }
    let response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${blocked.id}/events`, payload: eventPayload(blockedVersion, "SUBMIT_FOR_REVIEW") });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("REPORT_VALIDATION_FAILED");

    const valid = (await create({
      client: { id: "client-2", name: "Second Client", timezone: "Asia/Kolkata" },
      sections: { executive_summary: "required" },
    })).json();
    const uploaded = await upload(valid.id);
    let validVersion = uploaded.json().version;
    for (const event of ["START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "SUBMIT_FOR_REVIEW"]) {
      response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${valid.id}/events`, payload: eventPayload(validVersion, event) });
      validVersion = response.json().version;
    }
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ready_for_review");
  });
  it("increments versions and rejects stale screenshot and lifecycle writes", async () => {
    const created = (await create()).json();
    let response = await upload(created.id);
    expect(response.json().version).toBe(2);
    response = await upload(created.id, "overview", 1);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "REPORT_VERSION_CONFLICT", expectedVersion: 1, currentVersion: 2 });
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image` })).statusCode).toBe(200);
    response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(2, "START_DATA_FETCH") });
    expect(response.json().version).toBe(3);
    response = await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(2, "DATA_FETCH_SUCCEEDED") });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("REPORT_VERSION_CONFLICT");
  });
  it("serves the current stored screenshot image without exposing its storage key", async () => {
    const created = (await create()).json();
    await upload(created.id);
    const image = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/screenshots/overview/image` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(image.rawPayload).toEqual(PNG);
    expect((await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/screenshots/top_flows/image` })).json().error).toBe("SCREENSHOT_NOT_FOUND");
  });
  it("returns creation and transition history, and 404 for unknown history", async () => {
    const created = (await create()).json();
    await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(1, "START_DATA_FETCH") });
    const history = await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` });
    expect(history.json().map(({ eventType }: { eventType: string }) => eventType)).toEqual(["REPORT_CREATED", "START_DATA_FETCH"]);
    expect((await app.inject({ method: "GET", url: "/api/v1/report-drafts/00000000-0000-4000-8000-000000000000/history" })).statusCode).toBe(404);
  });
  it("does not mutate status, version, or history after an illegal transition", async () => {
    const created = (await create()).json();
    await app.inject({ method: "POST", url: `/api/v1/report-drafts/${created.id}/events`, payload: eventPayload(1, "GENERATION_SUCCEEDED") });
    const stored = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}` })).json();
    const history = (await app.inject({ method: "GET", url: `/api/v1/report-drafts/${created.id}/history` })).json();
    expect(stored).toMatchObject({ status: "draft", version: 1 });
    expect(history).toHaveLength(1);
  });
});
