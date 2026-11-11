import { describe, expect, it } from "vitest";
import {
  clientReportSnapshot, clientReportTargetsSchema, clientSetupBlockers, clientSetupStatus, finalGenerationDataBlockers, klaviyoAccountDisplayName, parseKlaviyoMetricUrl, parseProviderMetricId, parseSubscriberGrowthSourceUrl, sameKlaviyoAccountIdentity,
  type ClientReportTargets,
} from "./index.js";

/** A fully set-up client, built only from its own values (never another client's). */
function readyClient(overrides: Partial<ClientReportTargets> = {}): ClientReportTargets {
  return clientReportTargetsSchema.parse({
    clientId: "steven-dann", createdAt: null, updatedAt: null,
    profile: { name: "Steven Dann", timezone: "America/New_York", currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "SDmet1" }, sections: null },
    businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01SD", displayName: "Business Review", accountLabel: "Steven Dann" },
    sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" },
    ...overrides,
  });
}
const codes = (targets: ClientReportTargets, others: ClientReportTargets[] = []) => clientSetupBlockers(targets, others).map(({ code }) => code);

describe("client setup validator", () => {
  it("a fully configured client is READY with no blockers", () => {
    expect(codes(readyClient())).toEqual([]);
    expect(clientSetupStatus(clientSetupBlockers(readyClient()))).toBe("READY");
  });

  it("a brand-new client with only a name lists every remaining required item, in checklist order", () => {
    const fresh = clientReportTargetsSchema.parse({ clientId: "steven-dann", createdAt: null, updatedAt: null, profile: { name: "Steven Dann", timezone: null } });
    expect(codes(fresh)).toEqual([
      "KLAVIYO_ACCOUNT_NOT_VERIFIED", "TIMEZONE_NOT_CONFIGURED", "CURRENCY_NOT_CONFIGURED", "CONVERSION_METRIC_ID_NOT_CONFIGURED",
      "BUSINESS_REVIEW_SOURCE_NOT_VERIFIED", "DELIVERABILITY_SOURCE_NOT_VERIFIED", "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED",
    ]);
    expect(clientSetupStatus(clientSetupBlockers(fresh))).toBe("INCOMPLETE");
  });

  it("a client without a profile is missing its name", () => {
    expect(codes(readyClient({ profile: null }))).toContain("CLIENT_NAME_NOT_CONFIGURED");
  });

  it.each([
    ["timezone", { profile: { ...readyClient().profile!, timezone: null } }, "TIMEZONE_NOT_CONFIGURED"],
    ["currency", { profile: { ...readyClient().profile!, currency: null } }, "CURRENCY_NOT_CONFIGURED"],
    ["non-ISO currency", { profile: { ...readyClient().profile!, currency: "XYZ" } }, "CURRENCY_NOT_CONFIGURED"],
    ["metric ID", { profile: { ...readyClient().profile!, conversionMetric: { label: "Placed Order", providerMetricId: null } } }, "CONVERSION_METRIC_ID_NOT_CONFIGURED"],
    ["Klaviyo account", { businessReview: { dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/01SD", displayName: "Business Review" } }, "KLAVIYO_ACCOUNT_NOT_VERIFIED"],
    ["Business Review", { businessReview: { displayName: "Business Review", accountLabel: "Steven Dann" } }, "BUSINESS_REVIEW_SOURCE_NOT_VERIFIED"],
    ["Deliverability", { sourceUrls: { subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" } }, "DELIVERABILITY_SOURCE_NOT_VERIFIED"],
    ["Deliverability on the wrong route", { sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability", subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" } }, "DELIVERABILITY_SOURCE_NOT_VERIFIED"],
    ["Subscriber Growth", { sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score" } }, "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED"],
  ] as const)("missing %s blocks READY with exactly that item", (_name, override, code) => {
    const targets = readyClient(override as Partial<ClientReportTargets>);
    expect(codes(targets)).toEqual([code]);
    expect(clientSetupStatus(clientSetupBlockers(targets))).toBe("INCOMPLETE");
  });

  it("optional sections (signup forms, welcome flow, customer split) never block READY", () => {
    expect(codes(readyClient({ signupForms: null, welcomeFlowListing: null, customerSegment: null, nonCustomerSegment: null }))).toEqual([]);
  });

  it("another client's provider metric ID is never accepted: the client is in ERROR", () => {
    const club = readyClient({ clientId: "club-furniture", profile: { ...readyClient().profile!, name: "Club Furniture", conversionMetric: { label: "Placed Order", providerMetricId: "KyqTnx" } } });
    const copied = readyClient({ profile: { ...readyClient().profile!, conversionMetric: { label: "Placed Order", providerMetricId: "KyqTnx" } } });
    expect(codes(copied, [club, copied])).toEqual(["CONVERSION_METRIC_ID_SHARED_WITH_OTHER_CLIENT"]);
    expect(clientSetupStatus(clientSetupBlockers(copied, [club]))).toBe("ERROR");
    expect(codes(readyClient(), [club])).toEqual([]);
  });
});

describe("report-time client snapshot", () => {
  it("freezes the READY client's own values", () => {
    expect(clientReportSnapshot(readyClient())).toEqual({
      id: "steven-dann", name: "Steven Dann", timezone: "America/New_York", currency: "USD",
      conversionMetric: { label: "Placed Order", providerMetricId: "SDmet1" },
      klaviyoAccount: { accountLabel: "Steven Dann", providerAccountId: null },
    });
  });
  it("refuses to snapshot an incomplete client", () => {
    expect(() => clientReportSnapshot(readyClient({ profile: { ...readyClient().profile!, currency: null } }))).toThrow();
  });
  it("a snapshotted report is unaffected by later profile changes; a legacy report still reads the profile", () => {
    const snapshotted = { client: { currency: "USD", conversionMetric: { label: "Placed Order", providerMetricId: "SDmet1" } } };
    const laterProfile = { currency: "CAD", conversionMetric: { label: "Placed Order", providerMetricId: null } };
    expect(finalGenerationDataBlockers(snapshotted, laterProfile)).toEqual([]);
    expect(finalGenerationDataBlockers({ client: { currency: "USD" } }, laterProfile).map(({ code }) => code)).toEqual(["CLIENT_CURRENCY_MISMATCH", "CONVERSION_METRIC_ID_NOT_CONFIGURED"]);
  });
});

describe("conversion metric ID entry", () => {
  it("parses the provider metric ID from a Placed Order URL, ignoring the query", () => {
    expect(parseKlaviyoMetricUrl("https://www.klaviyo.com/metric/QuWhQ9/placed-order")).toEqual({ ok: true, providerMetricId: "QuWhQ9" });
    expect(parseKlaviyoMetricUrl("  https://www.klaviyo.com/metric/QuWhQ9/placed-order?function=&dimension=&value=  ")).toEqual({ ok: true, providerMetricId: "QuWhQ9" });
    expect(parseKlaviyoMetricUrl("https://www.klaviyo.com/metric/QuWhQ9/placed-order/")).toEqual({ ok: true, providerMetricId: "QuWhQ9" });
  });
  it.each([
    "QuWhQ9", "www.klaviyo.com/metric/QuWhQ9/placed-order", "http://www.klaviyo.com/metric/QuWhQ9/placed-order",
    "https://evil.example/metric/QuWhQ9/placed-order", "https://www.klaviyo.com/metric/QuWhQ9", "https://www.klaviyo.com/metric/QuWhQ9/active-on-site",
    "https://www.klaviyo.com/analytics/metrics?metric=QuWhQ9", "https://www.klaviyo.com/metric/Qu-Q9/placed-order",
  ])("rejects %s as INVALID_METRIC_URL", (url) => {
    expect(parseKlaviyoMetricUrl(url)).toEqual({ ok: false, code: "INVALID_METRIC_URL", message: "Paste a Klaviyo Placed Order URL such as /metric/<id>/placed-order." });
  });
  it("accepts a manual ID with surrounding whitespace trimmed", () => {
    expect(parseProviderMetricId("  QuWhQ9 \n")).toEqual({ ok: true, providerMetricId: "QuWhQ9" });
  });
  it.each([
    ["", "Enter the Klaviyo metric ID."],
    ["https://www.klaviyo.com/metric/QuWhQ9/placed-order", "Enter only the Klaviyo metric ID, not the full URL."],
    ["/metric/QuWhQ9/placed-order", "Enter only the Klaviyo metric ID, not the full URL."],
    ["QuW hQ9", "A Klaviyo metric ID has no spaces."],
    ["QuWhQ9!", "A Klaviyo metric ID contains only letters and digits (for example QuWhQ9)."],
    ["Q9", "A Klaviyo metric ID contains only letters and digits (for example QuWhQ9)."],
  ])("rejects manual ID %j as INVALID_PROVIDER_METRIC_ID", (raw, message) => {
    expect(parseProviderMetricId(raw)).toEqual({ ok: false, code: "INVALID_PROVIDER_METRIC_ID", message });
  });
  it("the stored profile refuses anything but a well-formed metric ID, whichever way it was entered", () => {
    const parse = (providerMetricId: string) => clientReportTargetsSchema.safeParse({ ...readyClient(), profile: { ...readyClient().profile!, conversionMetric: { label: "Placed Order", providerMetricId } } }).success;
    expect(parse("QuWhQ9")).toBe(true);
    expect(parse("https://www.klaviyo.com/metric/QuWhQ9/placed-order")).toBe(false);
    expect(parse("Qu WhQ9")).toBe(false);
  });
});

describe("Klaviyo account display name", () => {
  it.each([
    ["ST Steven Dann", "Steven Dann"], ["CL Club Furniture", "Club Furniture"], ["Steven Dann", "Steven Dann"],
    ["  ST   Steven Dann ", "Steven Dann"], ["ABC Widgets", "ABC Widgets"], ["SD Steven Dann", "SD Steven Dann"],
  ])("%j → %j (only the account's own avatar initials are removed)", (label, name) => {
    expect(klaviyoAccountDisplayName(label)).toBe(name);
  });
  it("treats the saved 'ST Steven Dann' and visible 'Steven Dann' as one account, and never another client", () => {
    expect(sameKlaviyoAccountIdentity("ST Steven Dann", "Steven Dann")).toBe(true);
    expect(sameKlaviyoAccountIdentity("steven dann", "Steven Dann")).toBe(true);
    expect(sameKlaviyoAccountIdentity("Steven Dann", "Club Furniture")).toBe(false);
    expect(sameKlaviyoAccountIdentity("ST Steven Dann", "CL Club Furniture")).toBe(false);
    expect(sameKlaviyoAccountIdentity("Steven Dann", null)).toBe(false);
  });
});

describe("Subscriber Growth source URL", () => {
  it.each([
    "https://www.klaviyo.com/people/subscribers", "https://www.klaviyo.com/people/subscribers/", "https://klaviyo.com/people/subscribers",
    "https://www.klaviyo.com/people/subscribers?channel=email&view=growth#top", "  https://www.klaviyo.com/people/subscribers?date=last_7_days  ",
  ])("reduces %j to the stable route", (raw) => {
    expect(parseSubscriberGrowthSourceUrl(raw)).toEqual({ ok: true, url: "https://www.klaviyo.com/people/subscribers" });
  });
  it.each([
    "http://www.klaviyo.com/people/subscribers", "https://evil.example/people/subscribers", "https://www.klaviyo.com/people",
    "https://www.klaviyo.com/analytics/deliverability/email/score", "https://www.klaviyo.com/people/subscribers/export", "www.klaviyo.com/people/subscribers", "",
  ])("rejects %j", (raw) => {
    expect(parseSubscriberGrowthSourceUrl(raw)).toMatchObject({ ok: false, code: "INVALID_SUBSCRIBER_GROWTH_URL" });
  });
  it("only the supported route satisfies the Subscriber Growth setup item", () => {
    expect(codes(readyClient({ sourceUrls: { deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", subscriberGrowthUrl: "https://www.klaviyo.com/analytics/metrics" } }))).toEqual(["SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED"]);
  });
});
