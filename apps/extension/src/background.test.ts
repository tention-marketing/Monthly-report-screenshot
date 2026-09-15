import { describe, expect, it, vi } from "vitest";
import { registerBackgroundAutomation } from "./background.js";
import { KLAVIYO_ACTION_INVOCATION_KEY, KLAVIYO_ACTIVE_TAB_GRANT_KEY } from "./features/klaviyo-navigation/active-tab-grant.js";

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
});
