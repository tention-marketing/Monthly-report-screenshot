import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ApiClient, type DevelopmentReviewPdfStatus, type ReportMutationEvent } from "@tention/api-client";
import { extensionApiBaseUrl } from "../lib/api/client.js";
import {
  automaticCaptureTypesForSections, finalGenerationDataBlockers, isAcceptedCapture, isValidIanaTimeZone, klaviyoAccountDisplayName, reportCover,
  type ClientReportTargets, type ClientSetupSummary, type FinalGenerationBlocker, type ClientReportTargetsInput, type ReportDraft, type ReportPdfArtifact, type ReportReadiness, type ReportValidationState,
} from "@tention/report-schema";
import { buildReportChecklist } from "../features/report-checklist/checklist.js";
import type { ChecklistItem } from "../features/report-checklist/checklist.js";
import { CaptureWorkflow, type CaptureUploadStatus } from "../features/screenshot-capture/CaptureWorkflow.js";
import { unavailableCaptureService, type CaptureService } from "../features/screenshot-capture/capture-service.js";
import { getAutomaticCapturePlan, getReportRunnerState } from "../features/report-runner/runner.js";
import { unavailableKlaviyoNavigationService, type KlaviyoNavigationService } from "../features/klaviyo-navigation/navigation-service.js";
import { unavailableAutoCaptureService, type AutoCaptureService } from "../features/automatic-capture/auto-capture-service.js";
import { LocalAutomaticAcceptanceRun } from "../features/automatic-capture/LocalAutomaticAcceptanceRun.js";
import { approveAllAndFinalize, approveAllBlockers, autoGenerationBlockers, FinalizeError, type FinalizeProgress } from "../features/final-report/approve-and-finalize.js";
import type { ToolbarInvocationDiagnostics } from "../features/klaviyo-navigation/active-tab-grant.js";
import type { CampaignsSourceInspectionResult } from "../features/klaviyo-navigation/campaigns-source-inspector.js";
import {
  formatCalendarRange, formatReportMonth, toMonthValue,
} from "../lib/dates/month-options.js";
import { ClientTargetEditor, supportedTimeZones, targetInput } from "../features/clients/client-targets.js";
import { ClientsWorkspace, missingItemLabel, type ClientSetupDiscovery, type ReportSync } from "../features/clients/ClientsWorkspace.js";
import type { ConversionMetricSourceResult, DeliverabilitySourceRequest, DeliverabilitySourceResult } from "../features/klaviyo-navigation/client-setup-sources.js";
import { discoverBusinessReview, discoverSubscriberGrowthSource, getSessionStorageUsage, reportSubscriberGrowthSourcePersisted, takeConversionMetricSource, verifyDeliverabilitySource, watchVerifiedConversionMetricSource, watchVerifiedSubscriberGrowthSource } from "../features/automatic-capture/auto-capture-service.js";
import type { SubscriberGrowthDiscoveryResult } from "../features/klaviyo-navigation/subscriber-growth-source-setup.js";

/** One-time Subscriber Growth source setup hooks (service-worker transaction); injectable for tests. */
export interface SubscriberGrowthSourceHooks {
  take(): Promise<SubscriberGrowthDiscoveryResult>;
  persisted(input: { saved: boolean; sourceUrl: string | null; failureCode?: string | null }): Promise<unknown>;
  watch(callback: () => void): () => void;
}
const chromeSubscriberGrowthSourceHooks: SubscriberGrowthSourceHooks = { take: discoverSubscriberGrowthSource, persisted: reportSubscriberGrowthSourcePersisted, watch: watchVerifiedSubscriberGrowthSource };
import type { BusinessReviewDiscoveryRequest, BusinessReviewDiscoveryResult } from "../features/klaviyo-navigation/business-review-discovery.js";
import { classifyPreflightFailure, watchToolbarInvocation, type PreflightBlocker } from "../features/automatic-capture/preflight-blocker.js";

type ConnectionState = "checking" | "connected" | "unavailable";
const ACTIVE_REPORT_STORAGE_KEY = "tention.active-report-id";
const pendingCaptureStorageKey = (reportId: string) => `tention.pending-capture.${reportId}`;

function readSessionValue(key: string): string | null {
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}
function writeSessionValue(key: string, value: string | null): void {
  try { if (value) window.sessionStorage.setItem(key, value); else window.sessionStorage.removeItem(key); } catch { /* session restore is best effort only */ }
}

export interface AppProps { api: ApiClient; captureService?: CaptureService; navigationService?: KlaviyoNavigationService; automaticCaptureService?: AutoCaptureService; discoverBusinessReviewSource?: (input: BusinessReviewDiscoveryRequest) => Promise<BusinessReviewDiscoveryResult>; subscriberGrowthSource?: SubscriberGrowthSourceHooks;
  /** Subscribes to Tention Reports toolbar clicks (the activeTab grant); injectable for tests. */
  watchToolbarClick?: (callback: () => void) => () => void; now?: () => Date;
  /** Client-setup verifiers for the metric page and Deliverability; injectable for tests. */
  clientSetupSources?: ClientSetupSources }
export interface ClientSetupSources {
  verifyDeliverability(request: DeliverabilitySourceRequest): Promise<DeliverabilitySourceResult>;
  takeConversionMetric(): Promise<ConversionMetricSourceResult>;
  watchConversionMetric(callback: () => void): () => void;
}
const chromeClientSetupSources: ClientSetupSources = { verifyDeliverability: verifyDeliverabilitySource, takeConversionMetric: takeConversionMetricSource, watchConversionMetric: watchVerifiedConversionMetricSource };
function safeApiDisplayUrl(value: string): string {
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, "")}`; }
  catch { return "Configured API"; }
}
function safeSourceDisplay(value: string | null): string {
  if (!value) return "unknown";
  try { const url = new URL(value); return `${url.protocol}//${url.host}${url.pathname}`; }
  catch { return "unavailable"; }
}
function localImportedReviewEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try { return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(extensionApiBaseUrl).hostname); }
  catch { return false; }
}
function businessReviewDiscoveryDebug(result: BusinessReviewDiscoveryResult): Record<string, string> {
  const diagnostics = result.ok ? {} : result.diagnostics ?? {};
  const value = (key: string, fallback = "—") => {
    const entry = diagnostics[key];
    return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ? String(entry) : fallback;
  };
  return {
    result: result.ok ? "verified" : result.code,
    stage: value("discoveryStage", result.ok ? "VERIFIED" : "unknown"),
    selectedClient: value("selectedClientName"),
    tabFound: value("activeTabFound"), tabId: value("tabId"), hostname: value("tabHostname"),
    urlEligible: value("urlEligible"), permission: value("permissionResult"),
    injection: value("scriptInjectionResult"), resultReturned: value("inspectionResultReturned"),
    headings: value("visibleHeadingsCount"), links: value("visibleLinksCount"),
    viewDashboardCandidates: value("viewDashboardCandidateCount"), businessReviewCandidates: value("businessReviewCandidateCount"),
    errorCode: value("typedErrorCode", result.ok ? "none" : result.code), error: value("safeErrorMessage", result.ok ? "none" : result.message),
    account: result.ok ? result.accountLabel : value("accountLabel"),
    accountSource: value("accountContextSource"), accountCandidates: Array.isArray(diagnostics.accountLabelCandidates) ? diagnostics.accountLabelCandidates.filter((candidate): candidate is string => typeof candidate === "string").join(" · ") || "none" : "—",
    providerIdentity: result.ok ? `${result.providerIdentityKind ?? "display"}${result.providerAccountId ? `:${result.providerAccountId}` : ""}` : value("providerIdentityKind", "display-only"),
    currentPage: value("currentUrl", value("observedUrl")),
  };
}

export function App({ api, captureService = unavailableCaptureService, navigationService = unavailableKlaviyoNavigationService, automaticCaptureService = unavailableAutoCaptureService, discoverBusinessReviewSource = discoverBusinessReview, subscriberGrowthSource = chromeSubscriberGrowthSourceHooks, watchToolbarClick = watchToolbarInvocation, now = () => new Date(), clientSetupSources = chromeClientSetupSources }: AppProps) {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const discovery = useMemo<ClientSetupDiscovery>(() => ({ ...clientSetupSources, verifyAccount: discoverBusinessReviewSource, subscriberGrowth: subscriberGrowthSource, watchToolbarClick }), [clientSetupSources, discoverBusinessReviewSource, subscriberGrowthSource, watchToolbarClick]);
  /** A report just created from "Create & Start Automatic Capture": its screen starts the capture once. */
  const [autoStartReportId, setAutoStartReportId] = useState<string | null>(null);
  const [recent, setRecent] = useState<ReportDraft[]>([]);
  const [report, setReport] = useState<ReportDraft | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReportDraft | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Every report list on screen (Recent Reports, a client's Reports) is reconciled through one step after a report is
  // deleted or found missing: `reportSync` tells the client page which IDs are gone and to refetch from the API.
  const [reportSync, setReportSync] = useState<ReportSync>({ revision: 0, removedIds: [] });
  /** The client page to show when the screen returns from a report that no longer exists. */
  const [returnToClientId, setReturnToClientId] = useState<string | null>(null);
  const recentRef = useRef(recent); recentRef.current = recent;
  const reportRef = useRef(report); reportRef.current = report;
  const reloadRecent = useCallback(async () => {
    try { const items = await api.listReportDrafts(); if (Array.isArray(items)) setRecent(items); } catch { /* the local removal stands; the next load is authoritative */ }
  }, [api]);
  const reconcileRemovedReport = useCallback(async (reportId: string, clientId: string | null) => {
    setRecent((items) => items.filter((item) => item.id !== reportId));
    setReportSync((current) => ({ revision: current.revision + 1, removedIds: current.removedIds.includes(reportId) ? current.removedIds : [...current.removedIds, reportId] }));
    if (readSessionValue(ACTIVE_REPORT_STORAGE_KEY) === reportId) writeSessionValue(ACTIVE_REPORT_STORAGE_KEY, null);
    if (reportRef.current?.id === reportId) { setReport(null); setReturnToClientId(clientId ?? reportRef.current.client.id); }
    setError(null);
    await reloadRecent();
  }, [reloadRecent]);

  const connect = useCallback(async () => {
    setConnection("checking"); setError(null);
    try {
      await api.health();
      setConnection("connected");
      setRecent(await api.listReportDrafts());
    } catch { setConnection("unavailable"); }
  }, [api]);
  useEffect(() => { void connect(); }, [connect]);

  const openReport = useCallback(async (id: string) => {
    setLoadingReport(true); setError(null);
    try { const loaded = await api.getReportDraft(id); setReport(loaded); setReturnToClientId(null); writeSessionValue(ACTIVE_REPORT_STORAGE_KEY, loaded.id); }
    catch (caught) {
      if (caught instanceof ApiError && (caught.code === "REPORT_NOT_FOUND" || caught.status === 404)) {
        // A stale link or a report deleted elsewhere: drop it everywhere and return to its client when known.
        const clientId = recentRef.current.find((item) => item.id === id)?.client.id ?? null;
        writeSessionValue(ACTIVE_REPORT_STORAGE_KEY, null);
        setReturnToClientId(clientId);
        setNotice("That report no longer exists.");
        await reconcileRemovedReport(id, clientId);
      } else setError("The report could not be loaded.");
    }
    finally { setLoadingReport(false); }
  }, [api, reconcileRemovedReport]);
  useEffect(() => {
    if (connection !== "connected" || report || loadingReport) return;
    const reportId = readSessionValue(ACTIVE_REPORT_STORAGE_KEY);
    if (reportId) void openReport(reportId);
  }, [connection, loadingReport, openReport, report]);
  useEffect(() => {
    if (!report) return;
    let active = true;
    void (async () => { try { const items = await api.listReportDrafts(); if (active && Array.isArray(items)) setRecent(items); } catch { /* report remains loaded from its canonical endpoint */ } })();
    return () => { active = false; };
  }, [api, report?.id, report?.version]);
  const startNewReport = useCallback(() => { writeSessionValue(ACTIVE_REPORT_STORAGE_KEY, null); setReturnToClientId(null); setReport(null); }, []);
  const requestReportDeletion = useCallback((target: ReportDraft) => {
    setDeleteTarget(target); setDeleteConfirmation(""); setDeleteError(null);
  }, []);
  const cancelReportDeletion = useCallback(() => {
    if (!deleteBusy) { setDeleteTarget(null); setDeleteConfirmation(""); setDeleteError(null); }
  }, [deleteBusy]);
  const deleteReport = useCallback(async () => {
    if (!deleteTarget || deleteConfirmation !== "DELETE") return;
    setDeleteBusy(true); setDeleteError(null);
    try {
      await api.deleteReportDraft(deleteTarget.id, deleteTarget.version);
      setNotice(`${formatReportMonth(deleteTarget.reportMonth)} report deleted.`); setDeleteTarget(null); setDeleteConfirmation("");
      await reconcileRemovedReport(deleteTarget.id, deleteTarget.client.id);
    } catch (caught) {
      setDeleteError(caught instanceof ApiError && caught.code === "REPORT_VERSION_CONFLICT"
        ? "This report was updated somewhere else. Reload recent reports before deleting it."
        : caught instanceof ApiError ? caught.message : "Report could not be deleted.");
    } finally { setDeleteBusy(false); }
  }, [api, deleteConfirmation, deleteTarget, reconcileRemovedReport]);

  return <div className="app-shell">
    <header className="brand-row">
      <div><p className="eyebrow">Tention Reports</p><span className={`connection ${connection}`}>{connection === "checking" ? "Checking API…" : connection === "connected" ? "Connected" : "API unavailable"}</span></div>
      {report && <button className="text-button" onClick={startNewReport}>Clients</button>}
    </header>
    {connection === "unavailable" && <section className="notice error-notice"><p>The reporting API could not be reached.</p><button onClick={() => void connect()}>Retry connection</button></section>}
    {error && <p role="alert" className="notice error-notice">{error}</p>}
    {loadingReport ? <p className="loading">Loading report…</p> : report
      ? <ReportDetail api={api} captureService={captureService} navigationService={navigationService} automaticCaptureService={automaticCaptureService} discoverBusinessReviewSource={discoverBusinessReviewSource} subscriberGrowthSource={subscriberGrowthSource} watchToolbarClick={watchToolbarClick} report={report} autoStart={autoStartReportId === report.id} onAutoStarted={() => setAutoStartReportId(null)} onReport={(updated) => { setReport(updated); writeSessionValue(ACTIVE_REPORT_STORAGE_KEY, updated.id); }} onStartNew={startNewReport} onRequestDelete={requestReportDeletion} />
      : <Home api={api} connected={connection === "connected"} recent={recent} notice={notice} now={now} discovery={discovery} reportSync={reportSync} returnToClientId={returnToClientId} onReportDeleted={(deleted) => { setNotice(null); void reconcileRemovedReport(deleted.id, deleted.client.id); }} onCreated={(created, options) => { if (options.autoStart) setAutoStartReportId(created.id); setReport(created); writeSessionValue(ACTIVE_REPORT_STORAGE_KEY, created.id); setRecent((items) => [created, ...items.filter((item) => item.id !== created.id)]); }} onOpen={openReport} onRequestDelete={requestReportDeletion} />}
    {deleteTarget && <ReportDeleteDialog report={deleteTarget} confirmation={deleteConfirmation} busy={deleteBusy} error={deleteError} onConfirmation={setDeleteConfirmation} onCancel={cancelReportDeletion} onDelete={() => void deleteReport()} />}
  </div>;
}

interface HomeProps {
  api: ApiClient; connected: boolean; recent: ReportDraft[]; now: () => Date; discovery: ClientSetupDiscovery;
  notice: string | null; reportSync: ReportSync; returnToClientId: string | null; onReportDeleted(report: ReportDraft): void;
  onCreated(report: ReportDraft, options: { autoStart: boolean }): void; onOpen(id: string): void; onRequestDelete(report: ReportDraft): void;
}

/** Phase 1 (client setup) and phase 2 (monthly reports) start from the client list; recent reports stay one click away. */
function Home({ api, connected, recent, notice, now, discovery, reportSync, returnToClientId, onReportDeleted, onCreated, onOpen, onRequestDelete }: HomeProps) {
  return <main>
    {notice && <p role="status" className="notice success-notice">{notice}</p>}
    <ClientsWorkspace api={api} connected={connected} now={now} discovery={discovery} initialClientId={returnToClientId} reportSync={reportSync} onReportDeleted={onReportDeleted} onReportCreated={onCreated} onOpenReport={onOpen} />
    <RecentReports reports={recent} onOpen={onOpen} onRequestDelete={onRequestDelete} />
  </main>;
}

function RecentReports({ reports, onOpen, onRequestDelete }: { reports: ReportDraft[]; onOpen(id: string): void; onRequestDelete(report: ReportDraft): void }) {
  return <section className="card"><h2>Recent Reports</h2>{reports.length === 0 ? <p className="empty">No reports yet.</p> : <ul className="recent-list">{reports.map((report) => <li key={report.id}><div className="recent-report"><strong>{report.client.name}</strong><span>{formatReportMonth(report.reportMonth)} · {humanize(report.status)}</span><small>Updated {new Date(report.updatedAt).toLocaleString()}</small></div><div className="recent-actions"><button onClick={() => onOpen(report.id)}>Open Report</button><button className="danger" onClick={() => onRequestDelete(report)}>Delete Report</button></div></li>)}</ul>}</section>;
}

function ReportDetail({ api, captureService, navigationService, automaticCaptureService, discoverBusinessReviewSource, subscriberGrowthSource, watchToolbarClick, report, autoStart = false, onAutoStarted, onReport, onStartNew, onRequestDelete }: { api: ApiClient; captureService: CaptureService; navigationService: KlaviyoNavigationService; automaticCaptureService: AutoCaptureService; discoverBusinessReviewSource(input: BusinessReviewDiscoveryRequest): Promise<BusinessReviewDiscoveryResult>; subscriberGrowthSource: SubscriberGrowthSourceHooks; watchToolbarClick: (callback: () => void) => () => void; report: ReportDraft; autoStart?: boolean; onAutoStarted?(): void; onReport(report: ReportDraft): void; onStartNew(): void; onRequestDelete(report: ReportDraft): void }) {
  const [validation, setValidation] = useState<ReportValidationState>(report.validation);
  const [history, setHistory] = useState<Awaited<ReturnType<ApiClient["getReportHistory"]>>>([]);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [captureItem, setCaptureItem] = useState<ChecklistItem | null>(null);
  const [runnerStarted, setRunnerStarted] = useState(false);
  const [automaticRunnerStarted, setAutomaticRunnerStarted] = useState(false);
  const [automaticRunQueue, setAutomaticRunQueue] = useState<ChecklistItem[]>([]);
  const [automaticRunIndex, setAutomaticRunIndex] = useState(0);
  const [localAutomaticAcceptanceActive, setLocalAutomaticAcceptanceActive] = useState(false);
  const [localAutomaticRunMode, setLocalAutomaticRunMode] = useState<"full" | "resume">("full");
  // A resume run's exact plan: the missing/stale sections, or the one pending section chosen for "Retake saved capture".
  const [resumePlan, setResumePlan] = useState<ChecklistItem[] | null>(null);
  const [subscriberGrowthSetupDiagnostics, setSubscriberGrowthSetupDiagnostics] = useState<Record<string, unknown> | null>(null);
  const [sessionStorageUsage, setSessionStorageUsage] = useState<Awaited<ReturnType<typeof getSessionStorageUsage>> | "unavailable" | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [importedReviewItem, setImportedReviewItem] = useState<ChecklistItem | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [toolbarDiagnostics, setToolbarDiagnostics] = useState<ToolbarInvocationDiagnostics | null>(null);
  const [campaignsSourceInspection, setCampaignsSourceInspection] = useState<CampaignsSourceInspectionResult | null>(null);
  const [businessReviewDiscoveryDiagnostics, setBusinessReviewDiscoveryDiagnostics] = useState<Record<string, string> | null>(null);
  const [pdfArtifact, setPdfArtifact] = useState<ReportPdfArtifact | null>(null);
  // A fully validated automatic capture generates the final report on its own; "Approve All" is optional QA.
  const [approveAllOpen, setApproveAllOpen] = useState(false);
  const [autoGenerating, setAutoGenerating] = useState(false);
  const [autoError, setAutoError] = useState<string | null>(null);
  /** Capture sets (report + hashes) already sent for automatic generation in this panel; each is tried once. */
  const autoAttempted = useRef(new Set<string>());
  /** Why the last automatic-capture start stopped, phrased as the action needed; null when nothing blocks. */
  const [preflightBlocker, setPreflightBlocker] = useState<PreflightBlocker | null>(null);
  /** The start that waits for one Tention Reports toolbar click on the client's Klaviyo tab, then continues by itself. */
  const pendingStart = useRef<{ mode: "full" | "resume"; only?: ChecklistItem } | null>(null);
  const startAutomaticRunnerRef = useRef<(mode?: "full" | "resume", only?: ChecklistItem) => Promise<void>>(async () => undefined);
  /** A generated report's current artifact is missing (its captures changed after generation): regenerate it. */
  const [artifactStale, setArtifactStale] = useState(false);
  const [finalizing, setFinalizing] = useState<FinalizeProgress | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [deliveryRetry, setDeliveryRetry] = useState<"drive" | "doc" | "adopt" | null>(null);
  const [developmentReviewPdf, setDevelopmentReviewPdf] = useState<DevelopmentReviewPdfStatus | null>(null);
  const [developmentReviewBusy, setDevelopmentReviewBusy] = useState(false);
  const [developmentPreviewOpen, setDevelopmentPreviewOpen] = useState(false);
  const [readiness, setReadiness] = useState<ReportReadiness | null>(null);
  const [targets, setTargets] = useState<ClientReportTargets | null>(null);
  /** The client's server-computed setup status; capture and final generation run only for a READY client. */
  const [clientSetup, setClientSetup] = useState<ClientSetupSummary | null>(null);
  const [automaticRunTargets, setAutomaticRunTargets] = useState<ClientReportTargets | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(true);
  const [targetEditorOpen, setTargetEditorOpen] = useState(false);
  const [targetBusy, setTargetBusy] = useState(false);
  const [profileTimeZone, setProfileTimeZone] = useState("");
  // The client's one-time profile is canonical; a draft created with other details must not be captured.
  const clientProfile = targets?.profile ?? null;
  const clientConfigurationBlocker = !targets ? null
    : !clientProfile ? "CLIENT_CONFIGURATION_REQUIRED: Save this client's timezone in Client Setup before capture."
      : clientProfile.name !== report.client.name || clientProfile.timezone !== report.client.timezone
        ? `CLIENT_CONFIGURATION_MISMATCH: This report was created as ${report.client.name} (${report.client.timezone}), but the client is configured as ${clientProfile.name} (${clientProfile.timezone}). Create the report again from the saved client configuration.`
        : null;
  // Server-computed client setup: capture, final PDF, Drive and the Doc need a READY client (the API enforces it too).
  const clientSetupMissing = clientSetup && clientSetup.status !== "READY"
    ? clientSetup.blockers.map((blocker) => missingItemLabel(blocker, clientSetup.setup.profile?.conversionMetric.label)) : null;
  const clientSetupBlocker = clientSetupMissing ? `CLIENT_SETUP_INCOMPLETE: Client setup incomplete. Missing: ${clientSetupMissing.join(", ")}.` : null;
  const [targetError, setTargetError] = useState<string | null>(null);
  const [captureUploadStatus, setCaptureUploadStatus] = useState<CaptureUploadStatus | null>(null);
  const [klaviyoAccountUrl, setKlaviyoAccountUrl] = useState(() => loadKlaviyoAccountUrl(report.id));
  const captureResumeRestored = useRef(false);
  const checklist = buildReportChecklist(report);
  const runner = getReportRunnerState(report);
  const optional = checklist.filter(({ requirement, screenshotType }) => requirement === "optional" && screenshotType !== null);
  const automaticItems = getAutomaticCapturePlan(report);
  const automaticTypeSet = new Set(automaticItems.map(({ screenshotType }) => screenshotType));
  const finalOnlyItems = checklist.filter(({ screenshotType, state }) => screenshotType && !automaticTypeSet.has(screenshotType) && state !== "disabled" && state !== "not_required");
  // The nine core sections, plus Section 10 when this report includes it.
  const expectedAutomaticCount = automaticCaptureTypesForSections(report.sections).length;
  const includesSubscriberGrowth = automaticItems.some(({ screenshotType }) => screenshotType === "email_subscriber_growth");
  // Missing or stale automatic sections, e.g. only Section 10 after it is added to a report whose 1–9 are captured.
  const resumeQueue = automaticItems.filter(({ state }) => state === "missing" || state === "stale");
  const canResume = resumeQueue.length > 0 && resumeQueue.length < automaticItems.length;
  const hasAllAutomaticCaptures = automaticItems.length === expectedAutomaticCount
    && automaticItems.every((item) => item.screenshotType && report.screenshots.some((screenshot) => screenshot.type === item.screenshotType));
  const automaticTypes = automaticItems.flatMap(({ screenshotType }) => screenshotType ? [screenshotType] : []);
  const dataBlockers = finalGenerationDataBlockers(report, targets?.profile ?? null);
  const approveBlockers = approveAllBlockers(report, automaticTypes, expectedAutomaticCount, dataBlockers.map(({ code }) => code));
  const approvedAutomaticCount = automaticTypes.filter((type) => report.screenshots.some((shot) => shot.type === type && shot.approved)).length;
  const awaitingApproval = hasAllAutomaticCaptures && resumeQueue.length === 0 && approvedAutomaticCount < automaticTypes.length;
  // Machine validation, never human approval, gates the automatic final report.
  const autoBlockers = autoGenerationBlockers(report, automaticTypes, expectedAutomaticCount, dataBlockers.map(({ code }) => code));
  const automaticComplete = hasAllAutomaticCaptures && resumeQueue.length === 0;
  const automaticValidated = automaticComplete && automaticTypes.every((type) => report.screenshots.some((shot) => shot.type === type && isAcceptedCapture(shot)));
  const automaticCaptureKey = `${report.id}:${automaticTypes.map((type) => report.screenshots.find((shot) => shot.type === type)?.sha256 ?? "-").join(",")}`;
  const autoReady = automaticComplete && targets !== null && !clientSetupBlocker && autoBlockers.length === 0 && report.status !== "generating"
    && (report.status !== "generated" || (artifactStale && !pdfArtifact)) && !captureItem && !runnerStarted && !automaticRunnerStarted && !localAutomaticAcceptanceActive && !busy && !finalizing && !approveAllOpen;

  useEffect(() => { setValidation(report.validation); }, [report]);
  // One toolbar click on Subscriber growth → Email → Growth is enough: the service worker verifies that exact tab at the
  // click, and the panel saves it canonically as soon as it is verified (or when the report opens afterwards).
  // The latest saved client configuration, updated synchronously on every save: concurrent saves (the automatic
  // Subscriber Growth save and the Business Review preflight) each build on it and never drop the other's field.
  const latestTargets = useRef(targets); latestTargets.current = targets;
  const adoptTargets = (next: ClientReportTargets) => { latestTargets.current = next; setTargets(next); };
  const subscriberGrowthSaveInFlight = useRef<Promise<{ targets: ClientReportTargets | null; error: string | null }> | null>(null);
  const subscriberGrowthSaved = Boolean(targets?.sourceUrls?.subscriberGrowthUrl);
  const targetsLoaded = targets !== null;
  useEffect(() => {
    if (!includesSubscriberGrowth || subscriberGrowthSaved || !targetsLoaded) return;
    void discoverAndSaveSubscriberGrowth({ quiet: true, base: latestTargets.current });
    return subscriberGrowthSource.watch(() => { void discoverAndSaveSubscriberGrowth({ base: latestTargets.current }); });
    // The save reads the latest targets through the ref; it re-subscribes only when setup state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includesSubscriberGrowth, subscriberGrowthSaved, targetsLoaded]);
  // One toolbar click on the client's Klaviyo tab continues a start that was waiting for tab access; the start
  // re-verifies the open account before anything is captured. No second Start click is needed.
  useEffect(() => watchToolbarClick(() => {
    const pending = pendingStart.current;
    if (!pending) return;
    pendingStart.current = null;
    void startAutomaticRunnerRef.current(pending.mode, pending.only);
  }), [watchToolbarClick]);
  useEffect(() => {
    if (captureResumeRestored.current) return;
    const section = readSessionValue(pendingCaptureStorageKey(report.id));
    const saved = section ? checklist.find((item) => item.section === section && item.screenshotType && (item.state === "missing" || item.state === "stale")) ?? null : null;
    if (saved) { setRunnerStarted(true); setCaptureItem(saved); }
    else if (section) writeSessionValue(pendingCaptureStorageKey(report.id), null);
    captureResumeRestored.current = true;
  }, [checklist, report.id]);
  useEffect(() => {
    if (!captureItem?.screenshotType) return;
    writeSessionValue(pendingCaptureStorageKey(report.id), captureItem.section);
  }, [captureItem, report.id]);
  useEffect(() => {
    // A configured full dashboard URL is useful for the manual "Open Klaviyo"
    // affordance. Automatic C1 capture still uses only the toolbar-granted tab.
    if (!klaviyoAccountUrl && targets?.businessReview?.dashboardUrl) setKlaviyoAccountUrl(targets.businessReview.dashboardUrl);
  }, [klaviyoAccountUrl, targets?.businessReview?.dashboardUrl]);
  useEffect(() => {
    let active = true;
    setReadinessLoading(true); setReadiness(null); setTargetError(null);
    void Promise.all([api.getReportReadiness(report.client.id, report.sections), api.getClientReportTargets(report.client.id), api.getClientSetup(report.client.id).catch(() => null)])
      .then(([nextReadiness, nextTargets, nextSetup]) => {
        if (!active) return;
        setReadiness(nextReadiness); setTargets(nextTargets); setClientSetup(nextSetup);
      })
      .catch(() => { if (active) setTargetError("Client target configuration could not be loaded."); })
      .finally(() => { if (active) setReadinessLoading(false); });
    return () => { active = false; };
  }, [api, report.client.id, report.sections]);
  useEffect(() => { saveKlaviyoAccountUrl(report.id, klaviyoAccountUrl); }, [report.id, klaviyoAccountUrl]);
  useEffect(() => {
    let active = true;
    // Keep the artifact a generation just returned for this report; anything else is reloaded from the backend.
    setPdfArtifact((current) => current?.reportId === report.id && report.status === "generated" ? current : null); setArtifactStale(false);
    if (report.status !== "generated" || !api.getCurrentPdfArtifact) return;
    void api.getCurrentPdfArtifact(report.id).then((artifact) => { if (active) setPdfArtifact(artifact); })
      .catch((caught: unknown) => { if (active && caught instanceof ApiError && caught.code === "PDF_ARTIFACT_STALE") setArtifactStale(true); });
    return () => { active = false; };
  }, [api, report.id, report.status]);
  useEffect(() => {
    let active = true;
    setDevelopmentReviewPdf(null); setDevelopmentPreviewOpen(false);
    if (!localImportedReviewEnabled() || !hasAllAutomaticCaptures || !api.getDevelopmentReviewPdfStatus) return;
    void api.getDevelopmentReviewPdfStatus(report.id, report.version).then((status) => { if (active) setDevelopmentReviewPdf(status); }).catch(() => { if (active) setDevelopmentReviewPdf(null); });
    return () => { active = false; };
  }, [api, report.id, report.version, hasAllAutomaticCaptures]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { setHistory(await api.getReportHistory(report.id)); }
    catch { setActionError("Lifecycle history could not be loaded."); }
    finally { setHistoryLoading(false); }
  }, [api, report.id]);

  async function validate() {
    setBusy(true); setActionError(null);
    try { setValidation(await api.validateReportDraft(report.id)); }
    catch { setActionError("Report validation could not be completed."); }
    finally { setBusy(false); }
  }
  async function applyEvent(event: ReportMutationEvent) {
    setBusy(true); setConflict(false); setActionError(null);
    try { const updated = await api.applyEvent(report.id, event, report.version); onReport(updated); setValidation(updated.validation); if (advancedOpen) await loadHistory(); }
    catch (caught) {
      if (caught instanceof ApiError && caught.code === "REPORT_VERSION_CONFLICT") setConflict(true);
      else setActionError(caught instanceof ApiError ? caught.message : "Lifecycle action failed.");
    } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true);
    try { const latest = await api.getReportDraft(report.id); onReport(latest); setValidation(latest.validation); setConflict(false); }
    catch { setActionError("Latest report version could not be loaded."); }
    finally { setBusy(false); }
  }
  async function completeCaptureReview() {
    setBusy(true); setActionError(null); setConflict(false);
    try {
      const event: ReportMutationEvent = report.status === "generated"
        ? "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW"
        : "SUBMIT_FOR_REVIEW";
      const updated = await api.applyEvent(report.id, event, report.version);
      onReport(updated); setValidation(updated.validation); setReviewOpen(false);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "REPORT_VERSION_CONFLICT") { setConflict(true); setReviewOpen(false); }
      else setActionError(caught instanceof ApiError ? caught.message : "Capture review could not be completed.");
    } finally { setBusy(false); }
  }
  async function applyProfileCurrency() {
    setBusy(true); setActionError(null);
    try { const updated = await api.applyClientProfileCurrency(report.id, report); onReport(updated); setValidation(updated.validation); }
    catch (caught) { if (caught instanceof ApiError && caught.code === "REPORT_VERSION_CONFLICT") setConflict(true); else setActionError(caught instanceof ApiError ? caught.message : "The client currency could not be applied to this report."); }
    finally { setBusy(false); }
  }
  async function generatePdf() {
    if (clientSetupBlocker) { setActionError(clientSetupBlocker); return; }
    setBusy(true); setActionError(null); setConflict(false);
    try { const result = await api.generatePdf(report.id, report.version, report.reportMonth); onReport(result.report); setPdfArtifact(result.artifact); setValidation(result.report.validation); }
    catch (caught) {
      if (caught instanceof ApiError && caught.code === "REPORT_VERSION_CONFLICT") setConflict(true);
      else if (caught instanceof ApiError && caught.code === "REPORT_MONTH_MISMATCH") setActionError(`REPORT_MONTH_MISMATCH: ${caught.message}`);
      else setActionError(caught instanceof ApiError ? caught.message : "PDF generation could not be completed.");
    } finally { setBusy(false); }
  }
  /**
   * Automatic capture complete (all sections present, none stale, no data blockers) → the backend machine-validates
   * the captures and generates the final PDF, Drive PDF and Google Doc. No approval is recorded or required. Each
   * capture set is attempted once per panel; a failure is shown with a retry and never triggers a recapture.
   */
  async function autoGenerateFinal() {
    if (clientSetupBlocker) { setAutoError(clientSetupBlocker); return; }
    setAutoGenerating(true); setAutoError(null); setFinalizeError(null); setActionError(null); setConflict(false);
    try {
      const result = await api.autoGenerateFinalReport(report.id, report.version, report.reportMonth);
      onReport(result.report); setValidation(result.report.validation); setPdfArtifact(result.artifact);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "REPORT_VERSION_CONFLICT") setConflict(true);
      setAutoError(caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "The automatic final report could not be completed.");
    } finally { setAutoGenerating(false); }
  }
  useEffect(() => {
    if (!autoReady || autoAttempted.current.has(automaticCaptureKey)) return;
    autoAttempted.current.add(automaticCaptureKey);
    void autoGenerateFinal();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per capture set when it becomes ready.
  }, [autoReady, automaticCaptureKey]);
  /** Runs after the explicit Approve All confirmation (or to finish a chain that stopped after approval). */
  async function finalizeReport() {
    if (clientSetupBlocker) { setApproveAllOpen(false); setActionError(clientSetupBlocker); return; }
    setApproveAllOpen(false); setFinalizeError(null); setActionError(null); setConflict(false); setBusy(true);
    setFinalizing({ stage: "approving", approved: approvedAutomaticCount, total: automaticTypes.length });
    try {
      const result = await approveAllAndFinalize(api, report, automaticTypes, setFinalizing);
      onReport(result.report); setValidation(result.report.validation); setPdfArtifact(result.artifact);
    } catch (caught) {
      if (caught instanceof FinalizeError) { onReport(caught.report); setValidation(caught.report.validation); setFinalizeError(caught.message); if (caught.cause instanceof ApiError && caught.cause.code === "REPORT_VERSION_CONFLICT") setConflict(true); }
      else setFinalizeError(caught instanceof Error ? caught.message : "The final report could not be completed.");
    } finally { setFinalizing(null); setBusy(false); }
  }
  /** Retries only Drive or only the Google Doc for the existing canonical PDF; never re-renders or recaptures. */
  async function retryDelivery(kind: "drive" | "doc" | "adopt") {
    setDeliveryRetry(kind); setFinalizeError(null);
    const candidate = pdfArtifact?.googleDoc?.googleDocCandidateId;
    try { setPdfArtifact(kind === "drive" ? await api.retryDriveDelivery(report.id) : kind === "adopt" && candidate ? await api.adoptGoogleDoc(report.id, candidate) : await api.retryGoogleDoc(report.id)); }
    catch (caught) { setFinalizeError(`${kind === "drive" ? "Google Drive" : kind === "adopt" ? "Adopting the existing Google Doc" : "Google Doc"} retry failed: ${caught instanceof ApiError ? `${caught.code}: ${caught.message}` : "unknown error"}. The final PDF is unaffected.`); }
    finally { setDeliveryRetry(null); }
  }
  async function generateDevelopmentReviewPdf() {
    setDevelopmentReviewBusy(true); setActionError(null);
    try {
      const status = await api.generateDevelopmentReviewPdf(report.id, report.version);
      if (status.reportId !== report.id || status.reportVersion !== report.version || !status.developmentOnly) throw new ApiError("PARTIAL_REVIEW_ACK_MISMATCH", "The API did not confirm a review PDF for the current report version.", 200);
      setDevelopmentReviewPdf(status); setDevelopmentPreviewOpen(false);
    } catch (caught) {
      setActionError(caught instanceof ApiError ? caught.message : "The development review PDF could not be generated.");
    } finally { setDevelopmentReviewBusy(false); }
  }
  function openPreview() { window.open(api.reportPreviewUrl(report.id), "_blank", "noopener,noreferrer"); }
  function openPdf(download = false) { window.open(api.reportPdfUrl(report.id, download), "_blank", "noopener,noreferrer"); }
  function openDevelopmentReviewPdf(download = false) {
    if (!developmentReviewPdf || developmentReviewPdf.reportVersion !== report.version) { setActionError("Generate a current development review PDF before opening or downloading it."); return; }
    window.open(api.developmentReviewPdfUrl(report.id, download), "_blank", "noopener,noreferrer");
  }
  function startRunner() {
    if (!runner.next) { setReviewOpen(true); return; }
    if (clientConfigurationBlocker) { setActionError(clientConfigurationBlocker); return; }
    if (!readiness?.ready) {
      setActionError(readinessLoading ? "Checking client target configuration before capture." : "Capture is blocked until required client targets are configured.");
      setTargetEditorOpen(true);
      return;
    }
    setRunnerStarted(true); setCaptureItem(runner.next);
  }
  /**
   * `only` retakes exactly one section that is captured but still pending review: a resume run whose plan is that
   * section alone. The backend keeps the other captures (their hashes are re-verified) and replaces this one only once
   * the fresh capture passes, still unapproved. Approved evidence is never retaken this way.
   */
  async function startAutomaticRunner(mode: "full" | "resume" = "full", only?: ChecklistItem) {
    if (readinessLoading) { setActionError("Checking the report configuration before automatic capture."); return; }
    if (clientConfigurationBlocker) { setActionError(clientConfigurationBlocker); return; }
    if (clientSetupBlocker) { setActionError(clientSetupBlocker); return; }
    pendingStart.current = null; setPreflightBlocker(null);
    // A Klaviyo tab-access or account problem is not a client-setup problem: say what to do, and continue on its own
    // after the next toolbar click (the account is verified again before anything is captured).
    const blockStart = (error: string | null) => {
      const blocker = classifyPreflightFailure(error, { clientName: report.client.name, profileConfigured: Boolean((latestTargets.current ?? targets)?.profile), sourceConfigured: Boolean((latestTargets.current ?? targets)?.businessReview?.dashboardUrl) });
      setPreflightBlocker(blocker); setActionError(null);
      if (blocker.kind !== "CLIENT_CONFIGURATION_MISSING") setTargetError(null);
      pendingStart.current = blocker.resumesOnToolbarClick ? { mode, ...(only ? { only } : {}) } : null;
    };
    // A resume captures only the missing or stale automatic sections; existing captures are kept as they are.
    const freshQueue = only ? [only] : mode === "resume" ? resumeQueue : getAutomaticCapturePlan(report);
    const first = freshQueue[0];
    if (!first) { setActionError("No supported automatic sections are enabled for this report."); return; }
    // A Subscriber Growth source save already in flight (e.g. the automatic one on opening the report) finishes first.
    if (subscriberGrowthSaveInFlight.current) await subscriberGrowthSaveInFlight.current;
    let verifiedTargets = latestTargets.current ?? targets;
    if (freshQueue.some((item) => item.screenshotType !== "overview" && item.screenshotType !== "email_subscriber_growth")) {
      // A saved, verified Business Review binding is reused: the authorized tab only re-proves the
      // same account. Discovery (and saving) runs only when no binding exists yet.
      const saved = targets?.businessReview;
      const preflight = await discoverAndSaveBusinessReview(false, Boolean(saved?.dashboardUrl && (saved.accountLabel || saved.providerAccountId)));
      if (!preflight.targets) { blockStart(preflight.error); return; }
      verifiedTargets = preflight.targets;
    }
    // Section 10 reuses the client's saved Subscriber growth source; only when none is saved yet is the source the
    // service worker verified at the toolbar click saved now, on top of the targets confirmed above.
    if (freshQueue.some((item) => item.screenshotType === "email_subscriber_growth") && !verifiedTargets?.sourceUrls?.subscriberGrowthUrl) {
      const saved = await discoverAndSaveSubscriberGrowth({ base: verifiedTargets });
      if (!saved.targets) { blockStart(saved.error); return; }
      verifiedTargets = saved.targets;
    }
    // React state updates above are asynchronous. Carry this exact preflight
    // result into the capture render so it cannot use the stale target closure.
    setAutomaticRunTargets(verifiedTargets);
    // One automatic run: every section is captured, machine-verified and saved on the report in turn, with no
    // review screen and no approval between sections. Production and local builds use the same runner.
    setLocalAutomaticRunMode(mode); setResumePlan(mode === "resume" ? freshQueue : null);
    writeSessionValue(pendingCaptureStorageKey(report.id), null);
    setCaptureItem(null); setRunnerStarted(false); setAutomaticRunnerStarted(false); setLocalAutomaticAcceptanceActive(true); setActionError(null);
  }
  startAutomaticRunnerRef.current = startAutomaticRunner;
  // "Create & Start Automatic Capture": start once, as soon as the client configuration has loaded.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current || readinessLoading || !targets) return;
    autoStarted.current = true; onAutoStarted?.();
    void startAutomaticRunnerRef.current("full");
  }, [autoStart, readinessLoading, targets, onAutoStarted]);
  async function saveClientProfile() {
    if (!isValidIanaTimeZone(profileTimeZone)) { setTargetError("Enter a valid IANA timezone."); return; }
    setTargetBusy(true); setTargetError(null);
    try {
      const saved = await api.saveClientReportTargets(report.client.id, { ...targetInput(latestTargets.current ?? targets), profile: { name: report.client.name, timezone: profileTimeZone, currency: (latestTargets.current ?? targets)?.profile?.currency ?? report.client.currency, conversionMetric: (latestTargets.current ?? targets)?.profile?.conversionMetric ?? { label: "Placed Order", providerMetricId: null }, sections: (latestTargets.current ?? targets)?.profile?.sections ?? null } });
      adoptTargets(saved); setActionError(null);
    } catch (caught) { setTargetError(caught instanceof ApiError ? caught.message : "The client timezone could not be saved."); }
    finally { setTargetBusy(false); }
  }
  /**
   * Canonical save of the source the service worker proved at the toolbar click. The source counts as configured only
   * after the backend saved it AND a reload of the client's targets returns the same URL; the service worker's
   * navigation lock is released (and the transaction acknowledged) on every path.
   */
  function discoverAndSaveSubscriberGrowth(options: { quiet?: boolean; base?: ClientReportTargets | null } = {}): Promise<{ targets: ClientReportTargets | null; error: string | null }> {
    // One source transaction at a time: an automatic save and a Start click share the same in-flight save.
    if (subscriberGrowthSaveInFlight.current) return subscriberGrowthSaveInFlight.current;
    const transaction = runSubscriberGrowthSourceSave(options).finally(() => { subscriberGrowthSaveInFlight.current = null; });
    subscriberGrowthSaveInFlight.current = transaction;
    return transaction;
  }
  async function runSubscriberGrowthSourceSave(options: { quiet?: boolean; base?: ClientReportTargets | null }): Promise<{ targets: ClientReportTargets | null; error: string | null }> {
    setTargetBusy(true); if (!options.quiet) setTargetError(null);
    let sourceUrl: string | null = null; let saved = false; let failureCode: string | null = null;
    const bounded = <T,>(work: Promise<T>, label: string) => Promise.race([work, new Promise<never>((_, reject) => window.setTimeout(() => reject(new Error(`${label} did not finish within 30 seconds.`)), 30_000))]);
    try {
      const result = await bounded(subscriberGrowthSource.take(), "Subscriber Growth source setup");
      if (!result.ok) {
        failureCode = result.code;
        // An automatic (quiet) attempt with no verified source yet is not an error: the toolbar click has not happened.
        if (!options.quiet) { setTargetError(result.message); setSubscriberGrowthSetupDiagnostics((result.diagnostics ?? null) as Record<string, unknown> | null); }
        return { targets: null, error: `${result.code}: ${result.message}` };
      }
      sourceUrl = result.subscriberGrowthUrl; setSubscriberGrowthSetupDiagnostics((result.diagnostics ?? null) as Record<string, unknown> | null);
      // The proven page must belong to this report's client: another account's Subscriber growth page is never saved.
      const client = report.client.name.trim().toLocaleLowerCase();
      if (!result.accountLabels.some((label) => label.toLocaleLowerCase().includes(client))) {
        failureCode = "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN";
        const error = `The Klaviyo account shown on Subscriber growth could not be proven to be ${report.client.name}. Switch to that account and click the Tention toolbar icon again.`;
        setTargetError(error); return { targets: null, error: `${failureCode}: ${error}` };
      }
      // Built on the freshest targets (e.g. a Business Review binding saved moments ago), never a stale copy.
      const base = options.base !== undefined ? options.base : targets;
      if (base?.sourceUrls?.subscriberGrowthUrl === sourceUrl) { saved = true; return { targets: base, error: null }; }
      const input = targetInput(base);
      input.sourceUrls = { ...(base?.sourceUrls ?? {}), subscriberGrowthUrl: sourceUrl };
      await bounded(api.saveClientReportTargets(report.client.id, input), "Saving the Subscriber Growth source");
      const reloaded = await bounded(api.getClientReportTargets(report.client.id), "Reloading the client configuration");
      if (reloaded.sourceUrls?.subscriberGrowthUrl !== sourceUrl) {
        failureCode = "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED";
        const error = "The client configuration did not confirm the saved Subscriber Growth source.";
        setTargetError(error); return { targets: null, error: `${failureCode}: ${error}` };
      }
      const nextReadiness = await api.getReportReadiness(report.client.id, report.sections);
      saved = true; adoptTargets(reloaded); setReadiness(nextReadiness); setTargetError(null); setActionError(null);
      return { targets: reloaded, error: null };
    } catch (caught) {
      failureCode = failureCode ?? "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED";
      const error = caught instanceof ApiError || caught instanceof Error ? caught.message : "The Subscriber growth source could not be saved.";
      setTargetError(error);
      return { targets: null, error };
    } finally {
      if (sourceUrl !== null || failureCode !== "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED") {
        const diagnostics = await subscriberGrowthSource.persisted({ saved, sourceUrl, failureCode: saved ? null : failureCode }).catch(() => null);
        if (diagnostics && typeof diagnostics === "object") setSubscriberGrowthSetupDiagnostics(diagnostics as Record<string, unknown>);
      }
      setTargetBusy(false);
    }
  }
  async function enableSubscriberGrowth() {
    setBusy(true); setActionError(null);
    try { onReport(await api.enableSubscriberGrowthSection(report.id, report.version)); }
    catch (caught) { setActionError(caught instanceof ApiError ? caught.message : "Subscriber Growth could not be added to this report."); }
    finally { setBusy(false); }
  }
  async function discoverAndSaveBusinessReview(useCurrentPage: boolean, verifySavedAccountOnly = false): Promise<{ targets: ClientReportTargets | null; error: string | null }> {
    setTargetBusy(true); setTargetError(null); setActionError(null);
    try {
      const result = await discoverBusinessReviewSource({
        clientName: report.client.name,
        configuredUrl: targets?.businessReview?.dashboardUrl ?? null,
        configuredAccountLabel: targets?.businessReview?.accountLabel ?? null,
        configuredProviderAccountId: targets?.businessReview?.providerAccountId ?? null,
        useCurrentPage,
        ...(verifySavedAccountOnly ? { verifySavedAccountOnly: true } : {}),
      });
      setBusinessReviewDiscoveryDiagnostics(businessReviewDiscoveryDebug(result));
      if (!result.ok) { setTargetError(result.message); return { targets: null, error: `${result.code}: ${result.message}` }; }
      // An account-only check never rewrites the saved binding; only a verified Business Review page may.
      if ("verification" in result && result.verification === "saved_target_account") {
        if (!targets || result.dashboardUrl !== targets.businessReview?.dashboardUrl) { setTargetError("The saved Business Review source changed during verification."); return { targets: null, error: "The saved Business Review source changed during verification." }; }
        return { targets: latestTargets.current ?? targets, error: null };
      }
      const existingBusinessReview = (latestTargets.current ?? targets)?.businessReview;
      if (existingBusinessReview && existingBusinessReview.dashboardUrl === result.dashboardUrl && existingBusinessReview.accountLabel === result.accountLabel && existingBusinessReview.providerAccountId === result.providerAccountId) {
        setTargetError(null);
        return { targets: latestTargets.current ?? targets, error: null };
      }
      const input = targetInput(latestTargets.current ?? targets);
      input.businessReview = { dashboardUrl: result.dashboardUrl, displayName: "Business Review", accountLabel: klaviyoAccountDisplayName(result.accountLabel), ...(result.providerAccountId ? { providerAccountId: result.providerAccountId, providerIdentityKind: result.providerIdentityKind ?? "account" } : {}) };
      const saved = await api.saveClientReportTargets(report.client.id, input);
      const nextReadiness = await api.getReportReadiness(report.client.id, report.sections);
      adoptTargets(saved); setReadiness(nextReadiness); setTargetError(null);
      return { targets: saved, error: null };
    } catch (caught) {
      setBusinessReviewDiscoveryDiagnostics({ result: "extension-message-failed", stage: "EXTENSION_MESSAGE", tabFound: "—", tabId: "—", hostname: "—", urlEligible: "—", permission: "—", injection: "—", resultReturned: "—", headings: "—", links: "—", viewDashboardCandidates: "—", businessReviewCandidates: "—", errorCode: "EXTENSION_MESSAGE_FAILED", error: "The extension could not complete Business Review discovery.", account: "—", currentPage: "—" });
      const error = caught instanceof ApiError ? caught.message : "The verified Business Review source could not be saved.";
      setTargetError(error);
      return { targets: null, error };
    } finally { setTargetBusy(false); }
  }
  async function saveTargets(input: ClientReportTargetsInput) {
    setTargetBusy(true); setTargetError(null);
    try {
      const saved = await api.saveClientReportTargets(report.client.id, input);
      const nextReadiness = await api.getReportReadiness(report.client.id, report.sections);
      adoptTargets(saved); setReadiness(nextReadiness); setTargetEditorOpen(false);
    } catch (caught) { setTargetError(caught instanceof ApiError ? caught.message : "Client target configuration could not be saved."); }
    finally { setTargetBusy(false); }
  }
  function selectManualCapture(item: ChecklistItem) { setRunnerStarted(false); setAutomaticRunnerStarted(false); setCaptureItem(item); }
  function recaptureStaleTopCampaigns(item: ChecklistItem) {
    if (item.section !== "top_campaigns" || item.state !== "stale") return;
    void startAutomaticRunner("resume", item);
  }
  function selectImportedReview(item: ChecklistItem) { setImportedReviewItem(item); setActionError(null); }
  function toggleAdvanced() {
    const next = !advancedOpen; setAdvancedOpen(next);
    if (next && history.length === 0) void loadHistory();
    if (next && automaticCaptureService.getToolbarDiagnostics) void automaticCaptureService.getToolbarDiagnostics().then(setToolbarDiagnostics).catch(() => setToolbarDiagnostics(null));
  }
  async function inspectCampaignsSource() {
    if (!automaticCaptureService.inspectCampaignsSource) { setCampaignsSourceInspection({ ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Campaigns inspection requires the Chrome extension service worker." }); return; }
    setCampaignsSourceInspection(null);
    try { setCampaignsSourceInspection(await automaticCaptureService.inspectCampaignsSource() ?? { ok: false, code: "SCRIPT_INJECTION_FAILED", message: "The extension did not return Campaigns inspection results." }); }
    catch { setCampaignsSourceInspection({ ok: false, code: "SCRIPT_INJECTION_FAILED", message: "Campaigns inspection could not run." }); }
  }

  if (localAutomaticAcceptanceActive) return <LocalAutomaticAcceptanceRun api={api} report={report} targets={automaticRunTargets ?? targets} plan={localAutomaticRunMode === "resume" ? resumePlan ?? resumeQueue : automaticItems} mode={localAutomaticRunMode} allSections={automaticItems} service={automaticCaptureService} diagnostics={localImportedReviewEnabled() && typeof api.startLocalAutomaticCaptureRun === "function"} closeOnSuccess onPersisted={(updated) => { onReport(updated); setValidation(updated.validation); }} onClose={(updated) => { if (updated) onReport(updated); setLocalAutomaticAcceptanceActive(false); setAutomaticRunTargets(null); setResumePlan(null); }} />;

  if (importedReviewItem?.screenshotType) {
    const imported = report.screenshots.find((item) => item.type === importedReviewItem.screenshotType);
    if (imported && imported.captureOrigin === "live_acceptance_import" && !imported.approved) return <ImportedCaptureReview
      api={api} report={report} screenshot={imported} label={importedReviewItem.label}
      onApproved={(updated) => { onReport(updated); setValidation(updated.validation); setImportedReviewItem(null); }}
      onBack={() => setImportedReviewItem(null)} />;
  }

  if (captureItem?.screenshotType) return <CaptureWorkflow
    key={`${report.id}:${captureItem.screenshotType}`}
    api={api} captureService={captureService} navigationService={navigationService} automaticCaptureService={automaticCaptureService} report={report} clientTargets={automaticRunnerStarted ? automaticRunTargets ?? targets : targets} screenshotType={captureItem.screenshotType} label={captureItem.label}
    klaviyoAccountUrl={klaviyoAccountUrl} onKlaviyoAccountUrlChange={setKlaviyoAccountUrl}
    onUploadStatus={setCaptureUploadStatus}
    {...(automaticRunnerStarted ? { step: { current: automaticRunIndex + 1, total: automaticRunQueue.length } } : runnerStarted ? { step: { current: runner.required.findIndex(({ section }) => section === captureItem.section) + 1, total: runner.required.length } } : {})}
    autoStart={automaticRunnerStarted}
    continueLabel={runnerStarted || automaticRunnerStarted ? "Confirm & Continue" : "Approve & Upload"}
    onComplete={(updated) => {
      onReport(updated); setValidation(updated.validation);
      const next = getReportRunnerState(updated).next;
      if (automaticRunnerStarted && automaticRunQueue[automaticRunIndex + 1]) {
        setAutomaticRunIndex((current) => current + 1);
        setCaptureItem(automaticRunQueue[automaticRunIndex + 1]!);
      }
      else if (runnerStarted && next) setCaptureItem(next);
      else { writeSessionValue(pendingCaptureStorageKey(report.id), null); setCaptureItem(null); setRunnerStarted(false); setAutomaticRunnerStarted(false); setAutomaticRunQueue([]); setAutomaticRunIndex(0); setAutomaticRunTargets(null); }
    }}
    onVersionConflict={() => { writeSessionValue(pendingCaptureStorageKey(report.id), null); setCaptureItem(null); setRunnerStarted(false); setAutomaticRunnerStarted(false); setAutomaticRunQueue([]); setAutomaticRunIndex(0); setConflict(true); }} onCancel={() => { writeSessionValue(pendingCaptureStorageKey(report.id), null); setCaptureItem(null); setRunnerStarted(false); setAutomaticRunnerStarted(false); setAutomaticRunQueue([]); setAutomaticRunIndex(0); }}
  />;

  if (approveAllOpen) return <ApproveAllReview api={api} report={report} items={automaticItems} blockers={approveBlockers} onConfirm={() => void finalizeReport()} onBack={() => setApproveAllOpen(false)} />;

  if (reviewOpen) return <CaptureReview api={api} report={report} items={runner.required} completed={report.status === "ready_for_review"} busy={busy} completionError={actionError} onComplete={() => void completeCaptureReview()} onBack={() => setReviewOpen(false)} onRetake={(item) => { setReviewOpen(false); selectManualCapture(item); }} />;

  return <main>
    <section className="card report-hero"><p className="kicker">Monthly report</p><h1>{report.client.name}</h1><p className="report-month">{formatReportMonth(report.reportMonth)}</p>
      <div className="period-preview"><span>Client<strong>{report.client.name}</strong></span><span>Report Month<strong>{formatReportMonth(report.reportMonth)}</strong></span><span>Reporting Period<strong>{formatCalendarRange(report.period.startDate, report.period.endDate)}</strong></span><span>Previous Comparison<strong>{formatCalendarRange(report.period.previousStartDate, report.period.previousEndDate)}</strong></span></div>
      {clientSetupMissing && <div role="alert" className="notice error-notice" aria-label="Client setup incomplete"><strong>Client setup incomplete</strong><p>Missing:</p><ul>{clientSetupMissing.map((item) => <li key={item}>{item}</li>)}</ul><p className="support-copy">Automatic capture and final generation stay disabled until the client is READY.</p></div>}
      <p className="progress-copy">{automaticItems.length > 0 && !runner.isComplete ? `Automatic capture: ${automaticItems.filter(({ state }) => state === "approved" || state === "unapproved").length} / ${expectedAutomaticCount} sections captured` : `Final report readiness: ${runner.completed} / ${runner.required.length} required screenshots approved`}</p>
      {runner.isComplete ? <><section aria-label="Capture Review"><h2>Capture Review</h2><p>{report.status === "ready_for_review" || (report.status === "generated" && pdfArtifact) ? "✓ Completed" : "Review required"}</p></section>{report.status === "ready_for_review" || (report.status === "generated" && pdfArtifact) ? <div className="actions"><button onClick={() => setReviewOpen(true)}>View Review</button><button onClick={openPreview}>Preview Report</button></div> : <div className="actions"><button className="primary" disabled={busy || dataBlockers.length > 0 || Boolean(clientSetupBlocker)} onClick={() => void finalizeReport()}>Finish Final Report</button><button onClick={() => setReviewOpen(true)}>Review Report</button></div>}{automaticItems.length > 0 && <button className="secondary" onClick={() => void startAutomaticRunner()} disabled={readinessLoading || Boolean(clientSetupBlocker)}>Start Fresh Automatic Capture · {automaticItems.length} sections</button>}</> : <>{awaitingApproval && <section aria-label="Optional Human Review"><p className="support-copy">Human review is optional: the final report is generated automatically from the machine-validated captures.</p>
        <div className="actions"><button disabled={busy || autoGenerating || approveBlockers.length > 0} onClick={() => { setFinalizeError(null); setApproveAllOpen(true); }}>Review & Approve {automaticTypes.length} Captures</button></div></section>}
      <div className="actions"><button className={automaticComplete || automaticItems.length > 0 ? undefined : "primary"} onClick={startRunner} disabled={readinessLoading || Boolean(clientSetupBlocker)}>Start Report</button>{canResume && <button className="primary" onClick={() => void startAutomaticRunner("resume")} disabled={readinessLoading || Boolean(clientSetupBlocker)}>Resume Automatic Capture · {resumeQueue.map(({ label }) => label).join(", ")}</button>}{automaticItems.length > 0 && <button className={canResume || automaticComplete ? undefined : "primary"} onClick={() => void startAutomaticRunner()} disabled={readinessLoading || Boolean(clientSetupBlocker)}>Start Automatic Capture · {automaticItems.length} sections</button>}</div></>}
      <button className="secondary" onClick={onStartNew}>Start New Report</button>
    </section>
    {localImportedReviewEnabled() && hasAllAutomaticCaptures && <section className="card" aria-label="Development Review PDF"><p className="kicker">DEVELOPMENT REVIEW PDF</p><h2>Development Review PDF</h2><p className="notice">This is a temporary review PDF. It does not update Google Drive or the editable Google Doc.</p><p className="support-copy">{includesSubscriberGrowth ? "DEVELOPMENT REVIEW — 9 CORE SECTIONS + SUBSCRIBER GROWTH VERIFIED." : "DEVELOPMENT REVIEW — 9 CORE SECTIONS VERIFIED."} Optional sections remain intentionally unconfigured when no verified evidence exists.</p><div className="actions"><button className="primary" disabled={developmentReviewBusy} onClick={() => void generateDevelopmentReviewPdf()}>{developmentReviewBusy ? "Generating Review PDF…" : developmentReviewPdf ? "Regenerate Review PDF" : "Generate Review PDF"}</button>{developmentReviewPdf && <><button onClick={() => setDevelopmentPreviewOpen((open) => !open)}>{developmentPreviewOpen ? "Hide Review PDF Preview" : "Preview Review PDF"}</button><button onClick={() => openDevelopmentReviewPdf(false)}>Open Review PDF</button><button onClick={() => openDevelopmentReviewPdf(true)}>Download Review PDF</button></>}</div>{developmentReviewPdf && <p className="support-copy">Saved for report version {developmentReviewPdf.reportVersion} · {developmentReviewPdf.physicalPageCount} pages · {developmentReviewPdf.fileName}</p>}{developmentPreviewOpen && developmentReviewPdf && <iframe className="review-pdf-preview" title="Development Review PDF Preview" src={api.developmentReviewPdfUrl(report.id)} />}</section>}
    <FinalClientReport report={report} cover={reportCover(report)} approved={runner.completed} required={runner.required.length} complete={runner.isComplete} automatic={{ captured: automaticTypes.length, expected: expectedAutomaticCount, complete: automaticComplete, validated: automaticValidated, blockers: autoBlockers, generating: autoGenerating, error: autoError, humanApproved: approvedAutomaticCount }} artifact={pdfArtifact} busy={busy} dataBlockers={dataBlockers} profileCurrency={targets?.profile?.currency ?? null} finalizing={finalizing} finalizeError={finalizeError} deliveryRetry={deliveryRetry} onApplyCurrency={() => void applyProfileCurrency()} onGenerate={() => void (report.status === "ready_for_review" || report.status === "approved" ? generatePdf() : autoGenerateFinal())} onRetryDelivery={(kind) => void retryDelivery(kind)} onOpen={openPdf} />
    <section className="card" aria-label="Client Setup"><div className="section-heading"><div><h2>Client Setup</h2><p className="support-copy">Automatic capture verifies the currently authorized Klaviyo account and discovers Business Review before section one. Final-only targets do not block the {automaticItems.length} automatic sections.</p></div><button onClick={() => setTargetEditorOpen((open) => !open)}>{targetEditorOpen ? "Close Advanced Targets" : "Configure Missing Targets"}</button></div>
      <ul className="checklist"><li><span className={`check-icon ${targets?.businessReview?.accountLabel ? "approved" : "pending"}`}>{targets?.businessReview?.accountLabel ? "✓" : "○"}</span><span><strong>Klaviyo account</strong><small>{targets?.businessReview?.accountLabel ? `${targets.businessReview.accountLabel}${targets.businessReview.providerAccountId ? " · stable identity saved" : " · display identity saved"}` : "Not yet verified · Tention verifies the authorized account before capture"}</small></span></li><li><span className={`check-icon ${clientConfigurationBlocker ? "unapproved" : "approved"}`}>{clientConfigurationBlocker ? "!" : "✓"}</span><span><strong>Timezone</strong><small>{clientProfile ? `${clientProfile.timezone} · saved client configuration` : `Not saved for this client · this report was created with ${report.client.timezone}`}</small></span></li><li><span className="check-icon pending">○</span><span><strong>Overview source</strong><small>Uses the current authorized Klaviyo reporting tab · checked during capture</small></span></li><li><span className={`check-icon ${targets?.businessReview?.dashboardUrl ? "approved" : "pending"}`}>{targets?.businessReview?.dashboardUrl ? "✓" : "○"}</span><span><strong>Business Review</strong><small>{targets?.businessReview?.dashboardUrl ? "Verified reporting source saved for this client" : "Not yet verified · discovered automatically during preflight"}</small></span></li>
        {includesSubscriberGrowth && <li><span className={`check-icon ${targets?.sourceUrls?.subscriberGrowthUrl ? "approved" : "pending"}`}>{targets?.sourceUrls?.subscriberGrowthUrl ? "✓" : "○"}</span><span><strong>Subscriber Growth source</strong><small>{targets?.sourceUrls?.subscriberGrowthUrl ? "Verified Subscriber growth source saved for this client · reused every month" : "Not yet saved · open Audience → Profiles → View subscriber growth (any view or date) and click the Tention toolbar icon once · it is prepared and saved automatically"}</small></span>{!targets?.sourceUrls?.subscriberGrowthUrl && <button disabled={targetBusy} onClick={() => void discoverAndSaveSubscriberGrowth()}>Save Subscriber Growth Source</button>}</li>}</ul>
      {includesSubscriberGrowth && subscriberGrowthSetupDiagnostics && <details className="final-target-readiness" aria-label="Subscriber Growth source diagnostics"><summary>Subscriber Growth source setup diagnostics</summary><div className="metadata">{Object.entries(subscriberGrowthSetupDiagnostics).filter(([, value]) => typeof value !== "object" || value === null).map(([label, value]) => <span key={label}>{label}<strong>{value === null ? "—" : String(value)}</strong></span>)}</div></details>}
      {!includesSubscriberGrowth && report.status !== "generated" && localImportedReviewEnabled() && <div className="actions"><button disabled={busy} onClick={() => void enableSubscriberGrowth()}>Add Section 10 · Subscriber Growth</button></div>}
      {targets && !clientProfile && <div className="business-review-target" aria-label="Client timezone setup"><strong>Client timezone</strong><p className="support-copy">Choose the timezone of this client's Klaviyo account. It is saved once and reused for every report; the report's own value is not adopted automatically.</p>
        <label>Client timezone<input list="timezones" value={profileTimeZone} onChange={(event) => setProfileTimeZone(event.target.value)} placeholder="Select IANA timezone" /></label>
        <datalist id="timezones">{supportedTimeZones().map((zone) => <option key={zone} value={zone} />)}</datalist>
        <button disabled={targetBusy || !isValidIanaTimeZone(profileTimeZone)} onClick={() => void saveClientProfile()}>Save Client Timezone</button></div>}
      {clientConfigurationBlocker && clientProfile && <p role="alert" className="field-error">{clientConfigurationBlocker}</p>}
      {targetError && <p role="alert" className="field-error">{targetError}</p>}
      {readinessLoading ? <p className="support-copy">Checking final-report targets…</p> : readiness ? <details className="final-target-readiness"><summary>Final-report target details</summary><p className="support-copy">Only currently required verified captures can block final generation. Optional sections do not create placeholders or readiness blockers.</p><ul className="checklist">{readiness.sections.filter(({ status }) => status !== "ready").map((item) => <li key={item.sectionKey}><span className={`check-icon ${item.status === "missing_configuration" ? "unapproved" : "pending"}`}>{item.status === "missing_configuration" ? "!" : item.status === "not_applicable" ? "—" : "○"}</span><span><strong>{humanize(item.sectionKey)}</strong><small>{readinessText(item.status)}{item.reason ? ` · ${item.reason}` : ""}</small></span></li>)}</ul></details> : <p role="alert" className="field-error">Final-report target status is unavailable. The {automaticItems.length}-section automatic capture can still run its account/source preflight.</p>}
      {targetEditorOpen && <ClientTargetEditor targets={targets} busy={targetBusy} error={targetError} onSave={(input) => void saveTargets(input)} onDiscover={() => void discoverAndSaveBusinessReview(false)} onUseCurrentPage={() => void discoverAndSaveBusinessReview(true)} />}
    </section>
    <section className="card" aria-label="Automatic Capture Progress"><div className="section-heading"><h2>Automatic Capture Progress</h2><span className="count">{automaticItems.length} supported sections</span></div><p className="support-copy">Captured: {automaticItems.filter(({ state }) => state === "approved" || state === "unapproved").length} / {automaticItems.length} · Missing/stale: {automaticItems.filter(({ state }) => state === "missing" || state === "stale").length} · Human review optional ({automaticItems.filter(({ state }) => state === "approved").length} approved)</p><ul className="checklist runner-checklist">{automaticItems.map((item) => <li key={item.section}>{item.section === "top_campaigns" && item.state === "stale" ? <button className="recapture-row-button" aria-label="Recapture Top Campaigns" onClick={() => recaptureStaleTopCampaigns(item)}><span className={`check-icon ${item.state}`}>○</span><span><strong>{item.label}</strong><small>Stale evidence · recapture required</small></span><span className="recapture-action-label">Recapture</span></button> : <><span className={`check-icon ${item.state}`}>{item.state === "approved" || item.state === "unapproved" ? "✓" : "○"}</span><span><strong>{item.label}</strong><small>{item.state === "approved" ? "PASS · human approved" : item.state === "unapproved" ? "PASS · saved" : item.state === "stale" ? "Stale evidence · recapture required" : "Missing"}</small></span>{item.state === "approved" && <button disabled={busy} onClick={() => selectManualCapture(item)}>Retake</button>}</>}</li>)}</ul></section>
    <section className="card" aria-label="Final Report Readiness"><h2>Final Report Readiness</h2><p className="support-copy">Final report progress counts required screenshots only after approval. The final-only sections below are separate from the {automaticItems.length} automatic captures; required/optional status is shown explicitly.</p>{finalOnlyItems.length ? <ul className="checklist">{finalOnlyItems.map((item) => <li key={item.section}><span className={`check-icon ${item.state}`}>{item.state === "approved" ? "✓" : "○"}</span><span><strong>{item.label}</strong><small>{item.state === "approved" ? "Approved" : item.state === "unapproved" ? "Captured · Pending review" : item.state === "stale" ? "Stale · recapture required" : "Not yet captured"} · {item.requirement === "required" ? "Required for final report" : "Optional"}</small></span></li>)}</ul> : <p className="support-copy">No final-only screenshot sections are configured.</p>}</section>
    <section className="card"><div className="section-heading"><h2>Report Progress</h2><span className="count">{runner.completed} / {runner.required.length} required completed</span></div>
      <ul className="checklist runner-checklist">{runner.required.map((item) => <li key={item.section} className={item.section === runner.next?.section ? "current-step" : ""}><span className={`check-icon ${item.state}`}>{item.state === "approved" ? "✓" : item.section === runner.next?.section ? "→" : "○"}</span><span><strong>{item.label}</strong><small>{item.section === runner.next?.section ? "Next required capture" : checklistText(item.state, item.requirement)}</small></span>{item.state === "unapproved" && item.screenshotType && report.screenshots.some((shot) => shot.type === item.screenshotType && shot.captureOrigin === "live_acceptance_import") && <><button disabled={busy} onClick={() => selectImportedReview(item)}>Review saved capture</button>{automaticTypeSet.has(item.screenshotType) && report.status !== "generating" && <button disabled={busy || readinessLoading} onClick={() => void startAutomaticRunner("resume", item)}>Retake saved capture</button>}</>}{item.state === "approved" && <button disabled={busy} onClick={() => selectManualCapture(item)}>Retake</button>}</li>)}</ul>
    </section>
    {optional.length > 0 && <details className="card optional-sections"><summary>Optional Sections · {optional.length} available</summary><ul className="checklist">{optional.map((item) => <li key={item.section}><span className={`check-icon ${item.state}`}>{item.state === "approved" ? "✓" : "○"}</span><span><strong>{item.label}</strong><small>{checklistText(item.state, item.requirement)}</small></span>{item.state === "unapproved" && item.screenshotType && report.screenshots.some((shot) => shot.type === item.screenshotType && shot.captureOrigin === "live_acceptance_import") && <button disabled={busy} onClick={() => selectImportedReview(item)}>Review saved capture</button>}{item.state === "approved" ? <button disabled={busy} onClick={() => selectManualCapture(item)}>Retake</button> : !report.screenshots.some((shot) => shot.type === item.screenshotType && shot.captureOrigin === "live_acceptance_import") && <button disabled={busy} onClick={() => selectManualCapture(item)}>Capture</button>}</li>)}</ul></details>}
    <details className="card report-options"><summary>Report options</summary><button className="danger" disabled={busy} onClick={() => onRequestDelete(report)}>Delete Report</button></details>
    {conflict && <section role="alert" className="card conflict"><h2>This report was updated somewhere else.</h2><p>Reload the latest version before deciding what to do next.</p><button onClick={() => void reload()}>Reload Latest Version</button></section>}
    {actionError && <p role="alert" className="notice error-notice">{actionError}</p>}
    {preflightBlocker && <section role="alert" aria-label={preflightBlocker.title} className={`notice ${preflightBlocker.kind === "KLAVIYO_TAB_ACCESS_REQUIRED" ? "" : "error-notice"}`}><strong>{preflightBlocker.title}</strong><p>{preflightBlocker.message}</p>{preflightBlocker.resumesOnToolbarClick && <p className="support-copy">Capture continues automatically after that click.</p>}{preflightBlocker.code && <small>{preflightBlocker.code}</small>}</section>}
    <section className="card advanced"><button className="text-button" aria-expanded={advancedOpen} onClick={toggleAdvanced}>{advancedOpen ? "Hide Advanced / Debug" : "Show Advanced / Debug"}</button>
      {advancedOpen && <div className="advanced-content"><p className="support-copy">Technical report state and validation details. These controls are not part of the capture workflow.</p>
        {import.meta.env.DEV && <section aria-label="Development capture persistence"><h2>Development capture persistence</h2><div className="metadata"><span>API<strong>{safeApiDisplayUrl(extensionApiBaseUrl)}</strong></span><span>Report ID<strong>{report.id}</strong></span><span>Client ID<strong>{report.client.id}</strong></span><span>Month<strong>{toMonthValue(report.reportMonth)}</strong></span><span>Last capture upload<strong>{captureUploadStatus?.stage ?? "not attempted"}</strong></span><span>Last backend response<strong>{captureUploadStatus?.httpStatus === null || captureUploadStatus?.httpStatus === undefined ? "no HTTP response" : `HTTP ${captureUploadStatus.httpStatus}`}{captureUploadStatus?.operation ? ` · ${captureUploadStatus.operation}` : ""}</strong></span><span>Typed error<strong>{captureUploadStatus?.errorCode ?? "none"}</strong></span></div></section>}
        <div className="metadata"><span>Status<strong>{humanize(report.status)}</strong></span><span>Version<strong>{report.version}</strong></span><span>Updated<strong>{new Date(report.updatedAt).toLocaleString()}</strong></span></div>
        <section aria-label="Extension session storage"><h2>Extension session storage</h2><p className="support-copy">Sizes only; values are never shown. Session storage holds small transient state (10 MB limit).</p><button onClick={() => void getSessionStorageUsage().then((usage) => setSessionStorageUsage(usage ?? "unavailable"))}>Inspect session storage</button>
          {sessionStorageUsage === "unavailable" && <p className="support-copy">Session storage usage is unavailable outside the extension.</p>}
          {sessionStorageUsage && sessionStorageUsage !== "unavailable" && <><p className="support-copy">Total ≈ {Math.round(sessionStorageUsage.totalApproxBytes / 1024)} KB{sessionStorageUsage.bytesInUse !== null ? ` · Chrome reports ${Math.round(sessionStorageUsage.bytesInUse / 1024)} KB in use` : ""}</p><div className="metadata">{sessionStorageUsage.keys.slice(0, 15).map((item) => <span key={item.key}>{item.key}<strong>{Math.round(item.approxBytes / 1024)} KB · {item.valueType}{item.arrayLength !== null ? ` [${item.arrayLength}]` : ""}{item.objectKeyCount !== null ? ` {${item.objectKeyCount}}` : ""}</strong></span>)}</div></>}</section>
        <section><h2>Toolbar capture diagnostics</h2><div className="metadata"><span>Action handler fired<strong>{toolbarDiagnostics?.actionInvocation ? "Yes" : "No"}</strong></span><span>Granted tab<strong>{toolbarDiagnostics?.grantedTabId ?? "—"}</strong></span><span>Current active tab<strong>{toolbarDiagnostics?.currentActiveTabId ?? "—"}</strong></span><span>Granted page<strong>{toolbarDiagnostics?.actionInvocation?.pathname ?? "—"}</strong></span><span>Route matched<strong>{toolbarDiagnostics?.routeMatched ? "Yes" : "No"}</strong></span></div></section>
        <section aria-label="Campaigns source inspector"><h2>Campaigns source inspector</h2><p className="support-copy">Read-only inspection of the exact toolbar-authorized Campaigns tab. It does not navigate, change filters, or save any Klaviyo state.</p><button disabled={busy} onClick={() => void inspectCampaignsSource()}>Inspect authorized Campaigns page</button>
          {campaignsSourceInspection && (campaignsSourceInspection.ok ? <><div className="metadata"><span>Route<strong>{campaignsSourceInspection.sourceUrl}</strong></span><span>Rendered table<strong>{campaignsSourceInspection.pageRendered ? "Yes" : "No"}</strong></span><span>Heading<strong>{campaignsSourceInspection.pageHeading ?? "—"}</strong></span><span>Visible rows<strong>{campaignsSourceInspection.rowCount}</strong></span><span>Account candidates<strong>{campaignsSourceInspection.accountCandidates.join(" · ") || "—"}</strong></span><span>Date controls<strong>{campaignsSourceInspection.dateControls.join(" · ") || "—"}</strong></span><span>Conversion controls<strong>{campaignsSourceInspection.conversionMetricControls.join(" · ") || "—"}</strong></span><span>Sort controls<strong>{campaignsSourceInspection.sortControls.join(" · ") || "—"}</strong></span><span>Pagination<strong>{campaignsSourceInspection.pagination.join(" · ") || "—"}</strong></span></div><p className="support-copy">Headers: {campaignsSourceInspection.tableHeaders.join(" | ") || "none"}</p>{campaignsSourceInspection.visibleRows.length > 0 && <div className="source-inspection-rows">{campaignsSourceInspection.visibleRows.map((row, index) => <p key={`${index}-${row.join("-")}`}>{row.join(" | ")}</p>)}</div>}</> : <p role="alert" className="field-error">{campaignsSourceInspection.code}: {campaignsSourceInspection.message}</p>)}</section>
        {localImportedReviewEnabled() && businessReviewDiscoveryDiagnostics && <section aria-label="Business Review discovery diagnostics"><h2>Business Review discovery diagnostics</h2><div className="metadata">{Object.entries(businessReviewDiscoveryDiagnostics).map(([label, value]) => <span key={label}>{label}<strong>{value}</strong></span>)}</div></section>}
        <div className="validation-summary"><span>Errors <strong>{validation.errors.length}</strong></span><span>Warnings <strong>{validation.warnings.length}</strong></span></div>
        <button disabled={busy} onClick={() => void validate()}>{busy ? "Working…" : "Validate Report"}</button>
        {(validation.errors.length > 0 || validation.warnings.length > 0) && <ul className="issues">{[...validation.errors, ...validation.warnings].map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity}><strong>{issue.severity.toUpperCase()}</strong><span>{issue.message}<small>{issue.code}</small></span></li>)}</ul>}
        <section><h2>Development workflow</h2><div className="actions">{lifecycleActions(report.status).map(([event, label]) => <button key={event} disabled={busy} onClick={() => void applyEvent(event)}>{label}</button>)}</div></section>
        <section><h2>History</h2>{historyLoading ? <p>Loading history…</p> : history.length === 0 ? <p className="empty">No history available.</p> : <ol className="history">{history.map((entry) => <li key={entry.id}><time>{new Date(entry.createdAt).toLocaleString()}</time><strong>{entry.eventType}</strong><span>{entry.fromStatus ?? "—"} → {entry.toStatus} · Version {entry.reportVersion}</span></li>)}</ol>}</section>
      </div>}
    </section>
  </main>;
}

function ReportDeleteDialog({ report, confirmation, busy, error, onConfirmation, onCancel, onDelete }: {
  report: ReportDraft; confirmation: string; busy: boolean; error: string | null;
  onConfirmation(value: string): void; onCancel(): void; onDelete(): void;
}) {
  return <section role="dialog" aria-modal="true" aria-labelledby="delete-report-title" className="card delete-dialog"><h2 id="delete-report-title">Delete report?</h2><p><strong>{report.client.name}</strong><br />{formatReportMonth(report.reportMonth)}</p><p className="support-copy">This permanently deletes this monthly report and its stored screenshot assets.</p><label>Type DELETE to confirm<input aria-label="Type DELETE to confirm" value={confirmation} onChange={(event) => onConfirmation(event.target.value)} autoComplete="off" /></label>{error && <p role="alert" className="notice error-notice">{error}</p>}<div className="actions"><button disabled={busy} onClick={onCancel}>Cancel</button><button className="danger" disabled={busy || confirmation !== "DELETE"} onClick={onDelete}>{busy ? "Deleting…" : "Delete Report"}</button></div></section>;
}

function CaptureReview({ api, report, items, completed, busy, completionError, onComplete, onBack, onRetake }: { api: ApiClient; report: ReportDraft; items: ChecklistItem[]; completed: boolean; busy: boolean; completionError: string | null; onComplete(): void; onBack(): void; onRetake(item: ChecklistItem): void }) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true; const urls: string[] = [];
    void Promise.all(items.map(async (item) => {
      if (!item.screenshotType) return;
      const url = URL.createObjectURL(await api.getScreenshotImage(report.id, item.screenshotType));
      urls.push(url); if (active) setImages((current) => ({ ...current, [item.section]: url }));
    })).catch(() => { if (active) setError("One or more stored screenshots could not be loaded."); });
    return () => { active = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  }, [api, items, report.id]);
  return <main><section className="card report-hero"><p className="kicker">Capture review</p><h1>All required screenshots captured ✓</h1><p className="support-copy">Review each stored image before completing capture review and generating the client report.</p></section>
    {error && <p role="alert" className="notice error-notice">{error}</p>}
    {completionError && <p role="alert" className="notice error-notice">{completionError}</p>}
    <section className="card review-grid">{items.map((item) => <article key={item.section}><h2>{item.label}</h2>{images[item.section] ? <img src={images[item.section]} alt={`Stored ${item.label} screenshot`} /> : <p className="support-copy">Loading screenshot…</p>}<button onClick={() => onRetake(item)}>Retake</button></article>)}</section>
    <div className="actions">{completed ? <button className="primary" onClick={onBack}>Back to report</button> : <button className="primary" disabled={busy} onClick={onComplete}>{busy ? "Completing…" : "Complete Capture Review"}</button>}<button onClick={onBack}>{completed ? "Close Review" : "Back to report"}</button></div>
  </main>;
}

function ImportedCaptureReview({ api, report, screenshot, label, onApproved, onBack }: {
  api: ApiClient; report: ReportDraft; screenshot: ReportDraft["screenshots"][number]; label: string;
  onApproved(report: ReportDraft): void; onBack(): void;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true; let objectUrl: string | null = null;
    void api.getPendingImportedScreenshotImage(report.id, screenshot.type, screenshot.sha256 ?? "")
      .then((blob) => { objectUrl = URL.createObjectURL(blob); if (active) setImageUrl(objectUrl); })
      .catch((caught) => { if (active) setError(caught instanceof ApiError ? caught.message : "Saved imported screenshot could not be loaded for review."); });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, report.id, screenshot.id, screenshot.sha256, screenshot.type]);
  async function approve() {
    if (!screenshot.sha256) { setError("The stored screenshot has no verified SHA-256."); return; }
    setBusy(true); setError(null);
    try { onApproved(await api.approveImportedScreenshot(report.id, screenshot.type, { expectedVersion: report.version, expectedSha256: screenshot.sha256 })); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : "The saved screenshot was not approved by the backend."); }
    finally { setBusy(false); }
  }
  return <main><section className="card report-hero"><p className="kicker">Development evidence review</p><h1>Review saved {label}</h1><p className="support-copy">This live-acceptance import is not approved yet. Inspect the image below; approval is recorded only when you choose Approve this saved evidence.</p></section>
    {error && <p role="alert" className="notice error-notice">{error}</p>}
    <section className="card"><div className="metadata"><span>Client<strong>{report.client.name}</strong></span><span>Report month<strong>{toMonthValue(report.reportMonth)}</strong></span><span>Capture origin<strong>live_acceptance_import</strong></span><span>SHA-256<strong>{screenshot.sha256 ?? "missing"}</strong></span><span>Source<strong>{safeSourceDisplay(screenshot.sourceUrl)}</strong></span><span>Captured<strong>{new Date(screenshot.capturedAt).toLocaleString()}</strong></span></div>
      {imageUrl ? <img className="imported-review-image" src={imageUrl} alt={`Pending imported ${label} evidence`} /> : !error && <p className="support-copy">Loading the stored image and verifying its source metadata…</p>}
      <div className="actions"><button className="primary" disabled={busy || !imageUrl} onClick={() => void approve()}>{busy ? "Saving review…" : "Approve this saved evidence"}</button><button disabled={busy} onClick={onBack}>Back without approving</button></div>
    </section>
  </main>;
}

function lifecycleActions(status: ReportDraft["status"]): [ReportMutationEvent, string][] {
  const actions: Partial<Record<ReportDraft["status"], [ReportMutationEvent, string][]>> = {
    draft: [["START_DATA_FETCH", "Start Data Fetch"]],
    data_fetching: [["DATA_FETCH_SUCCEEDED", "Simulate Data Ready"], ["DATA_FETCH_FAILED", "Simulate Fetch Failure"]],
    data_ready: [["MARK_CAPTURES_INCOMPLETE", "Mark Captures Incomplete"], ["SUBMIT_FOR_REVIEW", "Submit for Review"]],
    captures_incomplete: [["SUBMIT_FOR_REVIEW", "Submit for Review"]],
    failed: [["RESET_TO_DRAFT", "Reset to Draft"]],
  };
  return actions[status] ?? [];
}
function humanize(value: string): string { return value.split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" "); }
function readinessText(status: string): string {
  if (status === "missing_configuration") return "Missing configuration";
  if (status === "optional_not_configured") return "Optional — Not configured";
  if (status === "manual_required") return "Manual required — missing evidence";
  if (status === "manual_by_design") return "Manual by design";
  if (status === "deferred") return "Deferred";
  return "Not applicable";
}
function checklistText(state: string, requirement: string): string {
  if (state === "approved") return "Approved";
  if (state === "stale") return "Stale source proof — recapture required";
  if (state === "unapproved") return "Automatic capture PASS · human review optional";
  if (state === "not_required") return "No screenshot required";
  return requirement === "required" ? "Required · Missing" : "Optional";
}
function klaviyoAccountUrlKey(reportId: string): string { return `tention.klaviyo-account-url.${reportId}`; }
function loadKlaviyoAccountUrl(reportId: string): string {
  try { return sessionStorage.getItem(klaviyoAccountUrlKey(reportId)) ?? ""; }
  catch { return ""; }
}
function saveKlaviyoAccountUrl(reportId: string, value: string): void {
  try {
    if (value.trim()) sessionStorage.setItem(klaviyoAccountUrlKey(reportId), value.trim());
    else sessionStorage.removeItem(klaviyoAccountUrlKey(reportId));
  } catch { /* Session storage is a convenience, never a report-data dependency. */ }
}

/** Automatic-capture facts the final report card shows; machine validation, not human approval, gates generation. */
interface AutomaticFinalState { captured: number; expected: number; complete: boolean; validated: boolean; blockers: string[]; generating: boolean; error: string | null; humanApproved: number }

/**
 * The client-facing deliverable, kept apart from the development review PDF: final generation writes the canonical
 * PDF, then the Drive PDF and the editable Google Doc. A fully machine-validated automatic capture generates it on its
 * own; otherwise it waits for every required screenshot to be approved.
 */
function FinalClientReport({ report, cover, approved, required, complete, automatic, artifact, busy, dataBlockers, profileCurrency, finalizing, finalizeError, deliveryRetry, onApplyCurrency, onGenerate, onRetryDelivery, onOpen }: {
  report: ReportDraft;
  /** Front-cover values from this report's own period-verified Executive Summary capture; final generation needs them. */
  cover: ReturnType<typeof reportCover>;
  approved: number; required: number; complete: boolean; automatic: AutomaticFinalState; artifact: ReportPdfArtifact | null; busy: boolean;
  /** Currency / conversion metric ID that are not configured; the backend enforces the same rule. */
  dataBlockers: FinalGenerationBlocker[];
  /** The client's saved profile currency; offered for this report only while the report's own currency is unset. */
  profileCurrency: string | null; onApplyCurrency: () => void;
  /** Progress of the optional Approve All chain; null when idle. */
  finalizing: FinalizeProgress | null; finalizeError: string | null; deliveryRetry: "drive" | "doc" | "adopt" | null;
  onGenerate: () => void; onRetryDelivery: (kind: "drive" | "doc" | "adopt") => void; onOpen: (download?: boolean) => void;
}) {
  const generated = report.status === "generated" && artifact !== null;
  const automaticPath = automatic.complete;
  const working = finalizing !== null || automatic.generating;
  const reviewDone = report.status === "ready_for_review" || report.status === "approved" || report.status === "failed" || report.status === "auto_validated";
  const blockedReason = working || generated ? null
    : dataBlockers.length ? `${dataBlockers.map(({ code }) => code).join(", ")}: ${dataBlockers.map(({ message }) => message).join(" ")}`
      : automaticPath ? (automatic.blockers.length ? automatic.blockers.join(" ") : null)
        : !complete ? `Waiting for all ${automatic.expected || required} automatic captures; the final report is then generated automatically.` : null;
  const drive = artifact?.driveDelivery; const doc = artifact?.googleDoc;
  // The Drive month folder that holds both the PDF and the Doc (Root/Year/Month).
  const folderId = drive?.driveFolderId ?? doc?.googleDocFolderId ?? null;
  const progress = finalizing ? finalizing.stage === "approving" ? `Approving ${finalizing.approved} / ${finalizing.total}…` : finalizing.stage === "submitting" ? "Submitting for review…" : "Generating…"
    : automatic.generating ? "Validating and generating…" : null;
  const validationState = automatic.generating && !automatic.validated ? "Validating…"
    : automatic.validated || generated ? "PASS"
      : automatic.error ? "FAIL"
        : blockedReason ? "BLOCKED" : automaticPath ? "Pending" : "Waiting for capture";
  const pdfState = progress ? progress : generated ? "PASS" : automatic.error && automatic.validated ? "FAIL" : blockedReason ? "BLOCKED" : "Not generated";
  const driveState = progress ? "Waiting for PDF" : !drive ? (generated ? "FAIL · not delivered" : blockedReason ? "BLOCKED" : "Not generated") : drive.driveUploadStatus === "uploaded" ? "PASS" : `FAIL · ${drive.driveErrorCode ?? "unknown"}`;
  const docState = progress ? "Waiting for PDF" : !doc ? (generated ? "FAIL · not synced" : blockedReason ? "BLOCKED" : "Not generated") : doc.googleDocStatus === "synced" ? "PASS" : `FAIL · ${doc.googleDocErrorCode ?? "unknown"}`;
  // A retry only after a failed attempt; a successful automatic capture never needs a Generate click.
  const canRetryGenerate = !generated && !working && !blockedReason && (automatic.error !== null || report.status === "failed" || (reviewDone && !automaticPath));
  return <section className="card" aria-label="Final Client Report"><p className="kicker">FINAL CLIENT REPORT</p><h2>Final Client Report</h2>
    <p className="support-copy">{report.client.name} · {formatReportMonth(report.reportMonth)} · {formatCalendarRange(report.period.startDate, report.period.endDate)}</p>
    <div className="metadata">
      <span>Captured<strong>{automaticPath || automatic.captured ? `${automatic.captured}/${automatic.expected}` : `${approved} / ${required}`}</strong></span>
      <span>Automated validation<strong>{validationState}</strong></span>
      <span>Cover values<strong>{cover.ok ? "PASS" : "NOT VERIFIED"}</strong></span>
      {progress && <span>Final Report<strong>{progress}</strong></span>}
      <span>Final PDF<strong>{pdfState}</strong></span>
      <span>Google Drive<strong>{driveState}</strong></span>
      <span>Google Doc<strong>{docState}</strong></span>
      <span>Human review<strong>{automaticPath ? (automatic.humanApproved > 0 ? `Optional · ${automatic.humanApproved}/${automatic.captured} approved` : "Optional") : `${approved} / ${required} approved`}</strong></span>
    </div>
    {blockedReason && <p className="support-copy">Reason: {blockedReason}</p>}
    {!cover.ok && automatic.complete && !generated && <p role="status" className="notice error-notice">Report cover: {cover.issues.map(({ metric, message }) => metric ? `${metric} — ${message}` : message).join(" ")} A fresh Executive Summary capture reads these values; they are never taken from an image.</p>}
    {automatic.error && <p role="alert" className="notice error-notice">Automatic final report failed: {automatic.error}. No capture was repeated; saved screenshots are unchanged.</p>}
    {finalizeError && <p role="alert" className="notice error-notice">{finalizeError}</p>}
    {!generated && report.client.currency === null && profileCurrency && /^[A-Z]{3}$/.test(profileCurrency) && <div className="actions"><button disabled={busy} onClick={onApplyCurrency}>Apply client currency ({profileCurrency}) to this report</button></div>}
    {!generated && dataBlockers.length > 0 && <p role="status" className="notice error-notice">Data definition incomplete — final generation stays blocked until these are configured: {dataBlockers.map(({ code, field }) => `${code} (${field})`).join(", ")}.</p>}
    {/* The Drive PDF is a fixed copy; the native Google Doc is the editable version. They are different files. */}
    <div className="actions" aria-label="Report files">
      {drive?.driveWebViewLink && <a className="button-link" href={drive.driveWebViewLink} target="_blank" rel="noopener noreferrer" title={drive.driveFileName ?? undefined}>Open Drive PDF</a>}
      {doc?.googleDocWebViewLink && <a className="button-link" href={doc.googleDocWebViewLink} target="_blank" rel="noopener noreferrer" title={doc.googleDocName ?? undefined}>{doc.googleDocStatus === "synced" ? "Open Editable Google Doc" : "Open Existing Google Doc"}</a>}
      {folderId && <a className="button-link" href={`https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`} target="_blank" rel="noopener noreferrer">Open {formatReportMonth(report.reportMonth)} Folder</a>}
    </div>
    {doc?.googleDocCandidateId && <div role="status" className="notice error-notice" aria-label="Unverified Google Doc">
      <p>Existing Google Doc found but not verified as Tention-managed. It was not changed. Adopt it only if it is this report's Doc: its content will be replaced with this report and Tention will update it from now on.</p>
      <div className="actions">
        {doc.googleDocCandidateWebViewLink && <a className="button-link" href={doc.googleDocCandidateWebViewLink} target="_blank" rel="noopener noreferrer">Open Existing Google Doc</a>}
        <button disabled={deliveryRetry !== null} onClick={() => onRetryDelivery("adopt")}>{deliveryRetry === "adopt" ? "Adopting…" : "Adopt Existing Doc"}</button>
      </div>
    </div>}
    <div className="actions">
      {canRetryGenerate && <button className="primary" disabled={busy} onClick={onGenerate}>{busy ? "Generating Final Report…" : "Retry Final Report"}</button>}
      {generated && <><button className="primary" onClick={() => onOpen()}>Open Final PDF</button><button onClick={() => onOpen(true)}>Download Final PDF</button></>}
      {generated && drive?.driveUploadStatus !== "uploaded" && <button disabled={deliveryRetry !== null} onClick={() => onRetryDelivery("drive")}>{deliveryRetry === "drive" ? "Retrying Drive upload…" : "Retry Google Drive upload"}</button>}
      {generated && doc?.googleDocStatus !== "synced" && <button disabled={deliveryRetry !== null} onClick={() => onRetryDelivery("doc")}>{deliveryRetry === "doc" ? "Retrying Google Doc…" : "Retry Google Doc"}</button>}
    </div>
  </section>;
}

/**
 * Shows every saved capture before a single explicit approval. Each pending image is fetched through the backend's
 * review route, which re-verifies client, month, source proof, stored bytes and SHA-256 before serving it; approval is
 * offered only once all of them loaded. Nothing is approved until the user confirms.
 */
function ApproveAllReview({ api, report, items, blockers, onConfirm, onBack }: {
  api: ApiClient; report: ReportDraft; items: ChecklistItem[]; blockers: string[]; onConfirm(): void; onBack(): void;
}) {
  const [images, setImages] = useState<Record<string, string>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  // Reload only when the set of captures itself changes (section, hash, approval), not on every parent render.
  const captureKey = items.map((item) => { const shot = report.screenshots.find((candidate) => candidate.type === item.screenshotType); return `${item.section}:${shot?.sha256 ?? "-"}:${shot?.approved ? 1 : 0}`; }).join("|");
  useEffect(() => {
    setImages({}); setFailures({});
    let active = true; const urls: string[] = [];
    for (const item of items) {
      const shot = item.screenshotType ? report.screenshots.find((candidate) => candidate.type === item.screenshotType) : undefined;
      if (!shot) { setFailures((current) => ({ ...current, [item.section]: "Capture missing." })); continue; }
      const load = shot.approved ? api.getScreenshotImage(report.id, shot.type) : api.getPendingImportedScreenshotImage(report.id, shot.type, shot.sha256 ?? "");
      void load.then((blob) => { const url = URL.createObjectURL(blob); urls.push(url); if (active) setImages((current) => ({ ...current, [item.section]: url })); })
        .catch((caught) => { if (active) setFailures((current) => ({ ...current, [item.section]: caught instanceof ApiError ? caught.message : "Stored capture could not be verified." })); });
    }
    return () => { active = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- captureKey covers items and screenshots
  }, [api, report.id, captureKey]);
  const loaded = items.filter((item) => images[item.section]).length;
  const ready = loaded === items.length && Object.keys(failures).length === 0 && blockers.length === 0;
  return <main><section className="card report-hero"><p className="kicker">Capture review</p><h1>Review & approve {items.length} captures</h1>
      <p className="support-copy">{report.client.name} · {formatReportMonth(report.reportMonth)} · {formatCalendarRange(report.period.startDate, report.period.endDate)} compared to {formatCalendarRange(report.period.previousStartDate, report.period.previousEndDate)}</p>
      <p className="support-copy">Check every screenshot below. Approving all {items.length} then creates the final PDF, the Google Drive PDF and the editable Google Doc automatically.</p></section>
    {blockers.length > 0 && <p role="alert" className="notice error-notice">Approval unavailable: {blockers.join(" ")}</p>}
    {Object.keys(failures).length > 0 && <p role="alert" className="notice error-notice">Not all captures could be verified, so nothing can be approved: {Object.entries(failures).map(([section, message]) => `${section}: ${message}`).join(" · ")}</p>}
    <section className="card review-grid">{items.map((item, index) => {
      const shot = report.screenshots.find((candidate) => candidate.type === item.screenshotType);
      return <article key={item.section} aria-label={`Capture ${index + 1} ${item.label}`}><h2>{index + 1}. {item.label}</h2>
        {images[item.section] ? <img src={images[item.section]} alt={`Saved ${item.label} capture`} /> : failures[item.section] ? <p className="notice error-notice">{failures[item.section]}</p> : <p className="support-copy">Verifying and loading…</p>}
        <p className="support-copy">{shot?.approved ? "Already approved" : "Pending approval"}{shot ? ` · captured ${new Date(shot.capturedAt).toLocaleString()} · SHA-256 ${(shot.sha256 ?? "missing").slice(0, 12)}…` : ""}</p></article>;
    })}</section>
    <div className="actions"><button className="primary" disabled={!ready} onClick={onConfirm}>Approve All {items.length}</button><button onClick={onBack}>Back without approving</button></div>
    {!ready && blockers.length === 0 && Object.keys(failures).length === 0 && <p className="support-copy">Verified {loaded} / {items.length} captures…</p>}
  </main>;
}
