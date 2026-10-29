import type { ReportPeriod, SubscriberGrowthEvidence } from "@tention/report-schema";
import {
  ChromeSessionKlaviyoActiveTabGrantStore, activeTabGrantFailureMessage, registerConfiguredCaptureRoute,
  type ActiveTabGrantFailureCode, type KlaviyoActiveTabGrantStore, verifyKlaviyoActiveTabGrant,
} from "./active-tab-grant.js";
import {
  prepareSubscriberGrowthDocument,
  type SubscriberGrowthAdapterResult, type SubscriberGrowthCaptureRequest, type SubscriberGrowthFailureCode, type SubscriberGrowthSourceProbe, type SubscriberGrowthTargetBounds,
} from "./subscriber-growth-capture.js";
import { adapterResultShapeError, injectionFailureDiagnostics } from "../../lib/chrome/injection-diagnostics.js";

export type SubscriberGrowthPreparation =
  | { kind: "ready"; sourceTabId: number; windowId: number; detectedPeriod: string; periodEvidence: { startDate: string; endDate: string }; target: SubscriberGrowthTargetBounds; evidence: SubscriberGrowthEvidence; diagnostics: Record<string, unknown> }
  | { kind: "failed"; code: ActiveTabGrantFailureCode | SubscriberGrowthFailureCode | "SUBSCRIBER_GROWTH_URL_REQUIRED" | "SUBSCRIBER_GROWTH_ROUTE_CHANGED" | "SCRIPT_RESULT_INVALID" | "SCRIPT_INJECTION_FAILED"; message: string; diagnostics?: Record<string, unknown> };
export interface SubscriberGrowthNavigation {
  prepare(input: { period: ReportPeriod; sourceUrl: string | null; clientName: string | null; extendedReadiness?: boolean }): Promise<SubscriberGrowthPreparation>;
}

interface Tab { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }
interface ChromeApi {
  tabs?: { get(id: number): Promise<Tab>; query(input: { active: boolean; windowId: number }): Promise<Tab[]>; update(id: number, input: { url?: string; active?: boolean }): Promise<Tab> };
  scripting?: { executeScript<R>(input: { target: { tabId: number; frameIds: [number] }; func: (...args: any[]) => R; args?: any[] }): Promise<Array<{ frameId?: number; documentId?: string; result?: R }>> };
}

const STABILITY = { sampleIntervalMs: 500, requiredStableSamples: 3, timeoutMs: 20_000 };
/** The configured route is reachable only as an HTTPS Klaviyo address; nothing else is ever navigated to. */
export function isSubscriberGrowthSourceUrl(value: string | null): value is string {
  try { const url = new URL(value ?? ""); return url.protocol === "https:" && (url.hostname === "www.klaviyo.com" || url.hostname === "klaviyo.com") && !url.username && !url.password && url.pathname.length > 1; } catch { return false; }
}
const samePath = (left: string | undefined, right: string) => { try { const a = new URL(left ?? ""); const b = new URL(right); return a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, ""); } catch { return false; } };

export class ChromeSubscriberGrowthNavigation implements SubscriberGrowthNavigation {
  constructor(
    private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
    private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore(),
    /** Persists the verified route list so a restarted service worker still recognises it. */
    private readonly onRouteRegistered: () => void = () => undefined,
    private readonly pollMs = 250,
    private readonly loadTimeoutMs = 30_000,
  ) {}

  async prepare(input: { period: ReportPeriod; sourceUrl: string | null; clientName: string | null; extendedReadiness?: boolean }): Promise<SubscriberGrowthPreparation> {
    const tabs = this.chromeApi?.tabs; const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting || !isSubscriberGrowthSourceUrl(input.sourceUrl)) return { kind: "failed", code: "SUBSCRIBER_GROWTH_URL_REQUIRED", message: "Save this client's Subscriber growth source once: open Audience → Profiles → View subscriber growth in Klaviyo (any view or date) and click the Tention toolbar icon. Email → Growth is selected and the source is saved automatically." };
    registerConfiguredCaptureRoute(input.sourceUrl); this.onRouteRegistered();
    const grant = await verifyKlaviyoActiveTabGrant(tabs, this.grantStore, { returningToConfiguredUrl: true });
    if (!grant.ok) return { kind: "failed", code: grant.code, message: activeTabGrantFailureMessage(grant.code) };
    const tabId = grant.grant.grantedTabId;
    try {
      // Every attempt reloads the saved source, so no prior tab, period, or chart state is reused.
      await tabs.update(tabId, { url: input.sourceUrl });
      const loadDeadline = Date.now() + this.loadTimeoutMs;
      let tab = await tabs.get(tabId);
      while (!(tab.status === "complete" && samePath(tab.url, input.sourceUrl)) && Date.now() < loadDeadline) { await new Promise((resolve) => setTimeout(resolve, this.pollMs)); tab = await tabs.get(tabId); }
      if (!samePath(tab.url, input.sourceUrl)) return { kind: "failed", code: "SUBSCRIBER_GROWTH_ROUTE_CHANGED", message: "Klaviyo did not stay on the saved Subscriber growth page (it may have redirected to sign-in or another page).", diagnostics: { expectedUrl: safe(input.sourceUrl), observedUrl: safe(tab.url ?? null), tabStatus: tab.status ?? null } };
      const request: SubscriberGrowthCaptureRequest = { purpose: "capture", period: { startDate: input.period.startDate, endDate: input.period.endDate }, clientName: input.clientName, readinessTimeoutMs: input.extendedReadiness ? 90_000 : 60_000, stability: STABILITY };
      const urlBefore = tab.url ?? null;
      const results = await scripting.executeScript<Promise<SubscriberGrowthAdapterResult | SubscriberGrowthSourceProbe>>({ target: { tabId, frameIds: [0] }, func: prepareSubscriberGrowthDocument, args: [request] });
      const main = results.find(({ frameId }) => frameId === 0) ?? results[0] ?? null;
      const result = main?.result as SubscriberGrowthAdapterResult | undefined;
      if (adapterResultShapeError(result) !== null || (result && "purpose" in result)) {
        const diagnostics = await injectionFailureDiagnostics({ section: "email_subscriber_growth", scripting: scripting as never, tabs, tabId, urlBefore, results, main, cardAliases: ["Subscriber growth"], failureStage: "PAGE_ADAPTER" }).catch(() => ({}));
        return { kind: "failed", code: "SCRIPT_RESULT_INVALID", message: "The Subscriber growth page adapter returned no usable result.", diagnostics };
      }
      if (!result!.ok) return { kind: "failed", code: result!.code, message: result!.message, ...(result!.diagnostics ? { diagnostics: result!.diagnostics } : {}) };
      return { kind: "ready", sourceTabId: tabId, windowId: grant.grant.grantedWindowId, detectedPeriod: result!.detectedPeriod, periodEvidence: result!.periodEvidence, target: result!.targetRect, evidence: result!.evidence, diagnostics: result!.diagnostics };
    } catch (error) {
      return { kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: error instanceof Error ? error.message : "The Subscriber growth adapter could not run." };
    }
  }
}

function safe(value: string | null): string | null { try { const url = new URL(value ?? ""); return `${url.origin}${url.pathname}`; } catch { return null; } }
