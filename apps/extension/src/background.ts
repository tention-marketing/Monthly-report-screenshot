import type { AutoCaptureStateStore } from "./features/automatic-capture/auto-capture-controller.js";
import { BusinessReviewAutoCaptureController } from "./features/automatic-capture/business-review-auto-capture-controller.js";
import { DashboardAutoCaptureController } from "./features/automatic-capture/dashboard-auto-capture-controller.js";
import { DeliverabilityScoreAutoCaptureController } from "./features/automatic-capture/deliverability-score-auto-capture-controller.js";
import { AUTO_CAPTURE_KEY_PREFIX, autoCaptureKey, type AutoCaptureMessage, type AutoCaptureState, type ExecutiveSummaryAutoCaptureRequest } from "./features/automatic-capture/auto-capture-service.js";
import { ChromeBusinessReviewCaptureNavigation } from "./features/klaviyo-navigation/business-review-navigation-service.js";
import { ChromeBusinessReviewDiscovery } from "./features/klaviyo-navigation/business-review-discovery.js";
import { isCanonicalDashboardScreenshotType } from "./features/klaviyo-navigation/dashboard-capture.js";
import { ChromeKlaviyoDashboardCaptureNavigation } from "./features/klaviyo-navigation/dashboard-navigation-service.js";
import { ChromeDeliverabilityScoreNavigation } from "./features/klaviyo-navigation/deliverability-score-navigation-service.js";
import { ChromeCampaignsSourceInspector } from "./features/klaviyo-navigation/campaigns-source-inspector.js";
import { CampaignsAutoCaptureController } from "./features/automatic-capture/campaigns-auto-capture-controller.js";
import { ChromeCampaignsCaptureNavigation } from "./features/klaviyo-navigation/campaigns-navigation-service.js";
import { isDeliverabilityScoreScreenshotType } from "./features/klaviyo-navigation/deliverability-score-capture.js";
import { SubscriberGrowthAutoCaptureController } from "./features/automatic-capture/subscriber-growth-auto-capture-controller.js";
import { ChromeSubscriberGrowthNavigation } from "./features/klaviyo-navigation/subscriber-growth-navigation-service.js";
import { isSubscriberGrowthScreenshotType } from "./features/klaviyo-navigation/subscriber-growth-capture.js";
import { SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY, SubscriberGrowthSourceSetup } from "./features/klaviyo-navigation/subscriber-growth-source-setup.js";
import { SourceSetupGate } from "./features/klaviyo-navigation/source-setup-gate.js";
import { ChromeCaptureService } from "./features/screenshot-capture/capture-service.js";
import { boundedDiagnostics, releaseObsoleteTransientState, sessionUsage } from "./lib/chrome/session-storage.js";
import {
  ChromeSessionKlaviyoActiveTabGrantStore,
  configuredCaptureRoutesSnapshot,
  isConfiguredCaptureRoute,
  isKlaviyoSupportedCaptureUrl,
  KLAVIYO_CONFIGURED_CAPTURE_ROUTES_KEY,
  registerConfiguredCaptureRoute,
  getToolbarInvocationDiagnostics,
  makeKlaviyoActionInvocation,
  type KlaviyoGrantTabsApi,
  type ChromeStorageSession,
} from "./features/klaviyo-navigation/active-tab-grant.js";

interface ChromeRuntimeApi {
  onMessage: { addListener(listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean | void): void };
  onInstalled?: { addListener(listener: () => void): void };
}
interface ChromeActionApi { onClicked: { addListener(listener: (tab: ChromeActionTab) => void): void } }
interface ChromeActionTab { id?: number; windowId?: number; url?: string }
interface ChromeSidePanelApi {
  open(options: { tabId: number }): Promise<void>;
  setPanelBehavior(options: { openPanelOnActionClick: boolean }): Promise<void>;
}
interface BackgroundChromeApi {
  runtime?: ChromeRuntimeApi;
  storage?: { session?: ChromeStorageSession };
  action?: ChromeActionApi;
  sidePanel?: ChromeSidePanelApi;
  tabs?: KlaviyoGrantTabsApi & {
    get(tabId: number): Promise<{ id?: number; windowId?: number; url?: string; active?: boolean; status?: string }>;
    update(tabId: number, properties: { url: string }): Promise<{ id?: number; windowId?: number; url?: string; active?: boolean; status?: string }>;
    onUpdated: {
      addListener(listener: (tabId: number, change: { status?: string }, tab: { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }) => void): void;
      removeListener(listener: (tabId: number, change: { status?: string }, tab: { id?: number; windowId?: number; url?: string; active?: boolean; status?: string }) => void): void;
    };
  };
}

/**
 * The one state store every capture controller writes through. A state can carry a full-viewport screenshot (often
 * 1–4 MB as a data URL), and chrome.storage.session has a 10 MB quota shared with the toolbar grant and source setup.
 * Live runs filled it (runs b4732590…07809233, and again 2026-10-29 when the toolbar click itself could no longer be
 * recorded). So images never go to session storage: the full state lives in service-worker memory, and session
 * storage holds only small metadata. If the worker restarted and an image is gone, the state reads as a typed,
 * retryable CAPTURE_STATE_LOST instead of a stale or missing screenshot. States from an older `attemptId` are ignored.
 */
export class ChromeSessionAutoCaptureStore implements AutoCaptureStateStore {
  private readonly currentAttempt = new Map<string, string>();
  private readonly memory = new Map<string, AutoCaptureState>();
  constructor(private readonly session: ChromeStorageSession, private readonly maxStatesInMemory = 24) {}

  async get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null> {
    const key = autoCaptureKey(request);
    const remembered = this.memory.get(key); if (remembered) return remembered;
    const stored = (await this.session.get(key).catch(() => ({} as Record<string, unknown>)))[key] as (AutoCaptureState & { imageInWorkerMemory?: boolean }) | undefined;
    if (!stored) return null;
    if (stored.imageInWorkerMemory) return { request: stored.request, stage: "failed", code: "CAPTURE_STATE_LOST", message: "The extension restarted after this screenshot was taken; it is captured again." } as AutoCaptureState;
    return stored;
  }

  async set(state: AutoCaptureState): Promise<void> {
    const key = autoCaptureKey(state.request); const attemptId = state.request.attemptId;
    if (state.stage === "preparing" && attemptId) this.currentAttempt.set(key, attemptId);
    const current = this.currentAttempt.get(key);
    if (current && attemptId && attemptId !== current) return;
    this.memory.delete(key); this.memory.set(key, state);
    // Bounded: the oldest states (long consumed or abandoned sections) are dropped from memory first.
    while (this.memory.size > this.maxStatesInMemory) this.memory.delete(this.memory.keys().next().value!);
    // Non-critical mirror: the in-memory state is authoritative, so a refused metadata write only loses restart recovery.
    await this.session.set({ [key]: withoutImages(state) }).catch(() => undefined);
  }

  async clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void> {
    const key = autoCaptureKey(request);
    this.memory.delete(key); this.currentAttempt.delete(key);
    await this.session.remove(key).catch(() => undefined);
  }

  async clearAll(): Promise<void> {
    this.memory.clear(); this.currentAttempt.clear();
    for (const key of Object.keys(await this.session.get(null).catch(() => ({})))) if (key.startsWith(AUTO_CAPTURE_KEY_PREFIX)) await this.session.remove(key).catch(() => undefined);
  }
}

/** Session metadata for a capture state: every screenshot data URL removed, and marked as held in worker memory. */
export function withoutImages(state: AutoCaptureState): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...state };
  let hadImage = false;
  if ("captured" in state && state.captured) { copy.captured = { ...state.captured, dataUrl: "" }; hadImage = true; }
  if ("viewportScreenshot" in state && state.viewportScreenshot) { copy.viewportScreenshot = { ...state.viewportScreenshot, dataUrl: "" }; hadImage = true; }
  if ("diagnostics" in state && state.diagnostics) copy.diagnostics = boundedDiagnostics(state.diagnostics);
  return hadImage ? { ...copy, imageInWorkerMemory: true } : copy;
}

function isAutoCaptureMessage(value: unknown): value is AutoCaptureMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export function registerBackgroundAutomation(chromeApi: BackgroundChromeApi): void {
  const session = chromeApi.storage?.session;
  const grantStore = new ChromeSessionKlaviyoActiveTabGrantStore(session);
  // Verified configured reporting routes (Subscriber Growth) survive a service-worker restart within the browser session.
  const routesLoaded: Promise<void> = (session?.get(KLAVIYO_CONFIGURED_CAPTURE_ROUTES_KEY) ?? Promise.resolve({} as Record<string, unknown>))
    .then((stored) => { const routes = stored[KLAVIYO_CONFIGURED_CAPTURE_ROUTES_KEY]; if (Array.isArray(routes)) for (const route of routes) if (typeof route === "string") registerConfiguredCaptureRoute(route); })
    .catch(() => undefined);
  const persistRoutes = () => { void session?.set({ [KLAVIYO_CONFIGURED_CAPTURE_ROUTES_KEY]: configuredCaptureRoutesSnapshot() }).catch(() => undefined); };
  // One-time source setup and automatic navigation never overlap: capture starts wait while a source is validated or saved.
  const sourceSetupGate = new SourceSetupGate();
  const sourceSetup = new SubscriberGrowthSourceSetup(chromeApi as never, grantStore, session, sourceSetupGate, persistRoutes);
  // This is registered immediately at service-worker startup. `activeTab` is
  // granted by this explicit action click, not by implicit side-panel behavior.
  chromeApi.action?.onClicked.addListener((tab) => {
    void openGrantedSidePanel(chromeApi, grantStore, tab, routesLoaded).then(async () => {
      // A Klaviyo page without a fixed reporting route (or a saved Subscriber growth route) is verified right now, on
      // this exact clicked tab, while the click's grant is fresh — never later against whichever tab is active.
      if (typeof tab.url === "string" && (!isKlaviyoSupportedCaptureUrl(tab.url) || isConfiguredCaptureRoute(tab.url))) await sourceSetup.verifyAtToolbarClick(tab);
    }).catch(async (error: unknown) => {
      // Never silent: a failed toolbar transaction leaves a compact, typed record the panel shows.
      const failure = error as { code?: unknown; message?: unknown; diagnostics?: unknown };
      await session?.set({ [SUBSCRIBER_GROWTH_SOURCE_DIAGNOSTICS_KEY]: boundedDiagnostics({ SOURCE_SETUP_STATE: "FAILED", FAILURE_CODE: typeof failure?.code === "string" ? failure.code : "TOOLBAR_HANDLER_FAILED", FAILURE_MESSAGE: String(failure?.message ?? error), GRANTED_TAB_ID: tab.id ?? null, GRANTED_AT: new Date().toISOString(), ...(failure?.diagnostics && typeof failure.diagnostics === "object" ? failure.diagnostics as Record<string, unknown> : {}) }) }).catch(() => undefined);
    });
  });
  // Panel behavior survives extension reloads. Disable legacy implicit opening
  // before relying exclusively on the explicit action listener above.
  void chromeApi.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  chromeApi.runtime?.onInstalled?.addListener(() => { void grantStore.clear().catch(() => undefined); });
  if (!chromeApi.runtime || !session) return;
  // One-time-per-start cleanup of known obsolete transient state from older builds (capture states holding screenshot
  // data URLs, oversized diagnostics). Grants, routes and verified sources are kept. Best effort by design.
  void releaseObsoleteTransientState(session).catch(() => undefined);
  const capture = new ChromeCaptureService(undefined, undefined, grantStore);
  const store = new ChromeSessionAutoCaptureStore(session);
  const businessReviewController = new BusinessReviewAutoCaptureController(
    new ChromeBusinessReviewCaptureNavigation(undefined, undefined, grantStore),
    capture, store,
  );
  const dashboardController = new DashboardAutoCaptureController(
    new ChromeKlaviyoDashboardCaptureNavigation(undefined, undefined, grantStore), capture, store,
  );
  const deliverabilityScoreController = new DeliverabilityScoreAutoCaptureController(
    new ChromeDeliverabilityScoreNavigation(undefined, grantStore), capture, store,
  );
  const subscriberGrowthNavigation = new ChromeSubscriberGrowthNavigation(undefined, grantStore, persistRoutes);
  const subscriberGrowthController = new SubscriberGrowthAutoCaptureController(subscriberGrowthNavigation, capture, store);
  const businessReviewDiscovery = new ChromeBusinessReviewDiscovery(undefined, undefined, grantStore);
  const campaignsSourceInspector = new ChromeCampaignsSourceInspector(undefined, grantStore);
  const campaignsController = new CampaignsAutoCaptureController(new ChromeCampaignsCaptureNavigation(undefined, undefined, grantStore), capture, store);
  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isAutoCaptureMessage(message)) return;
    if (message.type === "DISCOVER_BUSINESS_REVIEW") {
      void businessReviewDiscovery.discover(message.request).then((result) => {
        const safeDiagnostic = result.ok
          ? { discoveredAt: Date.now(), status: "verified", accountLabel: result.accountLabel, dashboardUrl: result.dashboardUrl, evidence: "evidence" in result ? result.evidence : null, verification: "verification" in result ? result.verification : "business_review_page" }
          : { discoveredAt: Date.now(), status: "failed", code: result.code, message: result.message, diagnostics: result.diagnostics ?? null };
        // Session-only diagnostic record: it expires with the extension session and contains no browser storage or auth material.
        // Non-critical, bounded diagnostic.
        void session.set({ "tention.business-review-discovery:last": boundedDiagnostics(safeDiagnostic) }).catch(() => undefined);
        sendResponse(result);
      }).catch(() => {
        const failure = { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Business Review discovery failed safely.", diagnostics: { discoveryStage: "BACKGROUND_MESSAGE_HANDLER", typedErrorCode: "SCRIPT_INJECTION_FAILED", safeErrorMessage: "The extension service worker could not complete discovery." } };
        void session.set({ "tention.business-review-discovery:last": boundedDiagnostics({ discoveredAt: Date.now(), status: "failed", ...failure }) }).catch(() => undefined);
        sendResponse(failure);
      });
      return true;
    }
    if (message.type === "DISCOVER_SUBSCRIBER_GROWTH_SOURCE") {
      void sourceSetup.takeVerifiedSource().then(sendResponse).catch(() => sendResponse({ ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Subscriber Growth source setup failed safely." }));
      return true;
    }
    if (message.type === "SUBSCRIBER_GROWTH_SOURCE_PERSISTED") {
      void sourceSetup.persisted(message.request).then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "START_KLAVIYO_AUTO_CAPTURE" || message.type === "START_BUSINESS_REVIEW_AUTO_CAPTURE" || message.type === "START_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      const request = message.request;
      sourceSetup.noteAutomaticNavigation();
      // Automatic navigation waits (bounded) while a source is being validated or persisted on the granted tab.
      void sourceSetupGate.waitUntilIdle(30_000).then((idle) => {
        if (!idle) { sendResponse({ request, stage: "failed", code: "SUBSCRIBER_GROWTH_SOURCE_SETUP_BUSY", message: "Subscriber Growth source setup did not finish within 30 seconds; automatic capture did not navigate." }); return; }
        const controller = request.screenshotType === "top_campaigns" ? campaignsController : isCanonicalDashboardScreenshotType(request.screenshotType) ? dashboardController : isDeliverabilityScoreScreenshotType(request.screenshotType) ? deliverabilityScoreController : isSubscriberGrowthScreenshotType(request.screenshotType) ? subscriberGrowthController : businessReviewController;
        void controller.start(request).then(sendResponse).catch(() => sendResponse(null));
      });
      return true;
    }
    if (message.type === "GET_KLAVIYO_AUTO_CAPTURE" || message.type === "GET_BUSINESS_REVIEW_AUTO_CAPTURE" || message.type === "GET_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      // Top Campaigns has an explicit rehydration path because it mutates only
      // transient Campaigns date/sort view state before screenshotting. The
      // remaining controllers retain their existing store-only semantics.
      const state = message.request.screenshotType === "top_campaigns"
        ? campaignsController.get(message.request)
        : store.get(message.request);
      void state.then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "CLEAR_ALL_KLAVIYO_AUTO_CAPTURE") {
      void store.clearAll().then(() => sendResponse(null)).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "CLEAR_KLAVIYO_AUTO_CAPTURE" || message.type === "CLEAR_BUSINESS_REVIEW_AUTO_CAPTURE" || message.type === "CLEAR_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      void store.clear(message.request).then(() => sendResponse(null)).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "GET_KLAVIYO_TOOLBAR_DIAGNOSTICS") {
      void getToolbarInvocationDiagnostics(chromeApi.tabs, grantStore).then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "GET_SESSION_STORAGE_USAGE") {
      void sessionUsage(session).then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "GET_EXTENSION_BUILD") {
      sendResponse(typeof __TENTION_BUILD__ === "string" ? __TENTION_BUILD__ : "unbundled");
      return;
    }
    if (message.type === "INSPECT_KLAVIYO_CAMPAIGNS_SOURCE") {
      void campaignsSourceInspector.inspect().then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
  });
}

async function openGrantedSidePanel(chromeApi: BackgroundChromeApi, grantStore: ChromeSessionKlaviyoActiveTabGrantStore, tab: ChromeActionTab, routesLoaded: Promise<void> = Promise.resolve()): Promise<void> {
  if (typeof tab.id !== "number") return;
  // Call sidePanel.open before awaiting storage writes so this remains within
  // the action's user gesture; persistence still completes before capture can run.
  const panelOpening = chromeApi.sidePanel?.open({ tabId: tab.id }).catch(() => undefined);
  const invocation = makeKlaviyoActionInvocation(tab);
  await routesLoaded;
  if (typeof tab.windowId === "number" && typeof tab.url === "string" && isKlaviyoSupportedCaptureUrl(tab.url)) {
    await grantStore.setActionInvocation(invocation);
    await grantStore.set({ grantedTabId: tab.id, grantedWindowId: tab.windowId, grantedOrigin: new URL(tab.url).origin, grantedUrl: tab.url, grantedAt: invocation.invokedAt });
  } else {
    // A prior grant is released first: its removal never depends on another write succeeding.
    await grantStore.clearGrant();
    await grantStore.setActionInvocation(invocation);
  }
  await panelOpening;
}

const chromeApi = (globalThis as typeof globalThis & { chrome?: BackgroundChromeApi }).chrome;
if (chromeApi) registerBackgroundAutomation(chromeApi);
