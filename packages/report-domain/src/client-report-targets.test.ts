import { describe, expect, it } from "vitest";
import {
  emptyClientReportTargets, getReportReadiness, InMemoryClientReportTargetsRepository,
} from "./client-report-targets.js";

const now = new Date("2026-09-18T12:00:00Z");
const targetInput = (businessReview: NonNullable<import("@tention/report-schema").ClientReportTargetsInput["businessReview"]>) => ({
  profile: null, businessReview, sourceUrls: null, primaryEmailList: null, primarySmsList: null, welcomeFlow: null, welcomeFlowListing: null,
  customerSegment: null, nonCustomerSegment: null, signupForms: null,
});

describe("client report targets", () => {
  it("uses the capture specification as the required-target authority", () => {
    const empty = emptyClientReportTargets("autoled");
    const readiness = getReportReadiness(empty, {
      signup_form: "optional", welcome_flow: "required", customer_split: "optional",
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.sections.filter(({ status }) => status !== "ready")).toEqual(expect.arrayContaining([
      expect.objectContaining({ sectionKey: "welcome_flow_performance", status: "missing_configuration", requiredTargets: ["welcomeFlowListing"] }),
      expect.objectContaining({ sectionKey: "deliverability", status: "missing_configuration", requiredTargets: ["deliverabilityUrl"] }),
      expect.objectContaining({ sectionKey: "signup_form_performance", status: "optional_not_configured" }),
      expect.objectContaining({ sectionKey: "customer_split", status: "optional_not_configured" }),
    ]));
    expect(readiness.sections.find(({ sectionKey }) => sectionKey === "executive_summary")).toMatchObject({ status: "ready", reason: null });
    expect(readiness.sections.find(({ sectionKey }) => sectionKey === "top_flows")).toMatchObject({ status: "ready", reason: null });
    expect(readiness.sections.find(({ sectionKey }) => sectionKey === "month_comparison")).toMatchObject({ status: "ready", reason: null });
  });

  it("does not block disabled or optional client-specific sections", () => {
    const readiness = getReportReadiness({
      ...emptyClientReportTargets("client-1"),
      sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score" },
    }, {
      signup_form: "disabled", welcome_flow: "optional", customer_split: "disabled", deliverability: "disabled",
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.sections.find(({ sectionKey }) => sectionKey === "signup_form_performance")).toMatchObject({ status: "not_applicable" });
    expect(readiness.sections.find(({ sectionKey }) => sectionKey === "welcome_flow_performance")).toMatchObject({ status: "optional_not_configured" });
  });

  it("unblocks only the sections backed by configured targets", () => {
    const targets = {
      ...emptyClientReportTargets("client-1"),
      primaryEmailList: { id: "list-1" }, welcomeFlowListing: { mode: "email_welcome_flows" as const, flows: [{ id: "WN2GLE", name: "Welcome 1", channel: "email" as const }, { id: "Rex4Pp", name: "Welcome 2", channel: "email" as const }] },
      customerSegment: { name: "Customers" }, nonCustomerSegment: { name: "Non-customers" },
      signupForms: { mode: "configured" as const, ids: ["form-1"], names: [] },
      sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score" },
    };
    const readiness = getReportReadiness(targets, {
      signup_form: "required", welcome_flow: "required", customer_split: "required", deliverability: "optional",
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.sections.filter(({ status }) => status === "missing_configuration")).toHaveLength(0);
  });

  it("persists normalized client-scoped values without leaking them to another client", async () => {
    const repository = new InMemoryClientReportTargetsRepository();
    const saved = await repository.save("client-1", {
      profile: null, businessReview: null, sourceUrls: { overviewUrl: " https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK " }, primaryEmailList: { name: " Main List " }, primarySmsList: null,
      welcomeFlow: { name: "Welcome", aliases: ["welcome", "Welcome Series", "welcome series"] }, welcomeFlowListing: null,
      customerSegment: null, nonCustomerSegment: null, signupForms: null,
    }, now);
    expect(saved.primaryEmailList).toEqual({ name: "Main List" });
    expect(saved.sourceUrls).toEqual({ overviewUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" });
    expect(saved.welcomeFlow).toEqual({ name: "Welcome", aliases: ["Welcome Series"] });
    expect(saved.createdAt).toBe(now.toISOString());
    expect(await repository.get("client-1")).toEqual(saved);
    expect(await repository.get("client-2")).toEqual(emptyClientReportTargets("client-2"));
  });

  it("binds a verified stable Klaviyo account once and prevents cross-client reuse or silent replacement", async () => {
    const repository = new InMemoryClientReportTargetsRepository();
    const bound = await repository.save("club-furniture", targetInput({ dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/review-1", accountLabel: "Club Furniture LLC", providerAccountId: "account_123", providerIdentityKind: "account" }), now);
    expect(bound.businessReview).toMatchObject({ accountLabel: "Club Furniture LLC", providerAccountId: "account_123", providerIdentityKind: "account" });
    const relabeled = await repository.save("club-furniture", targetInput({ dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/review-1", accountLabel: "Furniture Retail Operations", providerAccountId: "account_123", providerIdentityKind: "account" }), now);
    expect(relabeled.businessReview).toMatchObject({ accountLabel: "Furniture Retail Operations", providerAccountId: "account_123" });
    await expect(repository.save("club-furniture", targetInput({ dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/review-2", accountLabel: "Club Furniture LLC", providerAccountId: "account_456", providerIdentityKind: "account" }), now)).rejects.toMatchObject({ code: "CLIENT_ACCOUNT_BINDING_IMMUTABLE" });
    await expect(repository.save("autoledtech", targetInput({ dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/review-3", accountLabel: "AutoLEDTech", providerAccountId: "account_123", providerIdentityKind: "account" }), now)).rejects.toMatchObject({ code: "CLIENT_ACCOUNT_ALREADY_BOUND" });
    expect((await repository.get("club-furniture")).businessReview?.providerAccountId).toBe("account_123");
  });
});
