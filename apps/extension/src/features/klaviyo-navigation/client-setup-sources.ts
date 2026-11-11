import { KLAVIYO_DELIVERABILITY_SCORE_PATH } from "@tention/report-schema";
import type { KlaviyoActiveTabGrantStore, ChromeStorageSession } from "./active-tab-grant.js";
import type { BusinessReviewDiscoveryRequest, BusinessReviewDiscoveryResult } from "./business-review-discovery.js";
import { prepareDeliverabilityScoreDocument, type DeliverabilityScoreAdapterResult } from "./deliverability-score-capture.js";
import { SessionStorageWriteError, writeCriticalSession } from "../../lib/chrome/session-storage.js";

/**
 * One-time client-setup verifiers for two sources that are not covered by Business Review discovery:
 *
 * - Conversion metric: the user opens the client's own metric page (Analytics → Metrics → Placed Order) and clicks the
 *   Tention toolbar icon. The provider metric ID is read from that tab's own address (`/metric/<ID>/…`), never typed,
 *   and the page heading and account labels are returned so the panel can prove label and account before saving.
 * - Deliverability: on the toolbar-authorized tab, the client's saved Klaviyo account is re-proven and the existing
 *   Deliverability Score adapter must accept the page, exactly as a monthly capture would.
 *
 * Both are read-only. Nothing here touches screenshots or report data.
 */

export const CONVERSION_METRIC_VERIFIED_SOURCE_KEY = "tention.conversion-metric-source:verified";
const RECORD_TTL_MS = 15 * 60_000;
const KLAVIYO_ORIGINS = new Set(["https://www.klaviyo.com", "https://klaviyo.com"]);
const METRIC_PATH = /^\/metric\/([A-Za-z0-9]{4,32})(?:\/[^/]*)?\/?$/;

/** A Klaviyo metric detail page; the account-specific metric ID is the first path segment after /metric/. */
export function klaviyoMetricIdFromUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    if (!KLAVIYO_ORIGINS.has(url.origin)) return null;
    return METRIC_PATH.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

export interface ConversionMetricPageProbe { metricId: string | null; headings: string[]; title: string; accountLabels: string[]; sourceUrl: string }
/** The tiny restart-safe handoff from the toolbar click to the panel's save: no DOM, no image. */
export interface VerifiedConversionMetricSource { metricId: string; headings: string[]; title: string; accountLabels: string[]; sourceUrl: string; verifiedAt: number }
export type ConversionMetricSourceResult =
  | { ok: true; metricId: string; headings: string[]; title: string; accountLabels: string[]; sourceUrl: string }
  | { ok: false; code: "CONVERSION_METRIC_SOURCE_NOT_VERIFIED" | "CONVERSION_METRIC_PAGE_NOT_READ" | "SESSION_STORAGE_QUOTA_EXCEEDED" | "SESSION_STORAGE_WRITE_FAILED"; message: string };

/**
 * Serialized into the clicked metric tab: reads the metric ID from the address, the visible page headings, and the
 * account-identifying header controls. Self-contained (Chrome runs it without module scope); every exit is plain JSON.
 */
export async function inspectConversionMetricDocument(): Promise<ConversionMetricPageProbe> {
  try {
    const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
    const shown = (element: Element) => { const style = getComputedStyle(element); const rect = element.getBoundingClientRect(); return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0; };
    const headings = () => Array.from(document.querySelectorAll("h1,h2,[role=heading]")).filter(shown).map(textOf).filter((text) => text.length > 0 && text.length <= 120).slice(0, 20);
    // The metric page renders client-side: wait (bounded) for a heading before reading.
    const deadline = Date.now() + 10_000;
    while (headings().length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
    // The same candidates onboarding's Business Review discovery reads the account from: everything visible in the
    // page header/banner plus explicit account/workspace controls (aria-label, title and text of each).
    const candidates = Array.from(document.querySelectorAll("header *,[role=banner] *,nav button,nav [role=button],[aria-label*=account i],[title*=account i],[data-testid*=account i],[aria-label*=workspace i],[aria-label*=organization i]"))
      .filter(shown).flatMap((element) => [element.getAttribute("aria-label"), element.getAttribute("title"), textOf(element)]);
    const accountLabels = candidates.filter((value): value is string => Boolean(value && value.trim() && value.length <= 120)).map((value) => value.trim())
      .filter((value, index, all) => all.indexOf(value) === index).slice(0, 40);
    const match = /^\/metric\/([A-Za-z0-9]{4,32})(?:\/[^/]*)?\/?$/.exec(location.pathname);
    return { metricId: match?.[1] ?? null, headings: headings(), title: document.title.slice(0, 120), accountLabels, sourceUrl: `${location.origin}${location.pathname}`.slice(0, 300) };
  } catch {
    return { metricId: null, headings: [], title: "", accountLabels: [], sourceUrl: "" };
  }
}

interface Tab { id?: number; windowId?: number; url?: string }
interface ScriptingApi { executeScript<R>(input: { target: { tabId: number; frameIds: [number] }; func: (...args: any[]) => R; args?: any[] }): Promise<Array<{ frameId?: number; result?: R }>> }

export class ConversionMetricSourceSetup {
  constructor(
    private readonly scripting: ScriptingApi | undefined,
    private readonly session: ChromeStorageSession | undefined,
    private readonly now: () => number = () => Date.now(),
    private readonly probeTimeoutMs = 20_000,
  ) {}

  /** Runs at the toolbar click on a metric page, while the click's activeTab grant is fresh. Null for other pages. */
  async verifyAtToolbarClick(tab: Tab): Promise<ConversionMetricSourceResult | null> {
    const metricId = klaviyoMetricIdFromUrl(tab.url);
    if (!metricId || typeof tab.id !== "number" || !this.scripting) return null;
    await this.session?.remove(CONVERSION_METRIC_VERIFIED_SOURCE_KEY).catch(() => undefined);
    const probe = await this.boundedProbe(tab.id);
    if (!probe || probe.metricId !== metricId) return { ok: false, code: "CONVERSION_METRIC_PAGE_NOT_READ", message: "The Klaviyo metric page could not be read. Wait for it to load and click the Tention toolbar icon again." };
    const record: VerifiedConversionMetricSource = { metricId, headings: probe.headings.slice(0, 20), title: probe.title, accountLabels: probe.accountLabels.slice(0, 40), sourceUrl: probe.sourceUrl, verifiedAt: this.now() };
    try {
      if (!this.session) throw new SessionStorageWriteError("SESSION_STORAGE_WRITE_FAILED", "Extension session storage is unavailable.", { attemptedKey: CONVERSION_METRIC_VERIFIED_SOURCE_KEY, approxAttemptedBytes: 0, bytesInUse: null, removedKeys: [] });
      await writeCriticalSession(this.session, { [CONVERSION_METRIC_VERIFIED_SOURCE_KEY]: record });
    } catch (error) {
      if (!(error instanceof SessionStorageWriteError)) throw error;
      return { ok: false, code: error.code, message: "The extension could not store the metric it read (browser session storage is full). Reload the extension and click the toolbar icon again." };
    }
    return { ok: true, metricId, headings: record.headings, title: record.title, accountLabels: record.accountLabels, sourceUrl: record.sourceUrl };
  }

  /** The panel takes the metric read at the latest toolbar click (within 15 minutes) once; it is then consumed. */
  async take(): Promise<ConversionMetricSourceResult> {
    const stored = ((await this.session?.get(CONVERSION_METRIC_VERIFIED_SOURCE_KEY).catch(() => ({} as Record<string, unknown>))) ?? {})[CONVERSION_METRIC_VERIFIED_SOURCE_KEY] as VerifiedConversionMetricSource | undefined;
    if (!stored || typeof stored.metricId !== "string" || this.now() - stored.verifiedAt > RECORD_TTL_MS) {
      return { ok: false, code: "CONVERSION_METRIC_SOURCE_NOT_VERIFIED", message: "Open Analytics → Metrics → Placed Order in this client's Klaviyo account, then click the Tention toolbar icon once." };
    }
    await this.session?.remove(CONVERSION_METRIC_VERIFIED_SOURCE_KEY).catch(() => undefined);
    return { ok: true, metricId: stored.metricId, headings: stored.headings ?? [], title: stored.title ?? "", accountLabels: stored.accountLabels ?? [], sourceUrl: stored.sourceUrl };
  }

  private async boundedProbe(tabId: number): Promise<ConversionMetricPageProbe | null> {
    const run = this.scripting!.executeScript<Promise<ConversionMetricPageProbe>>({ target: { tabId, frameIds: [0] }, func: inspectConversionMetricDocument as never })
      .then((results) => ((results.find(({ frameId }) => frameId === 0) ?? results[0])?.result ?? null) as ConversionMetricPageProbe | null).catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.probeTimeoutMs); });
    try { return await Promise.race([run, timeout]); } finally { if (timer) clearTimeout(timer); }
  }
}

export interface DeliverabilitySourceRequest { clientName: string; configuredUrl: string | null; configuredAccountLabel: string | null; configuredProviderAccountId: string | null }
export type DeliverabilitySourceResult =
  | { ok: true; deliverabilityUrl: string; accountLabel: string }
  | { ok: false; code: string; message: string; diagnostics?: Record<string, unknown> };

/** Re-proves the client's saved account on the authorized tab, then requires the Deliverability adapter to accept the page. */
export class DeliverabilitySourceVerifier {
  constructor(
    private readonly tabs: { get(tabId: number): Promise<Tab> } | undefined,
    private readonly scripting: ScriptingApi | undefined,
    private readonly grantStore: KlaviyoActiveTabGrantStore,
    private readonly discoverAccount: (input: BusinessReviewDiscoveryRequest) => Promise<BusinessReviewDiscoveryResult>,
  ) {}

  async verify(request: DeliverabilitySourceRequest): Promise<DeliverabilitySourceResult> {
    if (!this.tabs || !this.scripting) return { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Deliverability verification is unavailable in this extension context." };
    if (!request.configuredUrl || (!request.configuredAccountLabel && !request.configuredProviderAccountId)) {
      return { ok: false, code: "KLAVIYO_ACCOUNT_NOT_VERIFIED", message: "Verify the client's Klaviyo account first." };
    }
    const account = await this.discoverAccount({ ...request, verifySavedAccountOnly: true });
    if (!account.ok) return { ok: false, code: account.code, message: account.message, ...(account.diagnostics ? { diagnostics: account.diagnostics } : {}) };
    const grant = await this.grantStore.get();
    const tab = grant ? await this.tabs.get(grant.grantedTabId).catch(() => null) : null;
    let path: string | null = null;
    try { path = tab?.url ? new URL(tab.url).pathname.replace(/\/$/, "") : null; } catch { path = null; }
    if (!grant || !tab?.url || path !== KLAVIYO_DELIVERABILITY_SCORE_PATH) {
      return { ok: false, code: "DELIVERABILITY_SOURCE_NOT_VERIFIED", message: "Open Analytics → Deliverability → Email → Score in this client's Klaviyo account, then click the Tention toolbar icon." };
    }
    const results = await this.scripting.executeScript<Promise<DeliverabilityScoreAdapterResult>>({ target: { tabId: grant.grantedTabId, frameIds: [0] }, func: prepareDeliverabilityScoreDocument as never }).catch(() => null);
    // Chrome resolves an injected async function's promise before returning its result.
    const page = ((results?.find(({ frameId }) => frameId === 0) ?? results?.[0])?.result ?? null) as DeliverabilityScoreAdapterResult | null;
    if (!page) return { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "The Deliverability page could not be read." };
    if (!page.ok) return { ok: false, code: page.code, message: page.message };
    return { ok: true, deliverabilityUrl: `${new URL(tab.url).origin}${KLAVIYO_DELIVERABILITY_SCORE_PATH}`, accountLabel: account.accountLabel };
  }
}
