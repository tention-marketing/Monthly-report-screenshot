import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemoryClientReportTargetsRepository, InMemoryReportDraftRepository } from "@tention/report-domain";
import { buildApp } from "./app.js";

/** One-time client configuration drives every monthly report; no client or month is special-cased. */
const NOW = new Date("2026-10-27T12:00:00Z");
let app: FastifyInstance;
let repository: InMemoryReportDraftRepository;

beforeEach(() => {
  repository = new InMemoryReportDraftRepository();
  app = buildApp({ requireClientSetupReady: false, now: () => new Date(NOW), repository, clientReportTargetsRepository: new InMemoryClientReportTargetsRepository() });
});
afterEach(async () => app.close());

const SECTIONS = { executive_summary: "required" };
async function configure(clientId: string, profile: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return app.inject({ method: "PUT", url: `/api/v1/clients/${clientId}/report-targets`, payload: { profile, ...extra } });
}
async function createReport(client: Record<string, unknown>, reportMonth: { year: number; month: number }) {
  return app.inject({ method: "POST", url: "/api/v1/report-drafts", payload: { client, reportMonth, sections: SECTIONS } });
}

describe("canonical client configuration", () => {
  it("stores the timezone on the client once and reuses it for every monthly report", async () => {
    expect((await configure("alpha-goods", { name: "Alpha Goods", timezone: "America/New_York" })).statusCode).toBe(200);
    const august = await createReport({ id: "alpha-goods" }, { year: 2026, month: 8 });
    const september = await createReport({ id: "alpha-goods" }, { year: 2026, month: 9 });
    expect(august.statusCode).toBe(201);
    expect(september.statusCode).toBe(201);
    expect(august.json()).toMatchObject({ client: { id: "alpha-goods", name: "Alpha Goods", timezone: "America/New_York" }, period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" } });
    expect(september.json()).toMatchObject({ client: { timezone: "America/New_York" }, period: { startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" } });
  });

  it("lets another client have its own timezone and conversion metric, configured without code", async () => {
    await configure("alpha-goods", { name: "Alpha Goods", timezone: "America/New_York" });
    await configure("beta-outfitters", { name: "Beta Outfitters", timezone: "Asia/Kolkata", conversionMetric: { label: "Shopify Placed Order" } });
    const beta = await createReport({ id: "beta-outfitters" }, { year: 2026, month: 9 });
    expect(beta.json()).toMatchObject({ client: { id: "beta-outfitters", name: "Beta Outfitters", timezone: "Asia/Kolkata" } });
    const listed = (await app.inject({ method: "GET", url: "/api/v1/clients" })).json();
    expect(listed.map((client: { clientId: string; profile: { timezone: string; conversionMetric: { label: string } } }) => [client.clientId, client.profile.timezone, client.profile.conversionMetric.label]))
      .toEqual([["alpha-goods", "America/New_York", "Placed Order"], ["beta-outfitters", "Asia/Kolkata", "Shopify Placed Order"]]);
  });

  it("rejects report details that differ from the client configuration instead of silently using them", async () => {
    await configure("alpha-goods", { name: "Alpha Goods", timezone: "America/New_York" });
    const conflicting = await createReport({ id: "alpha-goods", name: "Alpha Goods", timezone: "America/Chicago" }, { year: 2026, month: 8 });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json()).toMatchObject({ error: "CLIENT_CONFIGURATION_MISMATCH" });
    expect(await repository.list()).toHaveLength(0);
    expect((await createReport({ id: "alpha-goods", name: "Alpha Goods", timezone: "America/New_York" }, { year: 2026, month: 8 })).statusCode).toBe(201);
  });

  it("requires a name and timezone once for a client that has no configuration yet", async () => {
    const missing = await createReport({ id: "gamma-supply" }, { year: 2026, month: 8 });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: "CLIENT_CONFIGURATION_REQUIRED" });
    expect((await configure("gamma-supply", { name: "Gamma Supply", timezone: "Not/AZone" })).statusCode).toBe(400);
  });

  it("keeps the verified Business Review binding and the profile together in one client record", async () => {
    const businessReview = { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/alpha-review", displayName: "Business Review", accountLabel: "AG Alpha Goods" };
    const saved = await configure("alpha-goods", { name: "Alpha Goods", timezone: "Europe/London" }, { businessReview });
    expect(saved.json()).toMatchObject({ profile: { name: "Alpha Goods", timezone: "Europe/London", conversionMetric: { label: "Placed Order", providerMetricId: null } }, businessReview });
    expect((await app.inject({ method: "GET", url: "/api/v1/clients/alpha-goods/report-targets" })).json()).toMatchObject({ profile: { timezone: "Europe/London" }, businessReview });
  });

  it("saving one client's configuration never changes another client's, in either direction", async () => {
    const get = async (clientId: string) => (await app.inject({ method: "GET", url: `/api/v1/clients/${clientId}/report-targets` })).json();
    const alpha = {
      businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/alpha-review", displayName: "Business Review", accountLabel: "AG Alpha Goods" },
      sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers", deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score" },
    };
    await configure("alpha-goods", { name: "Alpha Goods", timezone: "America/New_York" }, alpha);
    const alphaBefore = await get("alpha-goods");

    // A brand-new client starts empty: nothing from the other client is inherited.
    expect(await get("beta-outfitters")).toMatchObject({ profile: null, businessReview: null, sourceUrls: null });
    const beta = { businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/beta-review", displayName: "Business Review", accountLabel: "BO Beta Outfitters" } };
    await configure("beta-outfitters", { name: "Beta Outfitters", timezone: "America/Los_Angeles" }, beta);
    await configure("beta-outfitters", { name: "Beta Outfitters", timezone: "America/Los_Angeles" }, { ...beta, sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" } });
    expect(await get("alpha-goods")).toEqual(alphaBefore);
    const betaAfter = await get("beta-outfitters");
    expect(betaAfter).toMatchObject({ profile: { name: "Beta Outfitters", timezone: "America/Los_Angeles" }, businessReview: beta.businessReview, sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" } });
    expect(betaAfter.sourceUrls.deliverabilityUrl).toBeUndefined();

    // And the reverse: re-saving Client A leaves Client B exactly as it was.
    await configure("alpha-goods", { name: "Alpha Goods", timezone: "America/New_York" }, { ...alpha, sourceUrls: { ...alpha.sourceUrls, campaignsUrl: "https://www.klaviyo.com/omnicampaigns" } });
    expect(await get("beta-outfitters")).toEqual(betaAfter);
    const reports = await Promise.all([createReport({ id: "alpha-goods" }, { year: 2026, month: 9 }), createReport({ id: "beta-outfitters" }, { year: 2026, month: 9 })]);
    expect(reports.map((report) => report.json().client)).toMatchObject([{ id: "alpha-goods", timezone: "America/New_York" }, { id: "beta-outfitters", timezone: "America/Los_Angeles" }]);
  });

  it("does not list clients that only have legacy targets and no profile", async () => {
    await app.inject({ method: "PUT", url: "/api/v1/clients/legacy-client/report-targets", payload: { businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/legacy" } } });
    expect((await app.inject({ method: "GET", url: "/api/v1/clients" })).json()).toEqual([]);
  });
});
