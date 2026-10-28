import {
  ChromeSessionKlaviyoActiveTabGrantStore,
  isKlaviyoBusinessReviewDashboardUrl,
  isKlaviyoSupportedCaptureUrl,
  verifyKlaviyoActiveTabGrant,
  type KlaviyoActiveTabGrantStore,
} from "./active-tab-grant.js";
import { chromeErrorMessage, isChromeOperationTimeout, withTimeout } from "../../lib/chrome/with-timeout.js";

export type BusinessReviewDiscoveryFailure =
  | "ACTION_NOT_INVOKED" | "GRANTED_TAB_CLOSED" | "GRANTED_TAB_NOT_ACTIVE" | "GRANTED_TAB_CHANGED_ORIGIN" | "GRANTED_TAB_ROUTE_NOT_SUPPORTED"
  | "ACCOUNT_CONTEXT_NOT_VERIFIED" | "ACCOUNT_CONTEXT_MISMATCH" | "BUSINESS_REVIEW_NOT_DISCOVERED"
  | "BUSINESS_REVIEW_PAGE_NOT_VERIFIED" | "SCRIPT_INJECTION_FAILED" | "INSPECTOR_RESULT_EMPTY" | "PAGE_READY_TIMEOUT";

export type BusinessReviewDiscoveryResult =
  | { ok: true; dashboardUrl: string; accountLabel: string; providerAccountId?: string; providerIdentityKind?: "account" | "workspace" | "organization"; accountMatchesClient: true; evidence: { businessReviewHeading: true; growthOverview: true; campaignPerformance: true; flowPerformance: true } }
  /** A saved, previously verified target: only the authorized tab's account binding was re-proven. */
  | { ok: true; verification: "saved_target_account"; dashboardUrl: string; accountLabel: string; providerAccountId?: string; providerIdentityKind?: "account" | "workspace" | "organization"; accountMatchesClient: true }
  | { ok: false; code: BusinessReviewDiscoveryFailure; message: string; diagnostics?: Record<string, unknown> };

interface ChromeTab { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }
interface ChromeTabsApi {
  get(tabId: number): Promise<ChromeTab>;
  query(query: { active: boolean; windowId: number }): Promise<ChromeTab[]>;
  update(tabId: number, properties: { url: string }): Promise<ChromeTab>;
  onUpdated: { addListener(listener: (tabId: number, change: { status?: string }, tab: ChromeTab) => void): void; removeListener(listener: (tabId: number, change: { status?: string }, tab: ChromeTab) => void): void };
}
interface DiscoveryDocument {
  url: string;
  accountLabel: string | null;
  providerAccountId: string | null;
  providerIdentityKind: "account" | "workspace" | "organization" | null;
  accountMatchesClient: boolean;
  isBusinessReview: boolean;
  evidence: { businessReviewHeading: boolean; growthOverview: boolean; campaignPerformance: boolean; flowPerformance: boolean };
  businessReviewLinks: Array<{ text: string; href: string }>;
  dashboardNavigationLinks: Array<{ text: string; href: string }>;
  visibleHeadings: string[];
  visibleHeadingCount: number;
  visibleLinkCount: number;
  viewDashboardControlCount: number;
  businessReviewCandidateCount: number;
  visibleControls: Array<{ text: string; tag: string; role: string | null; ariaSelected: string | null; ariaPressed: string | null }>;
  accountLabelCandidates: string[];
  accountContextSource: "header_match" | "account_control" | "not_found";
}
interface ChromeScriptingApi {
  executeScript<Result>(details: { target: { tabId: number; frameIds: [number] }; func: (...args: string[]) => Result; args: string[] }): Promise<Array<{ frameId?: number; result?: Result }>>;
}
interface ChromeApi { tabs?: ChromeTabsApi; scripting?: ChromeScriptingApi }

export interface BusinessReviewDiscoveryRequest {
  clientName: string; configuredUrl?: string | null; configuredAccountLabel?: string | null; configuredProviderAccountId?: string | null; useCurrentPage?: boolean;
  /** Preflight for a client whose Business Review target is already saved: prove the bound account on any supported capture page; never navigate. */
  verifySavedAccountOnly?: boolean;
}

/** Discovers only rendered Klaviyo links and accepts a destination only after semantic and account verification. */
export class ChromeBusinessReviewDiscovery {
  private diagnostics: Record<string, unknown> = {};
  constructor(
    private readonly chromeApi: ChromeApi | undefined = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome,
    private readonly timeoutMs = 10_000,
    private readonly grantStore: KlaviyoActiveTabGrantStore = new ChromeSessionKlaviyoActiveTabGrantStore(),
  ) {}

  async discover(input: BusinessReviewDiscoveryRequest): Promise<BusinessReviewDiscoveryResult> {
    this.diagnostics = { discoveryStage: "TAB_RESOLUTION", activeTabFound: false, tabId: null, tabHostname: null, urlEligible: false, permissionResult: "not_checked", scriptInjectionResult: "not_attempted", inspectionResultReturned: false };
    const tabs = this.chromeApi?.tabs;
    const scripting = this.chromeApi?.scripting;
    if (!tabs || !scripting) return fail("SCRIPT_INJECTION_FAILED", "Business Review discovery is unavailable in this extension context.", {
      ...this.diagnostics, discoveryStage: "EXTENSION_API_RESOLUTION", tabsApiAvailable: Boolean(tabs), scriptingApiAvailable: Boolean(scripting),
      typedErrorCode: "SCRIPT_INJECTION_FAILED", safeErrorMessage: "Required Chrome extension APIs are unavailable.",
    });
    try {
      const grant = await withTimeout(() => verifyKlaviyoActiveTabGrant(tabs, this.grantStore), "checking the authorized Klaviyo tab", this.timeoutMs);
      if (!grant.ok) return fail(grant.code, "Open the intended client’s Klaviyo account and click the Tention Reports extension before discovery.", { ...this.diagnostics, activeTabResult: grant.code, permissionResult: "toolbar active-tab authorization not verified" });
      this.diagnostics = { ...this.diagnostics, activeTabFound: true, tabId: grant.grant.grantedTabId, tabHostname: safeHostname(grant.tab.url), urlEligible: isAllowedKlaviyoUrl(grant.tab.url), activeTabResult: "authorized tab verified", permissionResult: "executeScript will verify page access" };
      const initialTab = await this.waitForReady(tabs, grant.grant.grantedTabId);
      if (!(input.verifySavedAccountOnly ? isKlaviyoSupportedCaptureUrl(initialTab.url ?? null) : isAllowedKlaviyoUrl(initialTab.url))) return fail("GRANTED_TAB_ROUTE_NOT_SUPPORTED", "The authorized tab is not on a supported Klaviyo reporting page.", { ...this.diagnostics, discoveryStage: "URL_ELIGIBILITY", observedUrl: safeUrl(initialTab.url ?? "") });
      this.diagnostics = { ...this.diagnostics, discoveryStage: "CURRENT_PAGE_INSPECTION", observedUrl: safeUrl(initialTab.url ?? "") };
      const initial = await this.inspectUntil(tabs, scripting, grant.grant.grantedTabId, input.clientName, (page) => page.accountLabel !== null);
      if (!initial) {
        const code = this.diagnostics.typedErrorCode === "INSPECTOR_RESULT_EMPTY" ? "INSPECTOR_RESULT_EMPTY" : this.diagnostics.typedErrorCode === "PAGE_READY_TIMEOUT" ? "PAGE_READY_TIMEOUT" : "SCRIPT_INJECTION_FAILED";
        return fail(code, code === "PAGE_READY_TIMEOUT" ? "The Klaviyo reporting page did not finish loading before inspection." : "Could not inspect the visible Klaviyo page.", { ...this.diagnostics, discoveryStage: "CURRENT_PAGE_INSPECTION" });
      }
      if (!initial.accountLabel) return fail("ACCOUNT_CONTEXT_NOT_VERIFIED", "The visible Klaviyo account label could not be identified. No dashboard URL was saved.", { ...this.diagnostics, ...summary(initial), selectedClientName: input.clientName, discoveryStage: "ACCOUNT_CONTEXT_VERIFICATION", typedErrorCode: "ACCOUNT_CONTEXT_NOT_VERIFIED", safeErrorMessage: "No account identity was found in the page header or an account-labeled control." });
      const storedAccount = input.configuredAccountLabel?.trim();
      const storedProviderId = input.configuredProviderAccountId?.trim();
      if (storedProviderId && initial.providerAccountId !== storedProviderId) return fail("ACCOUNT_CONTEXT_MISMATCH", "The authenticated Klaviyo account differs from this client’s saved account binding. No dashboard URL was saved.", { ...this.diagnostics, ...summary(initial), selectedClientName: input.clientName, configuredProviderAccountId: storedProviderId, observedProviderAccountId: initial.providerAccountId, comparisonResult: initial.providerAccountId ? "stable_provider_id_mismatch" : "stable_provider_id_unavailable", discoveryStage: "ACCOUNT_BINDING_VERIFICATION", typedErrorCode: "ACCOUNT_CONTEXT_MISMATCH", safeErrorMessage: "The existing stable Klaviyo account binding was not present on the authorized tab." });
      if (storedAccount && !storedProviderId && !sameAccountLabel(storedAccount, initial.accountLabel)) return fail("ACCOUNT_CONTEXT_MISMATCH", "The authenticated Klaviyo account differs from this client’s saved account binding. No dashboard URL was saved.", { ...this.diagnostics, ...summary(initial), selectedClientName: input.clientName, configuredAccountLabel: safeLabel(storedAccount), observedAccountLabel: safeLabel(initial.accountLabel), comparisonResult: "stored_binding_mismatch", discoveryStage: "ACCOUNT_BINDING_VERIFICATION", typedErrorCode: "ACCOUNT_CONTEXT_MISMATCH", safeErrorMessage: "The existing client-to-Klaviyo account binding is immutable and did not match the authorized tab." });
      // On first-time onboarding, an explicitly authorized Klaviyo tab with a
      // stable provider account/workspace ID is stronger than a display-name
      // difference (agency/workspace labels often differ from client branding).
      // The verified URL + this ID are persisted together; subsequent runs
      // require an exact ID match and never silently rebind.
      if (!initial.accountMatchesClient && !initial.providerAccountId && !storedProviderId && !storedAccount) return fail("ACCOUNT_CONTEXT_MISMATCH", "The authenticated Klaviyo account does not match the selected client. No dashboard URL was saved.", { ...this.diagnostics, ...summary(initial), selectedClientName: input.clientName, comparisonResult: "unbound_display_name_mismatch_without_stable_id", discoveryStage: "ACCOUNT_CONTEXT_VERIFICATION", typedErrorCode: "ACCOUNT_CONTEXT_MISMATCH", safeErrorMessage: "This client has no saved provider identity, and the authorized account label does not safely match the client name." });
      if (input.verifySavedAccountOnly) {
        const configured = input.configuredUrl?.trim();
        if (!configured || !isKlaviyoBusinessReviewDashboardUrl(configured) || (!storedAccount && !storedProviderId)) return fail("BUSINESS_REVIEW_NOT_DISCOVERED", "No verified Business Review source is saved for this client.", { ...this.diagnostics, ...summary(initial), discoveryStage: "SAVED_TARGET_VERIFICATION", typedErrorCode: "BUSINESS_REVIEW_NOT_DISCOVERED", safeErrorMessage: "A saved Business Review URL and account binding are both required." });
        // The binding checks above already required the stored provider ID, or the stored account label, to match this tab.
        const providerAccountId = storedProviderId || initial.providerAccountId || undefined;
        return { ok: true, verification: "saved_target_account", dashboardUrl: configured, accountLabel: initial.accountLabel, ...(providerAccountId ? { providerAccountId, providerIdentityKind: initial.providerIdentityKind ?? "account" } : {}), accountMatchesClient: true };
      }
      const currentPageVerified = this.verified(initial, input.clientName, initial.accountLabel, storedProviderId || initial.providerAccountId || undefined);
      if (!input.useCurrentPage && currentPageVerified?.ok === true && (!input.configuredUrl || normalizeUrl(input.configuredUrl) === normalizeUrl(currentPageVerified.dashboardUrl))) return currentPageVerified;

      if (input.useCurrentPage) {
        return this.verified(initial, input.clientName, initial.accountLabel, storedProviderId || initial.providerAccountId || undefined)
          ?? fail("BUSINESS_REVIEW_PAGE_NOT_VERIFIED", "Business Review could not be verified on this page. Open the existing Business Review reporting page, then choose Use Current Page.", summary(initial));
      }

      const configured = input.configuredUrl?.trim();
      if (configured && isKlaviyoBusinessReviewDashboardUrl(configured) && (storedProviderId || !storedAccount || sameAccountLabel(storedAccount, initial.accountLabel))) {
        const observed = await this.inspectAt(tabs, scripting, grant.grant.grantedTabId, configured, input.clientName);
        const verified = observed && this.verified(observed, input.clientName, initial.accountLabel, storedProviderId || initial.providerAccountId || undefined);
        if (verified) return verified;
      }

      const discovered = await this.findCandidates(tabs, scripting, grant.grant.grantedTabId, initial, input.clientName);
      if (discovered) return discovered;
      return fail("BUSINESS_REVIEW_NOT_DISCOVERED", "Business Review could not be discovered automatically. Open the existing Business Review in Klaviyo and click Use Current Page.", { ...summary(initial), ...this.diagnostics, discoveryStage: "BUSINESS_REVIEW_DISCOVERY" });
    } catch (error) {
      if (isChromeOperationTimeout(error)) return fail("PAGE_READY_TIMEOUT", error.message, { ...this.diagnostics, discoveryStage: "PAGE_READY" });
      return fail("SCRIPT_INJECTION_FAILED", "Business Review discovery failed safely.", { ...this.diagnostics, safeErrorName: safeErrorName(error), safeErrorMessage: safeChromeError(error) });
    }
  }

  private async findCandidates(tabs: ChromeTabsApi, scripting: ChromeScriptingApi, tabId: number, current: DiscoveryDocument, clientName: string, allowVisibleAction = true): Promise<BusinessReviewDiscoveryResult | null> {
    for (const candidate of current.businessReviewLinks.map(({ href }) => href)) {
      const result = await this.verifyCandidate(tabs, scripting, tabId, candidate, clientName, current.accountLabel!, current.providerAccountId ?? undefined);
      if (result) return result;
    }
    if (allowVisibleAction && current.viewDashboardControlCount === 1) {
      const dashboardPage = await this.openVisibleDashboard(tabs, scripting, tabId, current, clientName);
      if (dashboardPage) {
        const verified = this.verified(dashboardPage, clientName, current.accountLabel!, current.providerAccountId ?? undefined);
        if (verified) return verified;
        const discoveredFromDashboard = await this.findCandidates(tabs, scripting, tabId, dashboardPage, clientName, false);
        if (discoveredFromDashboard) return discoveredFromDashboard;
      }
    }
    const visited = new Set<string>();
    for (const link of current.dashboardNavigationLinks) {
      const listingUrl = safeCandidate(link.href);
      if (!listingUrl || visited.has(listingUrl) || isKlaviyoBusinessReviewDashboardUrl(listingUrl)) continue;
      visited.add(listingUrl);
      const listing = await this.inspectAt(tabs, scripting, tabId, listingUrl, clientName);
      if (!listing || (current.providerAccountId ? listing.providerAccountId !== current.providerAccountId : !listing.accountMatchesClient || !sameAccountLabel(listing.accountLabel ?? "", current.accountLabel!))) continue;
      for (const candidate of listing.businessReviewLinks.map(({ href }) => href)) {
        const result = await this.verifyCandidate(tabs, scripting, tabId, candidate, clientName, current.accountLabel!, current.providerAccountId ?? undefined);
        if (result) return result;
      }
    }
    return null;
  }

  /** Activates only Klaviyo's visible, read-only `View dashboard` control; never constructs a destination URL. */
  private async openVisibleDashboard(tabs: ChromeTabsApi, scripting: ChromeScriptingApi, tabId: number, current: DiscoveryDocument, clientName: string): Promise<DiscoveryDocument | null> {
    if ((!current.accountMatchesClient && !current.providerAccountId) || current.viewDashboardControlCount !== 1) return null;
    this.diagnostics = { ...this.diagnostics, discoveryStage: "VIEW_DASHBOARD_ACTION", viewDashboardCandidateCount: current.viewDashboardControlCount };
    const results = await withTimeout(() => scripting.executeScript<boolean>({
      target: { tabId, frameIds: [0] }, func: clickVisibleViewDashboardControl, args: [""],
    }), "opening the visible Klaviyo dashboard control", this.timeoutMs);
    const clicked = (results.find((item) => item.frameId === 0) ?? results[0])?.result === true;
    this.diagnostics = { ...this.diagnostics, viewDashboardClickAttempted: clicked, viewDashboardClickResult: clicked ? "clicked" : "not_found_or_ambiguous" };
    if (!clicked) return null;
    const page = await this.inspectUntil(tabs, scripting, tabId, clientName, (observed) => observed.accountLabel !== null && (
      observed.isBusinessReview || observed.businessReviewLinks.length > 0 || observed.dashboardNavigationLinks.length > 0
    ));
    if (!page || !isAllowedKlaviyoUrl(page.url)) return null;
    return page;
  }

  private async verifyCandidate(tabs: ChromeTabsApi, scripting: ChromeScriptingApi, tabId: number, rawUrl: string, clientName: string, expectedAccount: string, expectedProviderAccountId?: string): Promise<BusinessReviewDiscoveryResult | null> {
    const candidate = safeCandidate(rawUrl);
    if (!candidate || !isKlaviyoBusinessReviewDashboardUrl(candidate)) return null;
    const page = await this.inspectAt(tabs, scripting, tabId, candidate, clientName);
    return page ? this.verified(page, clientName, expectedAccount, expectedProviderAccountId) : null;
  }

  private verified(page: DiscoveryDocument, clientName: string, expectedAccount: string, expectedProviderAccountId?: string): BusinessReviewDiscoveryResult | null {
    const accountMatches = expectedProviderAccountId
      ? page.providerAccountId === expectedProviderAccountId
      : sameAccountLabel(page.accountLabel ?? "", expectedAccount) && accountLabelMatchesClient(expectedAccount, clientName);
    // A stable ID can verify a legacy/non-client-facing workspace label. With
    // no stable ID, both current-vs-expected and expected-vs-client labels
    // must match after conservative normalization.
    if (!page.isBusinessReview || !page.accountLabel || !accountMatches || (!expectedProviderAccountId && !page.accountMatchesClient)) return null;
    const url = safeCandidate(page.url);
    if (!url || !isKlaviyoBusinessReviewDashboardUrl(url)) return null;
    return { ok: true, dashboardUrl: url, accountLabel: page.accountLabel, ...(page.providerAccountId ? { providerAccountId: page.providerAccountId, providerIdentityKind: page.providerIdentityKind ?? "account" } : {}), accountMatchesClient: true, evidence: { businessReviewHeading: true, growthOverview: true, campaignPerformance: true, flowPerformance: true } };
  }

  private async inspectAt(tabs: ChromeTabsApi, scripting: ChromeScriptingApi, tabId: number, url: string, clientName: string): Promise<DiscoveryDocument | null> {
    const current = await this.waitForReady(tabs, tabId);
    if (normalizeUrl(current.url) !== normalizeUrl(url)) await withTimeout(() => tabs.update(tabId, { url }), "opening a discovered Klaviyo reporting link", this.timeoutMs);
    const tab = await this.waitForReady(tabs, tabId);
    if (normalizeUrl(tab.url) !== normalizeUrl(url)) return null;
    const isDashboardDetail = isKlaviyoBusinessReviewDashboardUrl(url);
    return this.inspectUntil(tabs, scripting, tabId, clientName, (page) => isDashboardDetail
      ? page.isBusinessReview
      : page.accountLabel !== null && (page.businessReviewLinks.length > 0 || page.dashboardNavigationLinks.length > 0));
  }

  /** SPA route completion is not page readiness; wait on rendered semantic evidence, bounded and condition-based. */
  private async inspectUntil(tabs: ChromeTabsApi, scripting: ChromeScriptingApi, tabId: number, clientName: string, ready: (page: DiscoveryDocument) => boolean): Promise<DiscoveryDocument | null> {
    const deadline = Date.now() + Math.min(this.timeoutMs, 4_000);
    let latest: DiscoveryDocument | null = null;
    let inspectionAttempts = 0;
    do {
      const tab = await tabs.get(tabId);
      this.diagnostics = { ...this.diagnostics, observedPageLoadingState: tab.status ?? "unknown", inspectionAttempts: ++inspectionAttempts };
      if (tab.status === "complete") {
        const observed = await this.inspect(scripting, tabId, clientName);
        if (observed) {
          latest = observed;
          if (ready(observed)) return observed;
        }
      }
      if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 125));
    } while (Date.now() < deadline);
    if (!latest && !this.diagnostics.typedErrorCode) this.diagnostics = { ...this.diagnostics, typedErrorCode: "PAGE_READY_TIMEOUT", safeErrorMessage: "The Klaviyo tab did not reach a complete document state before the bounded inspection deadline." };
    return latest;
  }

  private async inspect(scripting: ChromeScriptingApi, tabId: number, clientName: string): Promise<DiscoveryDocument | null> {
    try {
      const results = await withTimeout(() => scripting.executeScript<DiscoveryDocument>({ target: { tabId, frameIds: [0] }, func: inspectBusinessReviewDiscoveryDocument, args: [clientName] }), "reading visible Klaviyo report evidence", this.timeoutMs);
      this.diagnostics = { ...this.diagnostics, scriptInjectionResult: "resolved", permissionResult: "page injection permitted", inspectionResultReturned: results.length > 0, inspectionResultCount: results.length };
      const result = results.find((item) => item.frameId === 0) ?? results[0];
      if (!result?.result || !isDiscoveryDocument(result.result)) {
        this.diagnostics = { ...this.diagnostics, typedErrorCode: "INSPECTOR_RESULT_EMPTY", safeErrorMessage: "The injected read-only inspector returned no usable page evidence." };
        return null;
      }
      this.diagnostics = { ...this.diagnostics, visibleHeadingsCount: result.result.visibleHeadingCount, visibleLinksCount: result.result.visibleLinkCount, viewDashboardCandidateCount: result.result.viewDashboardControlCount, businessReviewCandidateCount: result.result.businessReviewCandidateCount };
      return result.result;
    } catch (error) {
      this.diagnostics = { ...this.diagnostics, scriptInjectionResult: "rejected", inspectionResultReturned: false, typedErrorCode: "SCRIPT_INJECTION_FAILED", safeErrorName: safeErrorName(error), safeErrorMessage: safeChromeError(error) };
      throw error;
    }
  }

  private async waitForReady(tabs: ChromeTabsApi, tabId: number): Promise<ChromeTab> {
    const current = await tabs.get(tabId);
    if (current.status === "complete") return current;
    let remove = () => {};
    const ready = new Promise<ChromeTab>((resolve, reject) => {
      const listener = (id: number, change: { status?: string }, tab: ChromeTab) => { if (id === tabId && (change.status === "complete" || tab.status === "complete")) { remove(); resolve(tab); } };
      remove = () => tabs.onUpdated.removeListener(listener);
      tabs.onUpdated.addListener(listener);
      void tabs.get(tabId).then((tab) => { if (tab.status === "complete") { remove(); resolve(tab); } }).catch(reject);
    });
    try { return await withTimeout(() => ready, "waiting for the Klaviyo route", this.timeoutMs); }
    finally { remove(); }
  }
}

/** Serialized into the authorized tab. Only reads visible text, headings and links. */
export function inspectBusinessReviewDiscoveryDocument(clientName: string): DiscoveryDocument {
  // This function is serialized by chrome.scripting.executeScript. Keep every
  // dependency inside its body; module closures do not cross into the page.
  const normalizeLabel = (value: string) => value.toLocaleLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]/g, "");
  const normalizeClient = (value: string) => {
    const trimmed = value.trim(); let normalized = normalizeLabel(trimmed);
    if (/\.com\s*$/i.test(trimmed)) normalized = normalized.slice(0, -3);
    return normalized.replace(/(?:limitedliabilitycompany|incorporated|corporation|company|llc|inc|corp|ltd|limited)$/i, "");
  };
  const identityText = (value: string) => value.replace(/^(?:account|workspace|organization)(?:\s+name)?\s*[:\-]\s*/i, "").replace(/\s+(?:account|workspace|organization)$/i, "").trim();
  const isGenericAccountControl = (value: string) => /^(?:(?:open|switch|select|manage|your|my)\s+)?(?:klaviyo\s+)?(?:account|workspace|organization)(?:\s+(?:menu|switcher|settings|selector))?$/i.test(value.trim());
  const matchesClient = (accountLabel: string) => normalizeClient(identityText(accountLabel)) === normalizeClient(clientName)
    || (/^[A-Z]{2,3}\s+(?=[A-Za-z])/.test(identityText(accountLabel)) && normalizeClient(identityText(accountLabel).replace(/^[A-Z]{2,3}\s+/, "")) === normalizeClient(clientName));
  const visible = (element: Element) => {
    const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    return !element.closest("[hidden],[aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,[role=heading]")).filter(visible).map(textOf).filter(Boolean).slice(0, 80);
  // Never treat Analytics/Dashboards navigation labels as an account name.
  // Prefer an exact selected-client match in Klaviyo's page header; only use a
  // non-matching label when it comes from an explicitly account/workspace
  // control, so a real mismatch remains fail-closed and diagnosable.
  const headerElements = Array.from(document.querySelectorAll("header *,[role=banner] *")).filter(visible);
  const candidatesFrom = (elements: Element[]) => elements.flatMap((element) => [element.getAttribute("aria-label"), element.getAttribute("title"), textOf(element)]
    .filter((label): label is string => Boolean(label && label.length <= 120)).map((label) => ({ label, element })));
  const headerCandidates = candidatesFrom(headerElements).filter(({ label }, index, all) => all.findIndex((entry) => entry.label === label) === index).slice(0, 30);
  const accountSelectors = "[aria-label*=account i],[title*=account i],[data-testid*=account i],[aria-label*=workspace i],[title*=workspace i],[data-testid*=workspace i],[aria-label*=organization i],[title*=organization i],[data-testid*=organization i]";
  const explicitAccountElements = Array.from(document.querySelectorAll(accountSelectors)).filter(visible);
  const explicitAccountCandidates = candidatesFrom(explicitAccountElements).filter(({ label }, index, all) => all.findIndex((entry) => entry.label === label) === index).slice(0, 20);
  const accountIdentityCandidates = explicitAccountCandidates.filter(({ label }) => !isGenericAccountControl(label));
  const identityCandidate = headerCandidates.find(({ label }) => matchesClient(label))
    ?? accountIdentityCandidates.find(({ label }) => matchesClient(label))
    ?? accountIdentityCandidates.find(({ label }) => normalizeLabel(identityText(label)).length >= 3)
    ?? null;
  const accountLabel = identityCandidate?.label ?? null;
  const accountLabelCandidates = [...headerCandidates, ...explicitAccountCandidates].map(({ label }) => label).filter((label, index, all) => all.indexOf(label) === index).slice(0, 30);
  let providerAccountId: string | null = null;
  let providerIdentityKind: "account" | "workspace" | "organization" | null = null;
  if (identityCandidate) {
    let node: Element | null = identityCandidate.element;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const identityAttributes = [["data-account-id", "account"], ["data-workspace-id", "workspace"], ["data-organization-id", "organization"]] as const;
      const found = identityAttributes.find(([attribute]) => node?.hasAttribute(attribute));
      const value = found && node.getAttribute(found[0]);
      if (value && /^[A-Za-z0-9_-]{3,128}$/.test(value)) { providerAccountId = value; providerIdentityKind = found![1]; break; }
    }
  }
  const headerIdentityMatched = Boolean(identityCandidate && headerCandidates.some((candidate) => candidate.element === identityCandidate.element && candidate.label === identityCandidate.label));
  const accountContextSource = headerIdentityMatched ? "header_match" : accountLabel ? "account_control" : "not_found";
  const breadcrumbEvidence = Array.from(document.querySelectorAll("[aria-label*=breadcrumb i],nav,[role=navigation]")).filter(visible)
    .some((element) => /\bbusiness\s*review\b/i.test(textOf(element)));
  const evidence = {
    businessReviewHeading: headings.some((heading) => normalizeLabel(heading) === "businessreview") || breadcrumbEvidence,
    growthOverview: headings.some((heading) => normalizeLabel(heading) === "growthoverview"),
    campaignPerformance: headings.some((heading) => ["campaignperformancesummary", "campaignperformance"].includes(normalizeLabel(heading))),
    flowPerformance: headings.some((heading) => ["flowperformancesummary", "flowperformance"].includes(normalizeLabel(heading))),
  };
  const links = Array.from(document.querySelectorAll("a[href]")).filter(visible).map((element) => ({ text: textOf(element), href: (element as HTMLAnchorElement).href }));
  const safeLinks = links.filter(({ href }) => { try { return new URL(href).origin === "https://www.klaviyo.com"; } catch { return false; } });
  const visibleControls = Array.from(document.querySelectorAll("button,[role=button],[role=tab],a[href]"))
    .filter(visible)
    .map((element) => ({ text: textOf(element), tag: element.tagName.toLowerCase(), role: element.getAttribute("role"), ariaSelected: element.getAttribute("aria-selected"), ariaPressed: element.getAttribute("aria-pressed") }))
    .filter(({ text }) => /business\s*review|view\s+dashboard|dashboards?/i.test(text))
    .slice(0, 30);
  const viewDashboardControlCount = Array.from(document.querySelectorAll("button,[role=button]"))
    .filter(visible).filter((element) => /^view\s+dashboard$/i.test(textOf(element))).length;
  const businessReviewCandidateCount = safeLinks.filter(({ text }) => /business\s*review/i.test(text)).length;
  const url = location.origin + location.pathname + location.search;
  const routeAllowed = location.origin === "https://www.klaviyo.com" && /^\/analytics\/dashboards\/[^/]+\/?$/.test(location.pathname);
  return {
    url, accountLabel, providerAccountId, providerIdentityKind, accountMatchesClient: Boolean(accountLabel && matchesClient(accountLabel)), accountLabelCandidates, accountContextSource,
    isBusinessReview: routeAllowed && evidence.businessReviewHeading && evidence.growthOverview && evidence.campaignPerformance && evidence.flowPerformance,
    evidence,
    businessReviewLinks: safeLinks.filter(({ text, href }) => /business\s*review/i.test(text) && /^\/analytics\/dashboards\/[^/]+\/?$/.test(new URL(href).pathname)).slice(0, 20),
    dashboardNavigationLinks: safeLinks.filter(({ text, href }) => /\bdashboards?\b/i.test(text) && /^\/analytics\/dashboards(?:\/[^/]+)?\/?$/.test(new URL(href).pathname)).slice(0, 20),
    visibleHeadings: headings,
    visibleHeadingCount: headings.length,
    visibleLinkCount: safeLinks.length,
    viewDashboardControlCount,
    businessReviewCandidateCount,
    visibleControls,
  };
}

/** Self-contained because Chrome serializes injected functions into the target page. */
export function clickVisibleViewDashboardControl(_unused?: string): boolean {
  const visible = (element: Element) => {
    const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
    return !element.closest("[hidden],[aria-hidden=true]") && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  };
  const textOf = (element: Element) => ((element as HTMLElement).innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  const controls = Array.from(document.querySelectorAll("button,[role=button]")).filter(visible).filter((element) => /^view\s+dashboard$/i.test(textOf(element)));
  if (controls.length !== 1) return false;
  (controls[0] as HTMLElement).click();
  return true;
}

function normalizeLabel(value: string): string { return value.toLocaleLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z0-9]/g, ""); }
/** Klaviyo may omit a client's display-only .com suffix in its account switcher. */
function normalizeClientName(value: string): string {
  const trimmed = value.trim(); let normalized = normalizeLabel(trimmed);
  if (/\.com\s*$/i.test(trimmed)) normalized = normalized.slice(0, -3);
  return normalized.replace(/(?:limitedliabilitycompany|incorporated|corporation|company|llc|inc|corp|ltd|limited)$/i, "");
}
function accountLabelMatchesClient(accountLabel: string, clientName: string): boolean {
  return normalizeClientName(accountLabel) === normalizeClientName(clientName)
    || (/^[A-Z]{2,3}\s+(?=[A-Za-z])/.test(accountLabel) && normalizeClientName(accountLabel.replace(/^[A-Z]{2,3}\s+/, "")) === normalizeClientName(clientName));
}
function sameAccountLabel(left: string, right: string): boolean {
  return normalizeClientName(left) === normalizeClientName(right)
    || accountLabelMatchesClient(left, right) || accountLabelMatchesClient(right, left);
}
function safeHostname(value: string | undefined): string | null { try { return new URL(value ?? "").hostname; } catch { return null; } }
function safeErrorName(error: unknown): string { return error instanceof Error && /^(?:Error|[A-Za-z]+Error)$/.test(error.name) ? error.name : "UnknownError"; }
function safeChromeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/permission|cannot access contents|host permission/i.test(message)) return "Chrome denied page access for this tab.";
  if (/normalizeClientName is not defined/i.test(message)) return "Injected inspector referenced a module-only helper.";
  if (/cannot be scripted|cannot access a chrome/i.test(message)) return "Chrome does not allow script injection on this page.";
  if (isChromeOperationTimeout(error)) return "The page inspection exceeded its bounded wait.";
  return "The read-only page inspection did not complete.";
}
function safeCandidate(value: string): string | null { try { const url = new URL(value); if (url.origin !== "https://www.klaviyo.com" || url.username || url.password || url.search || url.hash) return null; return url.origin + url.pathname; } catch { return null; } }
function normalizeUrl(value: string | undefined): string | null { return value ? safeCandidate(value) : null; }
function safeUrl(value: string): string { try { const url = new URL(value); return url.origin + url.pathname; } catch { return "unavailable"; } }
function safeLabel(value: string): string { return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120); }
function isAllowedKlaviyoUrl(value: string | undefined): boolean { try { const url = new URL(value ?? ""); return url.origin === "https://www.klaviyo.com" && (/^\/dashboard\/?$/.test(url.pathname) || /^\/analytics\/dashboards(?:\/[^/]+)?\/?$/.test(url.pathname)); } catch { return false; } }
function summary(page: DiscoveryDocument): Record<string, unknown> { return { currentUrl: safeUrl(page.url), accountLabel: page.accountLabel, providerAccountId: page.providerAccountId, providerIdentityKind: page.providerIdentityKind, accountLabelCandidates: page.accountLabelCandidates, accountContextSource: page.accountContextSource, accountMatchesClient: page.accountMatchesClient, visibleHeadings: page.visibleHeadings, visibleHeadingCount: page.visibleHeadingCount, visibleLinkCount: page.visibleLinkCount, viewDashboardCandidateCount: page.viewDashboardControlCount, businessReviewCandidateCount: page.businessReviewCandidateCount, visibleControls: page.visibleControls, evidence: page.evidence, businessReviewLinkCount: page.businessReviewLinks.length, dashboardNavigationLinkCount: page.dashboardNavigationLinks.length }; }
function fail(code: BusinessReviewDiscoveryFailure, message: string, diagnostics?: Record<string, unknown>): BusinessReviewDiscoveryResult { return { ok: false, code, message, ...(diagnostics ? { diagnostics } : {}) }; }
function isDiscoveryDocument(value: unknown): value is DiscoveryDocument { return Boolean(value && typeof value === "object" && "url" in value && typeof value.url === "string" && "accountMatchesClient" in value && typeof value.accountMatchesClient === "boolean" && "providerAccountId" in value && (value.providerAccountId === null || typeof value.providerAccountId === "string") && "providerIdentityKind" in value && "accountLabelCandidates" in value && Array.isArray(value.accountLabelCandidates) && "accountContextSource" in value && "evidence" in value && "businessReviewLinks" in value && Array.isArray(value.businessReviewLinks) && "dashboardNavigationLinks" in value && Array.isArray(value.dashboardNavigationLinks) && "visibleHeadingCount" in value && typeof value.visibleHeadingCount === "number" && "viewDashboardControlCount" in value && typeof value.viewDashboardControlCount === "number"); }
