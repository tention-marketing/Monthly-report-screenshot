export const KLAVIYO_ACTIVE_TAB_GRANT_KEY = "tention.klaviyo-active-tab-grant";
export const KLAVIYO_ACTION_INVOCATION_KEY = "tention.klaviyo-action-invocation";
export const KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED_MESSAGE = "Open the Klaviyo Business Review tab and click the Tention Reports toolbar icon to start capture.";

export type ActiveTabGrantFailureCode =
  | "ACTION_NOT_INVOKED"
  | "GRANTED_TAB_CLOSED"
  | "GRANTED_TAB_NOT_ACTIVE"
  | "GRANTED_TAB_CHANGED_ORIGIN"
  | "GRANTED_TAB_ROUTE_NOT_SUPPORTED";

export function activeTabGrantFailureMessage(code: ActiveTabGrantFailureCode): string {
  const messages: Record<ActiveTabGrantFailureCode, string> = {
    ACTION_NOT_INVOKED: "Open the Klaviyo Business Review tab and click the Tention Reports toolbar icon to start capture.",
    GRANTED_TAB_CLOSED: "The Klaviyo tab used to open Tention Reports was closed. Open it and click the Tention Reports toolbar icon again.",
    GRANTED_TAB_NOT_ACTIVE: "The Klaviyo tab used to open Tention Reports is no longer active. Return to it and click the Tention Reports toolbar icon again.",
    GRANTED_TAB_CHANGED_ORIGIN: "The Klaviyo tab used to open Tention Reports navigated away. Return to Business Review and click the Tention Reports toolbar icon again.",
    GRANTED_TAB_ROUTE_NOT_SUPPORTED: "The toolbar-granted tab is not the Klaviyo Business Review dashboard. Open Business Review and click the Tention Reports toolbar icon again.",
  };
  return messages[code];
}

export interface KlaviyoActionInvocation {
  tabId: number | null;
  windowId: number | null;
  origin: string | null;
  pathname: string | null;
  invokedAt: number;
}

export interface KlaviyoActiveTabGrant {
  grantedTabId: number;
  grantedWindowId: number;
  grantedOrigin: string;
  grantedUrl: string;
  grantedAt: number;
}

export interface ChromeStorageSession {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface KlaviyoActiveTabGrantStore {
  get(): Promise<KlaviyoActiveTabGrant | null>;
  getActionInvocation(): Promise<KlaviyoActionInvocation | null>;
  set(grant: KlaviyoActiveTabGrant): Promise<void>;
  setActionInvocation(invocation: KlaviyoActionInvocation): Promise<void>;
  clearGrant(): Promise<void>;
  clear(): Promise<void>;
}

export class ChromeSessionKlaviyoActiveTabGrantStore implements KlaviyoActiveTabGrantStore {
  constructor(private readonly session: ChromeStorageSession | undefined = (globalThis as typeof globalThis & { chrome?: { storage?: { session?: ChromeStorageSession } } }).chrome?.storage?.session) {}

  async get(): Promise<KlaviyoActiveTabGrant | null> {
    if (!this.session) return null;
    return asKlaviyoActiveTabGrant((await this.session.get(KLAVIYO_ACTIVE_TAB_GRANT_KEY))[KLAVIYO_ACTIVE_TAB_GRANT_KEY]);
  }

  async getActionInvocation(): Promise<KlaviyoActionInvocation | null> {
    if (!this.session) return null;
    return asKlaviyoActionInvocation((await this.session.get(KLAVIYO_ACTION_INVOCATION_KEY))[KLAVIYO_ACTION_INVOCATION_KEY]);
  }

  async set(grant: KlaviyoActiveTabGrant): Promise<void> {
    if (!this.session) throw new Error("Chrome session storage is unavailable.");
    await this.session.set({ [KLAVIYO_ACTIVE_TAB_GRANT_KEY]: grant });
  }

  async setActionInvocation(invocation: KlaviyoActionInvocation): Promise<void> {
    if (!this.session) throw new Error("Chrome session storage is unavailable.");
    await this.session.set({ [KLAVIYO_ACTION_INVOCATION_KEY]: invocation });
  }

  async clear(): Promise<void> {
    if (!this.session) return;
    await this.clearGrant();
    await this.session.remove(KLAVIYO_ACTION_INVOCATION_KEY);
  }

  async clearGrant(): Promise<void> {
    if (this.session) await this.session.remove(KLAVIYO_ACTIVE_TAB_GRANT_KEY);
  }
}

export interface KlaviyoGrantTab {
  id?: number;
  windowId?: number;
  url?: string;
  active?: boolean;
}

export interface KlaviyoGrantTabsApi {
  get(tabId: number): Promise<KlaviyoGrantTab>;
  query(queryInfo: { active: boolean; windowId: number }): Promise<KlaviyoGrantTab[]>;
}

export type KlaviyoActiveTabGrantCheck =
  | { ok: true; grant: KlaviyoActiveTabGrant; invocation: KlaviyoActionInvocation; tab: KlaviyoGrantTab }
  | { ok: false; code: ActiveTabGrantFailureCode };

export interface ToolbarInvocationDiagnostics {
  actionInvocation: KlaviyoActionInvocation | null;
  grantedTabId: number | null;
  currentActiveTabId: number | null;
  routeMatched: boolean;
}

/** The toolbar click is the only source of authority for activeTab-gated capture. */
export async function verifyKlaviyoActiveTabGrant(tabs: KlaviyoGrantTabsApi, store: KlaviyoActiveTabGrantStore): Promise<KlaviyoActiveTabGrantCheck> {
  const [invocation, grant] = await Promise.all([store.getActionInvocation(), store.get()]);
  if (!invocation || !grant || invocation.tabId !== grant.grantedTabId || invocation.windowId !== grant.grantedWindowId || invocation.origin !== grant.grantedOrigin) {
    return { ok: false, code: "ACTION_NOT_INVOKED" };
  }
  try {
    const tab = await tabs.get(grant.grantedTabId);
    if (tab.id !== grant.grantedTabId) return invalidate(store, "GRANTED_TAB_CLOSED");
    if (tab.windowId !== grant.grantedWindowId || tab.active !== true) return invalidate(store, "GRANTED_TAB_NOT_ACTIVE");
    const active = (await tabs.query({ active: true, windowId: grant.grantedWindowId }))[0];
    if (active?.id !== grant.grantedTabId) return invalidate(store, "GRANTED_TAB_NOT_ACTIVE");
    if (originOf(tab.url) !== grant.grantedOrigin) return invalidate(store, "GRANTED_TAB_CHANGED_ORIGIN");
    if (!isKlaviyoBusinessReviewDashboardUrl(tab.url ?? null)) return invalidate(store, "GRANTED_TAB_ROUTE_NOT_SUPPORTED");
    return { ok: true, grant, invocation, tab };
  } catch {
    return invalidate(store, "GRANTED_TAB_CLOSED");
  }
}

export async function getToolbarInvocationDiagnostics(tabs: KlaviyoGrantTabsApi | undefined, store: KlaviyoActiveTabGrantStore): Promise<ToolbarInvocationDiagnostics> {
  const [actionInvocation, grant] = await Promise.all([store.getActionInvocation(), store.get()]);
  if (!grant || !tabs) return { actionInvocation, grantedTabId: grant?.grantedTabId ?? null, currentActiveTabId: null, routeMatched: false };
  try {
    const [tab, active] = await Promise.all([
      tabs.get(grant.grantedTabId),
      tabs.query({ active: true, windowId: grant.grantedWindowId }),
    ]);
    return {
      actionInvocation,
      grantedTabId: grant.grantedTabId,
      currentActiveTabId: active[0]?.id ?? null,
      routeMatched: originOf(tab.url) === grant.grantedOrigin && isKlaviyoBusinessReviewDashboardUrl(tab.url ?? null),
    };
  } catch {
    return { actionInvocation, grantedTabId: grant.grantedTabId, currentActiveTabId: null, routeMatched: false };
  }
}

export function isKlaviyoBusinessReviewDashboardUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.origin === "https://www.klaviyo.com" && /^\/analytics\/dashboards\/[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function makeKlaviyoActionInvocation(tab: KlaviyoGrantTab): KlaviyoActionInvocation {
  const parsed = parseUrl(tab.url);
  return {
    tabId: typeof tab.id === "number" ? tab.id : null,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null,
    origin: parsed?.origin ?? null,
    pathname: parsed?.pathname ?? null,
    invokedAt: Date.now(),
  };
}

export function makeKlaviyoActiveTabGrant(tab: KlaviyoActiveTabGrant): KlaviyoActiveTabGrant | null {
  return isKlaviyoBusinessReviewDashboardUrl(tab.grantedUrl) && originOf(tab.grantedUrl) === tab.grantedOrigin ? tab : null;
}

async function invalidate(store: KlaviyoActiveTabGrantStore, code: Exclude<ActiveTabGrantFailureCode, "ACTION_NOT_INVOKED">): Promise<KlaviyoActiveTabGrantCheck> {
  await store.clearGrant();
  return { ok: false, code };
}

function asKlaviyoActiveTabGrant(value: unknown): KlaviyoActiveTabGrant | null {
  if (typeof value !== "object" || value === null) return null;
  const grant = value as Partial<KlaviyoActiveTabGrant>;
  if (typeof grant.grantedTabId !== "number" || typeof grant.grantedWindowId !== "number" || typeof grant.grantedOrigin !== "string" || typeof grant.grantedUrl !== "string" || typeof grant.grantedAt !== "number") return null;
  return makeKlaviyoActiveTabGrant(grant as KlaviyoActiveTabGrant);
}

function asKlaviyoActionInvocation(value: unknown): KlaviyoActionInvocation | null {
  if (typeof value !== "object" || value === null) return null;
  const invocation = value as Partial<KlaviyoActionInvocation>;
  if ((typeof invocation.tabId !== "number" && invocation.tabId !== null) || (typeof invocation.windowId !== "number" && invocation.windowId !== null) || (typeof invocation.origin !== "string" && invocation.origin !== null) || (typeof invocation.pathname !== "string" && invocation.pathname !== null) || typeof invocation.invokedAt !== "number") return null;
  return invocation as KlaviyoActionInvocation;
}

function parseUrl(value: string | undefined): URL | null {
  try { return value ? new URL(value) : null; } catch { return null; }
}

function originOf(value: string | undefined): string | null {
  return parseUrl(value)?.origin ?? null;
}
