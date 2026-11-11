import { useEffect, useRef, useState } from "react";
import { MIN_KLAVIYO_VIEWPORT_WIDTH, formatZoom, klaviyoViewportTooNarrowMessage, type KlaviyoViewportNormalization, type KlaviyoZoomRestore } from "./klaviyo-viewport.js";
import { createScreenshotSourceProof, matchesReportCaptureSpec, screenshotSourceProofSchema, verifyBusinessPerformance, type BusinessPerformanceEvidence, type ClientReportTargets, type ReportDraft, type ScreenshotType } from "@tention/report-schema";
import type { ApiClient, AutomaticCaptureSectionResult } from "@tention/api-client";
import type { AutoCaptureFailureState, AutoCaptureService, AutoCaptureState, ExecutiveSummaryAutoCaptureRequest } from "./auto-capture-service.js";
import type { ChecklistItem } from "../report-checklist/checklist.js";
import { configuredAutomaticCaptureUrl } from "../screenshot-capture/capture-source-url.js";
import { mapViewportCropToImage } from "../screenshot-capture/crop-geometry.js";
import type { BusinessReviewTargetBounds } from "../klaviyo-navigation/business-review-capture.js";
import type { DashboardTargetBounds } from "../klaviyo-navigation/dashboard-capture.js";
import { TOP_CAMPAIGN_ROW_COUNT } from "../klaviyo-navigation/campaigns-capture.js";
import { classifyFailure, recoveryPlan, type RecoveryAction } from "./recovery-policy.js";

interface Props {
  api: ApiClient; report: ReportDraft; targets: ClientReportTargets | null; plan: ChecklistItem[]; service: AutoCaptureService; onClose(report?: ReportDraft): void;
  /** "resume" captures only `plan` (missing/stale sections) and keeps every other valid capture on the report. */
  mode?: "full" | "resume";
  /** The report's full automatic section list, for "10/10"-style numbering during a resume. */
  allSections?: ChecklistItem[];
}
type Result = { section: string; label: string; status: "pending" | "running" | "PASS" | "FAIL"; phase: "Preparing" | "Capturing"; durationMs: number | null; attempt: number; error: string | undefined };
type Target = BusinessReviewTargetBounds | DashboardTargetBounds;
// Transient page states (loading, rendering, filter applying, stale DOM, layout shifts, capture hiccups) get
// bounded retries; a programming/schema error is permanent and fails on its first attempt with the exact field.
const MAX_ATTEMPTS = 5;
/** The final recovery level's bounded pause before rebuilding the section from scratch. */
const COOL_DOWN_MS = 3_000;
const EXTENSION_BUILD = typeof __TENTION_BUILD__ === "string" ? __TENTION_BUILD__ : "unbundled";

const semantic: Partial<Record<ScreenshotType, { card: string; view: string | null }>> = {
  overview: { card: "Business performance summary", view: "Default" }, top_campaigns: { card: "Campaigns list", view: "Placed Order, descending" },
  top_flows: { card: "Top performing flows", view: "Default" }, month_comparison: { card: "Growth overview", view: "Message type breakdown" },
  campaign_performance: { card: "Campaign Performance Summary", view: "Overview" }, campaign_metrics: { card: "Campaign Performance Summary", view: "Metrics" },
  flow_performance: { card: "Flow Performance Summary", view: "Overview" }, flow_metrics: { card: "Flow Performance Summary", view: "Metrics" }, deliverability: { card: "Deliverability Score", view: "Email" },
  email_subscriber_growth: { card: "Subscriber growth", view: "Email → Growth" },
};

/** Local acceptance uses the real toolbar-authorized capture controllers but stores evidence outside canonical screenshots. */
export function LocalAutomaticAcceptanceRun({ api, report, targets, plan, service, onClose, mode = "full", allSections = plan }: Props) {
  const position = (section: string) => `${allSections.findIndex((item) => item.screenshotType === section) + 1}/${allSections.length}`;
  const [results, setResults] = useState<Result[]>(() => plan.map((item) => ({ section: item.screenshotType!, label: item.label, status: "pending", phase: "Preparing", durationMs: null, attempt: 0, error: undefined })));
  const [runId, setRunId] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const [paused, setPaused] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [runDurationMs, setRunDurationMs] = useState<number | null>(null);
  const [canonicalReport, setCanonicalReport] = useState<ReportDraft | null>(null);
  const started = useRef(false);
  const [zoom, setZoom] = useState<Extract<KlaviyoViewportNormalization, { ok: true }> | null>(null);
  const [zoomRestore, setZoomRestore] = useState<KlaviyoZoomRestore | null>(null);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
    // The acceptance transaction runs exactly once after the user presses Start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The user's Klaviyo zoom is restored however the run ends: completed, failed, timed out, or refused at preflight.
  async function run() {
    try { await runCapture(); }
    finally { setZoomRestore(await service.restoreKlaviyoZoom?.().catch(() => null) ?? null); }
  }

  async function runCapture() {
    const runStartedAt = new Date(); const runStart = performance.now(); const id = crypto.randomUUID(); setRunId(id);
    let persistedPassCount = 0;
    let normalization: KlaviyoViewportNormalization | null = null;
    try {
      // Chrome reloads the side panel from disk but keeps an un-restarted service worker on its old code, so
      // the panel's build stamp alone does not prove which page adapters will run.
      const workerBuild = service.getExtensionBuild ? await service.getExtensionBuild() : EXTENSION_BUILD;
      if (workerBuild !== EXTENSION_BUILD) throw new Error(`The extension service worker is running build ${workerBuild ?? "(unknown)"}, but this panel is build ${EXTENSION_BUILD}. Reload the extension in chrome://extensions, reopen the panel, and start again.`);
      // A too-narrow Klaviyo layout fails every section (the Time period picker does not open, cards clip). The
      // authorized tab is zoomed out just enough first; when even that cannot help, no run is created.
      if (service.normalizeKlaviyoViewport) {
        const normalized = await service.normalizeKlaviyoViewport();
        if (!normalized.ok) throw new Error(normalized.message);
        normalization = normalized; setZoom(normalized);
      }
      await api.startLocalAutomaticCaptureRun({ runId: id, reportId: report.id, clientId: report.client.id, reportMonth: report.reportMonth, startedAt: runStartedAt.toISOString(), extensionBuild: EXTENSION_BUILD, ...(mode === "resume" ? { mode, plannedSections: plan.map((item) => item.screenshotType!) } : {}) });
      // Capture states (each holding a full-viewport screenshot) left by earlier sections, runs, or months are released.
      await service.clearAll?.().catch(() => undefined);
    } catch (error) { setRunError(errorMessage(error, "Local acceptance diagnostics could not be started.")); setRunning(false); return; }

    // A consumed section's stored state (its full-viewport screenshot) is released at once, so states never accumulate.
    const release = async (request: ExecutiveSummaryAutoCaptureRequest | null) => { if (request) await service.clear(request).catch(() => undefined); };
    // This loop is an explicit barrier: each section's final backend acknowledgement
    // is awaited before the next section is allowed to begin.
    sectionLoop: for (let index = 0; index < plan.length; index += 1) {
      const item = plan[index]!; const type = item.screenshotType!; const sectionStart = performance.now();
      const sourceUrl = configuredAutomaticCaptureUrl(type, targets);
      const description = semantic[type] ?? { card: "Configured semantic reporting target", view: null };
      let proof = createScreenshotSourceProof(type, report.period);
      let passed = false; let finalError = "Capture did not complete."; let finalErrorCode = "AUTOMATIC_CAPTURE_FAILED";
      const attemptHistory: Record<string, unknown>[] = [];
      // Each retry escalates through the shared recovery policy instead of repeating the identical operation.
      let previousFailure: { code: string; message: string } | null = null; let earlierActions: RecoveryAction[] = [];
      let lastRequest: ExecutiveSummaryAutoCaptureRequest | null = null;
      setResults((current) => current.map((result) => result.section === type ? { ...result, status: "running", phase: "Preparing", attempt: 1, error: undefined } : result));

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const start = performance.now(); const startedAt = new Date().toISOString();
        const recovery = recoveryPlan(attempt, previousFailure, earlierActions); earlierActions = recovery.actions;
        const recoveryRecord = { PREVIOUS_FAILURE: recovery.previousFailure, FAILURE_CATEGORY: recovery.category, KNOWN_FAILURE: recovery.knownFailure, RECOVERY_LEVEL: recovery.level, RECOVERY_ACTION: recovery.actions };
        // Every stage has its own bound and timestamp, so a stuck stage is aborted and located instead of hanging the run.
        const stageTimeline: Record<string, string> = { attemptStartedAt: startedAt };
        const mark = (name: string) => { stageTimeline[name] = new Date().toISOString(); };
        const bounded = <T,>(work: Promise<T>, timeoutMs: number, code: string): Promise<T> => Promise.race([work, new Promise<never>((_, reject) => window.setTimeout(() => reject(Object.assign(new Error(`The ${code.replace(/_TIMEOUT$/, "").toLowerCase()} stage did not finish within ${timeoutMs / 1000} seconds.`), { code })), timeoutMs))]);
        let stage = "NAVIGATION"; let observedState: AutoCaptureState | null = null;
        let captureMs = 0; let cropMs = 0; let uploadMs = 0; let backendConfirmMs = 0;
        let persistedResult: AutomaticCaptureSectionResult = {
          status: "running", attemptNumber: attempt, startedAt, finishedAt: null, durationMs: null,
          expectedUrl: safeUrl(sourceUrl), observedUrl: null, expectedSourceIdentity: proof.sourceIdentity, observedSourceIdentity: null,
          expectedPeriod: type === "deliverability" ? null : { startDate: report.period.startDate, endDate: report.period.endDate, ...(type === "month_comparison" ? { comparisonStartDate: report.period.previousStartDate, comparisonEndDate: report.period.previousEndDate } : {}) },
          observedPeriod: null, expectedSemanticCard: description.card, expectedView: description.view, visibleControls: [], usableRowCount: null,
          screenshotResult: "pending", sourceProofResult: "pending", sha256: null, errorCode: null, errorMessage: null,
          diagnostics: { attemptNumber: attempt, maxAttempts: MAX_ATTEMPTS, stage, extensionBuild: EXTENSION_BUILD, recovery: recoveryRecord, attemptHistory: [...attemptHistory] },
        };
        setResults((current) => current.map((result) => result.section === type ? { ...result, status: "running", phase: "Preparing", attempt, error: undefined } : result));

        try {
          const confirmStarted = performance.now();
          await bounded(api.saveLocalAutomaticCaptureSection(id, type, persistedResult), 30_000, "PERSISTENCE_TIMEOUT");
          backendConfirmMs += Math.round(performance.now() - confirmStarted);
          // Every attempt starts with a fresh controller state and re-enters its
          // canonical source navigation; no prior DOM or capture state is reused. A new attempt id makes any write
          // from an abandoned earlier attempt of this section ignored.
          stage = "NAVIGATION";
          const request: ExecutiveSummaryAutoCaptureRequest = { reportId: report.id, screenshotType: type, accountUrl: sourceUrl, period: report.period, clientName: report.client.name, clientTimezone: report.client.timezone, conversionMetric: targets?.profile?.conversionMetric.label ?? "Placed Order", desiredCampaignCount: TOP_CAMPAIGN_ROW_COUNT, attemptId: crypto.randomUUID(), recovery: { level: recovery.level, actions: recovery.actions, previousFailure: recovery.previousFailure } };
          lastRequest = request;
          if (recovery.actions.includes("release-capture-state")) await service.clearAll?.().catch(() => undefined);
          if (recovery.actions.includes("cool-down-before-retry")) await new Promise((resolve) => window.setTimeout(resolve, COOL_DOWN_MS));
          await service.clear(request);
          // Re-checked before every attempt: a zoom or window change mid-run is normalized again before capturing.
          if (service.normalizeKlaviyoViewport) {
            const normalized = await bounded(service.normalizeKlaviyoViewport(), 30_000, "VIEWPORT_TIMEOUT");
            if (!normalized.ok) throw Object.assign(new Error(normalized.message), { code: normalized.code, permanent: normalized.code === "KLAVIYO_VIEWPORT_CANNOT_BE_NORMALIZED" });
            normalization = normalized; setZoom(normalized); mark("viewportNormalizedAt");
          }
          setResults((current) => current.map((result) => result.section === type ? { ...result, phase: "Capturing" } : result));
          const captureStartedAt = performance.now();
          stage = "PAGE_READY";
          mark("controllerStartRequestedAt");
          const initial = await service.start(request);
          const state = await settleState(service, request, initial, (next) => { if (next === "capturing" && !stageTimeline.preparedAt) mark("preparedAt"); if (next === "review_ready" || next === "failed") mark("captureReturnedAt"); });
          captureMs = Math.round(performance.now() - captureStartedAt);
          observedState = state;

          if (state.stage === "failed") throw Object.assign(new Error(state.message), { code: state.code, diagnostics: state.diagnostics ?? {}, failureState: state });
          if (state.stage !== "review_ready") throw Object.assign(new Error("Automatic capture ended in an unexpected state."), { code: "AUTOMATIC_CAPTURE_UNEXPECTED_STATE" });
          if (!(state.target.viewportWidth >= MIN_KLAVIYO_VIEWPORT_WIDTH)) throw Object.assign(new Error(klaviyoViewportTooNarrowMessage(state.target.viewportWidth)), { code: "KLAVIYO_VIEWPORT_TOO_NARROW" });

          stage = "VERIFYING_PERIOD";
          // Top Campaigns proof carries the adapter's read-only Campaigns-list evidence.
          if (type === "top_campaigns") {
            if (!state.campaignsEvidence) throw Object.assign(new Error("The Campaigns adapter returned no Top Campaigns evidence."), { code: "TOP_CAMPAIGNS_EVIDENCE_MISSING" });
            proof = createScreenshotSourceProof(type, report.period, undefined, state.campaignsEvidence);
          }
          // Section 10 proof carries the adapter's exact Email → Growth counts and chart proof.
          if (type === "email_subscriber_growth") {
            if (!state.subscriberGrowthEvidence) throw Object.assign(new Error("The Subscriber growth adapter returned no Email → Growth evidence."), { code: "SUBSCRIBER_GROWTH_EVIDENCE_MISSING" });
            proof = createScreenshotSourceProof(type, report.period, undefined, null, state.subscriberGrowthEvidence);
          }
          // The Executive Summary proof carries the report cover values, read from the period-verified card's DOM text.
          // Missing or inconsistent values fail this section (retried) instead of producing a cover that cannot be trusted.
          if (type === "overview") {
            const evidence = state.businessPerformanceEvidence ?? null;
            const issues = evidence ? coverIssues(evidence, report.client.currency) : (state.businessPerformanceIssues?.length ? state.businessPerformanceIssues : ["The Business performance summary values were not read."]);
            if (!evidence || issues.length) throw Object.assign(new Error(`Report cover values could not be verified: ${issues.join(" ")}`), { code: "EXECUTIVE_SUMMARY_METRICS_UNVERIFIED", diagnostics: { businessPerformance: evidence, businessPerformanceIssues: issues } });
            proof = createScreenshotSourceProof(type, report.period, undefined, null, null, evidence);
          }
          const proofShape = screenshotSourceProofSchema.safeParse(proof);
          if (!proofShape.success) throw Object.assign(new Error(`Source proof failed schema validation: ${proofShape.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`), { code: "SOURCE_PROOF_SCHEMA_INVALID", permanent: true });
          const periodOk = exactPeriod(state, report, type);
          const proofOk = matchesReportCaptureSpec(type, proof) && periodOk;
          if (!periodOk || !proofOk) throw Object.assign(new Error("The rendered period or canonical source-proof period did not match this report."), { code: "AUTOMATIC_PERIOD_PROOF_MISMATCH", diagnostics: { expectedSourceProof: proof, detectedPeriod: state.detectedPeriod, observedPeriod: state.periodEvidence ?? null } });

          stage = "CAPTURING";
          const cropStartedAt = performance.now();
          const crop = await bounded(cropTarget(state.captured.dataUrl, state.target, type), 15_000, "CROP_TIMEOUT");
          mark("cropCompletedAt");
          cropMs = Math.round(performance.now() - cropStartedAt);
          stage = "UPLOADING";
          const uploadStartedAt = performance.now();
          let acknowledgment: Awaited<ReturnType<ApiClient["saveLocalAutomaticCaptureEvidence"]>>;
          mark("uploadStartedAt");
          try { acknowledgment = await bounded(api.saveLocalAutomaticCaptureEvidence(id, type, "capture", crop, attempt), 30_000, "UPLOAD_TIMEOUT"); mark("uploadCompletedAt"); }
          finally { uploadMs = Math.round(performance.now() - uploadStartedAt); }
          stage = "VERIFYING_BACKEND_SAVE";
          const totalMs = Math.round(performance.now() - start);
          const passDiagnostics = {
            attemptNumber: attempt, maxAttempts: MAX_ATTEMPTS, extensionBuild: EXTENSION_BUILD, sourceProof: proof, sourceIdentity: proof.sourceIdentity,
            ...(type === "overview" && state.stage === "review_ready" && state.businessPerformanceReadout ? { businessPerformanceReadout: state.businessPerformanceReadout } : {}),
            expectedPeriod: proof.expectedPeriod, observedPeriod: state.periodEvidence ?? null, observedPeriodProof: state.periodEvidence ?? null, targetBounds: state.target,
            stageTimingsMs: { ...(state.target.stageTimingsMs ?? {}), navigationMs: numberTiming(state.target.stageTimingsMs, "navigationMs"), pageReadyMs: numberTiming(state.target.stageTimingsMs, "pageReadyMs"), periodSetMs: numberTiming(state.target.stageTimingsMs, "periodSetMs"), cardResolveMs: numberTiming(state.target.stageTimingsMs, "cardResolveMs"), viewSwitchMs: numberTiming(state.target.stageTimingsMs, "viewSwitchMs"), contentReadyMs: numberTiming(state.target.stageTimingsMs, "contentReadyMs"), captureMs, cropMs, uploadMs, backendConfirmMs, totalMs },
            attemptHistory: [...attemptHistory], capturedAt: new Date().toISOString(), fullPageScreenshot: "not available through Chrome extension visible-tab capture",
            recovery: recoveryRecord, stageTimeline, viewportNormalization: normalization,
          };
          persistedResult = { ...persistedResult, status: "pass", finishedAt: new Date().toISOString(), durationMs: totalMs, observedUrl: safeUrl(state.captured.sourceUrl), observedSourceIdentity: proof.sourceIdentity, observedPeriod: state.detectedPeriod, visibleControls: state.target.visibleControls ?? [], usableRowCount: typeof state.target.availableRowCount === "number" ? state.target.availableRowCount : null, screenshotResult: "fresh_semantic_crop_saved", sourceProofResult: "PASS", sha256: acknowledgment.sha256, diagnostics: passDiagnostics };
          const confirmPassStarted = performance.now();
          await bounded(api.saveLocalAutomaticCaptureSection(id, type, persistedResult), 30_000, "PERSISTENCE_TIMEOUT");
          mark("sectionResultSavedAt");
          backendConfirmMs += Math.round(performance.now() - confirmPassStarted);
          const finalTotalMs = Math.round(performance.now() - start);
          persistedResult = { ...persistedResult, durationMs: finalTotalMs, diagnostics: { ...passDiagnostics, stageTimingsMs: { ...passDiagnostics.stageTimingsMs, backendConfirmMs, totalMs: finalTotalMs } } };
          // Persist measured acknowledgement timing too; this second acknowledgement
          // remains inside the barrier and must succeed before N+1 can start.
          const timingConfirmStarted = performance.now();
          await bounded(api.saveLocalAutomaticCaptureSection(id, type, { ...persistedResult, diagnostics: { ...persistedResult.diagnostics, stageTimeline } }), 30_000, "PERSISTENCE_TIMEOUT");
          backendConfirmMs += Math.round(performance.now() - timingConfirmStarted);
          passed = true;
          const sectionDuration = Math.round(performance.now() - sectionStart);
          persistedPassCount += 1;
          await release(request);
          setResults((current) => current.map((result) => result.section === type ? { ...result, status: "PASS", durationMs: sectionDuration, attempt } : result));
          break;
        } catch (error) {
          finalErrorCode = errorCode(error); finalError = errorMessage(error, "Automatic capture failed.");
          previousFailure = { code: finalErrorCode, message: finalError };
          const classification = classifyFailure(finalErrorCode, finalError);
          mark("failedAt");
          const failureState = error && typeof error === "object" && "failureState" in error ? (error as { failureState?: AutoCaptureFailureState }).failureState : null;
          const diagnostic = error && typeof error === "object" && "diagnostics" in error ? (error as { diagnostics?: Record<string, unknown> }).diagnostics ?? null : null;
          const ready = observedState?.stage === "review_ready" ? observedState : null;
          const capturedFailure = failureState?.viewportScreenshot ?? (ready ? ready.captured : null);
          const totalMs = Math.round(performance.now() - start);
          let viewportEvidence = "not_available";
          if (capturedFailure) {
            try {
              const viewportAck = await bounded(api.saveLocalAutomaticCaptureEvidence(id, type, "viewport", dataUrlBlob(capturedFailure.dataUrl), attempt), 30_000, "UPLOAD_TIMEOUT");
              viewportEvidence = `saved:${viewportAck.sha256}`;
            } catch (evidenceError) { viewportEvidence = `failed:${errorCode(evidenceError)}`; }
          }
          const failedResult: AutomaticCaptureSectionResult = {
            ...persistedResult, status: "fail", finishedAt: new Date().toISOString(), durationMs: totalMs,
            observedUrl: safeUrl(typeof diagnostic?.currentUrl === "string" ? diagnostic.currentUrl : capturedFailure?.sourceUrl ?? null),
            // The adapter's fallback period text can be a whole page region; the backend caps this field, and a
            // rejected diagnostic write would pause the run before its retry. Full text stays in dateControlState.
            observedPeriod: boundedText(typeof diagnostic?.observedPeriod === "string" ? diagnostic.observedPeriod : ready?.detectedPeriod ?? null, OBSERVED_PERIOD_MAX_LENGTH),
            visibleControls: Array.isArray(diagnostic?.visibleControls) ? diagnostic.visibleControls as Record<string, unknown>[] : ready?.target.visibleControls ?? [],
            usableRowCount: typeof diagnostic?.usableRowCount === "number" ? diagnostic.usableRowCount : ready && typeof ready.target.availableRowCount === "number" ? ready.target.availableRowCount : null,
            screenshotResult: capturedFailure ? "failure_viewport_saved" : "not_available", sourceProofResult: "not_created_or_unverified",
            errorCode: finalErrorCode, errorMessage: finalError,
            diagnostics: { extensionBuild: EXTENSION_BUILD, recovery: recoveryRecord, failureCategory: classification.category, knownFailure: classification.knownFailure, stageTimeline, failureStage: stage === "NAVIGATION" || stage === "PAGE_READY" ? failureStageFromCode(finalErrorCode) : stage, failureCode: finalErrorCode, failureMessage: finalError, ...(diagnostic ?? {}), ...(ready ? { periodEvidence: ready.periodEvidence ?? null, targetBounds: ready.target } : {}), viewportEvidence, stageTimingsMs: { ...(isNumericRecord(diagnostic?.stageTimingsMs) ? diagnostic.stageTimingsMs : {}), ...(ready?.target.stageTimingsMs ?? {}), navigationMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "navigationMs"), pageReadyMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "pageReadyMs"), periodSetMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "periodSetMs"), cardResolveMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "cardResolveMs"), viewSwitchMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "viewSwitchMs"), contentReadyMs: numberTiming(diagnostic?.stageTimingsMs ?? ready?.target.stageTimingsMs, "contentReadyMs"), captureMs, cropMs, uploadMs, backendConfirmMs, totalMs }, attemptNumber: attempt, maxAttempts: MAX_ATTEMPTS, attemptHistory: [...attemptHistory] },
          };
          attemptHistory.push({ attemptNumber: attempt, ...recoveryRecord, failureCategory: classification.category, knownFailure: classification.knownFailure, stageTimeline: { ...stageTimeline }, startedAt, finishedAt: failedResult.finishedAt, durationMs: totalMs, failureStage: failedResult.diagnostics && typeof failedResult.diagnostics.failureStage === "string" ? failedResult.diagnostics.failureStage : stage, errorCode: finalErrorCode, errorMessage: finalError, expectedUrl: failedResult.expectedUrl, observedUrl: failedResult.observedUrl, expectedPeriod: failedResult.expectedPeriod, observedPeriod: failedResult.observedPeriod, stageTimingsMs: failedResult.diagnostics && typeof failedResult.diagnostics.stageTimingsMs === "object" ? failedResult.diagnostics.stageTimingsMs : {}, viewportEvidence });
          try { await bounded(api.saveLocalAutomaticCaptureSection(id, type, { ...failedResult, diagnostics: { ...failedResult.diagnostics, attemptHistory: [...attemptHistory] } }), 30_000, "PERSISTENCE_TIMEOUT"); }
          catch (saveError) {
            finalError = `Backend did not acknowledge attempt diagnostics: ${errorMessage(saveError, "local diagnostic write failed")}`;
            setPaused(true);
            setRunError(finalError);
            setResults((current) => current.map((result) => result.section === type ? { ...result, status: "FAIL", durationMs: Math.round(performance.now() - sectionStart), attempt, error: finalError } : result));
            await release(lastRequest);
            break sectionLoop;
          }
          if (attempt === MAX_ATTEMPTS || isPermanentFailure(error)) {
            await release(lastRequest);
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
        setRunError(`All ${plan.length} sections passed, but canonical report persistence is still being confirmed.`);
        const persisted = await api.importLocalAutomaticCaptureRun(id, report, mode === "resume" ? plan.map((item) => item.screenshotType!) : undefined);
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
  const confirmedCaptures = canonicalReport ? allSections.flatMap((item) => {
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
    <p className="support-copy">{running ? "The extension completes and confirms each section before starting the next. Existing report screenshots are not replaced; fresh evidence is staged for verified canonical persistence." : paused ? `${results.find(({ status }) => status === "FAIL")?.label ?? "The current section"} needs attention. Later sections were not started.` : passed === plan.length && canonicalReport ? `All ${allSections.length} captures are saved to this report and awaiting review.` : passed === plan.length ? `All ${plan.length} sections passed, but canonical report persistence was not confirmed. The report checklist remains unchanged.` : "Automatic capture finished."}</p>
    {current && <p role="status" className="notice">{position(current.section)} {current.label} — {current.phase} (attempt {current.attempt}/{MAX_ATTEMPTS})…</p>}
    {runId && <p className="support-copy">Diagnostic run ID: <code>{runId}</code></p>}
    <ul className="checklist runner-checklist">{results.map((result, index) => <li key={result.section}><span className={`check-icon ${result.status === "PASS" ? "approved" : result.status === "FAIL" ? "unapproved" : "pending"}`}>{result.status === "PASS" ? "✓" : result.status === "FAIL" ? "!" : result.status === "running" ? "…" : "○"}</span><span><strong>{position(result.section)} {result.label}</strong><small>{result.status === "pending" ? "Not started" : result.status === "running" ? `${result.phase} · attempt ${result.attempt}/${MAX_ATTEMPTS}` : result.status === "PASS" ? `PASS · ${(result.durationMs ?? 0) / 1000}s · ${result.attempt} attempt(s)` : `FAIL after ${result.attempt} attempt(s) · ${result.error ?? "See diagnostic details."}`}</small></span></li>)}</ul>
    {!running && <p role="status" className="notice">Fresh captures: {passed} / {plan.length} successful · {canonicalReport ? `${confirmedCaptures.length} / ${allSections.length} captured · ${confirmedPending} pending review · ${confirmedApproved} approved · ${allSections.length - confirmedCaptures.length} missing` : "canonical persistence not confirmed"} · Total duration: {((runDurationMs ?? 0) / 1000).toFixed(1)}s</p>}
    {zoom && <p className="support-copy">Klaviyo zoom: {formatZoom(zoom.originalZoom)} → {formatZoom(zoom.captureZoom)} for capture · viewport {Math.round(zoom.viewport.width)} px (minimum {MIN_KLAVIYO_VIEWPORT_WIDTH} px)</p>}
    {zoomRestore?.restored && <p className="support-copy">Klaviyo zoom restored to {formatZoom(zoomRestore.originalZoom)}.</p>}
    {runError && <p role="alert" className="notice error-notice">{runError}</p>}
    {!running && <button className="secondary" onClick={() => onClose(canonicalReport ?? undefined)}>Back to report</button>}
  </section></main>;
}

type TerminalAutoCaptureState = Extract<AutoCaptureState, { stage: "review_ready" | "failed" }>;
async function settleState(service: AutoCaptureService, request: ExecutiveSummaryAutoCaptureRequest, initial: AutoCaptureState, onStage: (stage: AutoCaptureState["stage"]) => void = () => undefined): Promise<TerminalAutoCaptureState> {
  let state = initial; const deadline = Date.now() + 120_000; onStage(state.stage);
  while ((state.stage === "preparing" || state.stage === "capturing") && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    state = await service.get(request) ?? state; onStage(state.stage);
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
/** Matches the backend's `observedPeriod` limit in the local automatic-capture section schema. */
const OBSERVED_PERIOD_MAX_LENGTH = 500;
function boundedText(value: string | null, maxLength: number): string | null { return value === null || value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`; }
function safeUrl(value: string | null): string | null { if (!value) return null; try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return null; } }
// Wrong account, lost authorization, missing configuration, or a login redirect will not change on retry
// (the shared recovery policy classifies them as permanent); everything else escalates through recovery levels.
function isPermanentFailure(value: unknown): boolean { return Boolean(value && typeof value === "object" && (("permanent" in value && value.permanent === true) || ("code" in value && typeof value.code === "string" && classifyFailure(value.code, "message" in value && typeof value.message === "string" ? value.message : "").permanent))); }
function errorCode(value: unknown): string { return value && typeof value === "object" && "code" in value && typeof value.code === "string" ? value.code : "AUTOMATIC_CAPTURE_FAILED"; }
function errorMessage(value: unknown, fallback: string): string { return value instanceof Error && value.message ? value.message : fallback; }
function isNumericRecord(value: unknown): value is Record<string, number> { return Boolean(value && typeof value === "object" && Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item))); }
function numberTiming(value: unknown, key: string): number { return isNumericRecord(value) ? value[key] ?? 0 : 0; }
function failureStageFromCode(code: string): string { if (/NAVIGATION|TAB|ROUTE|URL|GRANT/.test(code)) return "NAVIGATION"; if (/PERIOD|DATE|COMPARISON/.test(code)) return "PERIOD"; if (/CARD|TARGET/.test(code)) return "CARD_RESOLUTION"; if (/TAB|VIEW/.test(code)) return "VIEW_RESOLUTION"; if (/CONTENT|ROWS/.test(code)) return "CONTENT_READY"; if (/SCREENSHOT|CAPTURE/.test(code)) return "CAPTURE"; return "PAGE_READY"; }
// Codes are matched by whole words (BUSINESS_REVIEW_ROWS_NOT_FOUND is a rows failure, not a VIEW one), and the
// exact code and its recovery category are always shown so a summary can never misdirect an investigation.
function friendlyFailure(code: string): string {
  const words = new Set(code.split("_"));
  const has = (...names: string[]) => names.some((name) => words.has(name));
  const summary = has("PERIOD", "DATE", "COMPARISON") ? "The rendered reporting period could not be verified."
    : has("TAB", "VIEW") ? "The required reporting view could not be selected and verified."
    : has("CARD", "TARGET", "ROWS", "CONTENT", "CHART", "OCCLUDED") ? "The required report content could not be verified."
    : has("CAPTURE", "SCREENSHOT") ? "A fresh screenshot could not be captured."
    : "Automatic capture failed. Diagnostic details were saved for investigation.";
  return `${summary} (${code} · ${classifyFailure(code).category})`;
}

/** Cover value checks at capture time: all present; with a configured currency, exact, in that currency, and consistent. */
function coverIssues(evidence: BusinessPerformanceEvidence, currency: string | null): string[] {
  if (!currency) return (["totalRevenue", "emailAttributedRevenue", "campaignRevenue", "flowRevenue"] as const).filter((key) => !evidence[key]).map((key) => `${key} is missing.`);
  const verified = verifyBusinessPerformance(evidence, currency);
  return verified.ok ? [] : verified.issues.map(({ code, message }) => `${code}: ${message}`);
}
