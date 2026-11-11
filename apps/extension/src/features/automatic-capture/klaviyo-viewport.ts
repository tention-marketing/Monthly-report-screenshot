import type { ChromeStorageSession, KlaviyoActiveTabGrantStore } from "../klaviyo-navigation/active-tab-grant.js";

/**
 * Klaviyo lays its cards and tables out to the tab's CSS viewport. Below this width (a narrow window or a zoomed-in
 * tab) its Time period picker stops opening reliably, cards clip columns and overlays cover rows. Observed on
 * 2026-11-02: every run at 974 CSS px (device pixel ratio 1.8) failed or produced clipped crops, while every run at
 * 1394 and 2074 CSS px (device pixel ratio 1) captured complete evidence. At 1315 CSS px the Campaigns list still
 * cut its Placed Order values under the sticky actions column, so the floor is the narrowest width proven complete.
 */
export const MIN_KLAVIYO_VIEWPORT_WIDTH = 1390;

/** Chrome's own zoom presets, largest first. Normalization never goes below 50%. */
export const CHROME_ZOOM_LEVELS: readonly number[] = [5, 4, 3, 2.5, 2, 1.75, 1.5, 1.25, 1.1, 1, 0.9, 0.8, 0.75, 2 / 3, 0.5];
const ZOOM_EPSILON = 0.005;

/** The run's toolbar-authorized tab and the zoom the user had before the extension changed it. */
export const KLAVIYO_ZOOM_RUN_KEY = "tention.klaviyo-zoom-run";
export const KLAVIYO_CAPTURE_RUN_PORT = "tention-automatic-capture-run";

export interface KlaviyoViewport { width: number; height: number; devicePixelRatio: number }

export type KlaviyoViewportNormalization =
  | { ok: true; tabId: number; originalZoom: number; captureZoom: number; changed: boolean; viewport: KlaviyoViewport }
  | { ok: false; code: "KLAVIYO_VIEWPORT_CANNOT_BE_NORMALIZED" | "KLAVIYO_VIEWPORT_UNAVAILABLE"; message: string; originalZoom: number | null; viewport: KlaviyoViewport | null };

export interface KlaviyoZoomRestore { restored: boolean; tabId: number | null; originalZoom: number | null; zoomAfter: number | null }

export interface ViewportScriptingApi {
  executeScript(details: { target: { tabId: number }; func: () => KlaviyoViewport }): Promise<Array<{ result?: unknown }>>;
}
export interface ZoomTabsApi {
  getZoom(tabId: number): Promise<number>;
  setZoom(tabId: number, zoomFactor: number): Promise<void>;
}

export function klaviyoViewportTooNarrowMessage(width: number): string {
  return `Klaviyo is displayed only ${Math.round(width)} px wide, so its cards and tables are clipped. Zoom the Klaviyo tab out (⌘−) or widen the Chrome window until it is at least ${MIN_KLAVIYO_VIEWPORT_WIDTH} px wide, then start again.`;
}

export function formatZoom(zoom: number | null): string {
  return zoom === null ? "unknown" : `${Math.round(zoom * 100)}%`;
}

/** Reads the CSS viewport of one tab; null when it cannot be read. */
export async function measureTabViewport(scripting: ViewportScriptingApi, tabId: number): Promise<KlaviyoViewport | null> {
  const [frame] = await scripting.executeScript({
    target: { tabId },
    func: () => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }),
  });
  const value = frame?.result as Partial<KlaviyoViewport> | undefined;
  return value && [value.width, value.height, value.devicePixelRatio].every((item) => typeof item === "number" && Number.isFinite(item) && item > 0)
    ? { width: value.width!, height: value.height!, devicePixelRatio: value.devicePixelRatio! } : null;
}

/**
 * Brings the toolbar-authorized Klaviyo tab to a CSS viewport where Klaviyo renders complete evidence, using Chrome's
 * real tab zoom (tabs.getZoom/setZoom) and the smallest reduction that works. Only the authorized tab is ever zoomed.
 * The user's zoom from before the run is kept in session storage, so it survives a worker restart and is restored
 * on success, failure, timeout, or when the panel running the capture closes.
 */
export class KlaviyoViewportNormalizer {
  constructor(
    private readonly tabs: ZoomTabsApi | undefined,
    private readonly scripting: ViewportScriptingApi | undefined,
    private readonly grantStore: KlaviyoActiveTabGrantStore,
    private readonly session: ChromeStorageSession | undefined,
    private readonly options: { settleIntervalMs?: number; settleTimeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  async normalize(): Promise<KlaviyoViewportNormalization> {
    const grant = await this.grantStore.get();
    if (!this.tabs || !this.scripting || !grant) return { ok: false, code: "KLAVIYO_VIEWPORT_UNAVAILABLE", message: "Open the Klaviyo tab and click the Tention Reports toolbar icon so the extension can check how wide Klaviyo is displayed.", originalZoom: null, viewport: null };
    const tabId = grant.grantedTabId;
    const stored = await this.stored();
    // A run abandoned on another tab gets its user zoom back before this tab is touched.
    if (stored && stored.tabId !== tabId) await this.restore();
    const originalZoom = stored?.tabId === tabId ? stored.originalZoom : await this.tabs.getZoom(tabId);
    if (stored?.tabId !== tabId) await this.session?.set({ [KLAVIYO_ZOOM_RUN_KEY]: { tabId, originalZoom } });

    let zoom = await this.tabs.getZoom(tabId);
    let viewport = await this.settledViewport(tabId);
    if (viewport && viewport.width >= MIN_KLAVIYO_VIEWPORT_WIDTH) return { ok: true, tabId, originalZoom, captureZoom: zoom, changed: Math.abs(zoom - originalZoom) > ZOOM_EPSILON, viewport };
    for (const level of CHROME_ZOOM_LEVELS.filter((candidate) => candidate < zoom - ZOOM_EPSILON)) {
      await this.tabs.setZoom(tabId, level);
      zoom = await this.tabs.getZoom(tabId);
      viewport = await this.settledViewport(tabId);
      if (viewport && viewport.width >= MIN_KLAVIYO_VIEWPORT_WIDTH) return { ok: true, tabId, originalZoom, captureZoom: zoom, changed: true, viewport };
    }
    await this.restore();
    return {
      ok: false, code: viewport ? "KLAVIYO_VIEWPORT_CANNOT_BE_NORMALIZED" : "KLAVIYO_VIEWPORT_UNAVAILABLE", originalZoom, viewport,
      message: viewport
        ? `Even at ${formatZoom(zoom)} zoom Klaviyo is only ${Math.round(viewport.width)} px wide (at least ${MIN_KLAVIYO_VIEWPORT_WIDTH} px is needed). The Chrome window itself is too narrow: make the window wider, then start again. Your zoom was restored to ${formatZoom(originalZoom)}.`
        : "The Klaviyo tab's viewport could not be measured. Reload the Klaviyo tab, click the Tention Reports toolbar icon, and start again.",
    };
  }

  /** Puts the user's zoom back on the tab the run changed; a no-op when no run is recorded. */
  async restore(): Promise<KlaviyoZoomRestore> {
    const stored = await this.stored();
    if (!stored || !this.tabs) return { restored: false, tabId: null, originalZoom: null, zoomAfter: null };
    try {
      await this.tabs.setZoom(stored.tabId, stored.originalZoom);
      const zoomAfter = await this.tabs.getZoom(stored.tabId);
      await this.session?.remove(KLAVIYO_ZOOM_RUN_KEY);
      return { restored: Math.abs(zoomAfter - stored.originalZoom) <= ZOOM_EPSILON, tabId: stored.tabId, originalZoom: stored.originalZoom, zoomAfter };
    } catch {
      // A closed tab has nothing left to restore.
      await this.session?.remove(KLAVIYO_ZOOM_RUN_KEY).catch(() => undefined);
      return { restored: false, tabId: stored.tabId, originalZoom: stored.originalZoom, zoomAfter: null };
    }
  }

  private async stored(): Promise<{ tabId: number; originalZoom: number } | null> {
    const record: Record<string, unknown> = await this.session?.get(KLAVIYO_ZOOM_RUN_KEY).catch(() => ({})) ?? {};
    const value = record[KLAVIYO_ZOOM_RUN_KEY] as { tabId?: unknown; originalZoom?: unknown } | undefined;
    return value && typeof value.tabId === "number" && typeof value.originalZoom === "number" && value.originalZoom > 0 ? { tabId: value.tabId, originalZoom: value.originalZoom } : null;
  }

  /** Klaviyo relayouts after a zoom change; the viewport counts only once two consecutive readings agree. */
  private async settledViewport(tabId: number): Promise<KlaviyoViewport | null> {
    const interval = this.options.settleIntervalMs ?? 150;
    const reads = Math.max(2, Math.ceil((this.options.settleTimeoutMs ?? 3_000) / interval));
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let previous = await measureTabViewport(this.scripting!, tabId).catch(() => null);
    for (let read = 1; read < reads; read += 1) {
      await sleep(interval);
      const next = await measureTabViewport(this.scripting!, tabId).catch(() => null);
      if (next && previous && next.width === previous.width && next.height === previous.height) return next;
      previous = next;
    }
    return null;
  }
}
