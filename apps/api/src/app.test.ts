import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("health routes", () => {
  it.each(["/health", "/api/v1/health"])("returns health at %s", async (url) => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
  it("allows extension origins without opening CORS to arbitrary websites", async () => {
    const app = buildApp();
    apps.push(app);
    const extension = await app.inject({ method: "GET", url: "/api/v1/health", headers: { origin: "chrome-extension://abcdefghijklmnop" } });
    const website = await app.inject({ method: "GET", url: "/api/v1/health", headers: { origin: "https://example.com" } });
    expect(extension.headers["access-control-allow-origin"]).toBe("chrome-extension://abcdefghijklmnop");
    expect(website.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("does not expose the local acceptance import route in the normal API app", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/dev/live-acceptance/import", payload: { clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } } });
    expect(response.statusCode).toBe(404);
  });
  it("refuses local acceptance import when persistence is not PostgreSQL-backed", async () => {
    const app = buildApp({ enableLocalDevelopmentImports: true, repositoryRoot: process.cwd() });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/dev/live-acceptance/import", payload: { clientId: "autoledtech", reportMonth: { year: 2026, month: 8 } } });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "LOCAL_IMPORT_REQUIRES_PERSISTENT_STORAGE" });
  });
  it("refuses canonical partial-PDF rendering unless the local API is persistent", async () => {
    const app = buildApp({ enableLocalDevelopmentImports: true });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "LOCAL_REVIEW_REQUIRES_PERSISTENT_STORAGE" });
  });
  it.each([
    ["GET", "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/status"],
    ["GET", "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/pdf"],
  ] as const)("refuses development review PDF retrieval without persistent storage (%s %s)", async (method, url) => {
    const app = buildApp({ enableLocalDevelopmentImports: true });
    apps.push(app);
    const response = await app.inject({ method, url });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "LOCAL_REVIEW_REQUIRES_PERSISTENT_STORAGE" });
  });
  it("keeps development review PDF routes absent from production mode", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/dev/report-drafts/f577d631-a1f6-4cc0-9052-68e30460876d/partial-review/pdf" });
    expect(response.statusCode).toBe(404);
  });
});
