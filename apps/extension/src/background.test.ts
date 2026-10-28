import { describe, expect, it, vi } from "vitest";
import { ChromeSessionAutoCaptureStore, registerBackgroundAutomation } from "./background.js";
import { KLAVIYO_ACTION_INVOCATION_KEY, KLAVIYO_ACTIVE_TAB_GRANT_KEY } from "./features/klaviyo-navigation/active-tab-grant.js";
import { clickVisibleViewDashboardControl, inspectBusinessReviewDiscoveryDocument } from "./features/klaviyo-navigation/business-review-discovery.js";
import { prepareBusinessReviewCaptureDocument } from "./features/klaviyo-navigation/business-review-capture.js";
import { prepareDashboardCaptureDocument } from "./features/klaviyo-navigation/dashboard-capture.js";

describe("Tention toolbar activeTab setup", () => {
  it("registers the explicit action listener synchronously, stores the clicked Klaviyo tab, and opens its side panel", async () => {
    const values: Record<string, unknown> = {};
    const actionListener = vi.fn();
    const open = vi.fn().mockResolvedValue(undefined);
    const setPanelBehavior = vi.fn().mockResolvedValue(undefined);
    registerBackgroundAutomation({
      action: { onClicked: { addListener: actionListener } },
      runtime: { onMessage: { addListener: vi.fn() } },
      storage: { session: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      } },
      sidePanel: { open, setPanelBehavior },
    });

    expect(actionListener).toHaveBeenCalledOnce();
    expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: false });
    const listener = actionListener.mock.calls[0]![0] as (tab: { id?: number; windowId?: number; url?: string }) => void;
    listener({ id: 7, windowId: 4, url: "https://www.klaviyo.com/analytics/dashboards/business-review" });

    await vi.waitFor(() => expect(values[KLAVIYO_ACTIVE_TAB_GRANT_KEY]).toMatchObject({
      grantedTabId: 7,
      grantedWindowId: 4,
      grantedOrigin: "https://www.klaviyo.com",
      grantedUrl: "https://www.klaviyo.com/analytics/dashboards/business-review",
      grantedAt: expect.any(Number),
    }));
    expect(values[KLAVIYO_ACTION_INVOCATION_KEY]).toMatchObject({
      tabId: 7, windowId: 4, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/business-review", invokedAt: expect.any(Number),
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalledWith({ tabId: 7 }));
  });

  it("does not leave a prior Klaviyo grant attached when the action is clicked on another page", async () => {
    const actionListener = vi.fn();
    const remove = vi.fn().mockResolvedValue(undefined);
    registerBackgroundAutomation({
      action: { onClicked: { addListener: actionListener } },
      storage: { session: { get: vi.fn(), set: vi.fn(), remove } },
      sidePanel: { open: vi.fn().mockResolvedValue(undefined), setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    });
    const listener = actionListener.mock.calls[0]![0] as (tab: { id?: number; windowId?: number; url?: string }) => void;
    listener({ id: 8, windowId: 4, url: "https://example.com/" });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(KLAVIYO_ACTIVE_TAB_GRANT_KEY));
  });

  it("records /dashboard as the authoritative tab for the two home-dashboard captures", async () => {
    const values: Record<string, unknown> = {};
    const actionListener = vi.fn();
    registerBackgroundAutomation({
      action: { onClicked: { addListener: actionListener } }, runtime: { onMessage: { addListener: vi.fn() } },
      storage: { session: { get: vi.fn(async (key: string) => ({ [key]: values[key] })), set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }), remove: vi.fn() } },
      sidePanel: { open: vi.fn().mockResolvedValue(undefined), setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    });
    const listener = actionListener.mock.calls[0]![0] as (tab: { id?: number; windowId?: number; url?: string }) => void;
    listener({ id: 7, windowId: 4, url: "https://www.klaviyo.com/dashboard" });
    await vi.waitFor(() => expect(values[KLAVIYO_ACTIVE_TAB_GRANT_KEY]).toMatchObject({ grantedTabId: 7, grantedUrl: "https://www.klaviyo.com/dashboard" }));
  });

  it("clears persisted invocation and grant state on extension installation or update", async () => {
    const installedListener = vi.fn();
    const remove = vi.fn().mockResolvedValue(undefined);
    registerBackgroundAutomation({
      runtime: { onMessage: { addListener: vi.fn() }, onInstalled: { addListener: installedListener } },
      storage: { session: { get: vi.fn(), set: vi.fn(), remove } },
      sidePanel: { open: vi.fn().mockResolvedValue(undefined), setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    });
    expect(installedListener).toHaveBeenCalledOnce();
    const listener = installedListener.mock.calls[0]![0] as () => void;
    listener();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(KLAVIYO_ACTIVE_TAB_GRANT_KEY));
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(KLAVIYO_ACTION_INVOCATION_KEY));
  });

  it("routes real extension discovery messaging to the authorized tab and persists only safe diagnostics", async () => {
    const values: Record<string, unknown> = {
      [KLAVIYO_ACTION_INVOCATION_KEY]: { tabId: 7, windowId: 4, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/discovered-id", invokedAt: 10 },
      [KLAVIYO_ACTIVE_TAB_GRANT_KEY]: { grantedTabId: 7, grantedWindowId: 4, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/analytics/dashboards/discovered-id", grantedAt: 10 },
    };
    const messageListener = vi.fn();
    const tab = { id: 7, windowId: 4, url: "https://www.klaviyo.com/analytics/dashboards/discovered-id", active: true, status: "complete" };
    const chromeApi = {
      action: { onClicked: { addListener: vi.fn() } },
      runtime: { onMessage: { addListener: messageListener }, onInstalled: { addListener: vi.fn() } },
      storage: { session: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      } },
      tabs: {
        get: vi.fn(async () => tab), query: vi.fn().mockResolvedValue([tab]),
        update: vi.fn(async (_id: number, properties: { url: string }) => ({ ...tab, url: properties.url })),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn(async ({ func, args }: { func: (...args: string[]) => unknown; args: string[] }) => {
        const serialized = new Function(`return (${func.toString()})`)() as (...values: string[]) => unknown;
        return [{ frameId: 0, result: serialized(...args) }];
      }) },
      sidePanel: { open: vi.fn().mockResolvedValue(undefined), setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    };
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: chromeApi });
    document.body.innerHTML = "<header><button>CL Club Furniture</button></header><main><h1>Business Review</h1><h2>Growth Overview</h2><h2>Campaign Performance Summary</h2><h2>Flow Performance Summary</h2></main>";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20, x: 0, y: 0, toJSON() {} });
    window.history.replaceState({}, "", "/analytics/dashboards/discovered-id");
    registerBackgroundAutomation(chromeApi as never);
    const listener = messageListener.mock.calls[0]![0] as (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;
    const response = vi.fn();
    expect(listener({ type: "DISCOVER_BUSINESS_REVIEW", request: { clientName: "Club Furniture", useCurrentPage: true } }, {}, response)).toBe(true);
    await vi.waitFor(() => expect(response).toHaveBeenCalledOnce());
    expect(response).toHaveBeenCalledWith(expect.objectContaining({ ok: true, accountLabel: "CL Club Furniture", dashboardUrl: "https://www.klaviyo.com/analytics/dashboards/discovered-id" }));
    await vi.waitFor(() => expect(values["tention.business-review-discovery:last"]).toMatchObject({ status: "verified", accountLabel: "CL Club Furniture" }));
    expect(chromeApi.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] }, func: inspectBusinessReviewDiscoveryDocument }));
    expect(chromeApi.scripting.executeScript).not.toHaveBeenCalledWith(expect.objectContaining({ func: clickVisibleViewDashboardControl }));
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: previousChrome });
  });

  it.each(["overview", "top_flows"] as const)("routes automatic %s capture to the Klaviyo Home dashboard adapter, never Business Review", async (screenshotType) => {
    const values: Record<string, unknown> = {
      [KLAVIYO_ACTION_INVOCATION_KEY]: { tabId: 7, windowId: 4, origin: "https://www.klaviyo.com", pathname: "/dashboard", invokedAt: 10 },
      [KLAVIYO_ACTIVE_TAB_GRANT_KEY]: { grantedTabId: 7, grantedWindowId: 4, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/dashboard", grantedAt: 10 },
    };
    const messageListener = vi.fn();
    const tab = { id: 7, windowId: 4, url: "https://www.klaviyo.com/dashboard", active: true, status: "complete" };
    const executeScript = vi.fn().mockResolvedValue([{ frameId: 0, result: { ok: false, code: "TOP_FLOW_ROWS_NOT_FOUND", message: "stub" } }]);
    // Like Chrome, a navigation reports "loading" then "complete" to onUpdated listeners.
    const updatedListeners: Array<(id: number, change: { status?: string }, updated: typeof tab) => void> = [];
    const chromeApi = {
      action: { onClicked: { addListener: vi.fn() } },
      runtime: { onMessage: { addListener: messageListener }, onInstalled: { addListener: vi.fn() } },
      storage: { session: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
        remove: vi.fn(async (key: string) => { delete values[key]; }),
      } },
      tabs: {
        get: vi.fn(async () => tab), query: vi.fn().mockResolvedValue([tab]),
        update: vi.fn(async (_id: number, properties: { url: string }) => {
          setTimeout(() => { for (const status of ["loading", "complete"]) updatedListeners.forEach((listener) => listener(7, { status }, { ...tab, url: properties.url })); }, 5);
          return { ...tab, url: properties.url };
        }),
        onUpdated: { addListener: vi.fn((listener: typeof updatedListeners[number]) => updatedListeners.push(listener)), removeListener: vi.fn() },
        captureVisibleTab: vi.fn().mockRejectedValue(new Error("not captured in test")),
      },
      scripting: { executeScript },
      sidePanel: { open: vi.fn().mockResolvedValue(undefined), setPanelBehavior: vi.fn().mockResolvedValue(undefined) },
    };
    const previousChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
    Object.defineProperty(globalThis, "chrome", { configurable: true, value: chromeApi });
    try {
      registerBackgroundAutomation(chromeApi as never);
      const listener = messageListener.mock.calls[0]![0] as (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;
      const period = { startDate: "2026-07-01", endDate: "2026-07-31", previousStartDate: "2026-06-01", previousEndDate: "2026-06-30" };
      const response = vi.fn();
      expect(listener({ type: "START_KLAVIYO_AUTO_CAPTURE", request: { reportId: "report-1", screenshotType, accountUrl: "https://www.klaviyo.com/dashboard", period } }, {}, response)).toBe(true);
      await vi.waitFor(() => expect(executeScript).toHaveBeenCalledOnce());
      expect(executeScript).toHaveBeenCalledWith(expect.objectContaining({ target: { tabId: 7, frameIds: [0] }, func: prepareDashboardCaptureDocument, args: [expect.objectContaining({ sectionKey: screenshotType === "overview" ? "executive_summary" : "top_flows" }), period] }));
      expect(executeScript).not.toHaveBeenCalledWith(expect.objectContaining({ func: prepareBusinessReviewCaptureDocument }));
      // Every attempt reloads the Home dashboard fresh, even when the tab already shows it.
      expect(chromeApi.tabs.update).toHaveBeenCalledWith(7, { url: "https://www.klaviyo.com/dashboard" });
    } finally {
      Object.defineProperty(globalThis, "chrome", { configurable: true, value: previousChrome });
    }
  });
});

describe("shared capture state store", () => {
  const period = { startDate: "2026-06-01", endDate: "2026-06-30", previousStartDate: "2026-05-01", previousEndDate: "2026-05-31" };
  const request = (screenshotType: "top_campaigns" | "overview", attemptId?: string) => ({ reportId: "june", screenshotType, accountUrl: null, period, ...(attemptId ? { attemptId } : {}) });
  /** A session storage with a byte budget, like chrome.storage.session's 10 MB quota. */
  function quotaSession(budget: number) {
    const data: Record<string, unknown> = {};
    const size = () => JSON.stringify(data).length;
    return {
      data,
      get: vi.fn(async (key: string | null) => key === null ? { ...data } : { [key]: data[key] }),
      set: vi.fn(async (values: Record<string, unknown>) => {
        const before = { ...data }; Object.assign(data, values);
        if (size() > budget) { for (const key of Object.keys(data)) delete data[key]; Object.assign(data, before); throw new Error("Session storage quota bytes exceeded. Values were not stored."); }
      }),
      remove: vi.fn(async (key: string) => { delete data[key]; }),
    };
  }
  const screenshot = (bytes: number) => ({ sourceUrl: "https://www.klaviyo.com/omnicampaigns", isKlaviyo: true, tabId: 7, dataUrl: `data:image/png;base64,${"A".repeat(bytes)}` });

  it("never throws when session storage is full: releases stale capture states, then falls back to memory", async () => {
    const session = quotaSession(6_000);
    session.data["tention.business-review-auto-capture.july.overview"] = { stale: "A".repeat(4_000) };
    session.data["tention.active-tab-grant"] = { keep: true };
    const store = new ChromeSessionAutoCaptureStore(session);
    const ready = { request: request("top_campaigns"), stage: "review_ready" as const, sourceTabId: 7, detectedPeriod: "June", target: { x: 0, y: 0, width: 1, height: 1, viewportWidth: 1, viewportHeight: 1 }, captured: screenshot(3_000) };
    await expect(store.set(ready as never)).resolves.toBeUndefined();
    expect(session.data["tention.business-review-auto-capture.july.overview"]).toBeUndefined();
    expect(session.data["tention.active-tab-grant"]).toEqual({ keep: true });
    await expect(store.get(request("top_campaigns"))).resolves.toMatchObject({ stage: "review_ready" });
    // Larger than the whole budget: kept in service-worker memory instead of throwing into a controller.
    const huge = { ...ready, captured: screenshot(20_000) };
    await expect(store.set(huge as never)).resolves.toBeUndefined();
    await expect(store.get(request("top_campaigns"))).resolves.toMatchObject({ captured: { dataUrl: huge.captured.dataUrl } });
  });

  it("ignores every write from an abandoned attempt of the same section", async () => {
    const store = new ChromeSessionAutoCaptureStore(quotaSession(1_000_000));
    await store.set({ request: request("overview", "attempt-1"), stage: "preparing" });
    await store.set({ request: request("overview", "attempt-2"), stage: "preparing" });
    await store.set({ request: request("overview", "attempt-1"), stage: "failed", code: "CAPTURE_FAILED", message: "late write from attempt 1" });
    await expect(store.get(request("overview"))).resolves.toMatchObject({ stage: "preparing", request: { attemptId: "attempt-2" } });
  });

  it("releases every stored capture state at run start", async () => {
    const session = quotaSession(1_000_000);
    session.data["tention.business-review-auto-capture.june.top_campaigns"] = { old: true };
    session.data["tention.business-review-auto-capture.august.flow_metrics"] = { old: true };
    session.data["tention.active-tab-grant"] = { keep: true };
    await new ChromeSessionAutoCaptureStore(session).clearAll();
    expect(Object.keys(session.data)).toEqual(["tention.active-tab-grant"]);
  });
});
