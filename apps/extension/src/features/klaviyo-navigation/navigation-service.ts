import type { ReportPeriod, ScreenshotType } from "@tention/report-schema";
import { isKlaviyoUrl } from "../screenshot-capture/capture-service.js";
import {
  prepareExecutiveSummaryDocument,
  type ExecutiveSummaryAdapterResult,
  type ExecutiveSummaryTargetBounds,
  type KlaviyoAutomationFailureCode,
} from "./executive-summary-adapter.js";

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
  top_campaigns: { label: "Top Campaigns", manualInstruction: "Open campaign reporting." },
  top_flows: { label: "Top 5 Flows", manualInstruction: "Open flow reporting." },
  month_comparison: { label: "Month Comparison", manualInstruction: "Open the comparison view for the selected month." },
  campaign_performance: { label: "Campaign Performance", manualInstruction: "Open campaign performance reporting." },
  flow_performance: { label: "Flow Performance", manualInstruction: "Open flow performance reporting." },
  signup_form: { label: "Signup Form", manualInstruction: "Open signup form performance." },
  welcome_flow: { label: "Welcome Flow", manualInstruction: "Open the welcome flow performance screen." },
  customer_split: { label: "Customer Split", manualInstruction: "Open customer versus non-customer reporting." },
  deliverability: { label: "Deliverability", manualInstruction: "Open deliverability reporting." },
  campaign_metrics: { label: "Campaign Metrics", manualInstruction: "Open campaign metrics reporting." },
  flow_metrics: { label: "Flow Metrics", manualInstruction: "Open flow metrics reporting." },
  list_growth: { label: "List Growth", manualInstruction: "Open list growth reporting." },
};

export type NavigationResult =
  | { kind: "opened_workspace"; target: KlaviyoNavigationTarget }
  | { kind: "account_context_required"; target: KlaviyoNavigationTarget }
  | { kind: "open_failed"; target: KlaviyoNavigationTarget; message: string };

interface ChromeTab { id?: number; url?: string }
interface ChromeTabsApi {
  create(properties: { url: string; active: boolean }): Promise<ChromeTab>;
  query?(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<ChromeTab[]>;
  update?(tabId: number, properties: { active: boolean }): Promise<ChromeTab>;
}
interface ChromeScriptingApi {
  executeScript<Result>(details: { target: { tabId: number }; func: (expectedPeriod: string) => Promise<Result>; args: [string] }): Promise<Array<{ result?: Result }>>;
}
interface ChromeApi { tabs?: ChromeTabsApi; scripting?: ChromeScriptingApi }

export type ExecutiveSummaryPreparation =
  | { kind: "ready"; detectedPeriod: string; target: ExecutiveSummaryTargetBounds }
  | { kind: "failed"; code: KlaviyoAutomationFailureCode };

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

export class ChromeKlaviyoNavigationService implements KlaviyoNavigationService {
  constructor(private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome) {}

  async openSection(type: ScreenshotType, accountUrl: string | null, _period: ReportPeriod): Promise<NavigationResult> {
    const target = klaviyoNavigationTargets[type];
    if (!accountUrl || !isKlaviyoUrl(accountUrl)) return { kind: "account_context_required", target };
    try {
      const tabs = this.chromeApi?.tabs;
      if (!tabs) return { kind: "open_failed", target, message: "Chrome tab navigation is unavailable in this environment." };
      await tabs.create({ url: accountUrl, active: true });
      return { kind: "opened_workspace", target };
    } catch {
      return { kind: "open_failed", target, message: "Klaviyo could not be opened automatically." };
    }
  }

  preparePeriod(_period: ReportPeriod): { kind: "manual_period_required" } { return { kind: "manual_period_required" }; }

  async prepareExecutiveSummary(accountUrl: string | null, period: ReportPeriod): Promise<ExecutiveSummaryPreparation> {
    const tabs = this.chromeApi?.tabs;
    const scripting = this.chromeApi?.scripting;
    if (!tabs?.query || !tabs.update || !scripting) return { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED" };
    const expectedPeriod = formatPeriod(period);
    try {
      const currentTabs = await tabs.query({ currentWindow: true });
      const candidates = currentTabs.filter((tab) => typeof tab.id === "number" && isKlaviyoUrl(tab.url ?? null));
      let lastFailure: ExecutiveSummaryPreparation | null = null;
      for (const tab of candidates) {
        const prepared = await this.runExecutiveSummaryAdapter(scripting, tab.id!, expectedPeriod);
        if (prepared.kind === "ready") {
          await tabs.update(tab.id!, { active: true });
          return this.runExecutiveSummaryAdapter(scripting, tab.id!, expectedPeriod);
        }
        lastFailure = prepared;
      }
      if (accountUrl && isKlaviyoUrl(accountUrl)) {
        const opened = await tabs.create({ url: accountUrl, active: true });
        if (typeof opened.id === "number") return this.runExecutiveSummaryAdapter(scripting, opened.id, expectedPeriod);
      }
      return lastFailure ?? { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED" };
    } catch {
      return { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED" };
    }
  }

  private async runExecutiveSummaryAdapter(scripting: ChromeScriptingApi, tabId: number, expectedPeriod: string): Promise<ExecutiveSummaryPreparation> {
    const result = await scripting.executeScript<ExecutiveSummaryAdapterResult>({
      target: { tabId }, func: prepareExecutiveSummaryDocument, args: [expectedPeriod],
    });
    const prepared = result[0]?.result;
    return prepared?.kind === "ready" || prepared?.kind === "failed"
      ? prepared
      : { kind: "failed", code: "KLAVIYO_PAGE_NOT_SUPPORTED" };
  }
}

function formatPeriod(period: ReportPeriod): string {
  const date = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${value}T00:00:00.000Z`));
  return `${date(period.startDate)} – ${date(period.endDate)}`;
}
