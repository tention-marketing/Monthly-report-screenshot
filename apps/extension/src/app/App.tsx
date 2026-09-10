import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type ApiClient, type ReportMutationEvent } from "@tention/api-client";
import {
  isValidIanaTimeZone, reportSectionKeySchema,
  type ReportDraft, type ReportMonth, type ReportValidationState, type SectionConfiguration,
} from "@tention/report-schema";
import { DEFAULT_DRAFT_SECTION_CONFIGURATION } from "../features/create-report/defaults.js";
import { buildReportChecklist, summarizeChecklist } from "../features/report-checklist/checklist.js";
import type { ChecklistItem } from "../features/report-checklist/checklist.js";
import { CaptureWorkflow } from "../features/screenshot-capture/CaptureWorkflow.js";
import { unavailableCaptureService, type CaptureService } from "../features/screenshot-capture/capture-service.js";
import {
  formatCalendarRange, formatReportMonth, getCompletedMonthOptions, normalizeSelectedMonth,
  parseMonthValue, toMonthValue,
} from "../lib/dates/month-options.js";

type ConnectionState = "checking" | "connected" | "unavailable";
const sectionLabels: Record<string, string> = {
  executive_summary: "Executive Summary", top_campaigns: "Top Campaigns", top_flows: "Top 5 Flows",
  month_comparison: "Month Comparison", campaign_performance: "Campaign Performance", flow_performance: "Flow Performance",
  signup_form: "Signup Form", welcome_flow: "Welcome Flow", customer_split: "Customer Split",
  deliverability: "Deliverability", campaign_metrics: "Campaign Metrics", flow_metrics: "Flow Metrics",
  list_growth: "List Growth", analysis: "Analysis", next_month_plan: "Next Month Plan",
};

export interface AppProps { api: ApiClient; captureService?: CaptureService; now?: () => Date }

export function App({ api, captureService = unavailableCaptureService, now = () => new Date() }: AppProps) {
  const [connection, setConnection] = useState<ConnectionState>("checking");
  const [recent, setRecent] = useState<ReportDraft[]>([]);
  const [report, setReport] = useState<ReportDraft | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    try { setReport(await api.getReportDraft(id)); }
    catch (caught) { setError(caught instanceof ApiError && caught.code === "REPORT_NOT_FOUND" ? "Report not found." : "The report could not be loaded."); }
    finally { setLoadingReport(false); }
  }, [api]);

  return <div className="app-shell">
    <header className="brand-row">
      <div><p className="eyebrow">Tention Reports</p><span className={`connection ${connection}`}>{connection === "checking" ? "Checking API…" : connection === "connected" ? "Connected" : "API unavailable"}</span></div>
      {report && <button className="text-button" onClick={() => setReport(null)}>Home</button>}
    </header>
    {connection === "unavailable" && <section className="notice error-notice"><p>The reporting API could not be reached.</p><button onClick={() => void connect()}>Retry connection</button></section>}
    {error && <p role="alert" className="notice error-notice">{error}</p>}
    {loadingReport ? <p className="loading">Loading report…</p> : report
      ? <ReportDetail api={api} captureService={captureService} report={report} onReport={setReport} />
      : <Home api={api} connected={connection === "connected"} recent={recent} now={now} onCreated={(created) => { setReport(created); setRecent((items) => [created, ...items]); }} onOpen={openReport} />}
  </div>;
}

interface HomeProps {
  api: ApiClient; connected: boolean; recent: ReportDraft[]; now: () => Date;
  onCreated(report: ReportDraft): void; onOpen(id: string): void;
}

function Home({ api, connected, recent, now, onCreated, onOpen }: HomeProps) {
  const [clientId, setClientId] = useState("");
  const [clientName, setClientName] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [reportMonth, setReportMonth] = useState<ReportMonth | null>(null);
  const [sections, setSections] = useState<SectionConfiguration>({ ...DEFAULT_DRAFT_SECTION_CONFIGURATION });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<ReportDraft | null>(null);
  const timeZones = useMemo(() => supportedTimeZones(), []);
  const monthOptions = useMemo(() => {
    if (!isValidIanaTimeZone(timeZone)) return [];
    return getCompletedMonthOptions(now(), timeZone, 24);
  }, [now, timeZone]);
  useEffect(() => { setReportMonth((selected) => normalizeSelectedMonth(selected, monthOptions)); }, [monthOptions]);
  const period = reportMonth ? monthOptions.find(({ month }) => toMonthValue(month) === toMonthValue(reportMonth))?.period : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!reportMonth || !isValidIanaTimeZone(timeZone)) return;
    setCreating(true); setCreateError(null); setDuplicate(null);
    try {
      onCreated(await api.createReportDraft({ client: { id: clientId.trim(), name: clientName.trim(), timezone: timeZone }, reportMonth, sections }));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "REPORT_DRAFT_ALREADY_EXISTS") {
        setCreateError("A monthly report already exists for this client and month.");
        const matches = await api.listReportDrafts({ clientId: clientId.trim(), year: reportMonth.year, month: reportMonth.month }).catch(() => []);
        setDuplicate(matches[0] ?? null);
      } else setCreateError(caught instanceof ApiError ? caught.message : "The report could not be created.");
    } finally { setCreating(false); }
  }

  return <main>
    <section className="card">
      <div className="section-heading"><div><p className="kicker">Create monthly report</p><h1>Report setup</h1></div></div>
      <p className="support-copy">Client directory and connection management come in a later phase.</p>
      <form onSubmit={(event) => void submit(event)}>
        <label>Client Name<input value={clientName} onChange={(event) => setClientName(event.target.value)} required placeholder="Client name" /></label>
        <label>Client ID<input value={clientId} onChange={(event) => setClientId(event.target.value)} required placeholder="Stable client ID" /></label>
        <label>Timezone<input list="timezones" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} required placeholder="Select IANA timezone" /></label>
        <datalist id="timezones">{timeZones.map((zone) => <option key={zone} value={zone} />)}</datalist>
        {timeZone && !isValidIanaTimeZone(timeZone) && <p role="alert" className="field-error">Enter a valid IANA timezone.</p>}
        <label>Report Month<select aria-label="Report Month" value={reportMonth ? toMonthValue(reportMonth) : ""} onChange={(event) => setReportMonth(parseMonthValue(event.target.value))} disabled={!monthOptions.length} required>
          {!monthOptions.length && <option value="">Select timezone first</option>}
          {monthOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select></label>
        {period && <div className="period-preview" aria-label="Derived reporting periods">
          <span>Reporting Period<strong>{formatCalendarRange(period.startDate, period.endDate)}</strong></span>
          <span>Previous Comparison<strong>{formatCalendarRange(period.previousStartDate, period.previousEndDate)}</strong></span>
        </div>}
        <fieldset><legend>Report sections</legend><p className="support-copy">Defaults apply to new drafts only and can be changed per report.</p>
          <div className="section-config">{reportSectionKeySchema.options.map((section) => <label key={section}>{sectionLabels[section]}
            <select aria-label={`${sectionLabels[section]} requirement`} value={sections[section]} onChange={(event) => setSections((current) => ({ ...current, [section]: event.target.value as "required" | "optional" | "disabled" }))}>
              <option value="required">Required</option><option value="optional">Optional</option><option value="disabled">Disabled</option>
            </select></label>)}</div>
        </fieldset>
        {createError && <div role="alert" className="notice error-notice"><p>{createError}</p>{duplicate && <button type="button" onClick={() => onOpen(duplicate.id)}>Load existing report</button>}</div>}
        <button className="primary" type="submit" disabled={!connected || creating || !reportMonth || !isValidIanaTimeZone(timeZone)}>{creating ? "Creating…" : "Continue"}</button>
      </form>
    </section>
    <RecentReports reports={recent} onOpen={onOpen} />
  </main>;
}

function RecentReports({ reports, onOpen }: { reports: ReportDraft[]; onOpen(id: string): void }) {
  return <section className="card"><h2>Recent Reports</h2>{reports.length === 0 ? <p className="empty">No reports yet.</p> : <ul className="recent-list">{reports.map((report) => <li key={report.id}><button onClick={() => onOpen(report.id)}><strong>{report.client.name}</strong><span>{formatReportMonth(report.reportMonth)} · {humanize(report.status)}</span><small>Updated {new Date(report.updatedAt).toLocaleString()}</small></button></li>)}</ul>}</section>;
}

function ReportDetail({ api, captureService, report, onReport }: { api: ApiClient; captureService: CaptureService; report: ReportDraft; onReport(report: ReportDraft): void }) {
  const [validation, setValidation] = useState<ReportValidationState>(report.validation);
  const [history, setHistory] = useState<Awaited<ReturnType<ApiClient["getReportHistory"]>>>([]);
  const [busy, setBusy] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [captureItem, setCaptureItem] = useState<ChecklistItem | null>(null);
  const [viewedImage, setViewedImage] = useState<string | null>(null);
  const checklist = buildReportChecklist(report);
  const summary = summarizeChecklist(checklist);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try { setHistory(await api.getReportHistory(report.id)); }
    catch { setActionError("Lifecycle history could not be loaded."); }
    finally { setHistoryLoading(false); }
  }, [api, report.id]);
  useEffect(() => { void loadHistory(); }, [loadHistory]);
  useEffect(() => () => { if (viewedImage) URL.revokeObjectURL(viewedImage); }, [viewedImage]);

  async function validate() {
    setBusy(true); setActionError(null);
    try { setValidation(await api.validateReportDraft(report.id)); }
    catch { setActionError("Report validation could not be completed."); }
    finally { setBusy(false); }
  }
  async function applyEvent(event: ReportMutationEvent) {
    setBusy(true); setConflict(false); setActionError(null);
    try { const updated = await api.applyEvent(report.id, event, report.version); onReport(updated); setValidation(updated.validation); await loadHistory(); }
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
  async function viewScreenshot(item: ChecklistItem) {
    if (!item.screenshotType) return;
    setBusy(true); setActionError(null);
    try { setViewedImage(URL.createObjectURL(await api.getScreenshotImage(report.id, item.screenshotType))); }
    catch (caught) { setActionError(caught instanceof ApiError ? caught.message : "Screenshot preview could not be loaded."); }
    finally { setBusy(false); }
  }

  if (captureItem?.screenshotType) return <CaptureWorkflow
    api={api} captureService={captureService} report={report} screenshotType={captureItem.screenshotType} label={captureItem.label}
    onComplete={(updated) => { onReport(updated); setValidation(updated.validation); setCaptureItem(null); }}
    onVersionConflict={() => { setCaptureItem(null); setConflict(true); }} onCancel={() => setCaptureItem(null)}
  />;

  return <main>
    <section className="card report-hero"><p className="kicker">Monthly report</p><h1>{report.client.name}</h1><p className="report-month">{formatReportMonth(report.reportMonth)}</p>
      <div className="period-preview"><span>Reporting Period<strong>{formatCalendarRange(report.period.startDate, report.period.endDate)}</strong></span><span>Previous Comparison<strong>{formatCalendarRange(report.period.previousStartDate, report.period.previousEndDate)}</strong></span></div>
      <div className="metadata"><span>Status<strong>{humanize(report.status)}</strong></span><span>Version<strong>{report.version}</strong></span><span>Updated<strong>{new Date(report.updatedAt).toLocaleString()}</strong></span></div>
    </section>
    <section className="card"><div className="section-heading"><h2>Report Checklist</h2><span className="count">{summary.requiredComplete} / {summary.requiredTotal} required</span></div>
      <ul className="checklist">{checklist.filter(({ state }) => state !== "disabled").map((item) => <li key={item.section}><span className={`check-icon ${item.state}`}>{item.state === "approved" ? "✓" : item.state === "unapproved" ? "◐" : "○"}</span><span><strong>{item.label}</strong><small>{checklistText(item.state, item.requirement)}</small></span>{item.screenshotType && (item.state === "approved" ? <span className="check-actions"><button disabled={busy} onClick={() => void viewScreenshot(item)}>View</button><button disabled={busy} onClick={() => setCaptureItem(item)}>Retake</button></span> : <button disabled={busy} onClick={() => setCaptureItem(item)}>Capture</button>)}</li>)}</ul>
      {checklist.some(({ state }) => state === "disabled") && <details><summary>Disabled sections</summary><p>{checklist.filter(({ state }) => state === "disabled").map(({ label }) => label).join(", ")}</p></details>}
      <div className="validation-summary"><span>Errors <strong>{validation.errors.length}</strong></span><span>Warnings <strong>{validation.warnings.length}</strong></span></div>
      <button className="primary" disabled={busy} onClick={() => void validate()}>{busy ? "Working…" : "Validate Report"}</button>
      {(validation.errors.length > 0 || validation.warnings.length > 0) && <ul className="issues">{[...validation.errors, ...validation.warnings].map((issue, index) => <li key={`${issue.code}-${index}`} className={issue.severity}><strong>{issue.severity.toUpperCase()}</strong><span>{issue.message}<small>{issue.code}</small></span></li>)}</ul>}
    </section>
    {conflict && <section role="alert" className="card conflict"><h2>This report was updated somewhere else.</h2><p>Reload the latest version before deciding what to do next.</p><button onClick={() => void reload()}>Reload Latest Version</button></section>}
    {actionError && <p role="alert" className="notice error-notice">{actionError}</p>}
    {viewedImage && <section className="card screenshot-view"><div className="section-heading"><h2>Stored Screenshot</h2><button onClick={() => setViewedImage(null)}>Close</button></div><img src={viewedImage} alt="Stored report screenshot" /></section>}
    <section className="card"><h2>Development workflow</h2><p className="support-copy">These actions test report states only. Provider fetching and PDF generation are not implemented.</p><div className="actions">{lifecycleActions(report.status).map(([event, label]) => <button key={event} disabled={busy} onClick={() => void applyEvent(event)}>{label}</button>)}</div></section>
    <section className="card"><h2>History</h2>{historyLoading ? <p>Loading history…</p> : history.length === 0 ? <p className="empty">No history available.</p> : <ol className="history">{history.map((entry) => <li key={entry.id}><time>{new Date(entry.createdAt).toLocaleString()}</time><strong>{entry.eventType}</strong><span>{entry.fromStatus ?? "—"} → {entry.toStatus} · Version {entry.reportVersion}</span></li>)}</ol>}</section>
  </main>;
}

function lifecycleActions(status: ReportDraft["status"]): [ReportMutationEvent, string][] {
  const actions: Partial<Record<ReportDraft["status"], [ReportMutationEvent, string][]>> = {
    draft: [["START_DATA_FETCH", "Start Data Fetch"]],
    data_fetching: [["DATA_FETCH_SUCCEEDED", "Simulate Data Ready"], ["DATA_FETCH_FAILED", "Simulate Fetch Failure"]],
    data_ready: [["MARK_CAPTURES_INCOMPLETE", "Mark Captures Incomplete"], ["SUBMIT_FOR_REVIEW", "Submit for Review"]],
    captures_incomplete: [["SUBMIT_FOR_REVIEW", "Submit for Review"]],
    ready_for_review: [["APPROVE", "Approve"]], approved: [["START_GENERATION", "Simulate Generation Start"]],
    generating: [["GENERATION_SUCCEEDED", "Simulate Generated"], ["GENERATION_FAILED", "Simulate Generation Failure"]],
    failed: [["RESET_TO_DRAFT", "Reset to Draft"]],
  };
  return actions[status] ?? [];
}
function supportedTimeZones(): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  return supportedValuesOf ? supportedValuesOf("timeZone") : ["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Kolkata"];
}
function humanize(value: string): string { return value.split("_").map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" "); }
function checklistText(state: string, requirement: string): string {
  if (state === "approved") return "Approved";
  if (state === "unapproved") return "Captured — Approval required";
  if (state === "not_required") return "No screenshot required";
  return requirement === "required" ? "Required · Missing" : "Optional";
}
