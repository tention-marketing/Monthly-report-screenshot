import type { BusinessPerformanceEvidence, ReportPeriod } from "@tention/report-schema";
import { injectPeriodEntry } from "./injected/period-entry-contract.js";
import { chromeErrorMessage, isChromeOperationTimeout, withTimeout } from "../../lib/chrome/with-timeout.js";
import { recoveryRequests, waitForSettledTab, type AttemptRecovery } from "../../lib/chrome/settle-tab.js";
import { injectionFailureDiagnostics, type InjectionResultLike } from "../../lib/chrome/injection-diagnostics.js";
import {
  ChromeSessionKlaviyoActiveTabGrantStore, activeTabGrantFailureMessage,
  isKlaviyoHomeDashboardUrl, type ActiveTabGrantFailureCode, type KlaviyoActiveTabGrantStore, verifyKlaviyoActiveTabGrant,
} from "./active-tab-grant.js";
import {
  DASHBOARD_TARGETS, prepareDashboardCaptureDocument,
  type DashboardFailureCode, type DashboardScreenshotType, type DashboardTargetBounds,
} from "./dashboard-capture.js";

export type DashboardPreparation =
  | { kind: "ready"; sourceTabId: number; windowId: number; detectedPeriod: string; observedPeriod: { startDate: string; endDate: string }; target: DashboardTargetBounds;
      /** Executive Summary only: the verified card's rendered Business performance values, or why they were not read. */
      businessPerformance?: BusinessPerformanceEvidence | null; businessPerformanceIssues?: string[]; businessPerformanceReadout?: Record<string, unknown> }
  | { kind: "failed"; code: DashboardFailureCode | ActiveTabGrantFailureCode | "SCRIPT_RESULT_EMPTY" | "SCRIPT_RESULT_UNDEFINED" | "SCRIPT_RESULT_INVALID" | "SCRIPT_INJECTION_FAILED" | "PAGE_READY_TIMEOUT"; message: string; sourceTabId?: number; windowId?: number; diagnostics?: Record<string, unknown> };

export interface DashboardCaptureNavigation {
  prepare(screenshotType: DashboardScreenshotType, period: ReportPeriod, dashboardUrl?: string | null, recovery?: AttemptRecovery): Promise<DashboardPreparation>;
}

interface ChromeTab { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }
interface ChromeTabsApi {
  get(tabId: number): Promise<ChromeTab>;
  query(query: { active: boolean; windowId: number }): Promise<ChromeTab[]>;
  update(tabId: number, properties: { url: string }): Promise<ChromeTab>;
  onUpdated: { addListener(listener: (tabId: number, change: { status?: string }, tab: ChromeTab) => void): void; removeListener(listener: (tabId: number, change: { status?: string }, tab: ChromeTab) => void): void };
}
interface ChromeScriptingApi { executeScript<Result>(details: { target: { tabId: number; frameIds: [number] }; func: (target: typeof DASHBOARD_TARGETS[DashboardScreenshotType], period: { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }) => Promise<Result>; args: [typeof DASHBOARD_TARGETS[DashboardScreenshotType], { startDate: string; endDate: string; previousStartDate: string; previousEndDate: string }, ...number[]] }): Promise<Array<{ frameId?: number; result?: Result }>> }
interface ChromeApi { tabs?: ChromeTabsApi; scripting?: ChromeScriptingApi }

/** Uses only the tab explicitly authorized through the Tention toolbar action. */
export class ChromeKlaviyoDashboardCaptureNavigation implements DashboardCaptureNavigation {
  constructor(
    private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
    private readonly timeoutMs = 8_000,
    private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore(),
  ) {}

  async prepare(screenshotType: DashboardScreenshotType, period: ReportPeriod, dashboardUrl: string | null = null, recovery?: AttemptRecovery): Promise<DashboardPreparation> {
    const tabs = this.chromeApi?.tabs; const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting) return { kind: "failed", code: "DASHBOARD_NOT_FOUND", message: "Chrome dashboard automation is unavailable in this environment." };
    let injection: { tabId: number; urlBefore: string | null } | null = null;
    try {
      const grant = await withTimeout(() => verifyKlaviyoActiveTabGrant(tabs, this.grantStore, { returningToConfiguredUrl: true }), "checking the Tention toolbar grant", this.timeoutMs);
      if (!grant.ok) return { kind: "failed", code: grant.code, message: activeTabGrantFailureMessage(grant.code) };
      const current = await this.waitForReady(tabs, grant.grant.grantedTabId);
      const navigationStartedAt = performance.now();
      if (!isKlaviyoHomeDashboardUrl(current.url ?? null)) {
        if (!dashboardUrl || !isKlaviyoHomeDashboardUrl(dashboardUrl)) return { kind: "failed", code: "DASHBOARD_URL_REQUIRED", message: "A configured Klaviyo Overview URL is required to navigate the toolbar-authorized tab from its current reporting view." };
        if (!tabs.update) return { kind: "failed", code: "DASHBOARD_URL_REQUIRED", message: "The authorized Klaviyo tab cannot navigate to the configured Overview source." };
      }
      // Every attempt loads the Overview fresh, even when the tab already shows it, so a retry never reuses the
      // previous attempt's half-rendered or replaced DOM.
      const freshUrl = dashboardUrl && isKlaviyoHomeDashboardUrl(dashboardUrl) ? dashboardUrl : current.url ?? null;
      if (typeof tabs.update === "function" && freshUrl && isKlaviyoHomeDashboardUrl(freshUrl)) await this.navigateFresh(tabs, grant.grant.grantedTabId, freshUrl);
      const dashboard = await this.waitForReady(tabs, grant.grant.grantedTabId);
      const navigationMs = Math.max(0, Math.round(performance.now() - navigationStartedAt));
      if (!isKlaviyoHomeDashboardUrl(dashboard.url ?? null)) return { kind: "failed", code: "DASHBOARD_NOT_FOUND", message: "The toolbar-authorized tab did not reach the configured Klaviyo Overview dashboard." };
      if (recoveryRequests(recovery, "settle-before-inject")) await waitForSettledTab(tabs, grant.grant.grantedTabId);
      injection = { tabId: grant.grant.grantedTabId, urlBefore: dashboard.url ?? null };
      // The shared period helper first: the adapter replaces whatever month Klaviyo kept with the report's own.
      await injectPeriodEntry(scripting, grant.grant.grantedTabId);
      const results = await withTimeout(() => scripting.executeScript<unknown>({
        target: { tabId: grant.grant.grantedTabId, frameIds: [0] }, func: prepareDashboardCaptureDocument,
        args: [DASHBOARD_TARGETS[screenshotType], { startDate: period.startDate, endDate: period.endDate, previousStartDate: period.previousStartDate, previousEndDate: period.previousEndDate }, ...(recoveryRequests(recovery, "extended-readiness") ? [6_000, 25_000] as const : [] as const)],
      }), "preparing the Klaviyo dashboard target", Math.max(this.timeoutMs, 60_000));
      const main = results.find((result) => result.frameId === 0) ?? results[0];
      const describe = (found: InjectionResultLike | null) => injectionFailureDiagnostics({ section: screenshotType, scripting: scripting as never, tabs: tabs as never, tabId: grant.grant.grantedTabId, urlBefore: dashboard.url ?? null, results, main: found, cardAliases: [DASHBOARD_TARGETS[screenshotType].heading], failureStage: "SCRIPT_RESULT" });
      if (!main) return { kind: "failed", code: "SCRIPT_RESULT_EMPTY", message: "The dashboard helper returned no result.", diagnostics: { injection: await describe(null) } };
      if (main.result === undefined) return { kind: "failed", code: "SCRIPT_RESULT_UNDEFINED", message: "The dashboard helper returned an undefined result.", diagnostics: { injection: await describe(main) } };
      if (!isAdapterResult(main.result)) return { kind: "failed", code: "SCRIPT_RESULT_INVALID", message: "The dashboard helper returned an invalid result.", sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, diagnostics: { injection: await describe(main), failureStage: "PAGE_READY", expectedUrl: safeUrl(dashboardUrl ?? dashboard.url), observedUrl: safeUrl(dashboard.url), expectedSourceIdentity: DASHBOARD_TARGETS[screenshotType].sourceIdentity, resultShape: summarizeAdapterResult(main.result) } };
      if (!main.result.ok) return { kind: "failed", code: main.result.code, message: main.result.message, sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, diagnostics: { ...(main.result.diagnostics ?? {}), stageTimingsMs: { ...((main.result.diagnostics?.stageTimingsMs as Record<string, number> | undefined) ?? {}), navigationMs } } };
      return { kind: "ready", sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, detectedPeriod: formatPeriod(period), observedPeriod: main.result.observedPeriod, target: { ...main.result.targetRect, stageTimingsMs: { ...(main.result.targetRect.stageTimingsMs ?? {}), navigationMs } },
        ...(main.result.businessPerformance !== undefined ? { businessPerformance: main.result.businessPerformance, businessPerformanceIssues: main.result.businessPerformanceIssues ?? [], businessPerformanceReadout: main.result.businessPerformanceReadout ?? {} } : {}) };
    } catch (error) {
      if (isChromeOperationTimeout(error)) return { kind: "failed", code: "PAGE_READY_TIMEOUT", message: error.message };
      const diagnostics = injection ? { injection: await injectionFailureDiagnostics({ section: screenshotType, scripting: scripting as never, tabs: tabs as never, tabId: injection.tabId, urlBefore: injection.urlBefore, results: null, main: null, cardAliases: [DASHBOARD_TARGETS[screenshotType].heading], failureStage: "SCRIPT_INJECTION" }), injectionError: chromeErrorMessage(error) } : undefined;
      return { kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: `Dashboard preparation failed: ${chromeErrorMessage(error)}`, ...(diagnostics ? { diagnostics } : {}) };
    }
  }

  /** Navigates and waits for the load it started (loading → complete), so the script never runs in the old document. */
  private async navigateFresh(tabs: ChromeTabsApi, tabId: number, url: string): Promise<void> {
    let remove: () => void = () => {}; let sawLoading = false;
    const loaded = new Promise<void>((resolve) => {
      const listener = (id: number, change: { status?: string }) => {
        if (id !== tabId) return;
        if (change.status === "loading") sawLoading = true;
        else if (sawLoading && change.status === "complete") resolve();
      };
      remove = () => tabs.onUpdated.removeListener(listener); tabs.onUpdated.addListener(listener);
    });
    try {
      await withTimeout(() => tabs.update(tabId, { url }), "opening the Klaviyo Overview in the toolbar-authorized tab", this.timeoutMs);
      const started = await Promise.race([loaded.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(sawLoading), Math.min(3_000, this.timeoutMs)))]);
      if (started || sawLoading) await withTimeout(() => loaded, "waiting for the fresh Klaviyo Overview load", Math.max(this.timeoutMs, 20_000));
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

function safeUrl(value: string | null | undefined): string | null { try { const url = new URL(value ?? ""); return `${url.origin}${url.pathname}`; } catch { return null; } }

function summarizeAdapterResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return { kind: value === null ? "null" : typeof value };
  const result = value as Record<string, unknown>;
  const target = result.targetRect && typeof result.targetRect === "object" ? result.targetRect as Record<string, unknown> : null;
  return { keys: Object.keys(result).slice(0, 30), okType: typeof result.ok, okValue: typeof result.ok === "boolean" ? result.ok : null, codeType: typeof result.code, messageType: typeof result.message, targetRectKeys: target ? Object.keys(target).slice(0, 30) : null, targetRectCoordinates: target ? Object.fromEntries(["x", "y", "width", "height", "viewportWidth", "viewportHeight"].map((key) => [key, { type: typeof target[key], finite: typeof target[key] === "number" && Number.isFinite(target[key]) }])) : null };
}

function isAdapterResult(value: unknown): value is Awaited<ReturnType<typeof prepareDashboardCaptureDocument>> {
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
