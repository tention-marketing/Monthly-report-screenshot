import { useEffect, useRef, useState } from "react";
import { ApiError, type ApiClient } from "@tention/api-client";
import { createScreenshotSourceProof, type ClientReportTargets, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import { formatCalendarRange } from "../../lib/dates/month-options.js";
import type { CaptureService, ActiveCaptureTab, CapturedImage } from "./capture-service.js";
import { mapDisplayedCropToImage, mapViewportCropToImage, selectionFromDrag, type CropRectangle } from "./crop-geometry.js";
import { createSessionCropTemplateStore, denormalizeCrop, normalizeCrop, type CropTemplateStore } from "./crop-template-store.js";
import type { KlaviyoNavigationService } from "../klaviyo-navigation/navigation-service.js";
import type { KlaviyoAutomationFailureCode } from "../klaviyo-navigation/executive-summary-adapter.js";
import { isAutomaticBusinessReviewScreenshotType, type BusinessReviewFailureCode, type BusinessReviewTargetBounds } from "../klaviyo-navigation/business-review-capture.js";
import { isCanonicalDashboardScreenshotType, type DashboardFailureCode, type DashboardTargetBounds } from "../klaviyo-navigation/dashboard-capture.js";
import { TOP_CAMPAIGN_ROW_COUNT, type CampaignsEvidence, type CampaignsFailureCode, type CampaignTargetBounds } from "../klaviyo-navigation/campaigns-capture.js";
import type { AutoCaptureFailureState, AutoCaptureService, AutoCaptureState } from "../automatic-capture/auto-capture-service.js";
import { configuredAutomaticCaptureUrl } from "./capture-source-url.js";

interface CaptureWorkflowProps {
  api: ApiClient;
  captureService: CaptureService;
  report: ReportDraft;
  clientTargets: ClientReportTargets | null;
  screenshotType: ScreenshotType;
  label: string;
  navigationService: KlaviyoNavigationService;
  automaticCaptureService: AutoCaptureService;
  klaviyoAccountUrl: string;
  onKlaviyoAccountUrlChange(value: string): void;
  step?: { current: number; total: number };
  continueLabel?: string;
  autoStart?: boolean;
  cropTemplateStore?: CropTemplateStore;
  onComplete(report: ReportDraft): void;
  onUploadStatus?(status: CaptureUploadStatus): void;
  onVersionConflict(): void;
  onCancel(): void;
}

export interface CaptureUploadStatus {
  stage: "uploading" | "success" | "failed";
  httpStatus: number | null;
  operation: "PUT screenshot" | "GET canonical draft" | "PUT + canonical GET" | null;
  errorCode: string | null;
}

type Stage = "instructions" | "crop" | "review";

export function CaptureWorkflow({
  api, captureService, report, clientTargets, screenshotType, label, navigationService, automaticCaptureService, klaviyoAccountUrl, onKlaviyoAccountUrlChange,
  step, continueLabel = "Approve & Upload", autoStart = false, cropTemplateStore = createSessionCropTemplateStore(), onComplete, onUploadStatus, onVersionConflict, onCancel,
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
  const [automaticTarget, setAutomaticTarget] = useState<BusinessReviewTargetBounds | DashboardTargetBounds | CampaignTargetBounds | null>(null);
  const [campaignsEvidence, setCampaignsEvidence] = useState<CampaignsEvidence | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [navigationMessage, setNavigationMessage] = useState<string | null>(null);
  const [autoPolling, setAutoPolling] = useState(false);
  const [automaticFailure, setAutomaticFailure] = useState(false);
  const automaticStartRequested = useRef(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const previewUrl = useObjectUrl(croppedImage);
  const period = formatCalendarRange(report.period.startDate, report.period.endDate);
  const previousComparisonPeriod = formatCalendarRange(report.period.previousStartDate, report.period.previousEndDate);
  const monthComparisonCapture = screenshotType === "month_comparison";
  const welcomeListingRows = clientTargets?.welcomeFlowListing?.flows ?? [];
  const welcomeListingIds = welcomeListingRows.map(({ id }) => id).join(" and ");
  const periodConfirmationText = monthComparisonCapture
    ? `I verified this screenshot visibly shows ${period} and ${previousComparisonPeriod} as the current and previous periods.`
    : screenshotType === "signup_form" ? "I verified this is the account-wide Sign-up Forms listing and the visible rows include performance columns; no form is open."
      : screenshotType === "welcome_flow" ? `I verified this is the Flows listing, it shows the configured Email rows (${welcomeListingIds}), SMS rows are excluded, and no flow is open.`
      : "I confirm this screenshot shows the selected report period.";
  const listingTargetReady = screenshotType === "signup_form" ? clientTargets?.signupForms?.mode === "all"
    : screenshotType === "welcome_flow" ? clientTargets?.welcomeFlowListing?.flows.length === 2 : true;

  function applyAutomaticState(state: AutoCaptureState): void {
    if (state.stage === "preparing" || state.stage === "capturing") {
      setBusy(true); setError(null); setAutomaticFailure(false); return;
    }
    setBusy(false); setAutoPolling(false);
    if (state.stage === "failed") {
      const detail = state.message || (screenshotType === "top_campaigns" ? "Campaigns capture could not complete." : automaticCaptureMessage(state.code));
      setAutomaticFailure(true); setError(`Automatic capture couldn't complete. ${screenshotType === "top_campaigns" ? `${state.code}: ` : ""}${detail}`);
      return;
    }
    if (state.stage === "review_ready") {
      setAutomaticFailure(false);
      setCaptured(state.captured); setSelection(null); setCroppedImage(null); setCroppedSize(null);
      setPeriodConfirmed(true); setDetectedPeriod(state.detectedPeriod); setAutomaticTarget(state.target); setCampaignsEvidence(state.campaignsEvidence ?? null); setStage("crop");
    }
  }

  useEffect(() => {
    if (!isAutomaticKlaviyoScreenshotType(screenshotType)) return;
    let current = true;
    void automaticCaptureService.get({ reportId: report.id, screenshotType }).then((state) => {
      if (!current || !state) return;
      applyAutomaticState(state);
      if (state.stage === "preparing" || state.stage === "capturing") setAutoPolling(true);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [automaticCaptureService, report.id, screenshotType]);

  useEffect(() => {
    if (!autoPolling || !isAutomaticKlaviyoScreenshotType(screenshotType)) return;
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

  useEffect(() => {
    if (!autoStart || !isAutomaticKlaviyoScreenshotType(screenshotType) || automaticStartRequested.current) return;
    automaticStartRequested.current = true;
    void captureAutomatically();
  // A capture workflow is keyed by report + screenshot type, so this runs once per C1 step.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, screenshotType]);

  async function requestCapture() {
    setBusy(true); setError(null);
    try {
      const active = await captureService.getActiveTab();
      if (requiresListingRoute(screenshotType) && !isRequiredListingUrl(screenshotType, active.sourceUrl)) {
        setError(listingRouteError(screenshotType)); return;
      }
      if (!active.isKlaviyo) { setActiveTab(active); return; }
      await capture();
    } catch (caught) { setError(message(caught, "The current tab could not be inspected.")); }
    finally { setBusy(false); }
  }

  async function capture() {
    setBusy(true); setError(null);
    try {
      if (requiresListingRoute(screenshotType)) {
        const active = await captureService.getActiveTab();
        if (!isRequiredListingUrl(screenshotType, active.sourceUrl)) { setError(listingRouteError(screenshotType)); return; }
      }
      const image = await captureService.captureVisibleTab();
      if (requiresListingRoute(screenshotType) && !isRequiredListingUrl(screenshotType, image.sourceUrl)) { setError(listingRouteError(screenshotType)); return; }
      setCaptured(image); setSelection(null); setCroppedImage(null); setCroppedSize(null); setPeriodConfirmed(false); setDetectedPeriod(null); setAutomaticTarget(null); setStage("crop");
    } catch (caught) { setError(message(caught, "The current tab could not be captured.")); }
    finally { setBusy(false); }
  }

  async function captureAutomatically() {
    setBusy(true); setError(null); setNavigationMessage(null); setAutomaticFailure(false);
    try {
      if (!isAutomaticKlaviyoScreenshotType(screenshotType)) return;
      const configuredSourceUrl = configuredAutomaticCaptureUrl(screenshotType, clientTargets);
      const state = await automaticCaptureService.start({ reportId: report.id, screenshotType, accountUrl: configuredSourceUrl, period: report.period, clientName: report.client.name, clientTimezone: report.client.timezone, conversionMetric: clientTargets?.profile?.conversionMetric.label ?? "Placed Order", desiredCampaignCount: TOP_CAMPAIGN_ROW_COUNT });
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
    let operation: CaptureUploadStatus["operation"] = "PUT screenshot";
    onUploadStatus?.({ stage: "uploading", httpStatus: null, operation: "PUT screenshot", errorCode: null });
    setBusy(true); setError(null);
    try {
      const canonical = await api.uploadScreenshotImage(report.id, screenshotType, {
        expectedVersion: report.version, periodConfirmed: true,
        sourceUrl: captured.sourceUrl,
        sourceProof: createScreenshotSourceProof(screenshotType, report.period, screenshotType === "signup_form" ? { scope: "all_forms" }
          : screenshotType === "welcome_flow" ? { scope: "email_welcome_flows", entities: clientTargets?.welcomeFlowListing?.flows ?? [] } : undefined, screenshotType === "top_campaigns" ? campaignsEvidence : null),
        image: croppedImage,
      });
      operation = "GET canonical draft";
      if (canonical.id !== report.id || canonical.client.id !== report.client.id
        || canonical.reportMonth.year !== report.reportMonth.year || canonical.reportMonth.month !== report.reportMonth.month
        || !canonical.screenshots.some((record) => record.type === screenshotType && record.approved && record.periodConfirmed)) {
        throw new ApiError("SCREENSHOT_PERSISTENCE_NOT_CONFIRMED", "The canonical report reload did not contain the approved screenshot.", 200);
      }
      onUploadStatus?.({ stage: "success", httpStatus: 200, operation: "PUT + canonical GET", errorCode: null });
      if (isAutomaticKlaviyoScreenshotType(screenshotType)) void automaticCaptureService.clear({ reportId: report.id, screenshotType });
      onComplete(canonical);
    } catch (caught) {
      onUploadStatus?.({ stage: "failed", httpStatus: caught instanceof ApiError ? caught.status : null,
        operation: caught instanceof ApiError && (caught.code === "CANONICAL_DRAFT_RELOAD_FAILED" || caught.code === "SCREENSHOT_PERSISTENCE_NOT_CONFIRMED") ? "GET canonical draft" : operation,
        errorCode: caught instanceof ApiError ? caught.code : "SCREENSHOT_UPLOAD_FAILED" });
      if (isVersionConflict(caught)) onVersionConflict();
      else setError(message(caught, "The approved screenshot could not be uploaded."));
    } finally { setBusy(false); }
  }

  function retake() {
    setStage("instructions"); setCaptured(null); setSelection(null); setCroppedImage(null); setCroppedSize(null); setPeriodConfirmed(false); setDetectedPeriod(null); setAutomaticTarget(null); setCampaignsEvidence(null); setActiveTab(null); setError(null);
    setAutoPolling(false); setAutomaticFailure(false); if (isAutomaticKlaviyoScreenshotType(screenshotType)) void automaticCaptureService.clear({ reportId: report.id, screenshotType });
  }

  if (stage === "instructions") return <main className="capture-workflow">
    <section className="card report-hero"><p className="kicker">{step ? `Step ${step.current} of ${step.total}` : "Capture screenshot"}</p><h1>{label}</h1><p className="report-month">{report.client.name}</p><p className="support-copy">Expected report period: {period}</p></section>
    <section className="card"><h2>Open the correct Klaviyo screen</h2><p className="support-copy">The extension can open a configured Klaviyo workspace, but it does not guess account IDs or provider routes. Verify the screen and selected month yourself whenever automatic verification is unavailable.</p>
      {monthComparisonCapture && <p className="notice warning-notice">Manual comparison proof is required. Capture a view that visibly shows the current period ({period}) and the immediately previous complete month ({previousComparisonPeriod}). “Compared to previous period” by itself is not sufficient.</p>}
      {screenshotType === "signup_form" && <p className="notice warning-notice">Listing-only capture: stay on the Sign-up Forms listing. Capture the all-forms table with its visible performance columns (the account-wide listing scope); do not open a form.</p>}
      {screenshotType === "welcome_flow" && <p className="notice warning-notice">Listing-only capture: stay on the Flows listing, filter the table for “Welcome,” and include only the configured Email rows ({welcomeListingIds}). Exclude SMS rows. Do not click a flow or open Flow Builder.</p>}
      {requiresListingRoute(screenshotType) && !listingTargetReady && <p role="alert" className="notice error-notice">Save this listing scope in Client Target Configuration before capture. Return to the report and choose Configure Missing Targets.</p>}
      {screenshotType === "top_flows" && <p className="notice warning-notice">Klaviyo Home only: set the Time period to {period} and capture the “Top performing flows” card: the first five rows, or every row when fewer than five exist. Do not click a flow name or open Flow Builder.</p>}
      {screenshotType === "top_campaigns" && <p className="notice warning-notice">Campaigns-only source: keep the exact `/omnicampaigns` listing active, verify the correct account, then click the Tention Reports toolbar icon. The adapter only reads temporary date/sort/filter state and never opens a campaign.</p>}
      {isAutomaticKlaviyoScreenshotType(screenshotType) && screenshotType !== "top_campaigns" && <p className="support-copy">For automatic capture: keep {isCanonicalDashboardScreenshotType(screenshotType) ? "the Klaviyo home dashboard" : "Klaviyo Business Review"} active, click the Tention Reports toolbar icon to open this panel, then select Capture Automatically.</p>}
      <label>Klaviyo account URL <input type="url" value={klaviyoAccountUrl} onChange={(event) => onKlaviyoAccountUrlChange(event.target.value)} placeholder="https://www.klaviyo.com/..." /></label>
      <div className="actions">{isAutomaticKlaviyoScreenshotType(screenshotType) && <button className="primary" disabled={busy} onClick={() => void captureAutomatically()}>{busy ? "Preparing…" : automaticFailure ? "Try Again" : "Capture Automatically"}</button>}<button disabled={busy || !listingTargetReady} onClick={() => void openKlaviyoWorkspace()}>{busy ? "Opening…" : "Open Klaviyo"}</button></div>
      {navigationMessage && <p className="notice warning-notice">{navigationMessage}</p>}
      {activeTab && <div className="notice warning-notice"><p>This capture is intended for a Klaviyo page.</p><small>Current tab: {hostLabel(activeTab.sourceUrl)}</small><button disabled={busy} onClick={() => void capture()}>Capture anyway</button></div>}
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      <div className="actions"><button disabled={busy || !listingTargetReady} onClick={() => void requestCapture()}>{busy ? "Checking…" : "Capture Manually"}</button><button onClick={onCancel}>Back to report</button></div>
    </section>
  </main>;

  if (stage === "crop" && captured) return <main className="capture-workflow">
    <section className="card"><p className="kicker">Crop screenshot</p><h1>{label}</h1><p className="support-copy">Drag across the exact Klaviyo card, chart, or table. Crop coordinates are mapped to the full PNG resolution.</p>
      {automaticTarget && <p className="support-copy">Creating the verified Klaviyo crop from the visible target…</p>}
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
      <dl className="capture-details"><div><dt>Source</dt><dd>{hostLabel(captured?.sourceUrl ?? null)}</dd></div><div><dt>Dimensions</dt><dd>{croppedSize ? `${croppedSize.width} × ${croppedSize.height} PNG` : "—"}</dd></div><div><dt>Reporting Period</dt><dd>{period}</dd></div>{monthComparisonCapture && <div><dt>Previous Comparison</dt><dd>{previousComparisonPeriod}</dd></div>}{screenshotType === "top_flows" && typeof automaticTarget?.includedRowCount === "number" && <div><dt>Flows Captured</dt><dd>{topFlowsCountLabel(automaticTarget.includedRowCount)}</dd></div>}{screenshotType === "top_campaigns" && campaignsEvidence && <><div><dt>Campaign Metric</dt><dd>{campaignsEvidence.visibleMetricLabel}</dd></div><div><dt>Campaigns Captured</dt><dd>{campaignsEvidence.includedRowCount} of {campaignsEvidence.eligibleRowCount} eligible Sent campaigns</dd></div></>}</dl>
      {detectedPeriod ? <p className="notice success-notice">Period detected: {detectedPeriod}</p> : <label className="confirmation"><input type="checkbox" checked={periodConfirmed} onChange={(event) => setPeriodConfirmed(event.target.checked)} />{periodConfirmationText}</label>}
      <p className="support-copy">Review the crop before approval. The extension never approves or uploads a screenshot automatically.</p>
      {error && <p role="alert" className="notice error-notice">{error}</p>}
      {onUploadStatus && <p role="status" className="support-copy">Approval completes only after the API acknowledges the stored screenshot and the canonical report reload confirms it.</p>}
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
function isAutomaticKlaviyoScreenshotType(type: ScreenshotType): boolean {
  return type === "top_campaigns" || isCanonicalDashboardScreenshotType(type) || isAutomaticBusinessReviewScreenshotType(type);
}
function topFlowsCountLabel(count: number): string {
  return count >= 5 ? "Top 5 flows" : `${count} of 5 — Klaviyo shows only ${count} usable flow${count === 1 ? "" : "s"} for this month`;
}
function requiresListingRoute(type: ScreenshotType): type is "signup_form" | "welcome_flow" { return type === "signup_form" || type === "welcome_flow"; }
function isRequiredListingUrl(type: ScreenshotType, value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "klaviyo.com" || url.hostname === "www.klaviyo.com") && url.pathname.replace(/\/$/, "") === (type === "signup_form" ? "/forms" : "/flows");
  } catch { return false; }
}
function listingRouteError(type: "signup_form" | "welcome_flow"): string {
  return type === "signup_form" ? "SIGNUP_FORMS_LISTING_REQUIRED: stay on the Sign-up Forms listing; individual forms are not allowed."
    : "WELCOME_FLOWS_LISTING_REQUIRED: stay on the Flows listing; individual flows and Flow Builder are not allowed.";
}

function automationMessage(code: AutoCaptureFailureState["code"]): string {
  const dashboard: Partial<Record<DashboardFailureCode, string>> = {
    DASHBOARD_NOT_FOUND: "Open the Klaviyo home dashboard before automatic capture.",
    REPORT_PERIOD_NOT_CONFIRMED: "Klaviyo did not confirm the selected report period. Use Capture Manually.",
    BUSINESS_PERFORMANCE_SUMMARY_NOT_FOUND: "Business performance summary could not be verified. Use Capture Manually.",
    TOP_PERFORMING_FLOWS_NOT_FOUND: "Top performing flows could not be verified. Use Capture Manually.",
    TOP_FLOW_ROWS_NOT_FOUND: "Top performing flows did not show its table header and visible flow rows for the selected month. Use Capture Manually.",
    TOP_FLOWS_NO_DATA: "Klaviyo Home shows no usable rows in Top performing flows for the selected month. Nothing was captured.",
    TARGET_NOT_VISIBLE: "The verified dashboard target is not fully visible. Use Capture Manually.",
    TARGET_LAYOUT_NOT_STABLE: "The verified dashboard target did not stabilize. Use Capture Manually.",
    KLAVIYO_PAGE_ADAPTER_ERROR: "The Klaviyo dashboard helper failed. Use Capture Manually.",
  };
  if (dashboard[code as DashboardFailureCode]) return dashboard[code as DashboardFailureCode]!;
  const businessReview: Partial<Record<BusinessReviewFailureCode | "BUSINESS_REVIEW_URL_REQUIRED" | "BUSINESS_REVIEW_NAVIGATION_FAILED" | "SCRIPT_RESULT_EMPTY" | "SCRIPT_RESULT_UNDEFINED" | "SCRIPT_RESULT_INVALID", string>> = {
    BUSINESS_REVIEW_CARD_NOT_FOUND: "The required Business Review card could not be verified. Use Capture Manually.",
    BUSINESS_REVIEW_TAB_NOT_FOUND: "The required Business Review tab could not be verified. Use Capture Manually.",
    BUSINESS_REVIEW_TAB_NOT_SELECTED: "The required Business Review tab did not become selected. Use Capture Manually.",
    BUSINESS_REVIEW_ROWS_NOT_FOUND: "The required Business Review ranking rows could not be verified. Use Capture Manually.",
    BUSINESS_REVIEW_URL_REQUIRED: "Add the configured Klaviyo Business Review URL before automatic capture.",
    BUSINESS_REVIEW_NAVIGATION_FAILED: "The authorized tab did not reach the configured Business Review dashboard. Use Capture Manually.",
    REPORT_PERIOD_NOT_CONFIRMED: "Klaviyo did not confirm the selected report period. Use Capture Manually.",
    COMPARISON_PERIOD_NOT_CONFIRMED: "Klaviyo did not prove the immediately previous comparison period. Use Capture Manually.",
    TARGET_NOT_VISIBLE: "The verified Business Review target is not fully visible. Use Capture Manually.",
    TARGET_LAYOUT_NOT_STABLE: "The verified Business Review target did not stabilize. Use Capture Manually.",
    SCRIPT_RESULT_EMPTY: "The Business Review helper returned no result. Use Capture Manually.",
    SCRIPT_RESULT_UNDEFINED: "The Business Review helper returned an undefined result. Use Capture Manually.",
    SCRIPT_RESULT_INVALID: "The Business Review helper returned an invalid result. Use Capture Manually.",
  };
  if (businessReview[code as keyof typeof businessReview]) return businessReview[code as keyof typeof businessReview]!;
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
  return messages[code as KlaviyoAutomationFailureCode];
}

function automaticCaptureMessage(code: AutoCaptureFailureState["code"]): string {
  if (code === "CAPTURE_TARGET_NOT_ACTIVE") return "The prepared Klaviyo tab is no longer active, so no screenshot was captured.";
  if (code === "KLAVIYO_CAPTURE_PERMISSION_REQUIRED") return "To allow screenshot capture, keep the Klaviyo tab active and click the Tention Reports toolbar icon once.";
  if (code === "ACTIVE_TAB_LOOKUP_FAILED" || code === "VISIBLE_TAB_CAPTURE_FAILED" || code === "CAPTURE_TIMEOUT") return "The Klaviyo screenshot could not be captured. Try again or use Capture Manually.";
  return automationMessage(code);
}
