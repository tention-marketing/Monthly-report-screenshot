import { ExecutiveSummaryAutoCaptureController, type AutoCaptureStateStore } from "./features/automatic-capture/auto-capture-controller.js";
import { autoCaptureKey, type AutoCaptureMessage, type AutoCaptureState, type ExecutiveSummaryAutoCaptureRequest } from "./features/automatic-capture/auto-capture-service.js";
import { ChromeKlaviyoNavigationService } from "./features/klaviyo-navigation/navigation-service.js";
import { ChromeCaptureService } from "./features/screenshot-capture/capture-service.js";
import {
  ChromeSessionKlaviyoActiveTabGrantStore,
  isKlaviyoBusinessReviewDashboardUrl,
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
  tabs?: KlaviyoGrantTabsApi;
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
  const controller = new ExecutiveSummaryAutoCaptureController(
    new ChromeKlaviyoNavigationService(undefined, undefined, grantStore),
    new ChromeCaptureService(undefined, undefined, grantStore),
    new ChromeSessionAutoCaptureStore(session),
  );
  chromeApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isAutoCaptureMessage(message)) return;
    if (message.type === "START_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      void controller.start(message.request).then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "GET_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      void controller.get(message.request).then(sendResponse).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "CLEAR_EXECUTIVE_SUMMARY_AUTO_CAPTURE") {
      void controller.clear(message.request).then(() => sendResponse(null)).catch(() => sendResponse(null));
      return true;
    }
    if (message.type === "GET_KLAVIYO_TOOLBAR_DIAGNOSTICS") {
      void getToolbarInvocationDiagnostics(chromeApi.tabs, grantStore).then(sendResponse).catch(() => sendResponse(null));
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
  if (typeof tab.windowId === "number" && typeof tab.url === "string" && isKlaviyoBusinessReviewDashboardUrl(tab.url)) {
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
