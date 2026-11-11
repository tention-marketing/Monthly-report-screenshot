import { describe, expect, it, vi } from "vitest";
import {
  CONVERSION_METRIC_VERIFIED_SOURCE_KEY, ConversionMetricSourceSetup, DeliverabilitySourceVerifier, inspectConversionMetricDocument, klaviyoMetricIdFromUrl,
} from "./client-setup-sources.js";
import type { BusinessReviewDiscoveryResult } from "./business-review-discovery.js";
import type { KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";

function memorySession() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: vi.fn(async (key: string | null) => key === null ? Object.fromEntries(values) : values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}),
    set: vi.fn(async (entries: Record<string, unknown>) => { for (const [key, value] of Object.entries(entries)) values.set(key, structuredClone(value)); }),
    remove: vi.fn(async (key: string) => { values.delete(key); }),
  };
}

describe("conversion metric ID discovery", () => {
  it("reads the account-specific metric ID only from a Klaviyo metric page address", () => {
    expect(klaviyoMetricIdFromUrl("https://www.klaviyo.com/metric/KyqTnx/placed-order")).toBe("KyqTnx");
    expect(klaviyoMetricIdFromUrl("https://www.klaviyo.com/metric/SDmet1/placed-order?tab=activity")).toBe("SDmet1");
    expect(klaviyoMetricIdFromUrl("https://www.klaviyo.com/metric/SDmet1")).toBe("SDmet1");
    expect(klaviyoMetricIdFromUrl("https://www.klaviyo.com/analytics/metrics")).toBeNull();
    expect(klaviyoMetricIdFromUrl("https://evil.example/metric/KyqTnx/placed-order")).toBeNull();
    expect(klaviyoMetricIdFromUrl(undefined)).toBeNull();
  });

  it("the injected probe reads the ID from the address, the headings and the account controls", async () => {
    window.history.pushState({}, "", "/metric/SDmet1/placed-order");
    document.body.innerHTML = `<header><button aria-label="Account: Steven Dann">SD</button></header><main><h1>Placed Order</h1></main>`;
    for (const element of document.querySelectorAll("*")) (element as HTMLElement).getBoundingClientRect = () => ({ width: 100, height: 20, x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, toJSON: () => ({}) });
    const probe = await inspectConversionMetricDocument();
    expect(probe).toMatchObject({ metricId: "SDmet1", headings: ["Placed Order"] });
    expect(probe.accountLabels).toEqual(expect.arrayContaining(["Account: Steven Dann", "SD"]));
    expect(probe.sourceUrl).toMatch(/\/metric\/SDmet1\/placed-order$/);
    document.body.innerHTML = "";
  });

  it("records the metric read at the toolbar click and hands it to the panel exactly once", async () => {
    const session = memorySession();
    const scripting = { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: { metricId: "SDmet1", headings: ["Placed Order"], title: "Placed Order | Klaviyo", accountLabels: ["Steven Dann"], sourceUrl: "https://www.klaviyo.com/metric/SDmet1/placed-order" } }]) };
    let now = 1_000;
    const setup = new ConversionMetricSourceSetup(scripting, session, () => now);
    expect(await setup.verifyAtToolbarClick({ id: 7, windowId: 1, url: "https://www.klaviyo.com/metric/SDmet1/placed-order" })).toMatchObject({ ok: true, metricId: "SDmet1" });
    expect(session.values.get(CONVERSION_METRIC_VERIFIED_SOURCE_KEY)).toMatchObject({ metricId: "SDmet1" });
    expect(await setup.take()).toMatchObject({ ok: true, metricId: "SDmet1", headings: ["Placed Order"], accountLabels: ["Steven Dann"] });
    expect(await setup.take()).toMatchObject({ ok: false, code: "CONVERSION_METRIC_SOURCE_NOT_VERIFIED" });
    // A stale read is never used.
    await setup.verifyAtToolbarClick({ id: 7, windowId: 1, url: "https://www.klaviyo.com/metric/SDmet1/placed-order" });
    now += 16 * 60_000;
    expect(await setup.take()).toMatchObject({ ok: false, code: "CONVERSION_METRIC_SOURCE_NOT_VERIFIED" });
  });

  it("ignores non-metric pages and refuses a page whose rendered ID differs from the clicked address", async () => {
    const session = memorySession();
    const scripting = { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: { metricId: "OTHER1", headings: [], title: "", accountLabels: [], sourceUrl: "" } }]) };
    const setup = new ConversionMetricSourceSetup(scripting, session);
    expect(await setup.verifyAtToolbarClick({ id: 7, url: "https://www.klaviyo.com/analytics/dashboards/x" })).toBeNull();
    expect(await setup.verifyAtToolbarClick({ id: 7, url: "https://www.klaviyo.com/metric/SDmet1/placed-order" })).toMatchObject({ ok: false, code: "CONVERSION_METRIC_PAGE_NOT_READ" });
    expect(session.values.has(CONVERSION_METRIC_VERIFIED_SOURCE_KEY)).toBe(false);
  });
});

describe("Deliverability source verification", () => {
  const grantStore = (tabId = 9) => ({ get: vi.fn().mockResolvedValue({ grantedTabId: tabId, grantedWindowId: 1, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "", grantedAt: 1 }) }) as unknown as KlaviyoActiveTabGrantStore;
  const request = { clientName: "Steven Dann", configuredUrl: "https://www.klaviyo.com/analytics/dashboards/01SD", configuredAccountLabel: "Steven Dann", configuredProviderAccountId: null };
  const accountOk = vi.fn(async (): Promise<BusinessReviewDiscoveryResult> => ({ ok: true, verification: "saved_target_account", dashboardUrl: request.configuredUrl, accountLabel: "Steven Dann", accountMatchesClient: true }));
  const scoreOk = { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: true, sourceUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", targetRect: {}, diagnostics: {} } }]) };

  it("saves the standalone Email Score route after the saved account and the page are both proven", async () => {
    const tabs = { get: vi.fn().mockResolvedValue({ id: 9, url: "https://www.klaviyo.com/analytics/deliverability/email/score" }) };
    const verifier = new DeliverabilitySourceVerifier(tabs, scoreOk, grantStore(), accountOk);
    expect(await verifier.verify(request)).toEqual({ ok: true, deliverabilityUrl: "https://www.klaviyo.com/analytics/deliverability/email/score", accountLabel: "Steven Dann" });
    expect(accountOk).toHaveBeenCalledWith(expect.objectContaining({ verifySavedAccountOnly: true, configuredAccountLabel: "Steven Dann" }));
  });

  it("requires the account first, refuses a wrong account, the wrong page, or a page the adapter rejects", async () => {
    const onScore = { get: vi.fn().mockResolvedValue({ id: 9, url: "https://www.klaviyo.com/analytics/deliverability/email/score" }) };
    expect(await new DeliverabilitySourceVerifier(onScore, scoreOk, grantStore(), accountOk).verify({ ...request, configuredUrl: null })).toMatchObject({ ok: false, code: "KLAVIYO_ACCOUNT_NOT_VERIFIED" });
    const wrongAccount = vi.fn(async (): Promise<BusinessReviewDiscoveryResult> => ({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH", message: "The authenticated Klaviyo account differs." }));
    expect(await new DeliverabilitySourceVerifier(onScore, scoreOk, grantStore(), wrongAccount).verify(request)).toMatchObject({ ok: false, code: "ACCOUNT_CONTEXT_MISMATCH" });
    const elsewhere = { get: vi.fn().mockResolvedValue({ id: 9, url: "https://www.klaviyo.com/analytics/deliverability" }) };
    expect(await new DeliverabilitySourceVerifier(elsewhere, scoreOk, grantStore(), accountOk).verify(request)).toMatchObject({ ok: false, code: "DELIVERABILITY_SOURCE_NOT_VERIFIED" });
    const rejected = { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: false, code: "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED", message: "Not rendered." } }]) };
    expect(await new DeliverabilitySourceVerifier(onScore, rejected, grantStore(), accountOk).verify(request)).toMatchObject({ ok: false, code: "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED" });
  });
});
