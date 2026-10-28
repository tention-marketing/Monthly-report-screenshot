import type { ReportPeriod } from "@tention/report-schema";
import { ChromeSessionKlaviyoActiveTabGrantStore, activeTabGrantFailureMessage, type ActiveTabGrantFailureCode, type KlaviyoActiveTabGrantStore, verifyKlaviyoActiveTabGrant } from "./active-tab-grant.js";
import { prepareDeliverabilityScoreDocument, type DeliverabilityScoreAdapterResult, type DeliverabilityScoreStabilityOptions, type DeliverabilityScoreTargetBounds } from "./deliverability-score-capture.js";

const deliverabilityScoreStability: DeliverabilityScoreStabilityOptions = { sampleIntervalMs: 250, requiredStableSamples: 4, timeoutMs: 8_000 };

export type DeliverabilityScorePreparation =
  | { kind: "ready"; sourceTabId: number; windowId: number; detectedPeriod: string; target: DeliverabilityScoreTargetBounds; diagnostics: { observedScoreText: string | null; stableSamples: number } }
  | { kind: "failed"; code: ActiveTabGrantFailureCode | "DELIVERABILITY_SCORE_URL_REQUIRED" | "KLAVIYO_PAGE_ADAPTER_ERROR" | "DELIVERABILITY_SCORE_NOT_FOUND" | "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED" | "DELIVERABILITY_SCORE_NOT_STABLE" | "TARGET_BOUNDS_INVALID" | "SCRIPT_RESULT_INVALID" | "SCRIPT_INJECTION_FAILED"; message: string; diagnostics?: Record<string, unknown> };
export interface DeliverabilityScoreNavigation { prepare(period: ReportPeriod, scoreUrl: string | null): Promise<DeliverabilityScorePreparation>; }
interface Tab { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }
interface ChromeApi { tabs?: { get(id: number): Promise<Tab>; query(input: { active: boolean; windowId: number }): Promise<Tab[]>; update(id: number, input: { url: string }): Promise<Tab> }; scripting?: { executeScript<R>(input: { target: { tabId: number; frameIds: [number] }; func: (...args: any[]) => R; args: any[] }): Promise<Array<{ frameId?: number; result?: R }>> } }

export class ChromeDeliverabilityScoreNavigation implements DeliverabilityScoreNavigation {
  constructor(private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome, private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore()) {}
  async prepare(_period: ReportPeriod, scoreUrl: string | null): Promise<DeliverabilityScorePreparation> {
    const tabs = this.chromeApi?.tabs; const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting || !isScoreUrl(scoreUrl)) return { kind: "failed", code: "DELIVERABILITY_SCORE_URL_REQUIRED", message: "A configured standalone Klaviyo Deliverability Score Email URL is required." };
    const grant = await verifyKlaviyoActiveTabGrant(tabs, this.grantStore);
    if (!grant.ok) return { kind: "failed", code: grant.code, message: activeTabGrantFailureMessage(grant.code) };
    try {
      // Prefer Klaviyo's own sidebar link. A full deep-link reload can leave its
      // React shell blank even though the URL and tab status look complete.
      const sameDocumentNavigation = await scripting.executeScript<boolean>({ target: { tabId: grant.grant.grantedTabId, frameIds: [0] }, func: navigateViaExistingScoreLink, args: [scoreUrl] })
        .then((results) => results.find(({ frameId }) => frameId === 0)?.result ?? results[0]?.result ?? false)
        .catch(() => false);
      if (!sameDocumentNavigation) await tabs.update(grant.grant.grantedTabId, { url: scoreUrl });
      const result = await waitForScoreSemantics(tabs, scripting, grant.grant.grantedTabId, scoreUrl);
      if (!result) return { kind: "failed", code: "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED", message: "The standalone Deliverability Score route did not render its semantic card in the authorized Klaviyo tab." };
      if (!result || typeof result !== "object" || !("ok" in result) || typeof result.ok !== "boolean") return { kind: "failed", code: "SCRIPT_RESULT_INVALID", message: "The Deliverability Score semantic adapter returned an invalid result." };
      if (!result.ok) return { kind: "failed", code: result.code, message: result.message, ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}) };
      return { kind: "ready", sourceTabId: grant.grant.grantedTabId, windowId: grant.grant.grantedWindowId, detectedPeriod: "Based on last 30 days of data", target: result.targetRect, diagnostics: result.diagnostics };
    } catch (error) { return { kind: "failed", code: "SCRIPT_INJECTION_FAILED", message: error instanceof Error ? error.message : "The Deliverability Score adapter could not run." }; }
  }
}
function isScoreUrl(value: string | null): value is string { try { const url = new URL(value ?? ""); return url.protocol === "https:" && (url.hostname === "www.klaviyo.com" || url.hostname === "klaviyo.com") && /^\/analytics\/deliverability\/email\/score\/?$/i.test(url.pathname); } catch { return false; } }
/** Runs in the authorized Klaviyo document and only follows the visible sidebar link. */
function navigateViaExistingScoreLink(scoreUrl: string): boolean {
  const expected = new URL(scoreUrl);
  const visible = (node: Element) => { const rect = node.getBoundingClientRect(); const style = getComputedStyle(node); return rect.width > 1 && rect.height > 1 && style.display !== "none" && style.visibility !== "hidden"; };
  const link = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].find((candidate) => {
    const actual = new URL(candidate.href, location.href);
    const label = (candidate.textContent ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    return visible(candidate) && actual.origin === expected.origin
      && (actual.pathname === expected.pathname || (label === "deliverability" && /^\/analytics\/deliverability\/?$/i.test(actual.pathname)));
  });
  if (!link) return false;
  link.click();
  return true;
}
async function waitForScoreSemantics(tabs: NonNullable<ChromeApi["tabs"]>, scripting: NonNullable<ChromeApi["scripting"]>, tabId: number, scoreUrl: string): Promise<DeliverabilityScoreAdapterResult | null> {
  const expected = new URL(scoreUrl);
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const tab = await tabs.get(tabId);
    const actual = tab.url ? new URL(tab.url) : null;
    if (actual?.origin === expected.origin && actual.pathname === expected.pathname && tab.status === "complete") {
      // The adapter itself waits for the score gauge to settle; only an unrendered
      // card is worth polling again; unstable or clipped targets fail closed.
      const results = await scripting.executeScript<Promise<DeliverabilityScoreAdapterResult>>({ target: { tabId, frameIds: [0] }, func: prepareDeliverabilityScoreDocument, args: [deliverabilityScoreStability] }).catch(() => []);
      const result = (results.find(({ frameId }) => frameId === 0)?.result ?? results[0]?.result) as DeliverabilityScoreAdapterResult | undefined;
      if (result && (result.ok || result.code !== "DELIVERABILITY_SCORE_CONTENT_NOT_RENDERED")) return result;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  return null;
}
