import type { ReportPeriod } from "@tention/report-schema";
import { chromeErrorMessage, isChromeOperationTimeout, withTimeout } from "../../lib/chrome/with-timeout.js";
import { ChromeSessionKlaviyoActiveTabGrantStore, activeTabGrantFailureMessage, type ActiveTabGrantFailureCode, type KlaviyoActiveTabGrantStore, verifyKlaviyoActiveTabGrant } from "./active-tab-grant.js";
import { prepareCampaignsCaptureDocument, type CampaignsAdapterResult, type CampaignsCaptureRequest, type CampaignsEvidence, type CampaignsFailureCode, type CampaignTargetBounds } from "./campaigns-capture.js";

export type CampaignsPreparation =
  | { kind: "ready"; sourceTabId: number; windowId: number; detectedPeriod: string; observedPeriod: { startDate: string; endDate: string }; target: CampaignTargetBounds; evidence: CampaignsEvidence }
  | { kind: "failed"; code: CampaignsFailureCode | ActiveTabGrantFailureCode | "SCRIPT_RESULT_EMPTY" | "SCRIPT_RESULT_UNDEFINED" | "SCRIPT_RESULT_INVALID" | "SCRIPT_INJECTION_FAILED"; message: string; diagnostics?: Record<string, unknown> };
export interface CampaignsCaptureNavigation { prepare(request: CampaignsCaptureRequest, listUrl?: string | null): Promise<CampaignsPreparation>; }
interface ChromeTab { id?: number; windowId?: number; url?: string; status?: string }
interface ChromeTabsApi { get(tabId: number): Promise<ChromeTab>; query(query: { active: boolean; windowId: number }): Promise<ChromeTab[]>; update?(tabId: number, properties: { url: string }): Promise<ChromeTab>; }
interface ChromeScriptingApi { executeScript<Result>(details: { target: { tabId: number; frameIds: [number] }; func: (request: CampaignsCaptureRequest) => Promise<Result>; args: [CampaignsCaptureRequest] }): Promise<Array<{ frameId?: number; result?: Result }>> }
interface ChromeApi { tabs?: ChromeTabsApi; scripting?: ChromeScriptingApi }

/** Uses exactly the toolbar-authorized tab and rejects all campaign detail/editor routes. */
export class ChromeCampaignsCaptureNavigation implements CampaignsCaptureNavigation {
  constructor(private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome, private readonly timeoutMs = 8_000, private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore()) {}
  async prepare(request: CampaignsCaptureRequest, listUrl: string | null = null): Promise<CampaignsPreparation> {
    const tabs = this.chromeApi?.tabs; const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting) return { kind: "failed", code: "CAMPAIGNS_PAGE_NOT_READY", message: "Chrome Campaigns automation is unavailable in this extension context." };
    try {
      const grant = await withTimeout(() => verifyKlaviyoActiveTabGrant(tabs, this.grantStore), "checking the Tention toolbar grant", this.timeoutMs);
      if (!grant.ok) return { kind: "failed", code: grant.code, message: activeTabGrantFailureMessage(grant.code) };
      let tab = await tabs.get(grant.grant.grantedTabId);
      // A multi-section run leaves the authorized tab on another verified Klaviyo
      // reporting page; move it to the Campaigns list (read-only) before inspecting.
      // The report period travels as the listing's own startDate/endDate query (read-only
      // navigation); the adapter still requires Klaviyo to visibly show that exact range.
      const periodUrl = listUrl && isCampaignsListUrl(listUrl) ? withReportPeriod(listUrl, request.period) : null;
      // Always a fresh load, even when the tab already shows this listing: filters, sorts, and scroll state left by
      // an earlier attempt must never become this capture's starting point.
      if (periodUrl && tabs.update) {
        await withTimeout(() => tabs.update!(grant.grant.grantedTabId, { url: periodUrl }), "opening the Klaviyo Campaigns list in the toolbar-authorized tab", this.timeoutMs);
        tab = await this.waitForComplete(tabs, grant.grant.grantedTabId, true);
      }
      if (!isCampaignsListUrl(tab.url)) return { kind: "failed", code: "CAMPAIGNS_ROUTE_REQUIRED", message: "Open the Klaviyo Campaigns list (/omnicampaigns), then click the Tention Reports toolbar icon. Individual campaign pages are not permitted." };
      const results = await withTimeout(() => scripting.executeScript<unknown>({ target: { tabId: grant.grant.grantedTabId, frameIds: [0] }, func: prepareCampaignsCaptureDocument, args: [request] }), "preparing the Klaviyo Campaigns listing", Math.max(this.timeoutMs, 60_000));
      const main = results.find((result) => result.frameId === 0) ?? results[0];
      if (!main) return { kind: "failed", code: "SCRIPT_RESULT_EMPTY", message: "The Campaigns helper returned no result." };
      if (main.result === undefined) return { kind: "failed", code: "SCRIPT_RESULT_UNDEFINED", message: "The Campaigns helper returned an undefined result." };
      if (!isAdapterResult(main.result)) return { kind: "failed", code: "SCRIPT_RESULT_INVALID", message: "The Campaigns helper returned an invalid result." };
      if (!main.result.ok) return { kind: "failed", code: main.result.code, message: main.result.message, ...(main.result.diagnostics ? { diagnostics: main.result.diagnostics } : {}) };
      return { kind: "ready", sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, detectedPeriod: formatPeriod(request.period), observedPeriod: main.result.observedPeriod, target: main.result.targetRect, evidence: main.result.evidence };
    } catch (error) {
      return { kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: `Campaigns preparation failed: ${isChromeOperationTimeout(error) ? error.message : chromeErrorMessage(error)}` };
    }
  }
  private async waitForComplete(tabs: ChromeTabsApi, tabId: number, afterNavigation = false): Promise<ChromeTab> {
    const deadline = Date.now() + Math.max(this.timeoutMs, afterNavigation ? 20_000 : 0);
    let tab = await tabs.get(tabId);
    // After a navigation the tab can still report the old document as complete; wait (briefly) for the new load to start.
    const startBy = Date.now() + Math.min(3_000, this.timeoutMs);
    while (afterNavigation && tab.status === "complete" && Date.now() < startBy) { await new Promise((resolve) => setTimeout(resolve, 50)); tab = await tabs.get(tabId); }
    while (tab.status !== "complete" && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 100)); tab = await tabs.get(tabId); }
    return tab;
  }
}
function withReportPeriod(value: string, period: Pick<ReportPeriod, "startDate" | "endDate">): string { const url = new URL(value); url.searchParams.set("startDate", period.startDate); url.searchParams.set("endDate", period.endDate); return url.toString(); }
function isCampaignsListUrl(value: string | undefined): boolean { try { const url = new URL(value ?? ""); return url.protocol === "https:" && (url.hostname === "klaviyo.com" || url.hostname === "www.klaviyo.com") && url.pathname.replace(/\/$/, "") === "/omnicampaigns"; } catch { return false; } }
function isAdapterResult(value: unknown): value is CampaignsAdapterResult { if (!value || typeof value !== "object" || !("ok" in value) || typeof value.ok !== "boolean") return false; if (!value.ok) return "code" in value && "message" in value; const result = value as Extract<CampaignsAdapterResult, { ok: true }>; return Boolean(result.targetRect && result.evidence && typeof result.sourceUrl === "string" && Number.isFinite(result.targetRect.x) && Number.isFinite(result.targetRect.height)); }
function formatPeriod(period: Pick<ReportPeriod, "startDate" | "endDate">): string { const format = (value: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${value}T00:00:00.000Z`)); return `${format(period.startDate)} – ${format(period.endDate)}`; }
