import { describe, expect, it, vi } from "vitest";
import type { ChromeStorageSession, KlaviyoActiveTabGrantStore } from "../klaviyo-navigation/active-tab-grant.js";
import { KLAVIYO_ZOOM_RUN_KEY, KlaviyoViewportNormalizer, MIN_KLAVIYO_VIEWPORT_WIDTH, klaviyoViewportTooNarrowMessage } from "./klaviyo-viewport.js";

const grant = { grantedTabId: 7, grantedWindowId: 4, grantedOrigin: "https://www.klaviyo.com", grantedUrl: "https://www.klaviyo.com/dashboard", grantedAt: 1 };
const grantStore = (value: typeof grant | null = grant) => ({ get: vi.fn().mockResolvedValue(value) }) as unknown as KlaviyoActiveTabGrantStore;

/** A Chrome tab whose CSS viewport is its window width divided by its zoom, like a real tab. */
function fakeChrome(initialZoom: number, windowCssWidthAt100: number) {
  const zooms = new Map<number, number>([[7, initialZoom], [9, 1]]);
  const values: Record<string, unknown> = {};
  const tabs = {
    getZoom: vi.fn(async (tabId: number) => zooms.get(tabId)!),
    setZoom: vi.fn(async (tabId: number, factor: number) => { zooms.set(tabId, factor); }),
  };
  const scripting = {
    executeScript: vi.fn(async ({ target }: { target: { tabId: number } }) => [{ result: { width: Math.round(windowCssWidthAt100 / zooms.get(target.tabId)!), height: Math.round(1300 / zooms.get(target.tabId)!), devicePixelRatio: 2 * zooms.get(target.tabId)! } }]),
  };
  const session = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (next: Record<string, unknown>) => { Object.assign(values, next); }),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  } as unknown as ChromeStorageSession;
  return { zooms, values, tabs, scripting, session };
}
const fast = { settleIntervalMs: 1, sleep: async () => undefined };

describe("Klaviyo viewport normalization (Chrome tab zoom)", () => {
  it("leaves the zoom unchanged when Klaviyo is already wide enough", async () => {
    const chrome = fakeChrome(1, 1500);
    const result = await new KlaviyoViewportNormalizer(chrome.tabs, chrome.scripting, grantStore(), chrome.session, fast).normalize();
    expect(result).toMatchObject({ ok: true, originalZoom: 1, captureZoom: 1, changed: false, viewport: { width: 1500 } });
    expect(chrome.tabs.setZoom).not.toHaveBeenCalled();
  });

  it("reduces the zoom through Chrome's presets from the user's level and stops at the first safe one", async () => {
    const chrome = fakeChrome(1.25, 1100); // 880 px at 125% … 1375 px at 80%, 1467 px at 75%
    const result = await new KlaviyoViewportNormalizer(chrome.tabs, chrome.scripting, grantStore(), chrome.session, fast).normalize();
    expect(chrome.tabs.setZoom.mock.calls.map(([, factor]) => factor)).toEqual([1.1, 1, 0.9, 0.8, 0.75]);
    expect(result).toMatchObject({ ok: true, originalZoom: 1.25, captureZoom: 0.75, changed: true, viewport: { width: 1467 } });
    expect(result.ok && result.viewport.width).toBeGreaterThanOrEqual(MIN_KLAVIYO_VIEWPORT_WIDTH);
  });

  it("fails as KLAVIYO_VIEWPORT_CANNOT_BE_NORMALIZED when even 50% is too narrow, and restores the user's zoom", async () => {
    const chrome = fakeChrome(1, 600); // 1200 px at 50%
    const result = await new KlaviyoViewportNormalizer(chrome.tabs, chrome.scripting, grantStore(), chrome.session, fast).normalize();
    expect(result).toMatchObject({ ok: false, code: "KLAVIYO_VIEWPORT_CANNOT_BE_NORMALIZED", originalZoom: 1 });
    expect(!result.ok && result.message).toMatch(/Chrome window itself is too narrow/);
    expect(Math.min(...chrome.tabs.setZoom.mock.calls.map(([, factor]) => factor).slice(0, -1))).toBe(0.5);
    expect(chrome.zooms.get(7)).toBe(1);
    expect(chrome.values[KLAVIYO_ZOOM_RUN_KEY]).toBeUndefined();
  });

  it("keeps the user's original zoom across re-normalization mid-run and restores exactly that zoom", async () => {
    const chrome = fakeChrome(1.25, 1100);
    const normalizer = new KlaviyoViewportNormalizer(chrome.tabs, chrome.scripting, grantStore(), chrome.session, fast);
    await normalizer.normalize();
    chrome.zooms.set(7, 1.5); // the user zooms in while capture is running
    const again = await normalizer.normalize();
    expect(again).toMatchObject({ ok: true, originalZoom: 1.25, captureZoom: 0.75 });
    await expect(normalizer.restore()).resolves.toEqual({ restored: true, tabId: 7, originalZoom: 1.25, zoomAfter: 1.25 });
    expect(chrome.zooms.get(7)).toBe(1.25);
    expect(chrome.values[KLAVIYO_ZOOM_RUN_KEY]).toBeUndefined();
    await expect(normalizer.restore()).resolves.toMatchObject({ restored: false });
  });

  it("only reads and zooms the toolbar-authorized Klaviyo tab", async () => {
    const chrome = fakeChrome(1.25, 1100);
    const normalizer = new KlaviyoViewportNormalizer(chrome.tabs, chrome.scripting, grantStore(), chrome.session, fast);
    await normalizer.normalize(); await normalizer.restore();
    expect(new Set([...chrome.tabs.setZoom.mock.calls, ...chrome.tabs.getZoom.mock.calls].map(([tabId]) => tabId))).toEqual(new Set([7]));
    expect(new Set(chrome.scripting.executeScript.mock.calls.map(([details]) => details.target.tabId))).toEqual(new Set([7]));
    expect(chrome.zooms.get(9)).toBe(1);
  });

  it("does nothing without a toolbar grant", async () => {
    const chrome = fakeChrome(1.25, 1100);
    const result = await new KlaviyoViewportNormalizer(chrome.tabs, chrome.scripting, grantStore(null), chrome.session, fast).normalize();
    expect(result).toMatchObject({ ok: false, code: "KLAVIYO_VIEWPORT_UNAVAILABLE" });
    expect(chrome.tabs.setZoom).not.toHaveBeenCalled();
  });

  it("refuses the widths observed to clip Klaviyo evidence (974, 1315) and accepts the narrowest proven-complete width (1394)", () => {
    expect(974).toBeLessThan(MIN_KLAVIYO_VIEWPORT_WIDTH);
    expect(1315).toBeLessThan(MIN_KLAVIYO_VIEWPORT_WIDTH);
    expect(1394).toBeGreaterThanOrEqual(MIN_KLAVIYO_VIEWPORT_WIDTH);
    expect(klaviyoViewportTooNarrowMessage(974.4)).toMatch(/only 974 px wide.*at least 1390 px/);
  });
});
