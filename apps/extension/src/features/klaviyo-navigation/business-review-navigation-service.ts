import { REPORT_CAPTURE_SPEC_V1, type ReportPeriod } from "@tention/report-schema";
import { chromeErrorMessage, isChromeOperationTimeout, withTimeout } from "../../lib/chrome/with-timeout.js";
import {
  ChromeSessionKlaviyoActiveTabGrantStore, activeTabGrantFailureMessage,
  isKlaviyoBusinessReviewDashboardUrl, type ActiveTabGrantFailureCode, type KlaviyoActiveTabGrantStore, verifyKlaviyoActiveTabGrant,
} from "./active-tab-grant.js";
import {
  BUSINESS_REVIEW_TARGETS, prepareBusinessReviewCaptureDocument,
  type BusinessReviewFailureCode, type BusinessReviewScreenshotType, type BusinessReviewTargetBounds,
} from "./business-review-capture.js";

export type BusinessReviewPreparation =
  | { kind: "ready"; sourceTabId: number; windowId: number; detectedPeriod: string; observedPeriod: { startDate: string; endDate: string; comparisonStartDate?: string; comparisonEndDate?: string }; target: BusinessReviewTargetBounds }
  | { kind: "failed"; code: BusinessReviewFailureCode | ActiveTabGrantFailureCode | "BUSINESS_REVIEW_URL_REQUIRED" | "BUSINESS_REVIEW_NAVIGATION_FAILED" | "SCRIPT_RESULT_EMPTY" | "SCRIPT_RESULT_UNDEFINED" | "SCRIPT_RESULT_INVALID" | "SCRIPT_INJECTION_FAILED" | "PAGE_READY_TIMEOUT"; message: string; sourceTabId?: number; windowId?: number; diagnostics?: Record<string, unknown> };

export interface BusinessReviewCaptureNavigation {
  prepare(screenshotType: BusinessReviewScreenshotType, period: ReportPeriod, businessReviewUrl: string | null): Promise<BusinessReviewPreparation>;
}

interface ChromeTab { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }
interface ChromeTabsApi {
  get(tabId: number): Promise<ChromeTab>;
  query(query: { active: boolean; windowId: number }): Promise<ChromeTab[]>;
  update(tabId: number, properties: { url: string }): Promise<ChromeTab>;
  onUpdated: { addListener(listener: (tabId: number, change: { status?: string }, tab: ChromeTab) => void): void; removeListener(listener: (tabId: number, change: { status?: string }, tab: ChromeTab) => void): void };
}
interface ChromeScriptingApi { executeScript<Result>(details: { target: { tabId: number; frameIds: [number] }; func: (target: typeof BUSINESS_REVIEW_TARGETS[BusinessReviewScreenshotType], period: { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }) => Promise<Result>; args: [typeof BUSINESS_REVIEW_TARGETS[BusinessReviewScreenshotType], { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }] }): Promise<Array<{ frameId?: number; result?: Result }>> }
interface ChromeApi { tabs?: ChromeTabsApi; scripting?: ChromeScriptingApi }

/** Uses the already toolbar-authorized tab; it never opens or substitutes a dashboard. */
export class ChromeBusinessReviewCaptureNavigation implements BusinessReviewCaptureNavigation {
  constructor(
    private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
    private readonly timeoutMs = 8_000,
    private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore(),
  ) {}

  async prepare(screenshotType: BusinessReviewScreenshotType, period: ReportPeriod, businessReviewUrl: string | null): Promise<BusinessReviewPreparation> {
    const tabs = this.chromeApi?.tabs; const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting) return { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED", message: "Chrome Business Review automation is unavailable in this environment." };
    try {
      if (businessReviewUrl === null || !isKlaviyoBusinessReviewDashboardUrl(businessReviewUrl)) return { kind: "failed", code: "BUSINESS_REVIEW_URL_REQUIRED", message: "A configured HTTPS Klaviyo Business Review URL is required for this canonical capture." };
      // This section always reloads the saved Business Review URL next, so a tab left on another Klaviyo route
      // by an earlier attempt is brought back instead of losing its grant.
      const grant = await withTimeout(() => verifyKlaviyoActiveTabGrant(tabs, this.grantStore, { returningToConfiguredUrl: true }), "checking the Tention toolbar grant", this.timeoutMs);
      if (!grant.ok) return { kind: "failed", code: grant.code, message: activeTabGrantFailureMessage(grant.code) };
      const navigationStartedAt = performance.now();
      await this.waitForReady(tabs, grant.grant.grantedTabId);
      // Every section loads the dashboard fresh, even when the tab already shows it: the previous section's
      // view switches and half-rendered charts must never be reused as this section's DOM.
      const tab = await this.navigateFresh(tabs, grant.grant.grantedTabId, businessReviewUrl);
      if (normalizeUrl(tab.url) !== normalizeUrl(businessReviewUrl)) return { kind: "failed", code: "BUSINESS_REVIEW_NAVIGATION_FAILED", message: "The toolbar-authorized tab did not reach the configured Business Review dashboard." };
      const navigationMs = Math.max(0, Math.round(performance.now() - navigationStartedAt));
      // The script itself performs condition-based SPA readiness and bounded
      // React/view settling. Keep that browser operation separate from the
      // shorter route-load timeout so a legitimate delayed dashboard card is
      // not cut off immediately after the readiness window.
      const results = await withTimeout(() => scripting.executeScript<unknown>({
        target: { tabId: grant.grant.grantedTabId, frameIds: [0] }, func: prepareBusinessReviewCaptureDocument,
        args: [BUSINESS_REVIEW_TARGETS[screenshotType], { startDate: period.startDate, endDate: period.endDate, previousStartDate: period.previousStartDate, previousEndDate: period.previousEndDate }],
      }), "preparing the Klaviyo Business Review target", Math.max(this.timeoutMs, 90_000));
      const main = results.find((result) => result.frameId === 0) ?? results[0];
      if (!main) return { kind: "failed", code: "SCRIPT_RESULT_EMPTY", message: "The Business Review helper returned no result." };
      if (main.result === undefined) return { kind: "failed", code: "SCRIPT_RESULT_UNDEFINED", message: "The Business Review helper returned an undefined result." };
      if (!isAdapterResult(main.result)) return { kind: "failed", code: "SCRIPT_RESULT_INVALID", message: "The Business Review helper returned an invalid result.", sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, diagnostics: { failureStage: "PAGE_READY", navigationMs, expectedUrl: safeUrl(businessReviewUrl), observedUrl: safeUrl(tab.url), expectedSourceIdentity: expectedIdentity(screenshotType), resultShape: summarizeAdapterResult(main.result) } };
      if (!main.result.ok) return { kind: "failed", code: main.result.code, message: main.result.message, sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, diagnostics: { ...(main.result.diagnostics ?? {}), navigationMs, stageTimingsMs: { ...mapAdapterStageTimings(main.result.diagnostics?.stageTimingsMs), navigationMs }, expectedUrl: safeUrl(businessReviewUrl), expectedSourceIdentity: expectedIdentity(screenshotType) } };
      const adapterStages = main.result.targetRect.stageTimingsMs ?? {};
      return { kind: "ready", sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, detectedPeriod: formatPeriod(period), observedPeriod: main.result.observedPeriod, target: { ...main.result.targetRect, stageTimingsMs: { navigationMs, pageReadyMs: adapterStages.PAGE_READY ?? 0, periodSetMs: adapterStages.PERIOD ?? 0, cardResolveMs: adapterStages.CARD_RESOLUTION ?? 0, viewResolveMs: adapterStages.VIEW_RESOLUTION ?? 0, viewSwitchMs: adapterStages.VIEW_SWITCH ?? 0, contentReadyMs: adapterStages.CONTENT_READY ?? 0, scrollMs: adapterStages.SCROLL ?? 0 } } };
    } catch (error) {
      if (isChromeOperationTimeout(error)) return { kind: "failed", code: "PAGE_READY_TIMEOUT", message: error.message };
      return { kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: `Business Review preparation failed: ${chromeErrorMessage(error)}` };
    }
  }

  /** Navigates and waits for the load it started (loading → complete), so the script never runs in the old document. */
  private async navigateFresh(tabs: ChromeTabsApi, tabId: number, url: string): Promise<ChromeTab> {
    let remove: () => void = () => {}; let sawLoading = false;
    const loaded = new Promise<ChromeTab>((resolve) => {
      const listener = (id: number, change: { status?: string }, tab: ChromeTab) => {
        if (id !== tabId) return;
        if (change.status === "loading") sawLoading = true;
        else if (sawLoading && change.status === "complete") resolve(tab);
      };
      remove = () => tabs.onUpdated.removeListener(listener); tabs.onUpdated.addListener(listener);
    });
    try {
      await withTimeout(() => tabs.update(tabId, { url }), "opening the configured Business Review dashboard in the toolbar-authorized tab", this.timeoutMs);
      // Chrome reports "loading" almost at once; if it never does, fall back to the tab's own ready state.
      const started = await Promise.race([loaded.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(sawLoading), Math.min(3_000, this.timeoutMs)))]);
      if (started || sawLoading) return await withTimeout(() => loaded, "waiting for the fresh Klaviyo page load", Math.max(this.timeoutMs, 20_000));
      return await this.waitForReady(tabs, tabId);
    } finally { remove(); }
  }

  private async waitForReady(tabs: ChromeTabsApi, tabId: number): Promise<ChromeTab> {
    const current = await tabs.get(tabId);
    if (current.status === "complete") return current;
    let remove: () => void = () => {};
    const ready = new Promise<ChromeTab>((resolve, reject) => {
      const listener = (id: number, change: { status?: string }, tab: ChromeTab) => { if (id === tabId && (change.status === "complete" || tab.status === "complete")) { remove(); resolve(tab); } };
      remove = () => tabs.onUpdated.removeListener(listener); tabs.onUpdated.addListener(listener);
      void tabs.get(tabId).then((tab) => { if (tab.status === "complete") { remove(); resolve(tab); } }).catch(reject);
    });
    try { return await withTimeout(() => ready, "waiting for the Klaviyo page to load", this.timeoutMs); }
    finally { remove(); }
  }
}

function normalizeUrl(value: string | null | undefined): string | null {
  try { return value ? new URL(value).toString().replace(/\/$/, "") : null; } catch { return null; }
}

function safeUrl(value: string | null | undefined): string | null { try { const url = new URL(value ?? ""); return `${url.origin}${url.pathname}`; } catch { return null; } }
function expectedIdentity(type: BusinessReviewScreenshotType): string | null { return REPORT_CAPTURE_SPEC_V1.find((spec) => spec.screenshotType === type)?.sourceIdentity ?? null; }
function summarizeAdapterResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return { kind: value === null ? "null" : typeof value };
  const result = value as Record<string, unknown>;
  const target = result.targetRect && typeof result.targetRect === "object" ? result.targetRect as Record<string, unknown> : null;
  return { keys: Object.keys(result).slice(0, 30), okType: typeof result.ok, okValue: typeof result.ok === "boolean" ? result.ok : null, codeType: typeof result.code, messageType: typeof result.message, targetRectKeys: target ? Object.keys(target).slice(0, 30) : null, targetRectCoordinates: target ? Object.fromEntries(["x", "y", "width", "height", "viewportWidth", "viewportHeight"].map((key) => [key, { type: typeof target[key], finite: typeof target[key] === "number" && Number.isFinite(target[key]) }])) : null, observedPeriodType: typeof result.observedPeriod, diagnosticsType: typeof result.diagnostics };
}
function mapAdapterStageTimings(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const timings = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  const mapping: Record<string, string> = { PAGE_READY: "pageReadyMs", PERIOD: "periodSetMs", CARD_RESOLUTION: "cardResolveMs", VIEW_RESOLUTION: "viewResolveMs", VIEW_SWITCH: "viewSwitchMs", CONTENT_READY: "contentReadyMs", SCROLL: "scrollMs", CAPTURE: "captureMs" };
  for (const [source, destination] of Object.entries(mapping)) if (typeof timings[source] === "number" && Number.isFinite(timings[source])) result[destination] = timings[source] as number;
  return result;
}

function isAdapterResult(value: unknown): value is Awaited<ReturnType<typeof prepareBusinessReviewCaptureDocument>> {
  if (typeof value !== "object" || value === null || !("ok" in value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return "code" in value && "message" in value && typeof value.code === "string" && typeof value.message === "string";
  if (!("targetRect" in value) || typeof value.targetRect !== "object" || value.targetRect === null) return false;
  const target = value.targetRect as Record<string, unknown>;
  return [target.x, target.y, target.width, target.height, target.viewportWidth, target.viewportHeight].every((item) => typeof item === "number" && Number.isFinite(item));
}

function formatPeriod(period: ReportPeriod): string {
  const date = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`));
  return `${date(period.startDate)} – ${date(period.endDate)}`;
}
