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
});
