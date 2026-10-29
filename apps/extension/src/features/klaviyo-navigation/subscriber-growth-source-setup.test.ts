import { afterEach, describe, expect, it, vi } from "vitest";
import { isKlaviyoSupportedCaptureUrl, type ChromeStorageSession, type KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";
import { SourceSetupGate } from "./source-setup-gate.js";
import { installSubscriberGrowthFixture, removeSubscriberGrowthFixture } from "./subscriber-growth-fixture.js";
import { SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY, SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY, SubscriberGrowthSourceSetup } from "./subscriber-growth-source-setup.js";

const PAGE = "https://www.klaviyo.com/setup-subscriber-growth";
const verifiedProbe = { ok: true, purpose: "source", sourceUrl: PAGE, emailSelected: true, growthSelected: true, accountLabels: ["Club Furniture"], selections: ["Email", "Growth"] };
function memorySession(): ChromeStorageSession & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return { data, get: async (key) => key === null ? { ...data } : { [key]: data[key] }, set: async (values) => { Object.assign(data, values); }, remove: async (key) => { delete data[key]; } };
}
function grants(): KlaviyoActiveTabGrantStore { return { get: vi.fn(), getActionInvocation: vi.fn(), set: vi.fn().mockResolvedValue(undefined), setActionInvocation: vi.fn(), clearGrant: vi.fn(), clear: vi.fn() }; }
/** `urls` is the clicked tab's address at successive reads; the probe result is what the page reports. */
function chrome(urls: string[], probe: unknown = verifiedProbe, probeDelayMs = 0) {
  let read = 0;
  return {
    tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 3, url: urls[Math.min(read++, urls.length - 1)] })), query: vi.fn().mockResolvedValue([{ id: 99, windowId: 3 }]) },
    scripting: { executeScript: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve([{ frameId: 0, result: probe }]), probeDelayMs))) },
  };
}
const click = { id: 7, windowId: 3, url: `${PAGE}?range=last30` };

describe("one-time Subscriber Growth source setup at the toolbar click", () => {
  it("verifies and records the clicked tab immediately, then saves it once with an acknowledgement", async () => {
    const session = memorySession(); const store = grants(); const api = chrome([click.url]);
    const setup = new SubscriberGrowthSourceSetup(api as never, store, session, new SourceSetupGate());
    await expect(setup.verifyAtToolbarClick(click)).resolves.toMatchObject({ ok: true, subscriberGrowthUrl: PAGE, accountLabels: ["Club Furniture"] });
    expect(api.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] } }));
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ grantedTabId: 7, grantedWindowId: 3, grantedOrigin: "https://www.klaviyo.com" }));
    expect(isKlaviyoSupportedCaptureUrl(PAGE)).toBe(true);
    expect(session.data[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY]).toMatchObject({ SOURCE_SETUP_STATE: "VERIFIED", GRANTED_TAB_ID: 7, GRANTED_ORIGIN: "https://www.klaviyo.com", GRANTED_URL: PAGE, URL_BEFORE_TOOLBAR_GRANT: PAGE, URL_AFTER_TOOLBAR_GRANT: PAGE, NAVIGATION_DETECTED: false });
    // No query string (a date, a token) is ever stored or logged.
    expect(JSON.stringify(session.data)).not.toContain("range=last30");
    await expect(setup.takeVerifiedSource()).resolves.toMatchObject({ ok: true, subscriberGrowthUrl: PAGE });
    await setup.persisted({ saved: true, sourceUrl: PAGE });
    expect(session.data[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY]).toBeUndefined();
    expect(session.data[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY]).toMatchObject({ SOURCE_SETUP_STATE: "SAVED", URL_AFTER_SOURCE_SAVE: PAGE });
  });

  it.each([
    ["the path changes on the same origin", "https://www.klaviyo.com/setup-subscriber-growth/email/growth"],
    ["the query and hash change on the same origin", `${PAGE}?channel=email#growth`],
  ])("continues when %s (SPA rendering is not an origin change)", async (_label, after) => {
    const session = memorySession();
    const setup = new SubscriberGrowthSourceSetup(chrome([after]) as never, grants(), session, new SourceSetupGate());
    await expect(setup.verifyAtToolbarClick(click)).resolves.toMatchObject({ ok: true });
    expect(session.data[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY]).toMatchObject({ GRANTED_ORIGIN: "https://www.klaviyo.com", CURRENT_ORIGIN: "https://www.klaviyo.com", REDIRECTED_ORIGIN: null });
  });

  it("fails closed with typed diagnostics on a real cross-origin navigation, and saves nothing", async () => {
    const session = memorySession(); const store = grants();
    const setup = new SubscriberGrowthSourceSetup(chrome(["https://accounts.example.com/login?next=x"]) as never, store, session, new SourceSetupGate());
    await expect(setup.verifyAtToolbarClick(click)).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_REDIRECTED", diagnostics: { GRANTED_ORIGIN: "https://www.klaviyo.com", REDIRECTED_ORIGIN: "https://accounts.example.com", NAVIGATION_DETECTED: true } });
    expect(store.set).not.toHaveBeenCalled();
    expect(session.data[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY]).toBeUndefined();
    // The save step reports the click's own typed cause, never a generic "not verified".
    await expect(setup.takeVerifiedSource()).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_REDIRECTED" });
  });

  it("uses the granted tab id even when another tab becomes active before the save", async () => {
    const session = memorySession(); const api = chrome([click.url]);
    const setup = new SubscriberGrowthSourceSetup(api as never, grants(), session, new SourceSetupGate());
    await setup.verifyAtToolbarClick(click);
    // tabs.query would report tab 99 as active; setup never asks which tab is active.
    await expect(setup.takeVerifiedSource()).resolves.toMatchObject({ ok: true, subscriberGrowthUrl: PAGE, diagnostics: { GRANTED_TAB_ID: 7, CURRENT_TAB_ID: 7 } });
    expect(api.tabs.query).not.toHaveBeenCalled();
    expect(api.tabs.get.mock.calls.every(([id]) => id === 7)).toBe(true);
  });

  it.each([
    ["the Profiles table", { ok: false, code: "SUBSCRIBER_GROWTH_PAGE_NOT_READY", message: "Not Subscriber growth.", diagnostics: {} }],
    ["Text message", { ok: false, code: "SUBSCRIBER_GROWTH_EMAIL_TAB_NOT_SELECTED", message: "Select Email.", diagnostics: {} }],
    ["Overview", { ok: false, code: "SUBSCRIBER_GROWTH_VIEW_NOT_SELECTED", message: "Select Growth.", diagnostics: {} }],
  ])("never records %s as the source", async (_label, probe) => {
    const session = memorySession(); const store = grants();
    const setup = new SubscriberGrowthSourceSetup(chrome([click.url], probe) as never, store, session, new SourceSetupGate());
    await expect(setup.verifyAtToolbarClick(click)).resolves.toMatchObject({ ok: false, code: probe.code });
    expect(session.data[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY]).toBeUndefined();
    expect(store.set).not.toHaveBeenCalled();
  });

  it("bounds a page read that never returns", async () => {
    const setup = new SubscriberGrowthSourceSetup(chrome([click.url], verifiedProbe, 1_000) as never, grants(), memorySession(), new SourceSetupGate(), undefined, 20);
    await expect(setup.verifyAtToolbarClick(click)).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_SETUP_TIMEOUT" });
  });

  it("ignores toolbar clicks outside Klaviyo", async () => {
    const api = chrome(["https://example.com/"]);
    await expect(new SubscriberGrowthSourceSetup(api as never, grants(), memorySession(), new SourceSetupGate()).verifyAtToolbarClick({ id: 1, windowId: 1, url: "https://example.com/" })).resolves.toBeNull();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe("automatic navigation waits for source setup", () => {
  it("holds a capture start while the source is validating, then releases it", async () => {
    const gate = new SourceSetupGate();
    const setup = new SubscriberGrowthSourceSetup(chrome([click.url], verifiedProbe, 40) as never, grants(), memorySession(), gate);
    const validating = setup.verifyAtToolbarClick(click);
    expect(gate.state).toBe("VALIDATING");
    let started = false;
    const capture = gate.waitUntilIdle(1_000).then((idle) => { started = idle; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(started).toBe(false);
    await validating; await capture;
    expect(started).toBe(true); expect(gate.state).toBe("IDLE");
  });

  it("holds navigation while the panel persists, until the save is acknowledged", async () => {
    const gate = new SourceSetupGate();
    const setup = new SubscriberGrowthSourceSetup(chrome([click.url]) as never, grants(), memorySession(), gate);
    await setup.verifyAtToolbarClick(click);
    await setup.takeVerifiedSource();
    expect(gate.state).toBe("PERSISTING");
    await expect(gate.waitUntilIdle(10)).resolves.toBe(false);
    await setup.persisted({ saved: true, sourceUrl: PAGE });
    await expect(gate.waitUntilIdle(10)).resolves.toBe(true);
  });

  it("never stays locked: an unreleased stage returns to idle on its own", async () => {
    const gate = new SourceSetupGate(20);
    gate.begin("PERSISTING");
    await expect(gate.waitUntilIdle(500)).resolves.toBe(true);
  });
});

describe("live-state reproduction: toolbar click on Subscriber growth · Overview · Last 7 days", () => {
  /** A Chrome stand-in that runs the injected adapter in the simulated page, exactly as Chrome serializes it. */
  const realPage = (tabUrl = "https://www.klaviyo.com/people/subscribers?range=last_7_days") => ({
    tabs: { get: vi.fn(async (id: number) => ({ id, windowId: 3, url: tabUrl })), query: vi.fn() },
    scripting: { executeScript: vi.fn(async ({ func, args }: { func: (...input: unknown[]) => unknown; args?: unknown[] }) => [{ frameId: 0, result: await func(...(args ?? [])) }]) },
  });
  afterEach(removeSubscriberGrowthFixture);

  it("selects Email → Growth itself, verifies the three metrics, and records the stable source from one click", async () => {
    const page = installSubscriberGrowthFixture({ renderDelayMs: 150, metricsDelayMs: 150 });
    const session = memorySession(); const store = grants(); const gate = new SourceSetupGate();
    const setup = new SubscriberGrowthSourceSetup(realPage() as never, store, session, gate);
    const result = await setup.verifyAtToolbarClick({ id: 7, windowId: 3, url: "https://www.klaviyo.com/people/subscribers?range=last_7_days" });
    expect(result).toMatchObject({ ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers", accountLabels: ["Account menu Northwind Goods"] });
    expect(page.clicks).toEqual(["Email"]);
    expect(page.state).toEqual({ channel: "Email", view: "Growth", period: "Last 7 days" });
    expect(session.data[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY]).toMatchObject({ SOURCE_SETUP_STATE: "VERIFIED", GRANTED_TAB_ID: 7, GRANTED_ORIGIN: "https://www.klaviyo.com", PROBE_RESULT: "VERIFIED", PROBE_SELECTIONS: "Email" });
    expect(store.set).toHaveBeenCalledWith(expect.objectContaining({ grantedTabId: 7 }));
    expect(gate.state).toBe("IDLE");
    await expect(setup.takeVerifiedSource()).resolves.toMatchObject({ ok: true, subscriberGrowthUrl: "https://www.klaviyo.com/people/subscribers" });
  });

  it("reports the typed cause of a failed click instead of a generic not-verified", async () => {
    installSubscriberGrowthFixture({ heading: "Profiles", hasEmailTab: false, path: "/people" });
    const session = memorySession();
    const setup = new SubscriberGrowthSourceSetup(realPage("https://www.klaviyo.com/people") as never, grants(), session, new SourceSetupGate());
    await expect(setup.verifyAtToolbarClick({ id: 7, windowId: 3, url: "https://www.klaviyo.com/people" })).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE" });
    await expect(setup.takeVerifiedSource()).resolves.toMatchObject({ ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE", diagnostics: { FAILURE_CODE: "SUBSCRIBER_GROWTH_SOURCE_WRONG_PAGE" } });
  }, 15_000);
});
