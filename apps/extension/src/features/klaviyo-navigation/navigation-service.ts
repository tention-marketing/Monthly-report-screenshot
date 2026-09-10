import type { ReportPeriod, ScreenshotType } from "@tention/report-schema";
import { isKlaviyoUrl } from "../screenshot-capture/capture-service.js";

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

interface ChromeTabsApi { create(properties: { url: string; active: boolean }): Promise<unknown> }
interface ChromeApi { tabs?: ChromeTabsApi }

export interface KlaviyoNavigationService {
  openSection(type: ScreenshotType, accountUrl: string | null, period: ReportPeriod): Promise<NavigationResult>;
  preparePeriod(period: ReportPeriod): { kind: "manual_period_required" };
}

export const unavailableKlaviyoNavigationService: KlaviyoNavigationService = {
  async openSection(type) { return { kind: "open_failed", target: klaviyoNavigationTargets[type], message: "Chrome tab navigation is unavailable in this environment." }; },
  preparePeriod() { return { kind: "manual_period_required" }; },
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
}
