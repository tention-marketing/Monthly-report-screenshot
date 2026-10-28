import type { CaptureService } from "../screenshot-capture/capture-service.js";
import type { KlaviyoNavigationService } from "../klaviyo-navigation/navigation-service.js";
import type {
  AutoCaptureFailureState, AutoCaptureState, ExecutiveSummaryAutoCaptureRequest,
} from "./auto-capture-service.js";

export interface AutoCaptureStateStore {
  get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null>;
  set(state: AutoCaptureState): Promise<void>;
  clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void>;
  clearAll?(): Promise<void>;
}

/**
 * Runs only in the extension service worker. Its persisted state lets a reopened
 * Side Panel resume review after the action popup would otherwise have closed.
 */
export class ExecutiveSummaryAutoCaptureController {
  private readonly running = new Set<string>();

  constructor(
    private readonly navigation: KlaviyoNavigationService,
    private readonly capture: CaptureService,
    private readonly store: AutoCaptureStateStore,
  ) {}

  async start(request: ExecutiveSummaryAutoCaptureRequest): Promise<AutoCaptureState> {
    const state: AutoCaptureState = { request, stage: "preparing" };
    await this.store.set(state);
    void this.run(request);
    return state;
  }

  async get(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<AutoCaptureState | null> {
    const state = await this.store.get(request);
    if (state && (state.stage === "preparing" || state.stage === "capturing")) void this.run(state.request);
    return state;
  }

  async clear(request: Pick<ExecutiveSummaryAutoCaptureRequest, "reportId" | "screenshotType">): Promise<void> {
    await this.store.clear(request);
  }

  private async run(request: ExecutiveSummaryAutoCaptureRequest): Promise<void> {
    const key = `${request.reportId}:${request.screenshotType}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    try {
      const prepared = await this.navigation.prepareExecutiveSummary(request.accountUrl, request.period);
      if (prepared.kind === "failed") {
        await this.store.set({ request, stage: "failed", code: prepared.code, message: prepared.message ?? "Automatic capture could not verify the Klaviyo page." });
        return;
      }
      if (typeof prepared.sourceTabId !== "number" || !this.capture.captureVisibleTabFor) {
        await this.fail(request, "CAPTURE_FAILED", "The prepared Klaviyo tab could not be captured safely.");
        return;
      }
      await this.store.set({ request, stage: "capturing" });
      const captured = await this.capture.captureVisibleTabFor({ tabId: prepared.sourceTabId, ...(typeof prepared.windowId === "number" ? { windowId: prepared.windowId } : {}) });
      await this.store.set({ request, stage: "review_ready", sourceTabId: prepared.sourceTabId, detectedPeriod: prepared.detectedPeriod, target: prepared.target, captured });
    } catch (error) {
      const captureCode = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (typeof captureCode === "string" && [
        "KLAVIYO_CAPTURE_PERMISSION_REQUIRED", "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED", "ACTION_NOT_INVOKED", "GRANTED_TAB_CLOSED",
        "GRANTED_TAB_NOT_ACTIVE", "GRANTED_TAB_CHANGED_ORIGIN", "GRANTED_TAB_ROUTE_NOT_SUPPORTED", "CAPTURE_PERMISSION_DENIED",
      ].includes(captureCode)) {
        const message = captureCode === "KLAVIYO_CAPTURE_PERMISSION_REQUIRED" || captureCode === "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED"
          ? "Open the Klaviyo Business Review tab and click the Tention Reports toolbar icon to start capture."
          : error instanceof Error && error.message ? error.message : "The toolbar-granted Klaviyo tab could not be captured.";
        await this.fail(request, captureCode as AutoCaptureFailureState["code"], message);
        return;
      }
      const code = captureCode === "CAPTURE_TARGET_NOT_ACTIVE" ? "CAPTURE_TARGET_NOT_ACTIVE" : "CAPTURE_FAILED";
      await this.fail(request, code, error instanceof Error && error.message ? error.message : "Automatic capture could not complete.");
    } finally {
      this.running.delete(key);
    }
  }

  private async fail(request: ExecutiveSummaryAutoCaptureRequest, code: AutoCaptureFailureState["code"], message: string): Promise<void> {
    await this.store.set({ request, stage: "failed", code, message });
  }
}
