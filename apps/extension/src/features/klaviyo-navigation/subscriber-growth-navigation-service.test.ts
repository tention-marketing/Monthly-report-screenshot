import { afterEach, describe, expect, it, vi } from "vitest";
import { createScreenshotSourceProof, matchesReportCaptureSpec, type ReportDraft } from "@tention/report-schema";
import { installSubscriberGrowthFixture, removeSubscriberGrowthFixture } from "./subscriber-growth-fixture.js";
import { SubscriberGrowthAutoCaptureController } from "../automatic-capture/subscriber-growth-auto-capture-controller.js";
import { isKlaviyoSupportedCaptureUrl, registerConfiguredCaptureRoute, type KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";
import { ChromeSubscriberGrowthNavigation } from "./subscriber-growth-navigation-service.js";
import { getAutomaticCapturePlan } from "../report-runner/runner.js";
import { classifyFailure } from "../automatic-capture/recovery-policy.js";

const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };
const SOURCE = "https://www.klaviyo.com/subscriber-growth-from-config";
function store(invocationPath = "/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1"): KlaviyoActiveTabGrantStore {
  return {
    get: vi.fn().mockResolvedValue({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1", grantedAt: 1 }),
    getActionInvocation: vi.fn().mockResolvedValue({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: invocationPath, invokedAt: 1 }),
    set: vi.fn().mockResolvedValue(undefined), setActionInvocation: vi.fn(), clearGrant: vi.fn().mockResolvedValue(undefined), clear: vi.fn().mockResolvedValue(undefined),
  };
}
function chrome(tabUrl: string, scriptResult: unknown) {
  let url = "https://www.klaviyo.com/analytics/dashboards/01H2XYS7EKZT3VVQYBQ19GTVW1";
  const tabs = {
    get: vi.fn(async () => ({ id: 7, windowId: 3, active: true, status: "complete", url: url === SOURCE ? tabUrl : url })),
    query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]),
    update: vi.fn(async (_id: number, input: { url?: string }) => { if (input.url) url = input.url; return {}; }),
  };
  const scripting = { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: scriptResult }]) };
  return { tabs, scripting };
}
const ready = { ok: true, sourceUrl: SOURCE, detectedPeriod: "Aug 1 – Aug 31, 2026", periodEvidence: { startDate: "2026-08-01", endDate: "2026-08-31" }, targetRect: { x: 1, y: 2, width: 800, height: 600, viewportWidth: 1200, viewportHeight: 900, visibleControls: [] }, evidence: { channel: "email", view: "growth", emailSubscribers: 17698, newSubscribers: 943, exclusions: 499, changes: { emailSubscribers: null, newSubscribers: null, exclusions: null }, charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true }, visiblePeriodText: "Aug 1 – Aug 31, 2026" }, diagnostics: {} };

describe("Subscriber Growth navigation (Section 10)", () => {
  it("needs the client's saved source and never guesses a Klaviyo route", async () => {
    const api = chrome(SOURCE, ready);
    const navigation = new ChromeSubscriberGrowthNavigation(api as never, store(), undefined, 1);
    for (const sourceUrl of [null, "https://evil.example.com/subscriber-growth", "http://www.klaviyo.com/x", "https://www.klaviyo.com/"]) {
      await expect(navigation.prepare({ period, sourceUrl, clientName: "Club Furniture" })).resolves.toMatchObject({ kind: "failed", code: "SUBSCRIBER_GROWTH_URL_REQUIRED" });
    }
    expect(api.tabs.update).not.toHaveBeenCalled();
    expect(classifyFailure("SUBSCRIBER_GROWTH_URL_REQUIRED")).toMatchObject({ category: "CONFIGURATION", permanent: true });
  });

  it("reloads the saved source fresh, registers it as a capture route, and returns the adapter's evidence", async () => {
    const api = chrome(SOURCE, ready); const persisted = vi.fn();
    const navigation = new ChromeSubscriberGrowthNavigation(api as never, store(), persisted, 1);
    const result = await navigation.prepare({ period, sourceUrl: SOURCE, clientName: "Club Furniture" });
    expect(result).toMatchObject({ kind: "ready", sourceTabId: 7, windowId: 3, periodEvidence: { startDate: "2026-08-01", endDate: "2026-08-31" }, evidence: { emailSubscribers: 17698 } });
    expect(api.tabs.update).toHaveBeenCalledWith(7, { url: SOURCE });
    expect(api.scripting.executeScript.mock.calls[0]![0].args[0]).toMatchObject({ period: { startDate: "2026-08-01", endDate: "2026-08-31" }, clientName: "Club Furniture", stability: { requiredStableSamples: 3, sampleIntervalMs: 500 } });
    expect(isKlaviyoSupportedCaptureUrl(`${SOURCE}?date=1`)).toBe(true);
    expect(persisted).toHaveBeenCalled();
  });

  it("fails when Klaviyo redirects away from the saved source", async () => {
    const api = chrome("https://www.klaviyo.com/login", ready);
    await expect(new ChromeSubscriberGrowthNavigation(api as never, store(), undefined, 1, 50).prepare({ period, sourceUrl: SOURCE, clientName: "Club Furniture" }))
      .resolves.toMatchObject({ kind: "failed", code: "SUBSCRIBER_GROWTH_ROUTE_CHANGED", diagnostics: { observedUrl: "https://www.klaviyo.com/login" } });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });

  it("reports a null adapter result as an invalid script result, not a pass", async () => {
    const api = chrome(SOURCE, null);
    await expect(new ChromeSubscriberGrowthNavigation(api as never, store(), undefined, 1).prepare({ period, sourceUrl: SOURCE, clientName: "Club Furniture" })).resolves.toMatchObject({ kind: "failed", code: "SCRIPT_RESULT_INVALID" });
  });

  it("only registers HTTPS Klaviyo routes, and unregistered paths stay unsupported", () => {
    expect(registerConfiguredCaptureRoute("https://evil.example.com/x")).toBe(false);
    expect(registerConfiguredCaptureRoute("https://user:pw@www.klaviyo.com/x")).toBe(false);
    expect(isKlaviyoSupportedCaptureUrl("https://www.klaviyo.com/never-registered")).toBe(false);
    expect(isKlaviyoSupportedCaptureUrl("https://www.klaviyo.com/analytics/metrics")).toBe(false);
  });
});

describe("runner order with Section 10", () => {
  const nine = { executive_summary: "required", top_campaigns: "required", top_flows: "required", month_comparison: "required", campaign_performance: "required", flow_performance: "required", deliverability: "required", campaign_metrics: "required", flow_metrics: "required" } as const;
  const report = (sections: ReportDraft["sections"]): ReportDraft => ({ id: "11111111-1111-4111-8111-111111111111", client: { id: "c", name: "C", timezone: "America/New_York", currency: null }, reportMonth: { year: 2026, month: 8 }, period, status: "draft", version: 1, sections, screenshots: [], validation: { status: "valid", errors: [], warnings: [] }, createdAt: "2026-09-09T12:00:00.000Z", updatedAt: "2026-09-09T12:00:00.000Z" });
  it("keeps a nine-section report's run exactly as before", () => {
    expect(getAutomaticCapturePlan(report(nine)).map(({ screenshotType }) => screenshotType)).toEqual(["overview", "top_flows", "top_campaigns", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"]);
  });
  it("runs Subscriber Growth tenth when the report includes it", () => {
    const plan = getAutomaticCapturePlan(report({ ...nine, email_subscriber_growth: "required" }));
    expect(plan.map(({ screenshotType }) => screenshotType)).toEqual(["overview", "top_flows", "top_campaigns", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability", "email_subscriber_growth"]);
    expect(plan.at(-1)).toMatchObject({ label: "Subscriber Growth", requirement: "required", state: "missing" });
  });
  it("marks Section 10 stale when its proof lacks the Email → Growth evidence", () => {
    const shot = { id: "s", clientId: "c", reportMonth: { year: 2026, month: 8 }, type: "email_subscriber_growth" as const, capturedAt: "2026-09-09T12:00:00.000Z", sourceUrl: SOURCE, width: 10, height: 10, approved: false, periodConfirmed: true, storageKey: "k", mimeType: "image/png" as const, byteSize: 1, sha256: "a".repeat(64), approvedAt: null, sourceProof: createScreenshotSourceProof("email_subscriber_growth", period) };
    expect(getAutomaticCapturePlan({ ...report({ ...nine, email_subscriber_growth: "required" }), screenshots: [shot] }).at(-1)?.state).toBe("stale");
  });
  it.each(["SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED", "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED", "SUBSCRIBER_GROWTH_CHART_NOT_RENDERED", "SUBSCRIBER_GROWTH_NOT_STABLE", "SUBSCRIBER_GROWTH_TARGET_OCCLUDED", "SUBSCRIBER_GROWTH_DATE_CONTROL_NOT_FOUND"])("treats %s as a transient, retryable failure", (code) => {
    expect(classifyFailure(code).permanent).toBe(false);
    expect(classifyFailure(code).category).not.toBe("UNKNOWN");
  });
});

describe("Section 10 end to end on a simulated live page (saved source → Overview · Last 7 days)", () => {
  afterEach(removeSubscriberGrowthFixture);
  const SAVED = "https://www.klaviyo.com/people/subscribers";
  /** Chrome stand-in: the saved source loads the simulated page and the injected adapter runs inside it. */
  const liveChrome = () => {
    let url = "https://www.klaviyo.com/analytics/deliverability/email/score";
    return {
      tabs: { get: vi.fn(async () => ({ id: 7, windowId: 3, active: true, status: "complete", url })), query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true }]), update: vi.fn(async (_id: number, input: { url?: string }) => { if (input.url) url = input.url; return {}; }) },
      scripting: { executeScript: vi.fn(async ({ func, args }: { func: (...input: unknown[]) => unknown; args?: unknown[] }) => [{ frameId: 0, result: await func(...(args ?? [])) }]) },
    };
  };
  it.each([
    ["September 2026", { startDate: "2026-09-01", endDate: "2026-09-30", previousStartDate: "2026-08-01", previousEndDate: "2026-08-31" }, "09/01/2026 – 09/30/2026"],
    ["August 2026", { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" }, "08/01/2026 – 08/31/2026"],
  ] as const)("captures %s with exact proof and stores the screenshot state with its evidence", async (_label, reportPeriod, shown) => {
    const page = installSubscriberGrowthFixture({ picker: "inputs", renderDelayMs: 100, chartsDelayMs: 200 });
    const navigation = new ChromeSubscriberGrowthNavigation(liveChrome() as never, store(), undefined, 1);
    const store10 = new (class { state: unknown = null; async get() { return this.state as never; } async set(value: unknown) { this.state = value; } async clear() { this.state = null; } })();
    const captured = { sourceUrl: SAVED, isKlaviyo: true, dataUrl: "data:image/png;base64,AAAA" };
    const controller = new SubscriberGrowthAutoCaptureController(navigation, { captureVisibleTabFor: vi.fn().mockResolvedValue(captured) } as never, store10);
    await controller.start({ reportId: "r", screenshotType: "email_subscriber_growth", accountUrl: SAVED, period: reportPeriod, clientName: "Northwind Goods" });
    for (let wait = 0; wait < 100 && (store10.state as { stage?: string })?.stage !== "review_ready" && (store10.state as { stage?: string })?.stage !== "failed"; wait += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(store10.state).toMatchObject({ stage: "review_ready", detectedPeriod: shown, periodEvidence: { startDate: reportPeriod.startDate, endDate: reportPeriod.endDate }, subscriberGrowthEvidence: { emailSubscribers: 17_698, newSubscribers: 943, exclusions: 499, charts: { subscriberGrowthLine: true, newSubscribersExclusionsBar: true } }, captured });
    expect(page.state).toEqual({ channel: "Email", view: "Growth", period: shown });
    // The proof the run persists is the canonical Section 10 proof for exactly this month.
    const evidence = (store10.state as { subscriberGrowthEvidence: Parameters<typeof createScreenshotSourceProof>[4] }).subscriberGrowthEvidence;
    const proof = createScreenshotSourceProof("email_subscriber_growth", reportPeriod, undefined, null, evidence);
    expect(matchesReportCaptureSpec("email_subscriber_growth", proof)).toBe(true);
    expect(proof.expectedPeriod).toEqual({ startDate: reportPeriod.startDate, endDate: reportPeriod.endDate });
  }, 20_000);
});
