import { registerConfiguredCaptureRoute, type ChromeStorageSession, type KlaviyoActiveTabGrantStore } from "./active-tab-grant.js";
import { prepareSubscriberGrowthDocument, type SubscriberGrowthCaptureRequest, type SubscriberGrowthSourceProbe } from "./subscriber-growth-capture.js";
import type { SourceSetupGate } from "./source-setup-gate.js";
import { SessionStorageWriteError, writeCriticalSession } from "../../lib/chrome/session-storage.js";

/** Session record of a source proven at the toolbar click; consumed once by the panel's canonical save. */
export const SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY = "tention.subscriber-growth-source:verified";
/** The latest source-setup diagnostics (origins and paths only; never queries, cookies, or page content). */
export const SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY = "tention.subscriber-growth-source:last";

export interface SourceSetupDiagnostics {
  SOURCE_SETUP_STATE: string;
  GRANTED_TAB_ID: number | null; GRANTED_WINDOW_ID: number | null; GRANTED_URL: string | null; GRANTED_ORIGIN: string | null; GRANTED_AT: string | null;
  URL_BEFORE_TOOLBAR_GRANT: string | null; URL_AFTER_TOOLBAR_GRANT: string | null;
  CURRENT_TAB_ID: number | null; CURRENT_URL: string | null; CURRENT_ORIGIN: string | null;
  URL_BEFORE_SOURCE_SAVE: string | null; URL_AFTER_SOURCE_SAVE: string | null;
  REDIRECTED_ORIGIN: string | null; NAVIGATION_DETECTED: boolean; NAVIGATION_INITIATOR: string | null;
  FAILURE_CODE: string | null;
  /** What the page step reported, flattened to short primitives. */
  PROBE_RESULT: string | null; PROBE_SELECTIONS: string | null;
  /** Only on a refused session write. */
  SESSION_BYTES_IN_USE?: number | null; FAILED_WRITE_KEY?: string | null; FAILED_WRITE_APPROX_BYTES?: number | null;
}
/** The tiny restart-safe handoff from the toolbar click to the panel's save: no DOM, no image, no diagnostics. */
export interface VerifiedSubscriberGrowthSource { sourceUrl: string; tabId: number; windowId: number; origin: string; pathname: string; accountLabels: string[]; verifiedAt: number }
/** Hard budgets enforced by tests: the handoff and the diagnostics stay small however often setup runs. */
export const VERIFIED_SOURCE_MAX_BYTES = 1_024;
export const SOURCE_DIAGNOSTICS_MAX_BYTES = 4_096;
export type SubscriberGrowthDiscoveryResult =
  | { ok: true; subscriberGrowthUrl: string; accountLabels: string[]; diagnostics?: SourceSetupDiagnostics }
  | { ok: false; code: SubscriberGrowthSourceFailureCode; message: string; diagnostics?: SourceSetupDiagnostics | Record<string, unknown> };
export type SubscriberGrowthSourceFailureCode =
  | "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED" | "SUBSCRIBER_GROWTH_SOURCE_REDIRECTED" | "SUBSCRIBER_GROWTH_SOURCE_SETUP_TIMEOUT" | "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN"
  | "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED" | "SCRIPT_INJECTION_FAILED" | "SESSION_STORAGE_QUOTA_EXCEEDED" | "SESSION_STORAGE_WRITE_FAILED"
  | Extract<SubscriberGrowthSourceProbe, { ok: false }>["code"];
/** One-time source setup request: no client, no report month — only the stable reporting page and its Email → Growth view. */
const SOURCE_SETUP_REQUEST: SubscriberGrowthCaptureRequest = { purpose: "source", period: null, clientName: null, readinessTimeoutMs: 40_000, stability: { sampleIntervalMs: 500, requiredStableSamples: 3, timeoutMs: 10_000 } };

interface Tab { id?: number; windowId?: number; url?: string }
interface SetupChromeApi {
  tabs?: { get(id: number): Promise<Tab> };
  scripting?: { executeScript<R>(input: { target: { tabId: number; frameIds: [number] }; func: (...args: any[]) => R; args?: any[] }): Promise<Array<{ frameId?: number; result?: R }>> };
}

const KLAVIYO_ORIGINS = new Set(["https://www.klaviyo.com", "https://klaviyo.com"]);
const originOf = (value: string | null | undefined) => { try { return new URL(value ?? "").origin; } catch { return null; } };
/** Origin + path only: a query may carry a transient date or token and is never stored or logged. */
const safeUrl = (value: string | null | undefined) => { try { const url = new URL(value ?? ""); return `${url.origin}${url.pathname}`.slice(0, 300); } catch { return null; } };
/** Diagnostics are a fixed schema of short primitives; any string is cut, nothing nested survives. */
function compact(diagnostics: SourceSetupDiagnostics): SourceSetupDiagnostics {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(diagnostics)) out[key] = typeof value === "string" ? value.slice(0, 300) : typeof value === "number" || typeof value === "boolean" || value === null ? value : null;
  return out as unknown as SourceSetupDiagnostics;
}

/**
 * One-time Subscriber Growth source setup as a single transaction on the exact tab the user clicked:
 * toolbar click → freeze tab id + href + origin → read-only probe of that tab → origin re-check (by `URL.origin`;
 * same-origin path/query/hash changes are normal SPA rendering) → verified record → panel's canonical save →
 * acknowledgement. It never queries "whichever tab is active", and automatic navigation waits on the gate.
 */
export class SubscriberGrowthSourceSetup {
  private lastAutomaticNavigationAt = 0;
  constructor(
    private readonly chromeApi: SetupChromeApi | undefined,
    private readonly grantStore: KlaviyoActiveTabGrantStore,
    private readonly session: ChromeStorageSession | undefined,
    private readonly gate: SourceSetupGate,
    private readonly onRouteRegistered: () => void = () => undefined,
    /** Bounds the whole page transaction: identify the page, select Email → Growth, wait for the three metrics. */
    private readonly probeTimeoutMs = 45_000,
    private readonly recordTtlMs = 15 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Called for every automatic capture start: lets diagnostics attribute a later navigation to the extension. */
  noteAutomaticNavigation(): void { this.lastAutomaticNavigationAt = this.now(); }

  /** Runs at the toolbar click itself, while the click's activeTab grant is fresh. Returns null for non-Klaviyo tabs. */
  async verifyAtToolbarClick(tab: Tab): Promise<SubscriberGrowthDiscoveryResult | null> {
    const grantedOrigin = originOf(tab.url);
    if (typeof tab.id !== "number" || typeof tab.windowId !== "number" || !grantedOrigin || !KLAVIYO_ORIGINS.has(grantedOrigin)) return null;
    const tabs = this.chromeApi?.tabs; const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting) return null;
    const grantedAt = this.now();
    const diagnostics: SourceSetupDiagnostics = {
      SOURCE_SETUP_STATE: "VALIDATING", GRANTED_TAB_ID: tab.id, GRANTED_WINDOW_ID: tab.windowId, GRANTED_URL: safeUrl(tab.url), GRANTED_ORIGIN: grantedOrigin, GRANTED_AT: new Date(grantedAt).toISOString(),
      URL_BEFORE_TOOLBAR_GRANT: safeUrl(tab.url), URL_AFTER_TOOLBAR_GRANT: null, CURRENT_TAB_ID: tab.id, CURRENT_URL: null, CURRENT_ORIGIN: null,
      URL_BEFORE_SOURCE_SAVE: null, URL_AFTER_SOURCE_SAVE: null, REDIRECTED_ORIGIN: null, NAVIGATION_DETECTED: false, NAVIGATION_INITIATOR: null, FAILURE_CODE: null,
      PROBE_RESULT: null, PROBE_SELECTIONS: null,
    };
    this.gate.begin("VALIDATING");
    try {
      const probe = await this.boundedProbe(tab.id);
      const after = await tabs.get(tab.id).catch(() => null);
      Object.assign(diagnostics, { URL_AFTER_TOOLBAR_GRANT: safeUrl(after?.url), CURRENT_URL: safeUrl(after?.url), CURRENT_ORIGIN: originOf(after?.url) });
      diagnostics.NAVIGATION_DETECTED = diagnostics.URL_AFTER_TOOLBAR_GRANT !== diagnostics.URL_BEFORE_TOOLBAR_GRANT;
      if (diagnostics.NAVIGATION_DETECTED) diagnostics.NAVIGATION_INITIATOR = this.initiator(grantedAt);
      if (probe === "timeout") return await this.fail(diagnostics, "SUBSCRIBER_GROWTH_SOURCE_SETUP_TIMEOUT", "Reading the Subscriber growth page took too long. Click the Tention toolbar icon again once the page has loaded.");
      if (!after || after.id !== tab.id) return await this.fail(diagnostics, "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED", "The Klaviyo tab closed during Subscriber Growth setup.");
      // Only a real origin change fails here; a same-origin path, query, or hash change is ordinary SPA rendering.
      if (diagnostics.CURRENT_ORIGIN !== grantedOrigin) {
        diagnostics.REDIRECTED_ORIGIN = diagnostics.CURRENT_ORIGIN;
        return await this.fail(diagnostics, "SUBSCRIBER_GROWTH_SOURCE_REDIRECTED", "The Klaviyo tab left Klaviyo's reporting origin during setup. Return to Subscriber growth → Email → Growth and click the Tention toolbar icon again.");
      }
      if (!probe || typeof probe !== "object") return await this.fail(diagnostics, "SCRIPT_INJECTION_FAILED", "The Subscriber growth page could not be read.");
      diagnostics.PROBE_RESULT = probe.ok ? "VERIFIED" : String(probe.code).slice(0, 80);
      diagnostics.PROBE_SELECTIONS = probe.ok ? (Array.isArray(probe.selections) ? probe.selections : []).join(" → ") || "none needed" : null;
      if (!probe.ok) return await this.fail(diagnostics, probe.code, probe.message);
      if (originOf(probe.sourceUrl) !== grantedOrigin) {
        diagnostics.REDIRECTED_ORIGIN = originOf(probe.sourceUrl);
        return await this.fail(diagnostics, "SUBSCRIBER_GROWTH_SOURCE_REDIRECTED", "The Subscriber growth page reported a different origin than the authorized tab.");
      }
      registerConfiguredCaptureRoute(probe.sourceUrl); this.onRouteRegistered();
      const accountLabels = (Array.isArray(probe.accountLabels) ? probe.accountLabels : []).slice(0, 5).map((value) => String(value).slice(0, 80));
      const record: VerifiedSubscriberGrowthSource = { sourceUrl: probe.sourceUrl.slice(0, 300), tabId: tab.id, windowId: tab.windowId, origin: grantedOrigin, pathname: new URL(probe.sourceUrl).pathname.slice(0, 200), accountLabels, verifiedAt: grantedAt };
      try {
        // The proven page is now a verified reporting route; grant exactly this tab, as a click on a supported page would.
        await this.grantStore.set({ grantedTabId: tab.id, grantedWindowId: tab.windowId, grantedOrigin, grantedUrl: after.url ?? tab.url!, grantedAt });
        // Critical, acknowledged handoff: written, read back, and retried once after releasing obsolete transient state.
        if (!this.session) throw new SessionStorageWriteError("SESSION_STORAGE_WRITE_FAILED", "Extension session storage is unavailable.", { attemptedKey: SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY, approxAttemptedBytes: 0, bytesInUse: null, removedKeys: [] });
        await writeCriticalSession(this.session, { [SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY]: record });
      } catch (error) {
        if (!(error instanceof SessionStorageWriteError)) throw error;
        Object.assign(diagnostics, { SESSION_BYTES_IN_USE: error.diagnostics.bytesInUse, FAILED_WRITE_KEY: error.diagnostics.attemptedKey, FAILED_WRITE_APPROX_BYTES: error.diagnostics.approxAttemptedBytes });
        return await this.fail(diagnostics, error.code, "The extension could not store the verified Subscriber Growth source (browser session storage is full). Nothing was saved; reload the extension and click the Tention toolbar icon again.");
      }
      diagnostics.SOURCE_SETUP_STATE = "VERIFIED";
      await this.writeDiagnostics(diagnostics);
      return { ok: true, subscriberGrowthUrl: record.sourceUrl, accountLabels, diagnostics: compact(diagnostics) };
    } catch (error) {
      return await this.fail(diagnostics, "SCRIPT_INJECTION_FAILED", `Subscriber Growth source setup failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    } finally { this.gate.end(); }
  }

  /**
   * The panel's save step takes the source proven at the click. Navigation stays blocked (PERSISTING) until the panel
   * reports the canonical save, or the bounded hold expires. The source tab may have moved since the click: the
   * address was already proven, so only its origin and path are recorded for diagnostics.
   */
  async takeVerifiedSource(): Promise<SubscriberGrowthDiscoveryResult> {
    const all = (await this.session?.get(null).catch(() => ({} as Record<string, unknown>))) ?? {};
    const stored = all[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY] as VerifiedSubscriberGrowthSource | undefined;
    const last = all[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY] as SourceSetupDiagnostics | undefined;
    if ((!stored || this.now() - stored.verifiedAt > this.recordTtlMs) && last?.FAILURE_CODE && last.GRANTED_AT && this.now() - Date.parse(last.GRANTED_AT) <= this.recordTtlMs) {
      // The latest toolbar transaction failed: report its own typed cause rather than a generic "not verified".
      return { ok: false, code: last.FAILURE_CODE as SubscriberGrowthSourceFailureCode, message: `Subscriber Growth source setup failed at the toolbar click (${last.FAILURE_CODE}). See the setup diagnostics.`, diagnostics: compact(last) };
    }
    if (!stored || typeof stored.sourceUrl !== "string" || this.now() - stored.verifiedAt > this.recordTtlMs) {
      return { ok: false, code: "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED", message: "Open Audience → Profiles → View subscriber growth in Klaviyo (any view or date), then click the Tention toolbar icon once. Email → Growth is selected and the source is saved automatically.", ...(last ? { diagnostics: compact(last) } : {}) };
    }
    this.gate.begin("PERSISTING");
    const current = await this.chromeApi?.tabs?.get(stored.tabId).catch(() => null);
    const base: SourceSetupDiagnostics = last ?? { SOURCE_SETUP_STATE: "VERIFIED", GRANTED_TAB_ID: stored.tabId, GRANTED_WINDOW_ID: stored.windowId, GRANTED_URL: stored.sourceUrl, GRANTED_ORIGIN: stored.origin, GRANTED_AT: new Date(stored.verifiedAt).toISOString(), URL_BEFORE_TOOLBAR_GRANT: null, URL_AFTER_TOOLBAR_GRANT: stored.sourceUrl, CURRENT_TAB_ID: null, CURRENT_URL: null, CURRENT_ORIGIN: null, URL_BEFORE_SOURCE_SAVE: null, URL_AFTER_SOURCE_SAVE: null, REDIRECTED_ORIGIN: null, NAVIGATION_DETECTED: false, NAVIGATION_INITIATOR: null, FAILURE_CODE: null, PROBE_RESULT: "VERIFIED", PROBE_SELECTIONS: null };
    const diagnostics: SourceSetupDiagnostics = { ...base, SOURCE_SETUP_STATE: "PERSISTING", CURRENT_TAB_ID: current?.id ?? null, CURRENT_URL: safeUrl(current?.url), CURRENT_ORIGIN: originOf(current?.url), URL_BEFORE_SOURCE_SAVE: safeUrl(current?.url) };
    diagnostics.NAVIGATION_DETECTED = base.NAVIGATION_DETECTED || diagnostics.URL_BEFORE_SOURCE_SAVE !== base.URL_AFTER_TOOLBAR_GRANT;
    if (diagnostics.NAVIGATION_DETECTED && !diagnostics.NAVIGATION_INITIATOR) diagnostics.NAVIGATION_INITIATOR = this.initiator(stored.verifiedAt);
    await this.writeDiagnostics(diagnostics);
    return { ok: true, subscriberGrowthUrl: stored.sourceUrl, accountLabels: Array.isArray(stored.accountLabels) ? stored.accountLabels : [], diagnostics: compact(diagnostics) };
  }

  /** Ends the transaction. Only a confirmed canonical save consumes the verified record. */
  async persisted(input: { saved: boolean; sourceUrl: string | null; failureCode?: string | null }): Promise<SourceSetupDiagnostics | null> {
    try {
      const stored = (await this.session?.get(null).catch(() => ({} as Record<string, unknown>))) ?? {};
      const record = stored[SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY] as VerifiedSubscriberGrowthSource | undefined;
      const last = (stored[SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY] as SourceSetupDiagnostics | undefined) ?? null;
      const tabId = record?.tabId ?? last?.GRANTED_TAB_ID ?? null;
      const current = typeof tabId === "number" ? await this.chromeApi?.tabs?.get(tabId).catch(() => null) : null;
      const diagnostics = last ? { ...last, SOURCE_SETUP_STATE: input.saved ? "SAVED" : "SAVE_FAILED", URL_AFTER_SOURCE_SAVE: safeUrl(current?.url), FAILURE_CODE: input.saved ? null : input.failureCode ?? "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED" } : null;
      if (diagnostics) await this.writeDiagnostics(diagnostics);
      if (input.saved && record?.sourceUrl === input.sourceUrl) await this.session?.remove(SUBSCRIBER_GROWTH_VERIFIED_SOURCE_KEY).catch(() => undefined);
      return diagnostics;
    } finally { this.gate.end(); }
  }

  private async boundedProbe(tabId: number): Promise<SubscriberGrowthSourceProbe | null | "timeout"> {
    const run = this.chromeApi!.scripting!.executeScript<Promise<SubscriberGrowthSourceProbe>>({ target: { tabId, frameIds: [0] }, func: prepareSubscriberGrowthDocument as never, args: [SOURCE_SETUP_REQUEST] })
      .then((results) => (results.find(({ frameId }) => frameId === 0) ?? results[0])?.result ?? null).catch(() => null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), this.probeTimeoutMs); });
    try { return await Promise.race([run, timeout]); } finally { if (timer) clearTimeout(timer); }
  }

  private initiator(since: number): string {
    return this.lastAutomaticNavigationAt >= since ? "extension automatic capture" : "page or user (Chrome reports no initiator without the webNavigation permission)";
  }

  private async fail(diagnostics: SourceSetupDiagnostics, code: SubscriberGrowthSourceFailureCode, message: string): Promise<SubscriberGrowthDiscoveryResult> {
    diagnostics.SOURCE_SETUP_STATE = "FAILED"; diagnostics.FAILURE_CODE = code;
    await this.writeDiagnostics(diagnostics);
    return { ok: false, code, message, diagnostics: compact(diagnostics) };
  }

  /** Diagnostics are non-critical by design: a refused write never changes the transaction's outcome. Always compact. */
  private async writeDiagnostics(diagnostics: SourceSetupDiagnostics): Promise<void> {
    await this.session?.set({ [SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY]: compact(diagnostics) }).catch(() => undefined);
  }
}
