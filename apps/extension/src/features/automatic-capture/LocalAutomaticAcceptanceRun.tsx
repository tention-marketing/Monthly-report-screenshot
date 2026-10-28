import { useEffect, useRef, useState } from "react";
import { createScreenshotSourceProof, matchesReportCaptureSpec, screenshotSourceProofSchema, type ClientReportTargets, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import type { ApiClient, AutomaticCaptureSectionResult } from "@tention/api-client";
import type { AutoCaptureFailureState, AutoCaptureService, AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { ChecklistItem } from "../report-checklist/checklist.js";
import { configuredAutomaticCaptureUrl } from "../screenshot-capture/capture-source-url.js";
import { mapViewportCropToImage } from "../screenshot-capture/crop-geometry.js";
import type { BusinessReviewTargetBounds } from "../klaviyo-navigation/business-review-capture.js";
import type { DashboardTargetBounds } from "../klaviyo-navigation/dashboard-capture.js";
import { TOP_CAMPAIGN_ROW_COUNT } from "../klaviyo-navigation/campaigns-capture.js";

interface Props { api: ApiClient; report: ReportDraft; targets: ClientReportTargets | null; plan: ChecklistItem[]; service: AutoCaptureService; onClose(report?: ReportDraft): void }
type Result = { section: string; label: string; status: "pending" | "running" | "PASS" | "FAIL"; phase: "Preparing" | "Capturing"; durationMs: number | null; attempt: number; error: string | undefined };
type Target = BusinessReviewTargetBounds | DashboardTargetBounds;
// Transient page states (loading, rendering, filter applying, stale DOM, layout shifts, capture hiccups) get
// bounded retries; a programming/schema error is permanent and fails on its first attempt with the exact field.
const MAX_ATTEMPTS = 5;
const EXTENSION_BUILD = typeof __TENTION_BUILD__ === "string" ? __TENTION_BUILD__ : "unbundled";

const semantic: Partial<Record<ScreenshotType, { card: string; view: string | null }>> = {
  overview: { card: "Business performance summary", view: "Default" }, top_campaigns: { card: "Campaigns list", view: "Placed Order, descending" },
  top_flows: { card: "Top performing flows", view: "Default" }, month_comparison: { card: "Growth overview", view: "Message type breakdown" },
  campaign_performance: { card: "Campaign Performance Summary", view: "Overview" }, campaign_metrics: { card: "Campaign Performance Summary", view: "Metrics" },
  flow_performance: { card: "Flow Performance Summary", view: "Overview" }, flow_metrics: { card: "Flow Performance Summary", view: "Metrics" }, deliverability: { card: "Deliverability Score", view: "Email" },
};

/** Local acceptance uses the real toolbar-authorized capture controllers but stores evidence outside canonical screenshots. */
export function LocalAutomaticAcceptanceRun({ api, report, targets, plan, service, onClose }: Props) {
  const [results, setResults] = useState<Result[]>(() => plan.map((item) => ({ section: item.screenshotType!, label: item.label, status: "pending", phase: "Preparing", durationMs: null, attempt: 0, error: undefined })));
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [paused, setPaused] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runDurationMs, setRunDurationMs] = useState<number | null>(null);
  const [canonicalReport, setCanonicalReport] = useState<ReportDraft | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // The acceptance transaction runs exactly once after the user presses Start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run() {
    const runStartedAt = new Date(); const runStart = performance.now(); const id = crypto.randomUUID(); setRunId(id);
    let persistedPassCount = 0;
    try {
      // Chrome reloads the side panel from disk but keeps an un-restarted service worker on its old code, so
      // the panel's build stamp alone does not prove which page adapters will run.
      const workerBuild = service.getExtensionBuild ? await service.getExtensionBuild() : EXTENSION_BUILD;
      if (workerBuild !== EXTENSION_BUILD) throw new Error(`The extension service worker is running build ${workerBuild ?? "(unknown)"}, but this panel is build ${EXTENSION_BUILD}. Reload the extension in chrome://extensions, reopen the panel, and start again.`);
      await api.startLocalAutomaticCaptureRun({ runId: id, reportId: report.id, clientId: report.client.id, reportMonth: report.reportMonth, startedAt: runStartedAt.toISOString(), extensionBuild: EXTENSION_BUILD });
    } catch (error) { setRunError(errorMessage(error, "Local acceptance diagnostics could not be started.")); setRunning(false); return; }

    // This loop is an explicit barrier: each section's final backend acknowledgement
    // is awaited before the next section is allowed to begin.
    sectionLoop: for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index]!; const type = item.screenshotType!; const sectionStart = performance.now();
      const sourceUrl = configuredAutomaticCaptureUrl(type, targets);
      const description = semantic[type] ?? { card: "Configured semantic reporting target", view: null };
      let proof = createScreenshotSourceProof(type, report.period);
      let passed = false; let finalError = "Capture did not complete."; let finalErrorCode = "AUTOMATIC_CAPTURE_FAILED";
      const attemptHistory: Record<string, unknown>[] = [];
      setResults((current) => current.map((result) => result.section === type ? { ...result, status: "running", phase: "Preparing", attempt: 1, error: undefined } : result));

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const start = performance.now(); const startedAt = new Date().toISOString();
        let stage = "NAVIGATION"; let observedState: AutoCaptureState | null = null;
        let captureMs = 0; let cropMs = 0; let uploadMs = 0; let backendConfirmMs = 0;
        let persistedResult: AutomaticCaptureSectionResult = {
          status: "running", attemptNumber: attempt, startedAt, finishedAt: null, durationMs: null,
          expectedUrl: safeUrl(sourceUrl), observedUrl: null, expectedSourceIdentity: proof.sourceIdentity, observedSourceIdentity: null,
          expectedPeriod: type === "deliverability" ? null : { startDate: report.period.startDate, endDate: report.period.endDate, ...(type === "month_comparison" ? { comparisonStartDate: report.period.previousStartDate, comparisonEndDate: report.period.previousEndDate } : {}) },
          observedPeriod: null, expectedSemanticCard: description.card, expectedView: description.view, visibleControls: [], usableRowCount: null,
          screenshotResult: "pending", sourceProofResult: "pending", sha256: null, errorCode: null, errorMessage: null,
          diagnostics: { attemptNumber: attempt, maxAttempts: MAX_ATTEMPTS, stage, extensionBuild: EXTENSION_BUILD, attemptHistory: [...attemptHistory] },
        };
        setResults((current) => current.map((result) => result.section === type ? { ...result, status: "running", phase: "Preparing", attempt, error: undefined } : result));

        try {
          const confirmStarted = performance.now();
          await api.saveLocalAutomaticCaptureSection(id, type, persistedResult);
          backendConfirmMs += Math.round(performance.now() - confirmStarted);
          // Every attempt starts with a fresh controller state and re-enters its
          // canonical source navigation; no prior DOM or capture state is reused.
          stage = "NAVIGATION";
          const request: ExecutiveSummaryAutoCaptureRequest = { reportId: report.id, screenshotType: type, accountUrl: sourceUrl, period: report.period, clientName: report.client.name, clientTimezone: report.client.timezone, conversionMetric: targets?.profile?.conversionMetric.label ?? "Placed Order", desiredCampaignCount: TOP_CAMPAIGN_ROW_COUNT };
          await service.clear(request);
          setResults((current) => current.map((result) => result.section === type ? { ...result, phase: "Capturing" } : result));
          const captureStartedAt = performance.now();
          stage = "PAGE_READY";
          const initial = await service.start(request);
          const state = await settleState(service, request, initial);
          captureMs = Math.round(performance.now() - captureStartedAt);
          observedState = state;

          if (state.stage === "failed") throw Object.assign(new Error(state.message), { code: state.code, diagnostics: state.diagnostics ?? {}, failureState: state });
          if (state.stage !== "review_ready") throw Object.assign(new Error("Automatic capture ended in an unexpected state."), { code: "AUTOMATIC_CAPTURE_UNEXPECTED_STATE" });

          stage = "VERIFYING_PERIOD";
          // Top Campaigns proof carries the adapter's read-only Campaigns-list evidence.
          if (type === "top_campaigns") {
            if (!state.campaignsEvidence) throw Object.assign(new Error("The Campaigns adapter returned no Top Campaigns evidence."), { code: "TOP_CAMPAIGNS_EVIDENCE_MISSING" });
            proof = createScreenshotSourceProof(type, report.period, undefined, state.campaignsEvidence);
          }
          const proofShape = screenshotSourceProofSchema.safeParse(proof);
          if (!proofShape.success) throw Object.assign(new Error(`Source proof failed schema validation: ${proofShape.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`), { code: "SOURCE_PROOF_SCHEMA_INVALID", permanent: true });
          const periodOk = exactPeriod(state, report, type);
          const proofOk = matchesReportCaptureSpec(type, proof) && periodOk;
          if (!periodOk || !proofOk) throw Object.assign(new Error("The rendered period or canonical source-proof period did not match this report."), { code: "AUTOMATIC_PERIOD_PROOF_MISMATCH", diagnostics: { expectedSourceProof: proof, detectedPeriod: state.detectedPeriod, observedPeriod: state.periodEvidence ?? null } });

          stage = "CAPTURING";
          const cropStartedAt = performance.now();
          const crop = await cropTarget(state.captured.dataUrl, state.target, type);
          cropMs = Math.round(performance.now() - cropStartedAt);
          stage = "UPLOADING";
          const uploadStartedAt = performance.now();
          let acknowledgment: Awaited<ReturnType<ApiClient["saveLocalAutomaticCaptureEvidence"]>>;
          try { acknowledgment = await api.saveLocalAutomaticCaptureEvidence(id, type, "capture", crop, attempt); }
          finally { uploadMs = Math.round(performance.now() - uploadStartedAt); }
          stage = "VERIFYING_BACKEND_SAVE";
          const totalMs = Math.round(performance.now() - start);
          const passDiagnostics = {
            attemptNumber: attempt, maxAttempts: MAX_ATTEMPTS, extensionBuild: EXTENSION_BUILD, sourceProof: proof, sourceIdentity: proof.sourceIdentity,
            expectedPeriod: proof.expectedPeriod, observedPeriod: state.periodEvidence ?? null, observedPeriodProof: state.periodEvidence ?? null, targetBounds: state.target,
            stageTimingsMs: { ...(state.target.stageTimingsMs ?? {}), navigationMs: numberTiming(state.target.stageTimingsMs, "navigationMs"), pageReadyMs: numberTiming(state.target.stageTimingsMs, "pageReadyMs"), periodSetMs: numberTiming(state.target.stageTimingsMs, "periodSetMs"), cardResolveMs: numberTiming(state.target.stageTimingsMs, "cardResolveMs"), viewSwitchMs: numberTiming(state.target.stageTimingsMs, "viewSwitchMs"), contentReadyMs: numberTiming(state.target.stageTimingsMs, "contentReadyMs"), captureMs, cropMs, uploadMs, backendConfirmMs, totalMs },
            attemptHistory: [...attemptHistory], capturedAt: new Date().toISOString(), fullPageScreenshot: "not available through Chrome extension visible-tab capture",
          };
          persistedResult = { ...persistedResult, status: "pass", finishedAt: new Date().toISOString(), durationMs: totalMs, observedUrl: safeUrl(state.captured.sourceUrl), observedSourceIdentity: proof.sourceIdentity, observedPeriod: state.detectedPeriod, visibleControls: state.target.visibleControls ?? [], usableRowCount: typeof state.target.availableRowCount === "number" ? state.target.availableRowCount : null, screenshotResult: "fresh_semantic_crop_saved", sourceProofResult: "PASS", sha256: acknowledgment.sha256, diagnostics: passDiagnostics };
          const confirmPassStarted = performance.now();
          await api.saveLocalAutomaticCaptureSection(id, type, persistedResult);
          backendConfirmMs += Math.round(performance.now() - confirmPassStarted);
          const finalTotalMs = Math.round(performance.now() - start);
          persistedResult = { ...persistedResult, durationMs: finalTotalMs, diagnostics: { ...passDiagnostics, stageTimingsMs: { ...passDiagnostics.stageTimingsMs, backendConfirmMs, totalMs: finalTotalMs } } };
          // Persist measured acknowledgement timing too; this second acknowledgement
          // remains inside the barrier and must succeed before N+1 can start.
          const timingConfirmStarted = performance.now();
          await api.saveLocalAutomaticCaptureSection(id, type, persistedResult);
          backendConfirmMs += Math.round(performance.now() - timingConfirmStarted);
          passed = true;
          const sectionDuration = Math.round(performance.now() - sectionStart);
          persistedPassCount += 1;
          setResults((current) => current.map((result) => result.section === type ? { ...result, status: "PASS", durationMs: sectionDuration, attempt } : result));
          break;
        } catch (error) {
          finalErrorCode = errorCode(error); finalError = errorMessage(error, "Automatic capture failed.");
          const failureState = error && typeof error === "object" && "failureState" in error ? (error as { failureState?: AutoCaptureFailureState }).failureState : null;
          const diagnostic = error && typeof error === "object" && "diagnostics" in error ? (error as { diagnostics?: Record<string, unknown> }).diagnostics ?? null : null;
          const ready = observedState?.stage === "review_ready" ? observedState : null;
          const capturedFailure = failureState?.viewportScreenshot ?? (ready ? ready.captured : null);
          const totalMs = Math.round(performance.now() - start);
          let viewportEvidence = "not_available";
          if (capturedFailure) {
            try {
              const viewportAck = await api.saveLocalAutomaticCaptureEvidence(id, type, "viewport", dataUrlBlob(capturedFailure.dataUrl), attempt);
              viewportEvidence = `saved:${viewportAck.sha256}`;
            } catch (evidenceError) { viewportEvidence = `failed:${errorCode(evidenceError)}`; }
          }
          const failedResult: AutomaticCaptureSectionResult = {
            ...persistedResult, status: "fail", finishedAt: new Date().toISOString(), durationMs: totalMs,
            observedUrl: safeUrl(typeof diagnostic?.currentUrl === "string" ? diagnostic.currentUrl : capturedFailure?.sourceUrl ?? null),
            observedPeriod: typeof diagnostic?.observedPeriod === "string" ? diagnostic.observedPeriod : ready?.detectedPeriod ?? null,
            visibleControls: Array.isArray(diagnostic?.visibleControls) ? diagnostic.visibleControls as Record<string, unknown>[] : ready?.target.visibleControls ?? [],
            usableRowCount: typeof diagnostic?.usableRowCount === "number" ? diagnostic.usableRowCount : ready && typeof ready.target.availableRowCount === "number" ? ready.target.availableRowCount : null,
            screenshotResult: capturedFailure ? "failure_viewport_saved" : "not_available", sourceProofResult: "not_created_or_unverified",
            errorCode: finalErrorCode, errorMessage: finalError,
            diagnostics: { extensionBuild: EXTENSION_BUILD, failureStage: stage === "NAVIGATION" || stage === "PAGE_READY" ? failureStageFromCode(finalErrorCode) : stage, failureCode: finalErrorCode, failureMessage: finalError, ...(diagnostic ?? {}), ...(ready ? { periodEvidence: ready.periodEvidence ?? null, targetBounds: ready.target } : {}), viewportEvidence, stageTimingsMs: { ...(isNumericRecord(diagnostic?.stageTimingsMs) ? diagnostic.stageTimingsMs : {}), ...(ready?.target.stageTimingsMs ?? {}), navigationMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "navigationMs"), pageReadyMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "pageReadyMs"), periodSetMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "periodSetMs"), cardResolveMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "cardResolveMs"), viewSwitchMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "viewSwitchMs"), contentReadyMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "contentReadyMs"), captureMs, cropMs, uploadMs, backendConfirmMs, totalMs }, attemptNumber: attempt, maxAttempts: MAX_ATTEMPTS, attemptHistory: [...attemptHistory] },
          };
          attemptHistory.push({ attemptNumber: attempt, startedAt, finishedAt: failedResult.finishedAt, durationMs: totalMs, failureStage: failedResult.diagnostics && typeof failedResult.diagnostics.failureStage === "string" ? failedResult.diagnostics.failureStage : stage, errorCode: finalErrorCode, errorMessage: finalError, expectedUrl: failedResult.expectedUrl, observedUrl: failedResult.observedUrl, expectedPeriod: failedResult.expectedPeriod, observedPeriod: failedResult.observedPeriod, stageTimingsMs: failedResult.diagnostics && typeof failedResult.diagnostics.stageTimingsMs === "object" ? failedResult.diagnostics.stageTimingsMs : {}, viewportEvidence });
          try { await api.saveLocalAutomaticCaptureSection(id, type, { ...failedResult, diagnostics: { ...failedResult.diagnostics, attemptHistory: [...attemptHistory] } }); }
          catch (saveError) {
            finalError = `Backend did not acknowledge attempt diagnostics: ${errorMessage(saveError, "local diagnostic write failed")}`;
            setPaused(true);
            setRunError(finalError);
            setResults((current) => current.map((result) => result.section === type ? { ...result, status: "FAIL", durationMs: Math.round(performance.now() - sectionStart), attempt, error: finalError } : result));
            break sectionLoop;
          }
          if (attempt === MAX_ATTEMPTS || isPermanentFailure(error)) {
            setPaused(true);
            setResults((current) => current.map((result) => result.section === type ? { ...result, status: "FAIL", durationMs: Math.round(performance.now() - sectionStart), attempt, error: isPermanentFailure(error) ? finalError : friendlyFailure(finalErrorCode) } : result));
            break sectionLoop;
          }
        }
      }
      if (!passed && !paused) {
        // A failed section only advances after its bounded retry policy. In this
        // acceptance mode we pause instead of producing misleading cascade FAILs.
        setPaused(true);
        setResults((current) => current.map((result) => result.section === type ? { ...result, status: "FAIL", durationMs: Math.round(performance.now() - sectionStart), attempt: MAX_ATTEMPTS, error: friendlyFailure(finalErrorCode) } : result));
        break;
      }
    }
    try {
      await api.finishLocalAutomaticCaptureRun(id, { status: persistedPassCount === plan.length ? "completed" : "failed", finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - runStart) });
      if (persistedPassCount === plan.length) {
        setRunError("All nine sections passed, but canonical report persistence is still being confirmed.");
        const persisted = await api.importLocalAutomaticCaptureRun(id, report);
        setCanonicalReport(persisted);
        setRunError(null);
      }
    }
    catch (error) { setRunError(`The capture run finished, but its final result could not be saved: ${errorMessage(error, "backend error")}`); }
    setRunDurationMs(Math.round(performance.now() - runStart));
    setRunning(false);
  }

  const passed = results.filter(({ status }) => status === "PASS").length;
  const current = results.find(({ status }) => status === "running");
  const confirmedCaptures = canonicalReport ? plan.flatMap((item) => {
    const type = item.screenshotType;
    const screenshot = type ? canonicalReport.screenshots.find((record) => record.type === type) : undefined;
    return screenshot && type && matchesReportCaptureSpec(type, screenshot.sourceProof)
      && screenshot.clientId === canonicalReport.client.id && screenshot.reportMonth.year === canonicalReport.reportMonth.year && screenshot.reportMonth.month === canonicalReport.reportMonth.month
      ? [screenshot] : [];
  }) : [];
  const confirmedPending = confirmedCaptures.filter((screenshot) => !screenshot.approved).length;
  const confirmedApproved = confirmedCaptures.filter((screenshot) => screenshot.approved).length;
  return <main className="capture-workflow"><section className="card" aria-live="polite">
    <p className="kicker">Local live acceptance</p><h1>{running ? "Automatic capture running" : paused ? "Automatic capture paused" : "Automatic capture finished"}</h1><p className="support-copy">Extension build {EXTENSION_BUILD}</p>
    {!running && <h2>AUTOMATIC CAPTURE RESULTS</h2>}
    <p className="support-copy">{running ? "The extension completes and confirms each section before starting the next. Existing report screenshots are not replaced; fresh evidence is staged for verified canonical persistence." : paused ? `${results.find(({ status }) => status === "FAIL")?.label ?? "The current section"} needs attention. Later sections were not started.` : passed === 9 && canonicalReport ? "All nine captures are saved to this report and awaiting review." : passed === 9 ? "All nine sections passed, but canonical report persistence was not confirmed. The report checklist remains unchanged." : "Automatic capture finished."}</p>
    {current && <p role="status" className="notice">{results.indexOf(current) + 1}/{plan.length} {current.label} — {current.phase} (attempt {current.attempt}/{MAX_ATTEMPTS})…</p>}
    {runId && <p className="support-copy">Diagnostic run ID: <code>{runId}</code></p>}
    <ul className="checklist runner-checklist">{results.map((result, index) => <li key={result.section}><span className={`check-icon ${result.status === "PASS" ? "approved" : result.status === "FAIL" ? "unapproved" : "pending"}`}>{result.status === "PASS" ? "✓" : result.status === "FAIL" ? "!" : result.status === "running" ? "…" : "○"}</span><span><strong>{index + 1}/9 {result.label}</strong><small>{result.status === "pending" ? "Not started" : result.status === "running" ? `${result.phase} · attempt ${result.attempt}/${MAX_ATTEMPTS}` : result.status === "PASS" ? `PASS · ${(result.durationMs ?? 0) / 1000}s · ${result.attempt} attempt(s)` : `FAIL after ${result.attempt} attempt(s) · ${result.error ?? "See diagnostic details."}`}</small></span></li>)}</ul>
    {!running && <p role="status" className="notice">Fresh captures: {passed} / {plan.length} successful · {canonicalReport ? `${confirmedCaptures.length} captured · ${confirmedPending} pending review · ${confirmedApproved} approved · ${plan.length - confirmedCaptures.length} missing` : "canonical persistence not confirmed"} · Total duration: {((runDurationMs ?? 0) / 1000).toFixed(1)}s</p>}
    {runError && <p role="alert" className="notice error-notice">{runError}</p>}
    {!running && <button className="secondary" onClick={() => onClose(canonicalReport ?? undefined)}>Back to report</button>}
  </section></main>;
}

type TerminalAutoCaptureState = Extract<AutoCaptureState, { stage: "review_ready" | "failed" }>;
async function settleState(service: AutoCaptureService, request: ExecutiveSummaryAutoCaptureRequest, initial: AutoCaptureState): Promise<TerminalAutoCaptureState> {
  let state = initial; const deadline = Date.now() + 120_000;
  while ((state.stage === "preparing" || state.stage === "capturing") && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    state = await service.get(request) ?? state;
  }
  if (state.stage === "preparing" || state.stage === "capturing") return { request, stage: "failed", code: "CAPTURE_TIMEOUT", message: "The semantic reporting view did not finish within 120 seconds." };
  return state as TerminalAutoCaptureState;
}
function exactPeriod(state: Extract<AutoCaptureState, { stage: "review_ready" }>, report: ReportDraft, type: ScreenshotType): boolean {
  if (type === "deliverability") return true; // Klaviyo explicitly defines this card as a rolling last-30-day score.
  const value = state.periodEvidence;
  if (!value || value.startDate !== report.period.startDate || value.endDate !== report.period.endDate) return false;
  if (type === "month_comparison") return value.comparisonStartDate === report.period.previousStartDate && value.comparisonEndDate === report.period.previousEndDate;
  return true;
}
async function cropTarget(source: string, target: Target, type: ScreenshotType): Promise<Blob> {
  const image = await loadImage(source);
  const rect = mapViewportCropToImage({ x: target.x, y: target.y, width: target.width, height: target.height }, target.viewportWidth, target.viewportHeight, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas"); canvas.width = rect.width; canvas.height = rect.height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("Screenshot crop canvas could not be created.");
  context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Screenshot crop could not be encoded.")), "image/png"));
  if (!blob.size) throw new Error(`The ${type} semantic screenshot crop was empty.`);
  return blob;
}
function loadImage(source: string): Promise<HTMLImageElement> { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("Captured Klaviyo viewport PNG could not be decoded.")); image.src = source; }); }
function dataUrlBlob(value: string): Blob { const [header, data] = value.split(","); const type = header?.match(/data:([^;]+)/)?.[1] ?? "image/png"; const binary = atob(data ?? ""); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); return new Blob([bytes], { type }); }
function safeUrl(value: string | null): string | null { if (!value) return null; try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return null; } }
// Wrong account, missing authorization/configuration, or a source the run cannot reach will not change on retry.
const PERMANENT_FAILURE_CODES = new Set(["ACCOUNT_CONTEXT_MISMATCH", "ACTION_NOT_INVOKED", "KLAVIYO_ACTIVE_TAB_GRANT_REQUIRED", "KLAVIYO_CAPTURE_PERMISSION_REQUIRED", "CAPTURE_PERMISSION_DENIED", "GRANTED_TAB_CLOSED", "GRANTED_TAB_CHANGED_ORIGIN", "BUSINESS_REVIEW_URL_REQUIRED", "DASHBOARD_URL_REQUIRED", "DELIVERABILITY_SCORE_URL_REQUIRED", "CAMPAIGNS_ROUTE_REQUIRED", "SOURCE_PROOF_SCHEMA_INVALID"]);
function isPermanentFailure(value: unknown): boolean { return Boolean(value && typeof value === "object" && (("permanent" in value && value.permanent === true) || ("code" in value && typeof value.code === "string" && PERMANENT_FAILURE_CODES.has(value.code)))); }
function errorCode(value: unknown): string { return value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : "AUTOMATIC_CAPTURE_FAILED"; }
function errorMessage(value: unknown, fallback: string): string { return value instanceof Error && value.message ? value.message : fallback; }
function isNumericRecord(value: unknown): value is Record<string, number> { return Boolean(value && typeof value === "object" && Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item))); }
function numberTiming(value: unknown, key: string): number { return isNumericRecord(value) ? value[key] ?? 0 : 0; }
function failureStageFromCode(code: string): string { if (/NAVIGATION|TAB|ROUTE|URL|GRANT/.test(code)) return "NAVIGATION"; if (/PERIOD|DATE|COMPARISON/.test(code)) return "PERIOD"; if (/CARD|TARGET/.test(code)) return "CARD_RESOLUTION"; if (/TAB|VIEW/.test(code)) return "VIEW_RESOLUTION"; if (/CONTENT|ROWS/.test(code)) return "CONTENT_READY"; if (/SCREENSHOT|CAPTURE/.test(code)) return "CAPTURE"; return "PAGE_READY"; }
function friendlyFailure(code: string): string {
  if (/PERIOD|DATE|COMPARISON/.test(code)) return "The rendered reporting period could not be verified.";
  if (/TAB|VIEW/.test(code)) return "The required reporting view could not be selected and verified.";
  if (/CARD|TARGET|ROWS|CONTENT/.test(code)) return "The required report content could not be verified.";
  if (/CAPTURE|SCREENSHOT/.test(code)) return "A fresh screenshot could not be captured.";
  return "Automatic capture failed. Diagnostic details were saved for investigation.";
}
