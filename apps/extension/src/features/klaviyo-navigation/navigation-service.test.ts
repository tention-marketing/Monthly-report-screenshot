import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChromeKlaviyoNavigationService, klaviyoNavigationTargets } from "./navigation-service.js";
import { KLAVIYO_ACTION_INVOCATION_KEY, KLAVIYO_ACTIVE_TAB_GRANT_KEY } from "./active-tab-grant.js";

const period = { startDate: "2026-08-01", endDate: "2026-08-31", previousStartDate: "2026-07-01", previousEndDate: "2026-07-31" };

function readyTabs(overrides: Partial<{
  create: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}> = {}) {
  return {
    create: vi.fn().mockResolvedValue({ id: 8 }),
    query: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({ id: 7 }),
    get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" }),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
    ...overrides,
  };
}

function adapterSuccess() {
  return {
    ok: true as const,
    pageVerified: true as const,
    periodVerified: true as const,
    sourceUrl: "https://www.klaviyo.com/analytics/dashboards",
    targetRect: { x: 10, y: 20, width: 300, height: 200, top: 20, left: 10, right: 310, bottom: 220 },
    viewport: { width: 1200, height: 800 },
  };
}

describe("Klaviyo navigation service", () => {
  beforeEach(() => {
    const grant = {
      grantedTabId: 7,
      grantedWindowId: 3,
      grantedOrigin: "https://www.klaviyo.com",
      grantedUrl: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK",
      grantedAt: 1,
    };
    const invocation = { tabId: 7, windowId: 3, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK", invokedAt: 1 };
    vi.stubGlobal("chrome", { storage: { session: {
      get: vi.fn(async (key: string) => ({ [key]: key === KLAVIYO_ACTIVE_TAB_GRANT_KEY ? grant : key === KLAVIYO_ACTION_INVOCATION_KEY ? invocation : undefined })),
      set: vi.fn(), remove: vi.fn(),
    } } });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("keeps centralized guidance and falls back when account context is absent", async () => {
    const service = new ChromeKlaviyoNavigationService();
    await expect(service.openSection("top_campaigns", null, period)).resolves.toMatchObject({ kind: "account_context_required", target: klaviyoNavigationTargets.top_campaigns });
    expect(service.preparePeriod(period)).toEqual({ kind: "manual_period_required" });
  });
  it("opens only a user-provided Klaviyo workspace URL", async () => {
    const create = vi.fn().mockResolvedValue({});
    const service = new ChromeKlaviyoNavigationService({ tabs: { create } });
    await expect(service.openSection("overview", "https://www.klaviyo.com/company/example", period)).resolves.toMatchObject({ kind: "opened_workspace" });
    expect(create).toHaveBeenCalledWith({ url: "https://www.klaviyo.com/company/example", active: true });
  });
  it("reuses the already-active configured Klaviyo workspace instead of opening a duplicate", async () => {
    const create = vi.fn();
    const service = new ChromeKlaviyoNavigationService({
      tabs: readyTabs({ create, query: vi.fn().mockResolvedValue([{ id: 7, active: true, url: "https://www.klaviyo.com/company/example" }]) }),
    });
    await expect(service.openSection("overview", "https://www.klaviyo.com/company/example", period)).resolves.toMatchObject({ kind: "opened_workspace" });
    expect(create).not.toHaveBeenCalled();
  });
  it("returns a typed manual fallback when opening the workspace fails", async () => {
    const service = new ChromeKlaviyoNavigationService({ tabs: { create: vi.fn().mockRejectedValue(new Error("blocked")) } });
    await expect(service.openSection("top_flows", "https://www.klaviyo.com/company/example", period)).resolves.toMatchObject({ kind: "open_failed" });
  });
  it("reuses a verified Klaviyo tab and centralizes DOM preparation through scripting", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: adapterSuccess() }]);
    const query = vi.fn().mockResolvedValue([{ id: 7, active: true, url: "https://www.klaviyo.com/analytics/dashboards" }]);
    const tabs = readyTabs({ query });
    const service = new ChromeKlaviyoNavigationService({
      tabs,
      scripting: { executeScript },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toMatchObject({ kind: "ready", detectedPeriod: "Aug 1, 2026 – Aug 31, 2026" });
    expect(query).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({
      target: { tabId: 7, frameIds: [0] },
      args: [{ startDate: "2026-08-01", endDate: "2026-08-31" }],
    }));
    expect(tabs.create).not.toHaveBeenCalled();
  });
  it("requires a stored toolbar grant before automatic capture and never opens a replacement tab", async () => {
    const executeScript = vi.fn();
    const tabs = readyTabs({ query: vi.fn().mockResolvedValue([{ id: 7, windowId: 3, active: true, url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" }]) });
    const noGrant = { get: vi.fn().mockResolvedValue(null), getActionInvocation: vi.fn().mockResolvedValue(null), set: vi.fn(), setActionInvocation: vi.fn(), clearGrant: vi.fn(), clear: vi.fn() };
    const service = new ChromeKlaviyoNavigationService({ tabs, scripting: { executeScript } }, undefined, noGrant);

    await expect(service.prepareExecutiveSummary(null, period)).resolves.toMatchObject({
      kind: "failed", code: "ACTION_NOT_INVOKED",
    });
    expect(executeScript).not.toHaveBeenCalled();
    expect(tabs.create).not.toHaveBeenCalled();
  });
  it("invalidates the grant when its tab is no longer on the supported dashboard route", async () => {
    const executeScript = vi.fn();
    const tabs = readyTabs({
        query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/campaigns" }]),
        get: vi.fn().mockResolvedValue({ id: 7, status: "complete", url: "https://www.klaviyo.com/campaigns" }),
      });
    const service = new ChromeKlaviyoNavigationService({ tabs, scripting: { executeScript } });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toEqual({
      kind: "failed", code: "GRANTED_TAB_NOT_ACTIVE", message: "The Klaviyo tab used to open Tention Reports is no longer active. Return to it and click the Tention Reports toolbar icon again.",
    });
    expect(executeScript).not.toHaveBeenCalled();
    expect(tabs.create).not.toHaveBeenCalled();
  });
  it("does not substitute an unrelated active tab for the toolbar-granted tab", async () => {
    const executeScript = vi.fn();
    const service = new ChromeKlaviyoNavigationService({
      tabs: readyTabs({ query: vi.fn().mockResolvedValue([{ id: 8, windowId: 3, active: true, url: "https://www.klaviyo.com/analytics/dashboards/another" }]) }),
      scripting: { executeScript },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toMatchObject({ kind: "failed", code: "GRANTED_TAB_NOT_ACTIVE" });
    expect(executeScript).not.toHaveBeenCalled();
  });
  it("injects the final ready dashboard tab and reports only safe tab diagnostics", async () => {
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: adapterSuccess() }]);
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = new ChromeKlaviyoNavigationService({
      tabs: readyTabs({
        query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/campaigns" }]),
        get: vi.fn().mockResolvedValue({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" }),
      }),
      scripting: { executeScript },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toMatchObject({ kind: "ready", sourceTabId: 7 });
    expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] } }));
    expect(consoleInfo).toHaveBeenCalledWith("[Tention] Executive Summary tab diagnostic", {
      tabId: 7, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK", pathnameMatched: true,
    });
  });
  it("injects only the already-active tab without transferring automation to another tab", async () => {
    const events: string[] = [];
    const tabs = readyTabs({
      query: vi.fn().mockResolvedValue([{ id: 7, active: true, url: "https://www.klaviyo.com/analytics/dashboards" }]),
    });
    const executeScript = vi.fn().mockImplementation(async () => {
      events.push("inject");
      return [{ frameId: 0, result: { ok: false, code: "TARGET_NOT_FOUND", message: "Growth Overview could not be detected." } }];
    });
    const service = new ChromeKlaviyoNavigationService({ tabs, scripting: { executeScript } });
    await service.prepareExecutiveSummary(null, period);
    expect(events).toEqual(["inject"]);
    expect(tabs.update).not.toHaveBeenCalled();
  });
  it("fails closed when Chrome returns no ExecutionResult entries", async () => {
    const service = new ChromeKlaviyoNavigationService({
      tabs: readyTabs({ query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/analytics/dashboards" }]) }),
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toEqual({
      kind: "failed", code: "SCRIPT_RESULT_EMPTY", message: "The Tention Klaviyo helper returned no execution result. Use Capture Manually.",
    });
  });
  it("fails closed when Chrome returns an ExecutionResult with undefined result", async () => {
    const service = new ChromeKlaviyoNavigationService({
      tabs: readyTabs({ query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/analytics/dashboards" }]) }),
      scripting: { executeScript: vi.fn().mockResolvedValue([{ frameId: 0, result: undefined }]) },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toEqual({
      kind: "failed", code: "SCRIPT_RESULT_UNDEFINED", message: "The Tention Klaviyo helper did not return a usable result. Use Capture Manually.",
    });
  });
  it("preserves a typed page-side adapter error instead of treating it as a missing Chrome result", async () => {
    const service = new ChromeKlaviyoNavigationService({
      tabs: readyTabs({ query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/analytics/dashboards" }]) }),
      scripting: { executeScript: vi.fn().mockResolvedValue([{
        frameId: 0,
        result: { ok: false, code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: "Klaviyo changed this page while it was being prepared." },
      }]) },
    });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toEqual({
      kind: "failed", code: "KLAVIYO_PAGE_ADAPTER_ERROR", message: "Klaviyo changed this page while it was being prepared.",
    });
  });
  it("returns a bounded typed fallback when the target tab never becomes ready", async () => {
    const tabs = readyTabs({
      query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/analytics/dashboards" }]),
      get: vi.fn().mockResolvedValueOnce({ id: 7, windowId: 3, active: true, status: "complete", url: "https://www.klaviyo.com/analytics/dashboards/01HWZSHD83RW7CYWQ6EVVQD2BK" }).mockImplementation(() => new Promise(() => undefined)),
    });
    const service = new ChromeKlaviyoNavigationService({ tabs, scripting: { executeScript: vi.fn() } }, 1);
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toMatchObject({ kind: "failed", code: "PAGE_READY_TIMEOUT" });
  });
  it("reports a rejected script injection without leaving callers waiting", async () => {
    const tabs = readyTabs({ query: vi.fn().mockResolvedValue([{ id: 7, url: "https://www.klaviyo.com/analytics/dashboards" }]) });
    const service = new ChromeKlaviyoNavigationService({ tabs, scripting: { executeScript: vi.fn().mockRejectedValue(new Error("Cannot access contents of URL")) } });
    await expect(service.prepareExecutiveSummary(null, period)).resolves.toMatchObject({
      kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: expect.stringContaining("Cannot access contents of URL"),
    });
  });
});
