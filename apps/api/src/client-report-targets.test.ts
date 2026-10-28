import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryClientReportTargetsRepository } from "@tention/report-domain";
import { buildApp } from "./app.js";

const now = new Date("2026-09-18T12:00:00Z");
let app: FastifyInstance;

beforeEach(() => { app = buildApp({ now: () => now, clientReportTargetsRepository: new InMemoryClientReportTargetsRepository() }); });
afterEach(async () => app.close());

describe("client report targets API", () => {
  it("returns an explicit empty target configuration for a new client", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/clients/autoled/report-targets" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ clientId: "autoled", primaryEmailList: null, welcomeFlow: null, createdAt: null, updatedAt: null });
  });

  it("validates, saves, normalizes, and scopes targets by client", async () => {
    const saved = await app.inject({ method: "PUT", url: "/api/v1/clients/autoled/report-targets", payload: {
      businessReview: { dashboardUrl: " https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK " },
      primaryEmailList: { id: " main-list " }, primarySmsList: null,
      welcomeFlow: { name: "Welcome", aliases: ["welcome", "Welcome Series"] },
      customerSegment: { id: "customers" }, nonCustomerSegment: { id: "non-customers" },
      signupForms: { mode: "configured", ids: ["form-1"], names: [] },
    } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ clientId: "autoled", primaryEmailList: { id: "main-list" }, welcomeFlow: { aliases: ["Welcome Series"] }, createdAt: now.toISOString(), updatedAt: now.toISOString() });
    expect((await app.inject({ method: "GET", url: "/api/v1/clients/other/report-targets" })).json()).toMatchObject({ primaryEmailList: null });
  });

  it("rejects malformed targets and reports required versus optional readiness", async () => {
    const invalid = await app.inject({ method: "PUT", url: "/api/v1/clients/autoled/report-targets", payload: { customerSegment: { id: "same" }, nonCustomerSegment: { id: "same" } } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("INVALID_REPORT_TARGETS");
    const readiness = await app.inject({ method: "POST", url: "/api/v1/clients/autoled/report-readiness", payload: { sections: { welcome_flow: "required", signup_form: "optional", list_growth: "disabled" } } });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({ ready: false });
    expect(readiness.json().sections).toEqual(expect.arrayContaining([
      expect.objectContaining({ sectionKey: "welcome_flow_performance", status: "missing_configuration" }),
      expect.objectContaining({ sectionKey: "signup_form_performance", status: "optional_not_configured" }),
      expect.objectContaining({ sectionKey: "deliverability", status: "missing_configuration", requiredTargets: ["deliverabilityUrl"] }),
    ]));
  });

  it("persists provider account identity and rejects an attempt to reuse it for another client", async () => {
    const payload = { businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/review", accountLabel: "Club Furniture LLC", providerAccountId: "account_123", providerIdentityKind: "account" } };
    const first = await app.inject({ method: "PUT", url: "/api/v1/clients/club-furniture/report-targets", payload });
    expect(first.statusCode).toBe(200);
    expect(first.json().businessReview).toMatchObject(payload.businessReview);
    const reused = await app.inject({ method: "PUT", url: "/api/v1/clients/autoledtech/report-targets", payload: { businessReview: { ...payload.businessReview, dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/other" } } });
    expect(reused.statusCode).toBe(400);
    expect(reused.json()).toMatchObject({ error: "CLIENT_ACCOUNT_ALREADY_BOUND" });
  });
});
