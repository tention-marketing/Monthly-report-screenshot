import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "@tention/api-client";
import type { ReportDraft, ScreenshotType } from "@tention/report-schema";
import { formatCalendarRange } from "../../lib/dates/month-options.js";
import type { CaptureService, ActiveCaptureTab, CapturedImage } from "./capture-service.js";
import { mapDisplayedCropToImage, mapViewportCropToImage, selectionFromDrag, type CropRectangle } from "./crop-geometry.js";
import { createSessionCropTemplateStore, denormalizeCrop, normalizeCrop, type CropTemplateStore } from "./crop-template-store.js";
import type { KlaviyoNavigationService } from "../klaviyo-navigation/navigation-service.js";
import type { ExecutiveSummaryTargetBounds, KlaviyoAutomationFailureCode } from "../klaviyo-navigation/executive-summary-adapter.js";
import type { AutoCaptureService, AutoCaptureState } from "../automatic-capture/auto-capture-service.js";

interface CaptureWorkflowProps {
  api: ApiClient;
  captureService: CaptureService;
  report: ReportDraft;
  screenshotType: ScreenshotType;
  label: string;
  navigationService: KlaviyoNavigationService;
  automaticCaptureService: AutoCaptureService;
  klaviyoAccountUrl: string;
  onKlaviyoAccountUrlChange(value: string): void;
  step?: { current: number; total: number };
  continueLabel?: string;
  cropTemplateStore?: CropTemplateStore;
  onComplete(report: ReportDraft): void;
  onVersionConflict(): void;
  onCancel(): void;
}

type Stage = "instructions" | "crop" | "review";

export function CaptureWorkflow({
  api, captureService, report, screenshotType, label, navigationService, automaticCaptureService, klaviyoAccountUrl, onKlaviyoAccountUrlChange,
  step, continueLabel = "Approve & Upload", cropTemplateStore = createSessionCropTemplateStore(), onComplete, onVersionConflict, onCancel,
}: CaptureWorkflowProps) {
  const [stage, setStage] = useState<Stage>("instructions");
  const [activeTab, setActiveTab] = useState<ActiveCaptureTab | null>(null);
  const [captured, setCaptured] = useState<CapturedImage | null>(null);
  const [selection, setSelection] = useState<CropRectangle | null>(null);
  const [displaySize, setDisplaySize] = useState<{ width: number; height: number } | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [croppedImage, setCroppedImage] = useState<Blob | null>(null);
  const [croppedSize, setCroppedSize] = useState<CropRectangle | null>(null);
  const [periodConfirmed, setPeriodConfirmed] = useState(false);
  const [detectedPeriod, setDetectedPeriod] = useState<string | null>(null);
  const [automaticTarget, setAutomaticTarget] = useState<ExecutiveSummaryTargetBounds | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navigationMessage, setNavigationMessage] = useState<string | null>(null);
  const [autoPolling, setAutoPolling] = useState(false);
  const [automaticFailure, setAutomaticFailure] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const previewUrl = useObjectUrl(croppedImage);
  const period = formatCalendarRange(report.period.startDate, report.period.endDate);

  function applyAutomaticState(state: AutoCaptureState): void {
    if (state.stage === "preparing" || state.stage === "capturing") {
      setBusy(true); setError(null); setAutomaticFailure(false); return;
    }
    setBusy(false); setAutoPolling(false);
    if (state.stage === "failed") {
      setAutomaticFailure(true); setError(`Automatic capture couldn't complete. ${state.message || automaticCaptureMessage(state.code)}`);
      return;
    }
    if (state.stage === "review_ready") {
      setAutomaticFailure(false);
      setCaptured(state.captured); setSelection(null); setCroppedImage(null); setCroppedSize(null);
      setPeriodConfirmed(true); setDetectedPeriod(state.detectedPeriod); setAutomaticTarget(state.target); setStage("crop");
    }
  }

  useEffect(() => {
    if (screenshotType !== "overview") return;
    let current = true;
    void automaticCaptureService.get({ reportId: report.id, screenshotType }).then((state) => {
      if (!current || !state) return;
      applyAutomaticState(state);
      if (state.stage === "preparing" || state.stage === "capturing") setAutoPolling(true);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [automaticCaptureService, report.id, screenshotType]);

  useEffect(() => {
    if (!autoPolling || screenshotType !== "overview") return;
    let current = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const state = await automaticCaptureService.get({ reportId: report.id, screenshotType });
        if (!current || !state) return;
        applyAutomaticState(state);
        if (state.stage === "preparing" || state.stage === "capturing") timer = window.setTimeout(() => void poll(), 300);
      } catch {
        if (current) { setBusy(false); setAutoPolling(false); setError("Automatic capture couldn't complete. Reopen the extension and try again, or use Capture Manually."); }
      }
    };
    void poll();
    return () => { current = false; if (timer !== undefined) window.clearTimeout(timer); };
  }, [autoPolling, automaticCaptureService, report.id, screenshotType]);

  async function requestCapture() {
    setBusy(true); setError(null);
    try {
      const active = await captureService.getActiveTab();
      if (!active.isKlaviyo) { setActiveTab(active); return; }
      await capture();
    } catch (caught) { setError(message(caught, "The current tab could not be inspected.")); }
    finally { setBusy(false); }
  }

  async function capture() {
    setBusy(true); setError(null);
    try {
      const image = await captureService.captureVisibleTab();
      setCaptured(image); setSelection(null); setCroppedImage(null); setCroppedSize(null); setPeriodConfirmed(false); setDetectedPeriod(null); setAutomaticTarget(null); setStage("crop");
    } catch (caught) { setError(message(caught, "The current tab could not be captured.")); }
    finally { setBusy(false); }
  }

  async function captureAutomatically() {
    setBusy(true); setError(null); setNavigationMessage(null); setAutomaticFailure(false);
    try {
      const state = await automaticCaptureService.start({ reportId: report.id, screenshotType: "overview", accountUrl: klaviyoAccountUrl.trim() || null, period: report.period });
      applyAutomaticState(state);
      if (state.stage === "preparing" || state.stage === "capturing") setAutoPolling(true);
    } catch (caught) { setBusy(false); setAutoPolling(false); setError(message(caught, automationMessage("CAPTURE_FAILED"))); }
  }

  async function openKlaviyoWorkspace() {
    setBusy(true); setError(null); setNavigationMessage(null);
    const result = await navigationService.openSection(screenshotType, klaviyoAccountUrl.trim() || null, report.period);
    if (result.kind === "opened_workspace") setNavigationMessage(`Klaviyo workspace opened. ${result.target.manualInstruction} Then confirm the expected period before capturing.`);
    if (result.kind === "account_context_required") setNavigationMessage(`Add the correct Klaviyo account URL, or open it manually. ${result.target.manualInstruction}`);
    if (result.kind === "open_failed") setNavigationMessage(`${result.message} Open Klaviyo manually. ${result.target.manualInstruction}`);
    setBusy(false);
  }

  function beginSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!displaySize) return;
    const point = pointInImage(event);
    dragStart.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelection(null);
  }
  function moveSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current || !displaySize) return;
    const point = pointInImage(event);
    setSelection(selectionFromDrag(dragStart.current.x, dragStart.current.y, point.x, point.y, displaySize.width, displaySize.height, 24));
  }
  function endSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }
  function pointInImage(event: React.PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  async function continueToReview() {
    if (!captured || !selection || !displaySize || !naturalSize) return;
    setBusy(true); setError(null);
    try {
      const naturalCrop = mapDisplayedCropToImage(selection, displaySize.width, displaySize.height, naturalSize.width, naturalSize.height);
      setCroppedImage(await cropToPng(captured.dataUrl, naturalCrop));
      cropTemplateStore.save(screenshotType, normalizeCrop(naturalCrop, naturalSize.width, naturalSize.height));
      setCroppedSize(naturalCrop); setStage("review");
    } catch (caught) { setError(message(caught, "The screenshot crop could not be created.")); }
    finally { setBusy(false); }
  }

  async function createAutomaticCrop(image: HTMLImageElement) {
    if (!captured || !automaticTarget) return;
    setBusy(true); setError(null);
    try {
      const naturalCrop = mapViewportCropToImage(
        { x: automaticTarget.x, y: automaticTarget.y, width: automaticTarget.width, height: automaticTarget.height },
        automaticTarget.viewportWidth, automaticTarget.viewportHeight, image.naturalWidth, image.naturalHeight,
      );
      setCroppedImage(await cropToPng(captured.dataUrl, naturalCrop));
      setCroppedSize(naturalCrop); setStage("review");
    } catch { setError(automationMessage("CAPTURE_FAILED")); setAutomaticTarget(null); }
    finally { setBusy(false); }
  }

  async function approveAndUpload() {
    if (!croppedImage || !captured || !periodConfirmed) return;
    setBusy(true); setError(null);
    try {
      const updated = await api.uploadScreenshotImage(report.id, screenshotType, {
        expectedVersion: report.version, periodConfirmed: true,
        sourceUrl: captured.sourceUrl,
        image: croppedImage,
      });
      if (screenshotType === "overview") void automaticCaptureService.clear({ reportId: report.id, screenshotType });
      onComplete(updated);
    } catch (caught) {
      if (isVersionConflict(caught)) onVersionConflict();
      else setError(message(caught, "The approved screenshot could not be uploaded."));
    } finally { setBusy(false); }
  }

  function retake() {
    setStage("instructions"); setCaptured(null); setSelection(null); setCroppedImage(null); setCroppedSize(null); setPeriodConfirmed(false); setDetectedPeriod(null); setAutomaticTarget(null); setActiveTab(null); setError(null);
    setAutoPolling(false); setAutomaticFailure(false); if (screenshotType === "overview") void automaticCaptureService.clear({ reportId: report.id, screenshotType });
  }

  if (stage === "instructions") return <main className="capture-workflow">
    <section className="card report-hero"><p className="kicker">{step ? `Step ${step.current} of ${step.total}` : "Capture screenshot"}</p><h1>{label}</h1><p className="report-month">{report.client.name}</p><p className="support-copy">Expected report period: {period}</p></section>
    <section className="card"><h2>Open the correct Klaviyo screen</h2><p className="support-copy">The extension can open a configured Klaviyo workspace, but it does not guess account IDs or provider routes. Verify the screen and selected month yourself whenever automatic verification is unavailable.</p>
      {screenshotType === "overview" && <p className="support-copy">For automatic capture: keep Klaviyo Business review active, click the Tention Reports toolbar icon to open this panel, then select Capture Automatically.</p>}
      <label>Klaviyo account URL <input type="url" value={klaviyoAccountUrl} onChange={(event) => onKlaviyoAccountUrlChange(event.target.value)} placeholder="https://www.klaviyo.com/..." /></label>
      <div className="actions">{screenshotType === "overview" && <button className="primary" disabled={busy} onClick={() => void captureAutomatically()}>{busy ? "Preparing…" : automaticFailure ? "Try Again" : "Capture Automatically"}</button>}<button disabled={busy} onClick={() => void openKlaviyoWorkspace()}>{busy ? "Opening…" : "Open Klaviyo"}</button></div>
      {navigationMessage && <p className="notice warning-notice">{navigationMessage}</p>}
      {activeTab && <div className="notice warning-notice"><p>This capture is intended for a Klaviyo page.</p><small>Current tab: {hostLabel(activeTab.sourceUrl)}</small><button disabled={busy} onClick={() => void capture()}>Capture anyway</button></div>}
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      <div className="actions"><button disabled={busy} onClick={() => void requestCapture()}>{busy ? "Checking…" : "Capture Manually"}</button><button onClick={onCancel}>Back to report</button></div>
    </section>
  </main>;

  if (stage === "crop" && captured) return <main className="capture-workflow">
    <section className="card"><p className="kicker">Crop screenshot</p><h1>{label}</h1><p className="support-copy">Drag across the exact Klaviyo card, chart, or table. Crop coordinates are mapped to the full PNG resolution.</p>
      {automaticTarget && <p className="support-copy">Creating the Growth overview crop from the verified visible target…</p>}
      <div className="crop-image" onPointerDown={automaticTarget ? undefined : beginSelection} onPointerMove={automaticTarget ? undefined : moveSelection} onPointerUp={automaticTarget ? undefined : endSelection} onPointerCancel={automaticTarget ? undefined : endSelection}>
        <img src={captured.dataUrl} alt="Captured browser tab" draggable={false} onLoad={(event) => {
          const image = event.currentTarget; const bounds = image.getBoundingClientRect();
          setDisplaySize({ width: bounds.width, height: bounds.height }); setNaturalSize({ width: image.naturalWidth, height: image.naturalHeight });
          if (automaticTarget) void createAutomaticCrop(image);
          else { const saved = cropTemplateStore.get(screenshotType); if (saved) setSelection(denormalizeCrop(saved, bounds.width, bounds.height)); }
        }} />
        {selection && <span className="crop-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />}
      </div>
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      {!automaticTarget && <><p className="support-copy">A saved crop suggestion may appear for this section. It is never approved automatically.</p><div className="actions"><button onClick={() => setSelection(null)}>Reset</button><button onClick={retake}>Retake</button><button className="primary" disabled={busy || !selection} onClick={() => void continueToReview()}>{busy ? "Cropping…" : "Continue to Review"}</button></div></>}
    </section>
  </main>;

  return <main className="capture-workflow">
    <section className="card"><p className="kicker">Review screenshot</p><h1>{label}</h1><p className="support-copy">{report.client.name} · {period}</p>
      {previewUrl && <img className="crop-preview" src={previewUrl} alt={`Cropped ${label} screenshot`} />}
      <dl className="capture-details"><div><dt>Source</dt><dd>{hostLabel(captured?.sourceUrl ?? null)}</dd></div><div><dt>Dimensions</dt><dd>{croppedSize ? `${croppedSize.width} × ${croppedSize.height} PNG` : "—"}</dd></div><div><dt>Reporting Period</dt><dd>{period}</dd></div></dl>
      {detectedPeriod ? <p className="notice success-notice">Period detected: {detectedPeriod}</p> : <label className="confirmation"><input type="checkbox" checked={periodConfirmed} onChange={(event) => setPeriodConfirmed(event.target.checked)} />I confirm this screenshot shows the selected report period.</label>}
      <p className="support-copy">Review the crop before approval. The extension never approves or uploads a screenshot automatically.</p>
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      <div className="actions"><button onClick={retake}>Retake</button><button className="primary" disabled={busy || !periodConfirmed} onClick={() => void approveAndUpload()}>{busy ? "Uploading…" : continueLabel}</button></div>
    </section>
  </main>;
}

async function cropToPng(dataUrl: string, crop: CropRectangle): Promise<Blob> {
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = crop.width; canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable.");
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG encoding failed.")), "image/png"));
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Screenshot image could not load.")); image.src = source; });
}
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (!blob) { setUrl(null); return; } const value = URL.createObjectURL(blob); setUrl(value); return () => URL.revokeObjectURL(value); }, [blob]);
  return url;
}
function hostLabel(value: string | null): string { try { return value ? new URL(value).hostname : "Unavailable"; } catch { return "Unavailable"; } }
function isVersionConflict(error: unknown): error is { code: string } { return typeof error === "object" && error !== null && "code" in error && error.code === "REPORT_VERSION_CONFLICT"; }
function message(error: unknown, fallback: string): string { return error instanceof Error && error.message ? error.message : fallback; }
function automationMessage(code: KlaviyoAutomationFailureCode): string {
  const messages: Record<KlaviyoAutomationFailureCode, string> = {
    KLAVIYO_PAGE_NOT_SUPPORTED: "Open the Klaviyo Analytics → Dashboards → Business review page, then try again.",
    KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED: "Open the Klaviyo Business Review tab and click the Tention Reports toolbar icon to start capture.",
    ACTION_NOT_INVOKED: "Open the Klaviyo Business Review tab and click the Tention Reports toolbar icon to start capture.",
    GRANTED_TAB_CLOSED: "The Klaviyo tab used to open Tention Reports was closed. Open it and click the Tention Reports toolbar icon again.",
    GRANTED_TAB_NOT_ACTIVE: "The Klaviyo tab used to open Tention Reports is no longer active. Return to it and click the Tention Reports toolbar icon again.",
    GRANTED_TAB_CHANGED_ORIGIN: "The Klaviyo tab used to open Tention Reports navigated away. Return to Business Review and click the Tention Reports toolbar icon again.",
    GRANTED_TAB_ROUTE_NOT_SUPPORTED: "The toolbar-granted tab is not the Klaviyo Business Review dashboard. Open Business Review and click the Tention Reports toolbar icon again.",
    CAPTURE_PERMISSION_DENIED: "Chrome denied the screenshot request after the toolbar invocation. Click the Tention Reports toolbar icon on Business Review and try again.",
    TARGET_NOT_FOUND: "Growth overview was not found. Use Capture Manually after locating the card.",
    PERIOD_NOT_FOUND: "Klaviyo's Time period control was not found. Confirm the selected month and use Capture Manually.",
    PERIOD_SET_FAILED: "The required report period could not be selected safely. Confirm it manually before capturing.",
    PERIOD_VERIFY_FAILED: "Klaviyo did not verify the selected report period. No screenshot was captured.",
    TARGET_NOT_FULLY_VISIBLE: "Growth overview is not fully visible in the viewport. Resize or scroll it into view, then use Capture Manually.",
    CAPTURE_FAILED: "The verified Growth overview could not be captured. Use Capture Manually.",
    TAB_LOOKUP_FAILED: "Klaviyo tabs could not be inspected. Open the Business review page and use Capture Manually.",
    TAB_ACTIVATION_FAILED: "The Klaviyo tab could not be focused. Open the Business review page and use Capture Manually.",
    PAGE_READY_FAILED: "The Klaviyo page could not be read. Wait for it to load, then use Capture Manually.",
    PAGE_READY_TIMEOUT: "Klaviyo did not finish loading in time. Wait for it to load, then use Capture Manually.",
    SCRIPT_INJECTION_FAILED: "Klaviyo could not be checked automatically. Use Capture Manually.",
    KLAVIYO_PERIOD_DIALOG_NOT_FOUND: "Klaviyo's Time period dialog could not be verified. Confirm the month and use Capture Manually.",
    KLAVIYO_PERIOD_APPLY_NOT_FOUND: "Klaviyo's Apply button was not found. Confirm the month and use Capture Manually.",
    KLAVIYO_PERIOD_APPLY_TIMEOUT: "Klaviyo did not close the Time period dialog in time. Confirm the month and use Capture Manually.",
    KLAVIYO_PERIOD_VERIFY_FAILED: "Klaviyo did not show the selected report month after applying it. No screenshot was captured.",
    KLAVIYO_PAGE_ADAPTER_ERROR: "We couldn't run the Tention Klaviyo helper on this page. Use Capture Manually.",
    SCRIPT_RESULT_EMPTY: "The Tention Klaviyo helper returned no execution result. Use Capture Manually.",
    SCRIPT_RESULT_UNDEFINED: "The Tention Klaviyo helper did not return a usable result. Use Capture Manually.",
    SCRIPT_RESULT_INVALID: "The Tention Klaviyo helper returned an invalid result. Use Capture Manually.",
  };
  return messages[code];
}

function automaticCaptureMessage(code: KlaviyoAutomationFailureCode | "CAPTURE_TARGET_NOT_ACTIVE" | "KLAVIYO_CAPTURE_PERMISSION_REQUIRED" | "CAPTURE_FAILED" | "ACTIVE_TAB_LOOKUP_FAILED" | "VISIBLE_TAB_CAPTURE_FAILED" | "CAPTURE_TIMEOUT"): string {
  if (code === "CAPTURE_TARGET_NOT_ACTIVE") return "The prepared Klaviyo tab is no longer active, so no screenshot was captured.";
  if (code === "KLAVIYO_CAPTURE_PERMISSION_REQUIRED") return "To allow screenshot capture, keep the Klaviyo tab active and click the Tention Reports toolbar icon once.";
  if (code === "ACTIVE_TAB_LOOKUP_FAILED" || code === "VISIBLE_TAB_CAPTURE_FAILED" || code === "CAPTURE_TIMEOUT") return "The Klaviyo screenshot could not be captured. Try again or use Capture Manually.";
  return automationMessage(code);
}
