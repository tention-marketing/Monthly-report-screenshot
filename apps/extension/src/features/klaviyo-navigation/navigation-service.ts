import type { ReportPeriod, ScreenshotType } from "@tention/report-schema";
import { isKlaviyoUrl } from "../screenshot-capture/capture-service.js";
import {
  prepareExecutiveSummaryDocument,
  type ExecutiveSummaryAdapterResult,
  type ExecutiveSummaryInjectionPeriod,
  type ExecutiveSummaryTargetBounds,
  type KlaviyoAutomationFailureCode,
} from "./executive-summary-adapter.js";
import { chromeErrorMessage, isChromeOperationTimeout, withTimeout } from "../../lib/chrome/with-timeout.js";
import {
  ChromeSessionKlaviyoActiveTabGrantStore,
  activeTabGrantFailureMessage,
  type KlaviyoActiveTabGrantStore,
  verifyKlaviyoActiveTabGrant,
} from "./active-tab-grant.js";

export interface KlaviyoNavigationTarget {
  label: string;
  manualInstruction: string;
}

/**
 * Klaviyo does not yet have a verified, per-client route contract in this product.
 * Keep all section guidance here so a future verified adapter can replace it without
 * scattering provider paths or selectors through React.
 */
export const klaviyoNavigationTargets: Readonly<Record<ScreenshotType, KlaviyoNavigationTarget>> = {
  overview: { label: "Executive Summary", manualInstruction: "Open the Business Review or overview screen." },
  top_campaigns: { label: "Top 5 Campaigns", manualInstruction: "Open campaign reporting." },
  top_flows: { label: "Top 5 Flows", manualInstruction: "Open Klaviyo Home, set the Time period to the report month, and capture the Top performing flows card: the first five rows, or every row when fewer than five exist. Do not click a flow name or open Flow Builder." },
  month_comparison: { label: "Month Comparison", manualInstruction: "Open the comparison view for the selected month." },
  campaign_performance: { label: "Campaign Performance", manualInstruction: "Open campaign performance reporting." },
  flow_performance: { label: "Flow Performance", manualInstruction: "Open flow performance reporting." },
  signup_form: { label: "Signup Forms Listing", manualInstruction: "Open the Sign-up Forms listing and capture the all-forms table with performance columns. Do not open an individual form." },
  welcome_flow: { label: "Welcome Flow Listing", manualInstruction: "Open the Flows listing, filter for Welcome, and capture only the configured Email rows. Do not open an individual flow or Flow Builder." },
  customer_split: { label: "Customer Split", manualInstruction: "Open customer versus non-customer reporting." },
  deliverability: { label: "Deliverability Score", manualInstruction: "Open Analytics, Deliverability, Email, then Score. Read the score card only; do not use Action Center actions." },
  campaign_metrics: { label: "Campaign Metrics", manualInstruction: "Open campaign metrics reporting." },
  flow_metrics: { label: "Flow Metrics", manualInstruction: "Open flow metrics reporting." },
  list_growth: { label: "Historical List Growth", manualInstruction: "This retired section is retained only to view historical records." },
  email_subscriber_growth: { label: "Subscriber Growth", manualInstruction: "Open Audience, Profiles, View subscriber growth, then the Email tab and its Growth view, set the report month, and capture the Email Growth card with both charts. Read only; do not change profiles, lists, or suppressions." },
};

export type NavigationResult =
  | { kind: "opened_workspace"; target: KlaviyoNavigationTarget }
  | { kind: "account_context_required"; target: KlaviyoNavigationTarget }
  | { kind: "open_failed"; target: KlaviyoNavigationTarget; message: string };

interface ChromeTab { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }
interface ChromeTabsApi {
  create(properties: { url: string; active: boolean }): Promise<ChromeTab>;
  query?(queryInfo: { active?: boolean; currentWindow?: boolean; windowId?: number }): Promise<ChromeTab[]>;
  update?(tabId: number, properties: { active: boolean }): Promise<ChromeTab>;
  get?(tabId: number): Promise<ChromeTab>;
  onUpdated?: {
    addListener(listener: (tabId: number, changeInfo: { status?: string }, tab: ChromeTab) => void): void;
    removeListener(listener: (tabId: number, changeInfo: { status?: string }, tab: ChromeTab) => void): void;
  };
}
interface ChromeScriptingApi {
  executeScript<Result>(details: { target: { tabId: number; frameIds: [number] }; func: (expectedPeriod: ExecutiveSummaryInjectionPeriod) => Promise<Result>; args: [ExecutiveSummaryInjectionPeriod] }): Promise<Array<{ frameId?: number; result?: Result }>>;
}
interface ChromeApi { tabs?: ChromeTabsApi; scripting?: ChromeScriptingApi }

export type ExecutiveSummaryPreparation =
  | { kind: "ready"; detectedPeriod: string; target: ExecutiveSummaryTargetBounds; sourceTabId?: number; windowId?: number }
  | { kind: "failed"; code: KlaviyoAutomationFailureCode; message?: string };

export interface KlaviyoNavigationService {
  openSection(type: ScreenshotType, accountUrl: string | null, period: ReportPeriod): Promise<NavigationResult>;
  preparePeriod(period: ReportPeriod): { kind: "manual_period_required" };
  prepareExecutiveSummary(accountUrl: string | null, period: ReportPeriod): Promise<ExecutiveSummaryPreparation>;
}

export const unavailableKlaviyoNavigationService: KlaviyoNavigationService = {
  async openSection(type) { return { kind: "open_failed", target: klaviyoNavigationTargets[type], message: "Chrome tab navigation is unavailable in this environment." }; },
  preparePeriod() { return { kind: "manual_period_required" }; },
  async prepareExecutiveSummary() { return { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED" }; },
};

export const CHROME_AUTOMATION_TIMEOUT_MS = 8_000;

export class ChromeKlaviyoNavigationService implements KlaviyoNavigationService {
  constructor(
    private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
    private readonly timeoutMs = CHROME_AUTOMATION_TIMEOUT_MS,
    private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore(),
  ) {}

  async openSection(type: ScreenshotType, accountUrl: string | null, _period: ReportPeriod): Promise<NavigationResult> {
    const target = klaviyoNavigationTargets[type];
    if (!accountUrl || !isKlaviyoUrl(accountUrl)) return { kind: "account_context_required", target };
    try {
      const tabs = this.chromeApi?.tabs;
      if (!tabs) return { kind: "open_failed", target, message: "Chrome tab navigation is unavailable in this environment." };
      if (tabs.query) {
        const active = (await withTimeout(() => tabs.query!({ active: true, currentWindow: true }), "checking the active Klaviyo tab", this.timeoutMs))[0];
        if (matchesAccountUrl(active?.url ?? null, accountUrl)) return { kind: "opened_workspace", target };
      }
      await withTimeout(() => tabs.create({ url: accountUrl, active: true }), "opening the Klaviyo workspace", this.timeoutMs);
      return { kind: "opened_workspace", target };
    } catch (error) {
      return { kind: "open_failed", target, message: `Klaviyo could not be opened automatically: ${chromeErrorMessage(error)}` };
    }
  }

  preparePeriod(_period: ReportPeriod): { kind: "manual_period_required" } { return { kind: "manual_period_required" }; }

  async prepareExecutiveSummary(_accountUrl: string | null, period: ReportPeriod): Promise<ExecutiveSummaryPreparation> {
    const tabs = this.chromeApi?.tabs;
    const scripting = this.chromeApi?.scripting;
    if (!tabs?.query || !tabs.get || !tabs.onUpdated || !scripting) return { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED", message: "Chrome tab automation is unavailable in this environment." };
    const automationTabs = tabs as Required<Pick<ChromeTabsApi, "query" | "get" | "onUpdated">> & ChromeTabsApi;
    const expectedPeriod: ExecutiveSummaryInjectionPeriod = { startDate: period.startDate, endDate: period.endDate };
    const detectedPeriod = formatPeriod(period);
    try {
      const grant = await withTimeout(() => verifyKlaviyoActiveTabGrant(automationTabs, this.grantStore), "checking the Tention toolbar grant", this.timeoutMs);
      if (!grant.ok) return { kind: "failed", code: grant.code, message: activeTabGrantFailureMessage(grant.code) };
      return this.prepareActiveTab(automationTabs, scripting, grant.grant.grantedTabId, expectedPeriod, detectedPeriod);
    } catch (error) {
      return this.failure("TAB_LOOKUP_FAILED", "finding open Klaviyo tabs", error);
    }
  }

  private async prepareActiveTab(tabs: Required<Pick<ChromeTabsApi, "get" | "onUpdated">>, scripting: ChromeScriptingApi, tabId: number, expectedPeriod: ExecutiveSummaryInjectionPeriod, detectedPeriod: string): Promise<ExecutiveSummaryPreparation> {
    let readyTab: ChromeTab;
    try {
      readyTab = await this.waitForTabReady(tabs, tabId);
    } catch (error) {
      return this.failure(isChromeOperationTimeout(error) ? "PAGE_READY_TIMEOUT" : "PAGE_READY_FAILED", "waiting for the Klaviyo page to load", error);
    }
    const tabDiagnostic = executiveSummaryTabDiagnostic(readyTab.url ?? null);
    console.info("[Tention] Executive Summary tab diagnostic", { tabId, ...tabDiagnostic });
    if (!tabDiagnostic.pathnameMatched) {
      return { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED", message: "The selected tab is not a Klaviyo analytics dashboard. Open Business review and use Capture Automatically again." };
    }
    const prepared = await this.runExecutiveSummaryAdapter(scripting, tabId, expectedPeriod, detectedPeriod);
    return prepared.kind === "ready"
      ? { ...prepared, sourceTabId: tabId, ...(typeof readyTab.windowId === "number" ? { windowId: readyTab.windowId } : {}) }
      : prepared;
  }

  private async runExecutiveSummaryAdapter(scripting: ChromeScriptingApi, tabId: number, expectedPeriod: ExecutiveSummaryInjectionPeriod, detectedPeriod: string): Promise<ExecutiveSummaryPreparation> {
    try {
      const results = await withTimeout(() => scripting.executeScript<unknown>({
        target: { tabId, frameIds: [0] }, func: prepareExecutiveSummaryDocument, args: [expectedPeriod],
      }), "checking the Klaviyo Business review page", this.timeoutMs);
      const mainFrame = results.find((result) => result.frameId === 0) ?? results[0];
      const raw = mainFrame?.result;
      console.info("[Tention] Executive Summary executeScript", {
        tabId,
        resultCount: results.length,
        mainFrameResult: mainFrame ? raw === undefined ? "undefined" : "present" : "missing",
        ok: isExecutiveSummaryAdapterResult(raw) ? raw.ok : undefined,
        code: isExecutiveSummaryAdapterResult(raw) && !raw.ok ? raw.code : undefined,
        ...(isExecutiveSummaryAdapterResult(raw) && raw.diagnostics ? raw.diagnostics : {}),
      });
      if (!mainFrame) return { kind: "failed", code: "SCRIPT_RESULT_EMPTY", message: "The Tention Klaviyo helper returned no execution result. Use Capture Manually." };
      if (raw === undefined) return { kind: "failed", code: "SCRIPT_RESULT_UNDEFINED", message: "The Tention Klaviyo helper did not return a usable result. Use Capture Manually." };
      if (!isExecutiveSummaryAdapterResult(raw)) return { kind: "failed", code: "SCRIPT_RESULT_INVALID", message: "The Tention Klaviyo helper returned an invalid result. Use Capture Manually." };
      if (!raw.ok) return { kind: "failed", code: raw.code, message: raw.message };
      return {
        kind: "ready",
        detectedPeriod,
        target: {
          x: raw.targetRect.x, y: raw.targetRect.y, width: raw.targetRect.width, height: raw.targetRect.height,
          viewportWidth: raw.viewport.width, viewportHeight: raw.viewport.height,
        },
      };
    } catch (error) {
      return this.failure("SCRIPT_INJECTION_FAILED", "checking the Klaviyo Business review page", error);
    }
  }

  private async waitForTabReady(tabs: Required<Pick<ChromeTabsApi, "get" | "onUpdated">>, tabId: number): Promise<ChromeTab> {
    let cleanup: () => void = () => {};
    const ready = new Promise<ChromeTab>((resolve, reject) => {
      let settled = false;
      const finish = (tab?: ChromeTab, error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve(tab ?? {});
      };
      const listener = (updatedTabId: number, changeInfo: { status?: string }, tab: ChromeTab) => {
        if (updatedTabId === tabId && (changeInfo.status === "complete" || tab.status === "complete")) finish(tab);
      };
      cleanup = () => tabs.onUpdated.removeListener(listener);
      tabs.onUpdated.addListener(listener);
      // Register before reading: a page which became complete between calls is
      // still observed by this second check, without an unbounded event wait.
      void tabs.get(tabId).then((tab) => { if (tab.status === "complete") finish(tab); }).catch((error) => finish(undefined, error));
    });
    try {
      return await withTimeout(() => ready, "waiting for the Klaviyo page to load", this.timeoutMs);
    } finally {
      cleanup();
    }
  }

  private failure(code: KlaviyoAutomationFailureCode, stage: string, error: unknown): ExecutiveSummaryPreparation {
    return { kind: "failed", code, message: `${stage} failed: ${chromeErrorMessage(error)}` };
  }
}

function executiveSummaryTabDiagnostic(value: string | null): { origin: string | null; pathname: string | null; pathnameMatched: boolean } {
  if (!value) return { origin: null, pathname: null, pathnameMatched: false };
  try {
    const url = new URL(value);
    const klaviyoOrigin = url.protocol === "https:" && (url.hostname === "klaviyo.com" || url.hostname.endsWith(".klaviyo.com"));
    return { origin: url.origin, pathname: url.pathname, pathnameMatched: klaviyoOrigin && /^\/analytics\/dashboards(?:\/|$)/.test(url.pathname) };
  } catch {
    return { origin: null, pathname: null, pathnameMatched: false };
  }
}

function isExecutiveSummaryAdapterResult(value: unknown): value is ExecutiveSummaryAdapterResult {
  if (typeof value !== "object" || value === null || !("ok" in value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return "code" in value && typeof value.code === "string" && isAutomationFailureCode(value.code) && "message" in value && typeof value.message === "string";
  if (!("pageVerified" in value) || value.pageVerified !== true || !("periodVerified" in value) || value.periodVerified !== true || !("sourceUrl" in value) || typeof value.sourceUrl !== "string") return false;
  if (!("targetRect" in value) || !("viewport" in value) || typeof value.targetRect !== "object" || value.targetRect === null || typeof value.viewport !== "object" || value.viewport === null) return false;
  const rect = value.targetRect as Record<string, unknown>;
  const viewport = value.viewport as Record<string, unknown>;
  const numbers = [rect.x, rect.y, rect.width, rect.height, rect.top, rect.left, rect.right, rect.bottom, viewport.width, viewport.height];
  if (!numbers.every((number) => typeof number === "number" && Number.isFinite(number))) return false;
  return (rect.width as number) > 0 && (rect.height as number) > 0 && (viewport.width as number) > 0 && (viewport.height as number) > 0;
}

function isAutomationFailureCode(value: string): value is Exclude<KlaviyoAutomationFailureCode, "CAPTURE_FAILED"> {
  return [
    "KLAVIYO_PAGE_NOT_SUPPORTED", "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED", "ACTION_NOT_INVOKED", "GRANTED_TAB_CLOSED", "GRANTED_TAB_NOT_ACTIVE", "GRANTED_TAB_CHANGED_ORIGIN", "GRANTED_TAB_ROUTE_NOT_SUPPORTED", "CAPTURE_PERMISSION_DENIED", "TARGET_NOT_FOUND", "PERIOD_NOT_FOUND", "PERIOD_SET_FAILED", "PERIOD_VERIFY_FAILED",
    "TARGET_NOT_FULLY_VISIBLE", "TAB_LOOKUP_FAILED", "TAB_ACTIVATION_FAILED", "PAGE_READY_FAILED", "PAGE_READY_TIMEOUT",
    "SCRIPT_INJECTION_FAILED", "KLAVIYO_PERIOD_DIALOG_NOT_FOUND", "KLAVIYO_PERIOD_APPLY_NOT_FOUND", "KLAVIYO_PERIOD_APPLY_TIMEOUT",
    "KLAVIYO_PERIOD_VERIFY_FAILED", "KLAVIYO_PAGE_ADAPTER_ERROR", "SCRIPT_RESULT_EMPTY", "SCRIPT_RESULT_UNDEFINED", "SCRIPT_RESULT_INVALID",
  ].includes(value);
}

function matchesAccountUrl(tabUrl: string | null, accountUrl: string | null): boolean {
  if (!tabUrl || !accountUrl) return false;
  try {
    const normalize = (value: string) => {
      const url = new URL(value);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}${url.search}`;
    };
    return normalize(tabUrl) === normalize(accountUrl);
  } catch { return false; }
}

function formatPeriod(period: ReportPeriod): string {
  const date = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
  return `${date(period.startDate)} – ${date(period.endDate)}`;
}
