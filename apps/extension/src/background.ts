import type { AutoCaptureStateStore } from "./features/automatic-capture/auto-capture-controller.js";
import { BusinessReviewAutoCaptureController } from "./features/automatic-capture/business-review-auto-capture-controller.js";
import { DashboardAutoCaptureController } from "./features/automatic-capture/dashboard-auto-capture-controller.js";
import { DeliverabilityScoreAutoCaptureController } from "./features/automatic-capture/deliverability-score-auto-capture-controller.js";
import { autoCaptureKey, type AutoCaptureMessage, type AutoCaptureState, type ExecutiveSummaryAutoCaptureRequest } from "./features/automatic-capture/auto-capture-service.js";
import { ChromeBusinessReviewCaptureNavigation } from "./features/klaviyo-navigation/business-review-navigation-service.js";
import { ChromeBusinessReviewDiscovery } from "./features/klaviyo-navigation/business-review-discovery.js";
import { isCanonicalDashboardScreenshotType } from "./features/klaviyo-navigation/dashboard-capture.js";
import { ChromeKlaviyoDashboardCaptureNavigation } from "./features/klaviyo-navigation/dashboard-navigation-service.js";
import { ChromeDeliverabilityScoreNavigation } from "./features/klaviyo-navigation/deliverability-score-navigation-service.js";
import { ChromeCampaignsSourceInspector } from "./features/klaviyo-navigation/campaigns-source-inspector.js";
import { CampaignsAutoCaptureController } from "./features/automatic-capture/campaigns-auto-capture-controller.js";
import { ChromeCampaignsCaptureNavigation } from "./features/klaviyo-navigation/campaigns-navigation-service.js";
import { isDeliverabilityScoreScreenshotType } from "./features/klaviyo-navigation/deliverability-score-capture.js";
import { ChromeCaptureService } from "./features/screenshot-capture/capture-service.js";
import {
  ChromeSessionKlaviyoActiveTabGrantStore,
  isKlaviyoSupportedCaptureUrl,
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

export class ChromeSessionAutoCaptureStore implements AutoCaptureStateStore {
  constructor(private readonly session: ChromeStorageSession) {}

  async get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null> {
    const key = autoCaptureKey(request);
    return (await this.session.get(key))[key] as AutoCaptureState | undefined ?? null;
  }

  async set(state: AutoCaptureState): Promise<void> {
    await this.session.set({ [autoCaptureKey(state.request)]: state });
  }

  async clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void> {
    await this.session.remove(autoCaptureKey(request));
  }
}

function isAutoCaptureMessage(value: unknown): value is AutoCaptureMessage {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

export function registerBackgroundAutomation(chromeApi: BackgroundChromeApi): void {
  const session = chromeApi.storage?.session;
  const grantStore = new ChromeSessionKlaviyoActiveTabGrantStore(session);
  // This is registered immediately at service-worker startup. `activeTab` is
  // granted by this explicit action click, not by implicit side-panel behavior.
  chromeApi.action?.onClicked.addListener((tab) => {
    void openGrantedSidePanel(chromeApi, grantStore, tab);
  });
  // Panel behavior survives extension reloads. Disable legacy implicit opening
  // before relying exclusively on the explicit action listener above.
  void chromeApi.sidePanel?.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
  chromeApi.runtime?.onInstalled?.addListener(() => { void grantStore.clear(); });
  if (!chromeApi.runtime || !session) return;
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
        void session.set({ "tention.business-review-discovery:last": safeDiagnostic }).catch(() => undefined);
        sendResponse(result);
      }).catch(() => {
        const failure = { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Business Review discovery failed safely.", diagnostics: { discoveryStage: "BACKGROUND_MESSAGE_HANDLER", typedErrorCode: "SCRIPT_INJECTION_FAILED", safeErrorMessage: "The extension service worker could not complete discovery." } };
        void session.set({ "tention.business-review-discovery:last": { discoveredAt: Date.now(), status: "failed", ...failure } }).catch(() => undefined);
        sendResponse(failure);
      });
      return true;
    }
    if (message.type === "START_KLAVIYO_AUTO_CAPTURE" || message.type === "START_BUSINESS_REVIEW_AUTO_CAPTURE" || message.type === "START_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      const controller = message.request.screenshotType === "top_campaigns" ? campaignsController : isCanonicalDashboardScreenshotType(message.request.screenshotType) ? dashboardController : isDeliverabilityScoreScreenshotType(message.request.screenshotType) ? deliverabilityScoreController : businessReviewController;
      void controller.start(message.request).then(sendResponse).catch(() => sendResponse(null));
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
    if (message.type === "CLEAR_KLAVIYO_AUTO_CAPTURE" || message.type === "CLEAR_BUSINESS_REVIEW_AUTO_CAPTURE" || message.type === "CLEAR_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      void store.clear(message.request).then(() => sendResponse(null)).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "GET_KLAVIYO_TOOLBAR_DIAGNOSTICS") {
      void getToolbarInvocationDiagnostics(chromeApi.tabs, grantStore).then(sendResponse).catch(() => sendResponse(null));
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

async function openGrantedSidePanel(chromeApi: BackgroundChromeApi, grantStore: ChromeSessionKlaviyoActiveTabGrantStore, tab: ChromeActionTab): Promise<void> {
  if (typeof tab.id !== "number") return;
  // Call sidePanel.open before awaiting storage writes so this remains within
  // the action's user gesture; persistence still completes before capture can run.
  const panelOpening = chromeApi.sidePanel?.open({ tabId: tab.id }).catch(() => undefined);
  const invocation = makeKlaviyoActionInvocation(tab);
  if (typeof tab.windowId === "number" && typeof tab.url === "string" && isKlaviyoSupportedCaptureUrl(tab.url)) {
    await grantStore.setActionInvocation(invocation);
    await grantStore.set({ grantedTabId: tab.id, grantedWindowId: tab.windowId, grantedOrigin: new URL(tab.url).origin, grantedUrl: tab.url, grantedAt: invocation.invokedAt });
  } else {
    await grantStore.setActionInvocation(invocation);
    await grantStore.clearGrant();
  }
  await panelOpening;
}

const chromeApi = (globalThis as typeof globalThis & { chrome?: BackgroundChromeApi }).chrome;
if (chromeApi) registerBackgroundAutomation(chromeApi);
