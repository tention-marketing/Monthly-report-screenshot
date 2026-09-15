import { chromeErrorMessage, isChromeOperationTimeout, withTimeout } from "../../lib/chrome/with-timeout.js";
import {
  ChromeSessionKlaviyoActiveTabGrantStore,
  activeTabGrantFailureMessage,
  type ActiveTabGrantFailureCode,
  type KlaviyoActiveTabGrantStore,
  verifyKlaviyoActiveTabGrant,
} from "../klaviyo-navigation/active-tab-grant.js";

export interface ActiveCaptureTab { sourceUrl: string | null; isKlaviyo: boolean; tabId?: number; windowId?: number }
export interface CapturedImage extends ActiveCaptureTab { dataUrl: string }

export interface CaptureTarget { tabId: number; windowId?: number }

export interface CaptureService {
  getActiveTab(): Promise<ActiveCaptureTab>;
  captureVisibleTab(): Promise<CapturedImage>;
  captureVisibleTabFor?(target: CaptureTarget): Promise<CapturedImage>;
}

interface ChromeTabsApi {
  query(queryInfo: { active: boolean; currentWindow?: boolean; windowId?: number }): Promise<Array<{ id?: number; windowId?: number; url?: string; active?: boolean }>>;
  get?(tabId: number): Promise<{ id?: number; windowId?: number; url?: string; active?: boolean }>;
  captureVisibleTab(windowId?: number, options?: { format: "png" }): Promise<string>;
}
interface ChromeApi { tabs?: ChromeTabsApi }

export type CaptureFailureCode = "ACTIVE_TAB_LOOKUP_FAILED" | "VISIBLE_TAB_CAPTURE_FAILED" | "CAPTURE_TARGET_NOT_ACTIVE" | "CAPTURE_TIMEOUT" | "KLAVIYO_CAPTURE_PERMISSION_REQUIRED" | "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED" | "CAPTURE_PERMISSION_DENIED" | ActiveTabGrantFailureCode;

export class ChromeCaptureError extends Error {
  constructor(readonly code: CaptureFailureCode, message: string) {
    super(message);
    this.name = "ChromeCaptureError";
  }
}

export const CHROME_CAPTURE_TIMEOUT_MS = 8_000;

/** Isolates activeTab-gated Chrome calls from React so capture behavior remains testable. */
export class ChromeCaptureService implements CaptureService {
  constructor(
    private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
    private readonly timeoutMs = CHROME_CAPTURE_TIMEOUT_MS,
    private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore(),
  ) {}

  async getActiveTab(): Promise<ActiveCaptureTab> {
    const tabs = this.requireTabs();
    const tab = (await this.runChromeOperation(
      () => tabs.query({ active: true, currentWindow: true }),
      "checking the active browser tab",
      "ACTIVE_TAB_LOOKUP_FAILED",
    ))[0];
    const sourceUrl = tab?.url ?? null;
    return { sourceUrl, isKlaviyo: isKlaviyoUrl(sourceUrl), ...(typeof tab?.id === "number" ? { tabId: tab.id } : {}), ...(typeof tab?.windowId === "number" ? { windowId: tab.windowId } : {}) };
  }

  async captureVisibleTab(): Promise<CapturedImage> {
    const grant = await this.requireActiveTabGrant(this.requireTabs());
    return this.captureVisibleTabFor({ tabId: grant.grantedTabId, windowId: grant.grantedWindowId });
  }

  async captureVisibleTabFor(target: CaptureTarget): Promise<CapturedImage> {
    const tabs = this.requireTabs();
    const grant = await this.requireActiveTabGrant(tabs);
    if (target.tabId !== grant.grantedTabId || target.windowId !== grant.grantedWindowId) {
      throw new ChromeCaptureError("GRANTED_TAB_NOT_ACTIVE", activeTabGrantFailureMessage("GRANTED_TAB_NOT_ACTIVE"));
    }
    const verification = await verifyKlaviyoActiveTabGrant(tabs as Required<Pick<ChromeTabsApi, "get">> & ChromeTabsApi, this.grantStore);
    if (!verification.ok) throw new ChromeCaptureError(verification.code, activeTabGrantFailureMessage(verification.code));
    const tab = verification.tab;
    const sourceUrl = tab.url ?? null;
    const dataUrl = await this.runChromeOperation(
      () => tabs.captureVisibleTab(grant.grantedWindowId, { format: "png" }),
      "capturing the prepared Klaviyo tab",
      "VISIBLE_TAB_CAPTURE_FAILED",
    );
    return { sourceUrl, isKlaviyo: true, tabId: grant.grantedTabId, windowId: grant.grantedWindowId, dataUrl };
  }

  private async requireActiveTabGrant(tabs: ChromeTabsApi): Promise<{ grantedTabId: number; grantedWindowId: number }> {
    if (!tabs.get) throw new ChromeCaptureError("ACTION_NOT_INVOKED", activeTabGrantFailureMessage("ACTION_NOT_INVOKED"));
    let result;
    try {
      result = await verifyKlaviyoActiveTabGrant(tabs as Required<Pick<ChromeTabsApi, "get">> & ChromeTabsApi, this.grantStore);
    } catch {
      throw new ChromeCaptureError("ACTION_NOT_INVOKED", activeTabGrantFailureMessage("ACTION_NOT_INVOKED"));
    }
    if (result.ok) return result.grant;
    throw new ChromeCaptureError(result.code, activeTabGrantFailureMessage(result.code));
  }

  private requireTabs(): ChromeTabsApi {
    if (!this.chromeApi?.tabs) throw new Error("Chrome visible-tab capture is unavailable in this environment.");
    return this.chromeApi.tabs;
  }

  private async runChromeOperation<T>(operation: () => Promise<T>, stage: string, failureCode: Exclude<CaptureFailureCode, "CAPTURE_TIMEOUT" | "KLAVIYO_CAPTURE_PERMISSION_REQUIRED" | "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED" | "CAPTURE_PERMISSION_DENIED" | ActiveTabGrantFailureCode>): Promise<T> {
    try {
      return await withTimeout(operation, stage, this.timeoutMs);
    } catch (error) {
      if (isChromeOperationTimeout(error)) throw new ChromeCaptureError("CAPTURE_TIMEOUT", error.message);
      if (isActiveTabPermissionError(error)) {
        throw new ChromeCaptureError("CAPTURE_PERMISSION_DENIED", "Chrome denied the screenshot request after the toolbar invocation. Click the Tention Reports toolbar icon on Business Review and try again.");
      }
      throw new ChromeCaptureError(failureCode, `${stage} failed: ${chromeErrorMessage(error)}`);
    }
  }
}

function isActiveTabPermissionError(error: unknown): boolean {
  return /(?:either the ['"]?<all_urls>['"]? or ['"]?activeTab['"]? permission is required|activeTab permission is required)/i.test(chromeErrorMessage(error));
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
