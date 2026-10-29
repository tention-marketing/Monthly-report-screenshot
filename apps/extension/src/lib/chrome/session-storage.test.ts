import { describe, expect, it, vi } from "vitest";
import { approxBytes, boundedDiagnostics, stableJson, releaseObsoleteTransientState, SESSION_QUOTA_BYTES, sessionUsage, SessionStorageWriteError, writeCriticalSession, type SessionArea } from "./session-storage.js";
import { ChromeSessionKlaviyoActiveTabGrantStore, configuredCaptureRoutesSnapshot, isKlaviyoSupportedCaptureUrl, KLAVIYO_ACTIVE_TAB_GRANT_KEY, KLAVIYO_ACTION_INVOCATION_KEY, MAX_CONFIGURED_CAPTURE_ROUTES, registerConfiguredCaptureRoute } from "../../features/klaviyo-navigation/active-tab-grant.js";
import { ChromeSessionAutoCaptureStore } from "../../background.js";
import { SourceSetupGate } from "../../features/klaviyo-navigation/source-setup-gate.js";
import { SOURCE_DIAGNOSTICS_MAX_BYTES, SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY, SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY, SubscriberGrowthSourceSetup, VERIFIED_SOURCE_MAX_BYTES } from "../../features/klaviyo-navigation/subscriber-growth-source-setup.js";

/** chrome.storage.session stand-in that enforces the quota and refuses writes with Chrome's own message. */
export class QuotaSession implements SessionArea {
  data: Record<string, unknown> = {};
  constructor(private readonly quota = SESSION_QUOTA_BYTES) {}
  bytes(): number { return Object.entries(this.data).reduce((sum, [key, value]) => sum + approxBytes(key, value), 0); }
  /** Like Chrome, values come back with their object keys sorted. */
  async get(key: string | null) { const sorted = (value: unknown) => JSON.parse(stableJson(value)); return key === null ? Object.fromEntries(Object.entries(this.data).map(([name, value]) => [name, sorted(value)])) : key in this.data ? { [key]: sorted(this.data[key]) } : {}; }
  async set(values: Record<string, unknown>) {
    const next = { ...this.data, ...structuredClone(values) };
    if (Object.entries(next).reduce((sum, [key, value]) => sum + approxBytes(key, value), 0) > this.quota) throw new Error("Session storage quota bytes exceeded. Values were not stored.");
    this.data = next;
  }
  async remove(key: string) { delete this.data[key]; }
  async getBytesInUse() { return this.bytes(); }
}
const screenshot = (megabytes: number) => `data:image/png;base64,${"A".repeat(megabytes * 1024 * 1024)}`;
/** What older builds left behind: capture states holding full-viewport screenshots. */
function oldBuildCaptureState(section: string, megabytes: number) {
  return { request: { reportId: "aug", screenshotType: section, accountUrl: null, period: { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" } }, stage: "review_ready", sourceTabId: 7, detectedPeriod: "Aug", target: { x: 0, y: 0, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 }, captured: { sourceUrl: "https://www.klaviyo.com/dashboard", isKlaviyo: true, dataUrl: screenshot(megabytes) } };
}
function filledLikeTheLiveFailure(): QuotaSession {
  const session = new QuotaSession();
  for (const [index, section] of ["overview", "top_flows", "top_campaigns"].entries()) session.data[`tention.business-review-auto-capture.aug.${section}`] = oldBuildCaptureState(section, index === 0 ? 4 : 3);
  session.data[KLAVIYO_ACTIVE_TAB_GRANT_KEY] = { grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/dashboard", grantedAt: 1 };
  return session;
}
const PAGE = "https://www.klaviyo.com/people/subscribers";
const verifiedPage = { ok: true, purpose: "source", sourceUrl: PAGE, emailSelected: true, growthSelected: true, accountLabels: ["Account menu Club Furniture"], selections: ["Email"] };
const chromeFor = (url = `${PAGE}?range=last_7_days`) => ({ tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 3, url })) }, scripting: { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: verifiedPage }]) } });
const click = { id: 7, windowId: 3, url: `${PAGE}?range=last_7_days` };

describe("session storage usage report", () => {
  it("lists every key largest first, with sizes and shapes but no values", async () => {
    const session = filledLikeTheLiveFailure();
    const usage = await sessionUsage(session);
    expect(usage.keys[0]).toMatchObject({ key: "tention.business-review-auto-capture.aug.overview", valueType: "object" });
    expect(usage.keys[0]!.approxBytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(usage.totalApproxBytes).toBe(session.bytes());
    expect(usage.bytesInUse).toBe(session.bytes());
    expect(JSON.stringify(usage)).not.toContain("data:image");
  });
});

describe("the live quota failure, reproduced", () => {
  it("before the fix: a plain write of the toolbar invocation is refused when old capture states fill the session", async () => {
    const session = filledLikeTheLiveFailure();
    await expect(session.set({ [KLAVIYO_ACTION_INVOCATION_KEY]: { tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/people/subscribers", invokedAt: 1 } })).rejects.toThrow("Session storage quota bytes exceeded");
  });

  it("A: the toolbar click and the verified source are stored after obsolete capture state is released, and read back", async () => {
    const session = filledLikeTheLiveFailure();
    const grants = new ChromeSessionKlaviyoActiveTabGrantStore(session);
    await grants.setActionInvocation({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/people/subscribers", invokedAt: 1 });
    expect(Object.keys(session.data).filter((key) => key.startsWith("tention.business-review-auto-capture."))).toEqual([]);
    expect(session.data[KLAVIYO_ACTIVE_TAB_GRANT_KEY]).toBeDefined(); // grants are never released
    const setup = new SubscriberGrowthSourceSetup(chromeFor() as never, grants, session, new SourceSetupGate());
    await expect(setup.verifyAtToolbarClick(click)).resolves.toMatchObject({ ok: true, subscriberGrowthUrl: PAGE });
    await expect(setup.takeVerifiedSource()).resolves.toMatchObject({ ok: true, subscriberGrowthUrl: PAGE });
  });

  it("A (setup itself): a full session is cleaned and the verified source still lands", async () => {
    const session = filledLikeTheLiveFailure();
    const setup = new SubscriberGrowthSourceSetup(chromeFor() as never, new ChromeSessionKlaviyoActiveTabGrantStore(session), session, new SourceSetupGate());
    await expect(setup.verifyAtToolbarClick(click)).resolves.toMatchObject({ ok: true });
    expect(session.data[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY]).toMatchObject({ sourceUrl: PAGE, pathname: "/people/subscribers" });
  });

  it("B: a session full of state it may not remove gives a typed quota failure and no false success", async () => {
    const session = new QuotaSession();
    session.data["another-extension-feature"] = "x".repeat(SESSION_QUOTA_BYTES - 200);
    const setup = new SubscriberGrowthSourceSetup(chromeFor() as never, new ChromeSessionKlaviyoActiveTabGrantStore(session), session, new SourceSetupGate());
    const result = await setup.verifyAtToolbarClick(click);
    expect(result).toMatchObject({ ok: false, code: "SESSION_STORAGE_QUOTA_EXCEEDED" });
    expect(session.data[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY]).toBeUndefined();
    expect(session.data["another-extension-feature"]).toBeDefined();
    await expect(setup.takeVerifiedSource()).resolves.toMatchObject({ ok: false });
  });

  it("B: a critical write that cannot fit is a typed error with safe diagnostics", async () => {
    const session = new QuotaSession(64);
    const error = await writeCriticalSession(session, { "tention.critical": "y".repeat(500) }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SessionStorageWriteError);
    expect(error).toMatchObject({ code: "SESSION_STORAGE_QUOTA_EXCEEDED", diagnostics: { attemptedKey: "tention.critical", bytesInUse: 0 } });
  });
});

describe("bounded session state", () => {
  it("C: the verified source handoff stays under its byte budget", async () => {
    const session = new QuotaSession();
    const long = { ...verifiedPage, accountLabels: Array.from({ length: 50 }, (_, index) => `Account ${index} ${"z".repeat(500)}`) };
    const api = { tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 3, url: PAGE })) }, scripting: { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: long }]) } };
    await new SubscriberGrowthSourceSetup(api as never, new ChromeSessionKlaviyoActiveTabGrantStore(session), session, new SourceSetupGate()).verifyAtToolbarClick(click);
    expect(approxBytes(SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY, session.data[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY])).toBeLessThanOrEqual(VERIFIED_SOURCE_MAX_BYTES);
  });

  it("D: diagnostics stay under their byte budget even for a huge failing page", async () => {
    const session = new QuotaSession();
    const failing = { ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE", message: "m".repeat(10_000), diagnostics: { headings: Array.from({ length: 500 }, () => "h".repeat(200)) } };
    const api = { tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 3, url: `${PAGE}/${"p".repeat(5_000)}` })) }, scripting: { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: failing }]) } };
    await new SubscriberGrowthSourceSetup(api as never, new ChromeSessionKlaviyoActiveTabGrantStore(session), session, new SourceSetupGate()).verifyAtToolbarClick({ ...click, url: `${PAGE}/${"p".repeat(5_000)}` });
    expect(approxBytes(SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY, session.data[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY])).toBeLessThanOrEqual(SOURCE_DIAGNOSTICS_MAX_BYTES);
    expect(Object.values(session.data[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY] as object).every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))).toBe(true);
    expect(JSON.stringify(boundedDiagnostics({ nested: { deep: "x".repeat(10_000) }, error: new Error("boom") })).length).toBeLessThan(1_000);
  });

  it("E: configured capture routes are normalized, deduplicated and bounded", () => {
    for (let index = 0; index < 100; index += 1) registerConfiguredCaptureRoute(`${PAGE}?range=${index}#x`);
    expect(configuredCaptureRoutesSnapshot().filter((route) => route === PAGE)).toHaveLength(1);
    for (let index = 0; index < 100; index += 1) registerConfiguredCaptureRoute(`https://www.klaviyo.com/client-${index}/subscribers`);
    expect(configuredCaptureRoutesSnapshot()).toHaveLength(MAX_CONFIGURED_CAPTURE_ROUTES);
    expect(isKlaviyoSupportedCaptureUrl("https://www.klaviyo.com/client-99/subscribers")).toBe(true);
  });

  it("F: 100 repeated source setups do not grow session storage", async () => {
    const session = new QuotaSession();
    const grants = new ChromeSessionKlaviyoActiveTabGrantStore(session);
    const setup = new SubscriberGrowthSourceSetup(chromeFor() as never, grants, session, new SourceSetupGate());
    const sizes: number[] = [];
    for (let run = 0; run < 100; run += 1) {
      await grants.setActionInvocation({ tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/people/subscribers", invokedAt: run });
      await setup.verifyAtToolbarClick(click);
      const taken = await setup.takeVerifiedSource();
      await setup.persisted({ saved: true, sourceUrl: taken.ok ? taken.subscriberGrowthUrl : null });
      sizes.push(session.bytes());
    }
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(64);
    expect(sizes.at(-1)!).toBeLessThan(4_096);
  });

  it("G + H: screenshots never reach session storage, and usage returns to baseline after monthly runs", async () => {
    const session = new QuotaSession();
    const store = new ChromeSessionAutoCaptureStore(session as never);
    const baseline = session.bytes();
    for (const month of ["2026-08", "2026-09"]) {
      for (const section of ["overview", "top_flows", "top_campaigns", "month_comparison", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability", "email_subscriber_growth"]) {
        const state = oldBuildCaptureState(section, 2) as never as Parameters<typeof store.set>[0];
        (state.request as { reportId: string }).reportId = month;
        await store.set(state);
        expect(JSON.stringify(session.data)).not.toContain("data:image");
        expect(session.bytes()).toBeLessThan(64 * 1024);
        // The panel still gets the full screenshot from worker memory.
        expect(((await store.get(state.request)) as { captured: { dataUrl: string } }).captured.dataUrl.length).toBeGreaterThan(1024 * 1024);
        await store.clear(state.request);
      }
    }
    expect(session.bytes()).toBe(baseline);
  });

  it("reports a screenshot lost to a worker restart as a typed retryable state, never a blank image", async () => {
    const session = new QuotaSession();
    const state = oldBuildCaptureState("email_subscriber_growth", 1) as never as Parameters<ChromeSessionAutoCaptureStore["set"]>[0];
    await new ChromeSessionAutoCaptureStore(session as never).set(state);
    await expect(new ChromeSessionAutoCaptureStore(session as never).get(state.request)).resolves.toMatchObject({ stage: "failed", code: "CAPTURE_STATE_LOST" });
  });

  it("startup cleanup removes only obsolete Tention transient state", async () => {
    const session = filledLikeTheLiveFailure();
    session.data[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY] = { sourceUrl: PAGE };
    session.data["tention.klaviyo-configured-capture-routes"] = [PAGE];
    session.data["tention.business-review-discovery:last"] = { evidence: "e".repeat(100_000) };
    session.data["unrelated"] = { keep: true };
    const removed = await releaseObsoleteTransientState(session);
    expect(removed.sort()).toEqual(["tention.business-review-auto-capture.aug.overview", "tention.business-review-auto-capture.aug.top_campaigns", "tention.business-review-auto-capture.aug.top_flows", "tention.business-review-discovery:last"]);
    expect(Object.keys(session.data).sort()).toEqual([KLAVIYO_ACTIVE_TAB_GRANT_KEY, "tention.klaviyo-configured-capture-routes", SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY, "unrelated"].sort());
  });
});
