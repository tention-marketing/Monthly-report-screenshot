export interface ActiveCaptureTab { sourceUrl: string | null; isKlaviyo: boolean }
export interface CapturedImage extends ActiveCaptureTab { dataUrl: string }

export interface CaptureService {
  getActiveTab(): Promise<ActiveCaptureTab>;
  captureVisibleTab(): Promise<CapturedImage>;
}

interface ChromeTabsApi {
  query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ url?: string }>>;
  captureVisibleTab(windowId?: number, options?: { format: "png" }): Promise<string>;
}
interface ChromeApi { tabs?: ChromeTabsApi }

/** Isolates activeTab-gated Chrome calls from React so capture behavior remains testable. */
export class ChromeCaptureService implements CaptureService {
  constructor(private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome) {}

  async getActiveTab(): Promise<ActiveCaptureTab> {
    const tabs = this.requireTabs();
    const sourceUrl = (await tabs.query({ active: true, currentWindow: true }))[0]?.url ?? null;
    return { sourceUrl, isKlaviyo: isKlaviyoUrl(sourceUrl) };
  }

  async captureVisibleTab(): Promise<CapturedImage> {
    const active = await this.getActiveTab();
    const dataUrl = await this.requireTabs().captureVisibleTab(undefined, { format: "png" });
    return { ...active, dataUrl };
  }

  private requireTabs(): ChromeTabsApi {
    if (!this.chromeApi?.tabs) throw new Error("Chrome visible-tab capture is unavailable in this environment.");
    return this.chromeApi.tabs;
  }
}

export const unavailableCaptureService: CaptureService = {
  async getActiveTab() { return { sourceUrl: null, isKlaviyo: false }; },
  async captureVisibleTab() { throw new Error("Chrome visible-tab capture is unavailable in this environment."); },
};

export function isKlaviyoUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "klaviyo.com" || hostname.endsWith(".klaviyo.com");
  } catch { return false; }
}
