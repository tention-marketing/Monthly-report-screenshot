import { describe, expect, it, vi } from "vitest";
import { ChromeCaptureService, isKlaviyoUrl } from "./capture-service.js";
import {
  type KlaviyoActiveTabGrant,
  type KlaviyoActiveTabGrantStore,
} from "../klaviyo-navigation/active-tab-grant.js";

const grant: KlaviyoActiveTabGrant = {
  grantedTabId: 7,
  grantedWindowId: 4,
  grantedOrigin: "https://www.klaviyo.com",
  grantedUrl: "https://www.klaviyo.com/analytics/dashboards/business-review",
  grantedAt: 1,
};
const invocation = { tabId: 7, windowId: 4, origin: "https://www.klaviyo.com", pathname: "/analytics/dashboards/business-review", invokedAt: 1 };

function grantStore(initial: KlaviyoActiveTabGrant | null = grant): KlaviyoActiveTabGrantStore & { clear: ReturnType<typeof vi.fn> } {
  let current = initial;
  return {
    get: vi.fn(async () => current),
    getActionInvocation: vi.fn(async () => current ? invocation : null),
    set: vi.fn(async (next: KlaviyoActiveTabGrant) => { current = next; }),
    setActionInvocation: vi.fn(),
    clearGrant: vi.fn(async () => { current = null; }),
    clear: vi.fn(async () => { current = null; }),
  };
}

function grantedTab(overrides: Record<string, unknown> = {}) {
  return { id: 7, windowId: 4, active: true, url: grant.grantedUrl, ...overrides };
}

function chromeFor(tab = grantedTab()) {
  return {
    tabs: {
      query: vi.fn().mockResolvedValue([tab]),
      get: vi.fn().mockResolvedValue(tab),
      captureVisibleTab: vi.fn().mockResolvedValue("data:image/png;base64,AAAA"),
    },
  };
}

describe("Klaviyo source-tab recognition", () => {
  it.each(["https://www.klaviyo.com/analytics", "https://app.klaviyo.com/dashboard"])("recognizes %s", (url) => expect(isKlaviyoUrl(url)).toBe(true));
  it.each(["https://klaviyo.example.com/", "https://example.com/?next=klaviyo.com", null])("does not recognize %s", (url) => expect(isKlaviyoUrl(url)).toBe(false));

  it("uses the stored toolbar grant for manual capture and sends captureVisibleTab its granted window", async () => {
    const chromeApi = chromeFor();
    const service = new ChromeCaptureService(chromeApi, undefined, grantStore());

    await expect(service.captureVisibleTab()).resolves.toMatchObject({ tabId: 7, windowId: 4, sourceUrl: grant.grantedUrl });
    expect(chromeApi.tabs.get).toHaveBeenCalledWith(7);
    expect(chromeApi.tabs.captureVisibleTab).toHaveBeenCalledWith(4, { format: "png" });
  });

  it("does not substitute another matching Klaviyo tab for the toolbar-granted tab", async () => {
    const chromeApi = chromeFor({ id: 8, windowId: 4, active: true, url: "https://www.klaviyo.com/analytics/dashboards/another" });
    const service = new ChromeCaptureService(chromeApi, undefined, grantStore());

    await expect(service.captureVisibleTabFor!({ tabId: 8, windowId: 4 })).rejects.toMatchObject({ code: "GRANTED_TAB_CLOSED" });
    expect(chromeApi.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("fails closed when the granted tab is no longer active", async () => {
    const chromeApi = chromeFor(grantedTab({ active: false }));
    const store = grantStore();
    const service = new ChromeCaptureService(chromeApi, undefined, store);

    await expect(service.captureVisibleTab()).rejects.toMatchObject({ code: "GRANTED_TAB_NOT_ACTIVE" });
    expect(store.clearGrant).toHaveBeenCalledOnce();
    expect(chromeApi.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("fails closed when the granted tab was closed", async () => {
    const chromeApi = chromeFor();
    chromeApi.tabs.get.mockRejectedValue(new Error("No tab with id: 7"));
    const service = new ChromeCaptureService(chromeApi, undefined, grantStore());

    await expect(service.captureVisibleTab()).rejects.toMatchObject({ code: "GRANTED_TAB_CLOSED" });
    expect(chromeApi.tabs.captureVisibleTab).not.toHaveBeenCalled();
  });

  it("invalidates a grant after navigation away from Klaviyo", async () => {
    const chromeApi = chromeFor(grantedTab({ url: "https://example.com/" }));
    const store = grantStore();
    const service = new ChromeCaptureService(chromeApi, undefined, store);

    await expect(service.captureVisibleTab()).rejects.toMatchObject({
      code: "GRANTED_TAB_CHANGED_ORIGIN",
    });
    expect(store.clearGrant).toHaveBeenCalledOnce();
  });

  it("turns a Chrome activeTab denial into the same actionable grant failure", async () => {
    const chromeApi = chromeFor();
    chromeApi.tabs.captureVisibleTab.mockRejectedValue(new Error("Either the '<all_urls>' or 'activeTab' permission is required."));
    const service = new ChromeCaptureService(chromeApi, undefined, grantStore());

    await expect(service.captureVisibleTab()).rejects.toMatchObject({ code: "CAPTURE_PERMISSION_DENIED" });
  });

  it("bounds a stalled visible-tab capture and exposes a typed error", async () => {
    const chromeApi = chromeFor();
    chromeApi.tabs.captureVisibleTab.mockImplementation(() => new Promise(() => undefined));
    const service = new ChromeCaptureService(chromeApi, 1, grantStore());
    await expect(service.captureVisibleTab()).rejects.toMatchObject({ code: "CAPTURE_TIMEOUT" });
  });
});
