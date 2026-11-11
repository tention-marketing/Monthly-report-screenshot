import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type ApiClient } from "@tention/api-client";
import {
  CLIENT_SETUP_ITEMS, isValidIanaTimeZone, klaviyoAccountDisplayName, KLAVIYO_SUBSCRIBER_GROWTH_URL, parseKlaviyoMetricUrl, parseProviderMetricId, parseSubscriberGrowthSourceUrl,
  type ClientReportTargetsInput, type ClientSetupBlocker, type ClientSetupItemKey, type ClientSetupStatus, type ClientSetupSummary, type ReportDraft, type ReportMonth,
} from "@tention/report-schema";
import type { BusinessReviewDiscoveryRequest, BusinessReviewDiscoveryResult } from "../klaviyo-navigation/business-review-discovery.js";
import type { ConversionMetricSourceResult, DeliverabilitySourceRequest, DeliverabilitySourceResult } from "../klaviyo-navigation/client-setup-sources.js";
import type { SubscriberGrowthDiscoveryResult } from "../klaviyo-navigation/subscriber-growth-source-setup.js";
import { DEFAULT_DRAFT_SECTION_CONFIGURATION } from "../create-report/defaults.js";
import { formatCalendarRange, formatReportMonth, getCompletedMonthOptions, normalizeSelectedMonth, parseMonthValue, toMonthValue } from "../../lib/dates/month-options.js";
import { klaviyoAccountEvidence, type AccountIdentity } from "./account-evidence.js";
import { ClientTargetEditor, cleanTargetInput, supportedCurrencies, supportedTimeZones, targetInput } from "./client-targets.js";

/**
 * Client onboarding (phase 1) is separate from monthly reports (phase 2): a client is added once, its Klaviyo account
 * and sources are verified from the client's own Klaviyo tab, and only a READY client (as the API computes it with the
 * shared `clientSetupBlockers`) can create a monthly report.
 */

export interface ClientSetupDiscovery {
  verifyAccount(input: BusinessReviewDiscoveryRequest): Promise<BusinessReviewDiscoveryResult>;
  verifyDeliverability(request: DeliverabilitySourceRequest): Promise<DeliverabilitySourceResult>;
  takeConversionMetric(): Promise<ConversionMetricSourceResult>;
  watchConversionMetric(callback: () => void): () => void;
  subscriberGrowth: {
    take(): Promise<SubscriberGrowthDiscoveryResult>;
    persisted(request: { saved: boolean; sourceUrl: string | null; failureCode?: string | null }): Promise<unknown>;
    watch(callback: () => void): () => void;
  };
  /** Fires after each Tention toolbar click on a Klaviyo reporting page (the activeTab grant). */
  watchToolbarClick(callback: () => void): () => void;
}

export const STATUS_LABEL: Record<ClientSetupStatus, string> = { READY: "READY", INCOMPLETE: "SETUP INCOMPLETE", VERIFYING: "VERIFYING", ERROR: "SETUP ERROR" };
const ITEM_LABEL = Object.fromEntries(CLIENT_SETUP_ITEMS.map(({ key, label }) => [key, label])) as Record<ClientSetupItemKey, string>;
/** How a missing item reads in "Missing:" lists (the metric ID is named after its metric). */
export function missingItemLabel(blocker: Pick<ClientSetupBlocker, "item">, metricLabel = "Placed Order"): string {
  return blocker.item === "conversionMetricId" ? `${metricLabel} metric ID` : ITEM_LABEL[blocker.item] ?? blocker.item;
}
const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

type View = { kind: "list" } | { kind: "add" } | { kind: "setup"; clientId: string; advanced?: boolean } | { kind: "detail"; clientId: string } | { kind: "create"; clientId: string };

/** Reports removed since the panel opened (deleted, or found missing) and a revision that asks every list to refetch. */
export interface ReportSync { revision: number; removedIds: readonly string[] }
const NO_REPORT_SYNC: ReportSync = { revision: 0, removedIds: [] };

export interface ClientsWorkspaceProps {
  api: ApiClient; connected: boolean; now: () => Date; discovery: ClientSetupDiscovery;
  /** Opens on this client's page (e.g. returning from a report that no longer exists). */
  initialClientId?: string | null;
  reportSync?: ReportSync;
  /** A report was deleted from a client's Reports list: the app reconciles every other report list. */
  onReportDeleted?(report: ReportDraft): void;
  /** A report was created; `autoStart` asks the report screen to start the automatic capture. */
  onReportCreated(report: ReportDraft, options: { autoStart: boolean }): void;
  onOpenReport(id: string): void;
}

export function ClientsWorkspace({ api, connected, now, discovery, initialClientId = null, reportSync = NO_REPORT_SYNC, onReportDeleted, onReportCreated, onOpenReport }: ClientsWorkspaceProps) {
  const [view, setView] = useState<View>(initialClientId ? { kind: "detail", clientId: initialClientId } : { kind: "list" });
  const [setups, setSetups] = useState<ClientSetupSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!connected) return;
    try { setSetups(await api.listClientSetups()); setLoadError(null); }
    catch { setLoadError("Clients could not be loaded."); setSetups([]); }
  }, [api, connected]);
  useEffect(() => { void reload(); }, [reload]);
  const back = () => { setView({ kind: "list" }); void reload(); };

  if (view.kind === "add") return <AddClient api={api} onCancel={back} onAdded={(summary) => { void reload(); setView({ kind: "setup", clientId: summary.clientId }); }} onOpenExisting={(clientId) => setView({ kind: "detail", clientId })} />;
  if (view.kind === "setup") return <ClientSetup api={api} clientId={view.clientId} discovery={discovery} advancedOpen={view.advanced ?? false} onBack={() => setView({ kind: "detail", clientId: view.clientId })} onCreateReport={() => setView({ kind: "create", clientId: view.clientId })} />;
  if (view.kind === "detail") return <ClientDetail api={api} clientId={view.clientId} now={now} reportSync={reportSync} onReportDeleted={onReportDeleted} onBack={back} onEdit={() => setView({ kind: "setup", clientId: view.clientId })} onAdvanced={() => setView({ kind: "setup", clientId: view.clientId, advanced: true })} onCreateReport={() => setView({ kind: "create", clientId: view.clientId })} onOpenReport={onOpenReport} />;
  if (view.kind === "create") return <CreateMonthlyReport api={api} clientId={view.clientId} now={now} onBack={() => setView({ kind: "detail", clientId: view.clientId })} onCreated={(report) => onReportCreated(report, { autoStart: true })} onOpenReport={onOpenReport} />;

  return <section className="card" aria-label="Clients">
    <div className="section-heading"><div><p className="kicker">Tention Reports</p><h1>Clients</h1></div></div>
    {loadError && <p role="alert" className="field-error">{loadError}</p>}
    {setups === null ? <p className="support-copy">{connected ? "Loading clients…" : "Connect to the reporting API to load clients."}</p>
      : setups.length === 0 ? <p className="empty">No clients yet. Add a client to set it up once; monthly reports reuse that setup.</p>
        : <ul className="client-list">{setups.map((setup) => <li key={setup.clientId}><button className="client-row" onClick={() => setView({ kind: "detail", clientId: setup.clientId })} aria-label={`${setup.name} ${STATUS_LABEL[setup.status]}`}>
          <strong>{setup.name}</strong><span className={`setup-status ${setup.status.toLowerCase()}`}>{STATUS_LABEL[setup.status]}</span></button></li>)}</ul>}
    <button className="primary" disabled={!connected} onClick={() => setView({ kind: "add" })}>+ Add New Client</button>
  </section>;
}

function AddClient({ api, onCancel, onAdded, onOpenExisting }: { api: ApiClient; onCancel(): void; onAdded(summary: ClientSetupSummary): void; onOpenExisting(clientId: string): void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setError("Enter the client name."); return; }
    setBusy(true); setError(null); setExisting(null);
    try { onAdded(await api.createClient(name.trim())); }
    catch (caught) {
      if (caught instanceof ApiError && caught.code === "CLIENT_ALREADY_EXISTS") { setError(caught.message); setExisting((caught.details as { clientId?: string } | undefined)?.clientId ?? null); }
      else setError(caught instanceof ApiError ? caught.message : "The client could not be added.");
    } finally { setBusy(false); }
  }
  return <section className="card" aria-label="Add New Client">
    <p className="kicker">Add new client · Step 1</p><h1>Client Name</h1>
    <form onSubmit={(event) => void submit(event)}>
      <label>Client Name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Client name" autoFocus /></label>
      {error && <div role="alert" className="field-error">{error}{existing && <> <button type="button" className="text-button" onClick={() => onOpenExisting(existing)}>Open existing client</button></>}</div>}
      <div className="actions"><button className="primary" type="submit" disabled={busy}>{busy ? "Adding…" : "Continue"}</button><button type="button" onClick={onCancel} disabled={busy}>Cancel</button></div>
    </form>
  </section>;
}

type ItemState = { busy: boolean; error: string | null };
type GrowthErrorCode = "AUTO_VERIFY_FAILED" | "WRONG_KLAVIYO_ACCOUNT" | "INVALID_SUBSCRIBER_GROWTH_URL";
const GROWTH_ERROR: Record<GrowthErrorCode, { title: string; message: string }> = {
  AUTO_VERIFY_FAILED: { title: "AUTO VERIFICATION FAILED", message: "We couldn't verify Subscriber Growth automatically. Use the current Subscriber Growth page or paste its URL." },
  WRONG_KLAVIYO_ACCOUNT: { title: "WRONG KLAVIYO ACCOUNT", message: "This page appears to belong to another Klaviyo account. Nothing was saved." },
  INVALID_SUBSCRIBER_GROWTH_URL: { title: "INVALID_SUBSCRIBER_GROWTH_URL", message: "Paste the Klaviyo Subscriber Growth URL, such as https://www.klaviyo.com/people/subscribers." },
};
type MetricErrorCode = "AUTO_DETECTION_FAILED" | "WRONG_KLAVIYO_ACCOUNT" | "INVALID_METRIC_URL" | "INVALID_PROVIDER_METRIC_ID";
const METRIC_ERROR: Record<MetricErrorCode, { title: string; message: string }> = {
  AUTO_DETECTION_FAILED: { title: "AUTO DETECTION FAILED", message: "We couldn't verify this metric automatically. You can paste the Placed Order metric URL or enter the Provider Metric ID manually." },
  WRONG_KLAVIYO_ACCOUNT: { title: "WRONG KLAVIYO ACCOUNT", message: "This page appears to belong to another Klaviyo account. Nothing was saved." },
  INVALID_METRIC_URL: { title: "INVALID_METRIC_URL", message: "Paste a Klaviyo Placed Order URL such as /metric/<id>/placed-order." },
  INVALID_PROVIDER_METRIC_ID: { title: "INVALID_PROVIDER_METRIC_ID", message: "Enter only the Klaviyo metric ID, not the full URL." },
};

function ClientSetup({ api, clientId, discovery, advancedOpen, onBack, onCreateReport }: { api: ApiClient; clientId: string; discovery: ClientSetupDiscovery; advancedOpen: boolean; onBack(): void; onCreateReport(): void }) {
  const [summary, setSummary] = useState<ClientSetupSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItems] = useState<Partial<Record<ClientSetupItemKey, ItemState>>>({});
  const [wrongAccount, setWrongAccount] = useState<{ expected: string; detected: string } | null>(null);
  const [timeZone, setTimeZone] = useState("");
  const [currency, setCurrency] = useState("");
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [otherClients, setOtherClients] = useState<ClientSetupSummary[] | null>(null);
  const [metricUrl, setMetricUrl] = useState("");
  const [metricIdInput, setMetricIdInput] = useState("");
  const [pendingMetric, setPendingMetric] = useState<{ source: "url" | "manual"; providerMetricId: string } | null>(null);
  const [metricNotice, setMetricNotice] = useState<{ code: MetricErrorCode; detail: string | null } | null>(null);
  const [changingMetric, setChangingMetric] = useState(false);
  const [growthUrlInput, setGrowthUrlInput] = useState("");
  const [pendingGrowth, setPendingGrowth] = useState<{ source: "current"; url: string; probedUrl: string } | null>(null);
  const [growthNotice, setGrowthNotice] = useState<{ code: GrowthErrorCode; detail: string | null } | null>(null);
  useEffect(() => { void api.listClientSetups().then(setOtherClients).catch(() => setOtherClients([])); }, [api]);
  const timeZones = useMemo(() => supportedTimeZones(), []);
  const currencies = useMemo(() => supportedCurrencies(), []);
  // The freshest summary for callbacks registered once (toolbar and storage watchers).
  const latest = useRef(summary); latest.current = summary;
  // Saves run one at a time, each on top of the stored configuration: two verifications never drop each other's field.
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const refresh = useCallback(async () => {
    try { const next = await api.getClientSetup(clientId); setSummary(next); setLoadError(null); return next; }
    catch { setLoadError("The client setup could not be loaded."); return null; }
  }, [api, clientId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!summary) return;
    setTimeZone((current) => current || summary.setup.profile?.timezone || "");
    setCurrency((current) => current || summary.setup.profile?.currency || "");
  }, [summary]);

  const setItem = (key: ClientSetupItemKey, state: ItemState) => setItems((current) => ({ ...current, [key]: state }));
  function save(mutate: (input: ClientReportTargetsInput) => ClientReportTargetsInput): Promise<ClientSetupSummary | null> {
    const run = queue.current.then(async () => {
      const stored = await api.getClientReportTargets(clientId);
      await api.saveClientReportTargets(clientId, mutate(targetInput(stored)));
      return refresh();
    });
    queue.current = run.catch(() => undefined);
    return run;
  }
  const failure = (caught: unknown, fallback: string) => caught instanceof ApiError ? caught.message : caught instanceof Error ? caught.message : fallback;

  const has = (item: ClientSetupItemKey, current = latest.current) => Boolean(current && !current.blockers.some((blocker) => blocker.item === item));
  const accountReady = (current = latest.current) => has("klaviyoAccount", current) && has("businessReview", current);

  async function verifyAccount(quiet = false) {
    const current = latest.current; if (!current) return;
    const review = current.setup.businessReview;
    setItem("klaviyoAccount", { busy: true, error: null }); setWrongAccount(null);
    try {
      const result = await discovery.verifyAccount({ clientName: current.name, configuredUrl: review?.dashboardUrl ?? null, configuredAccountLabel: review?.accountLabel ?? null, configuredProviderAccountId: review?.providerAccountId ?? null });
      if (!result.ok) {
        if (result.code === "ACCOUNT_CONTEXT_MISMATCH") {
          const detected = typeof result.diagnostics?.accountLabel === "string" ? result.diagnostics.accountLabel : "an account that could not be named";
          setWrongAccount({ expected: review?.accountLabel ?? current.name, detected });
          setItem("klaviyoAccount", { busy: false, error: null }); return;
        }
        setItem("klaviyoAccount", { busy: false, error: quiet ? null : result.message }); return;
      }
      if (!("verification" in result)) {
        // The real Klaviyo account name, without the avatar initials a page reader picks up with it.
        await save((input) => ({ ...input, businessReview: { dashboardUrl: result.dashboardUrl, displayName: "Business Review", accountLabel: klaviyoAccountDisplayName(result.accountLabel), ...(result.providerAccountId ? { providerAccountId: result.providerAccountId, providerIdentityKind: result.providerIdentityKind ?? "account" } : {}) } }));
      }
      setItem("klaviyoAccount", { busy: false, error: null });
    } catch (caught) { setItem("klaviyoAccount", { busy: false, error: failure(caught, "The Klaviyo account could not be verified.") }); }
  }

  async function saveProfileValue(item: "timezone" | "currency", value: string) {
    setItem(item, { busy: true, error: null });
    try {
      await save((input) => ({ ...input, profile: { ...input.profile!, [item]: value } }));
      setItem(item, { busy: false, error: null });
    } catch (caught) { setItem(item, { busy: false, error: failure(caught, `The ${item} could not be saved.`) }); }
  }

  /** Other saved clients' identities: a page showing one of them is definitively the wrong account. */
  const otherAccounts = (): AccountIdentity[] => (otherClients ?? []).filter((other) => other.clientId !== clientId).map((other) => ({ name: other.name, accountLabel: other.setup.businessReview?.accountLabel ?? null }));
  const metricFailure = (code: MetricErrorCode, detail: string | null = null) => { setMetricNotice({ code, detail }); setItem("conversionMetricId", { busy: false, error: null }); };

  /** Method 1: the metric page read at the latest toolbar click on this client's Klaviyo tab. */
  async function verifyMetric(quiet = false) {
    const current = latest.current; if (!current) return;
    if (!accountReady(current)) { if (!quiet) setItem("conversionMetricId", { busy: false, error: "Verify the client's Klaviyo account first, or paste the metric URL / enter the metric ID below." }); return; }
    setItem("conversionMetricId", { busy: true, error: null }); setMetricNotice(null); setPendingMetric(null);
    try {
      const result = await discovery.takeConversionMetric();
      if (!result.ok) { if (quiet) setItem("conversionMetricId", { busy: false, error: null }); else metricFailure("AUTO_DETECTION_FAILED", result.message); return; }
      const label = current.setup.profile?.conversionMetric.label ?? "Placed Order";
      const fromAddress = parseKlaviyoMetricUrl(result.sourceUrl, label);
      const named = result.headings.some((heading) => normalize(heading) === normalize(label)) || normalize(result.title).startsWith(normalize(label));
      if (!fromAddress.ok || fromAddress.providerMetricId !== result.metricId || !named) {
        metricFailure("AUTO_DETECTION_FAILED", `The open page is not ${label} (found: ${result.headings.slice(0, 3).join(", ") || result.title || "no heading"}).`); return;
      }
      // Primary identity: the account binding verified at onboarding; the client name is secondary evidence.
      const evidence = klaviyoAccountEvidence(result.accountLabels, { name: current.name, accountLabel: current.setup.businessReview?.accountLabel ?? null }, otherAccounts());
      if (evidence === "WRONG_ACCOUNT") { metricFailure("WRONG_KLAVIYO_ACCOUNT"); return; }
      if (evidence === "UNKNOWN") { metricFailure("AUTO_DETECTION_FAILED", `The page did not show ${current.name}'s Klaviyo account name.`); return; }
      await saveMetricId(fromAddress.providerMetricId);
    } catch (caught) { setItem("conversionMetricId", { busy: false, error: failure(caught, "The metric ID could not be saved.") }); }
  }
  /** Method 2: a pasted metric page URL; only its pathname is read. Saved after an explicit confirmation. */
  function reviewMetricUrl() {
    setMetricNotice(null); setPendingMetric(null);
    const parsed = parseKlaviyoMetricUrl(metricUrl, summary?.setup.profile?.conversionMetric.label ?? "Placed Order");
    if (!parsed.ok) { setMetricNotice({ code: "INVALID_METRIC_URL", detail: parsed.message }); return; }
    setPendingMetric({ source: "url", providerMetricId: parsed.providerMetricId });
  }
  /** Method 3: the ID typed by hand. Saved only after the user confirms it came from this client's own account. */
  function reviewMetricId() {
    setMetricNotice(null); setPendingMetric(null);
    const parsed = parseProviderMetricId(metricIdInput);
    if (!parsed.ok) { setMetricNotice({ code: "INVALID_PROVIDER_METRIC_ID", detail: parsed.message }); return; }
    setPendingMetric({ source: "manual", providerMetricId: parsed.providerMetricId });
  }
  /** Every method ends here: the ID is stored on this client only; the API refuses an ID another client already has. */
  async function saveMetricId(providerMetricId: string) {
    setItem("conversionMetricId", { busy: true, error: null });
    try {
      await save((input) => ({ ...input, profile: { ...input.profile!, conversionMetric: { label: input.profile!.conversionMetric.label, providerMetricId } } }));
      setPendingMetric(null); setMetricUrl(""); setMetricIdInput(""); setMetricNotice(null); setChangingMetric(false);
      setItem("conversionMetricId", { busy: false, error: null });
    } catch (caught) { setItem("conversionMetricId", { busy: false, error: failure(caught, "The metric ID could not be saved.") }); }
  }

  async function verifyDeliverability(quiet = false) {
    const current = latest.current; if (!current) return;
    if (!accountReady(current)) { if (!quiet) setItem("deliverability", { busy: false, error: "Verify the client's Klaviyo account first." }); return; }
    const review = current.setup.businessReview;
    setItem("deliverability", { busy: true, error: null });
    try {
      const result = await discovery.verifyDeliverability({ clientName: current.name, configuredUrl: review?.dashboardUrl ?? null, configuredAccountLabel: review?.accountLabel ?? null, configuredProviderAccountId: review?.providerAccountId ?? null });
      if (!result.ok) { setItem("deliverability", { busy: false, error: quiet && result.code !== "ACCOUNT_CONTEXT_MISMATCH" ? null : result.message }); return; }
      await save((input) => ({ ...input, sourceUrls: { ...(input.sourceUrls ?? {}), deliverabilityUrl: result.deliverabilityUrl } }));
      setItem("deliverability", { busy: false, error: null });
    } catch (caught) { setItem("deliverability", { busy: false, error: failure(caught, "The Deliverability source could not be saved.") }); }
  }

  /**
   * Subscriber Growth source. The page itself is proven by the toolbar-click probe (route + Subscriber growth view; it
   * selects Email → Growth on its own). The account is proven by the page's labels or, when this page shows no readable
   * account name, by re-proving the saved binding on the authorized tab — never assumed. Another client's account blocks.
   */
  async function verifySubscriberGrowth(quiet = false) {
    const current = latest.current; if (!current) return;
    if (!accountReady(current)) { if (!quiet) setItem("subscriberGrowth", { busy: false, error: "Verify the client's Klaviyo account first, or save the Subscriber Growth URL below." }); return; }
    setItem("subscriberGrowth", { busy: true, error: null }); setGrowthNotice(null); setPendingGrowth(null);
    let sourceUrl: string | null = null; let saved = false; let failureCode: string | null = null;
    try {
      const result = await discovery.subscriberGrowth.take();
      if (!result.ok) { failureCode = result.code; setItem("subscriberGrowth", { busy: false, error: null }); if (!quiet) setGrowthNotice({ code: "AUTO_VERIFY_FAILED", detail: result.message }); return; }
      sourceUrl = result.subscriberGrowthUrl;
      const route = parseSubscriberGrowthSourceUrl(result.subscriberGrowthUrl);
      if (!route.ok) { failureCode = "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED"; setItem("subscriberGrowth", { busy: false, error: null }); setGrowthNotice({ code: "AUTO_VERIFY_FAILED", detail: "The open page is not Audience → Profiles → Subscriber growth." }); return; }
      const account = await growthAccountEvidence(current, result.accountLabels);
      if (account !== "THIS_CLIENT") {
        failureCode = "SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN"; setItem("subscriberGrowth", { busy: false, error: null });
        setGrowthNotice(account === "WRONG_ACCOUNT" ? { code: "WRONG_KLAVIYO_ACCOUNT", detail: null } : { code: "AUTO_VERIFY_FAILED", detail: `${current.name}'s Klaviyo account name could not be read on this page.` }); return;
      }
      saved = await saveGrowthSource(route.url);
      if (!saved) failureCode = "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED";
    } catch (caught) { failureCode = failureCode ?? "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED"; setItem("subscriberGrowth", { busy: false, error: failure(caught, "The Subscriber Growth source could not be saved.") }); }
    finally { if (sourceUrl !== null || (failureCode && failureCode !== "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED")) await discovery.subscriberGrowth.persisted({ saved, sourceUrl, failureCode: saved ? null : failureCode }).catch(() => undefined); }
  }
  /** Page labels first; when they name no account, the saved binding is re-proven on the authorized tab. */
  async function growthAccountEvidence(current: ClientSetupSummary, labels: readonly string[]): Promise<"THIS_CLIENT" | "WRONG_ACCOUNT" | "UNKNOWN"> {
    const evidence = klaviyoAccountEvidence(labels, { name: current.name, accountLabel: current.setup.businessReview?.accountLabel ?? null }, otherAccounts());
    if (evidence !== "UNKNOWN") return evidence;
    const review = current.setup.businessReview;
    const bound = await discovery.verifyAccount({ clientName: current.name, configuredUrl: review?.dashboardUrl ?? null, configuredAccountLabel: review?.accountLabel ?? null, configuredProviderAccountId: review?.providerAccountId ?? null, verifySavedAccountOnly: true }).catch(() => null);
    if (bound?.ok) return "THIS_CLIENT";
    return bound?.code === "ACCOUNT_CONTEXT_MISMATCH" ? "WRONG_ACCOUNT" : "UNKNOWN";
  }
  /** "Use Current Subscriber Growth Page": the page proven at the toolbar click, saved after an explicit confirmation. */
  async function useCurrentGrowthPage() {
    const current = latest.current; if (!current) return;
    setGrowthNotice(null); setPendingGrowth(null); setItem("subscriberGrowth", { busy: true, error: null });
    try {
      const result = await discovery.subscriberGrowth.take();
      if (!result.ok) { setItem("subscriberGrowth", { busy: false, error: null }); setGrowthNotice({ code: "AUTO_VERIFY_FAILED", detail: result.message }); return; }
      const route = parseSubscriberGrowthSourceUrl(result.subscriberGrowthUrl);
      const release = (failureCode: string) => discovery.subscriberGrowth.persisted({ saved: false, sourceUrl: result.subscriberGrowthUrl, failureCode }).catch(() => undefined);
      if (!route.ok) { await release("SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED"); setItem("subscriberGrowth", { busy: false, error: null }); setGrowthNotice({ code: "INVALID_SUBSCRIBER_GROWTH_URL", detail: "The open page is not Audience → Profiles → Subscriber growth." }); return; }
      // Wrong-account protection holds here too: a page that shows another client's account is never offered.
      if (klaviyoAccountEvidence(result.accountLabels, { name: current.name, accountLabel: current.setup.businessReview?.accountLabel ?? null }, otherAccounts()) === "WRONG_ACCOUNT") {
        await release("SUBSCRIBER_GROWTH_ACCOUNT_UNPROVEN"); setItem("subscriberGrowth", { busy: false, error: null }); setGrowthNotice({ code: "WRONG_KLAVIYO_ACCOUNT", detail: null }); return;
      }
      setPendingGrowth({ source: "current", url: route.url, probedUrl: result.subscriberGrowthUrl }); setItem("subscriberGrowth", { busy: false, error: null });
    } catch (caught) { setItem("subscriberGrowth", { busy: false, error: failure(caught, "The current page could not be read.") }); }
  }
  /** Manual fallback: a pasted address, reduced to the stable route. */
  async function saveGrowthUrl() {
    setGrowthNotice(null); setPendingGrowth(null);
    const route = parseSubscriberGrowthSourceUrl(growthUrlInput);
    if (!route.ok) { setGrowthNotice({ code: "INVALID_SUBSCRIBER_GROWTH_URL", detail: route.message }); return; }
    setItem("subscriberGrowth", { busy: true, error: null });
    try { await saveGrowthSource(route.url); } catch (caught) { setItem("subscriberGrowth", { busy: false, error: failure(caught, "The Subscriber Growth source could not be saved.") }); }
  }
  async function confirmCurrentGrowthPage() {
    if (!pendingGrowth) return;
    setItem("subscriberGrowth", { busy: true, error: null });
    let saved = false;
    try { saved = await saveGrowthSource(pendingGrowth.url); }
    catch (caught) { setItem("subscriberGrowth", { busy: false, error: failure(caught, "The Subscriber Growth source could not be saved.") }); }
    finally { await discovery.subscriberGrowth.persisted({ saved, sourceUrl: pendingGrowth.probedUrl, failureCode: saved ? null : "SUBSCRIBER_GROWTH_SOURCE_SAVE_UNCONFIRMED" }).catch(() => undefined); }
  }
  function cancelCurrentGrowthPage() {
    if (pendingGrowth) void discovery.subscriberGrowth.persisted({ saved: false, sourceUrl: pendingGrowth.probedUrl, failureCode: "SUBSCRIBER_GROWTH_SOURCE_SAVE_CANCELLED" }).catch(() => undefined);
    setPendingGrowth(null);
  }
  /** Every path ends here: the stable route on this client only, confirmed by reloading the saved setup. */
  async function saveGrowthSource(url: string): Promise<boolean> {
    const next = await save((input) => ({ ...input, sourceUrls: { ...(input.sourceUrls ?? {}), subscriberGrowthUrl: url } }));
    const saved = next?.setup.sourceUrls?.subscriberGrowthUrl === url;
    setItem("subscriberGrowth", { busy: false, error: saved ? null : "The saved Subscriber Growth source could not be confirmed." });
    if (saved) { setPendingGrowth(null); setGrowthUrlInput(""); setGrowthNotice(null); }
    return saved;
  }

  // Discovery-first: a toolbar click on the client's Klaviyo tab verifies whatever that page can prove, by itself.
  const handlers = useRef({ verifyAccount, verifyDeliverability, verifyMetric, verifySubscriberGrowth });
  handlers.current = { verifyAccount, verifyDeliverability, verifyMetric, verifySubscriberGrowth };
  useEffect(() => discovery.watchToolbarClick(() => {
    const current = latest.current; if (!current) return;
    if (!accountReady(current)) void handlers.current.verifyAccount(true);
    else if (!has("deliverability", current)) void handlers.current.verifyDeliverability(true);
  }), [discovery]);
  useEffect(() => discovery.watchConversionMetric(() => { if (latest.current && !has("conversionMetricId")) void handlers.current.verifyMetric(true); }), [discovery]);
  useEffect(() => discovery.subscriberGrowth.watch(() => { if (latest.current && !has("subscriberGrowth")) void handlers.current.verifySubscriberGrowth(true); }), [discovery]);

  async function saveAdvanced(input: ClientReportTargetsInput) {
    setAdvancedError(null);
    try { await save(() => cleanTargetInput({ ...input, profile: input.profile })); }
    catch (caught) { setAdvancedError(failure(caught, "The client configuration could not be saved.")); }
  }

  if (!summary) return <section className="card"><button className="text-button" onClick={onBack}>← Back</button>{loadError ? <p role="alert" className="field-error">{loadError}</p> : <p className="loading">Loading client setup…</p>}</section>;
  const profile = summary.setup.profile;
  const review = summary.setup.businessReview;
  const verifying = Object.values(items).some((state) => state?.busy);
  const status: ClientSetupStatus = verifying ? "VERIFYING" : summary.status;
  const metricLabel = profile?.conversionMetric.label ?? "Placed Order";
  const values: Record<ClientSetupItemKey, string | null> = {
    clientName: profile?.name ?? null,
    klaviyoAccount: review?.accountLabel ?? review?.providerAccountId ?? null,
    timezone: profile?.timezone ?? null, currency: profile?.currency ?? null,
    conversionMetric: profile?.conversionMetric.label ?? null, conversionMetricId: profile?.conversionMetric.providerMetricId ?? null,
    businessReview: "Verified", deliverability: "Verified", subscriberGrowth: "Verified",
  };
  const blockerFor = (item: ClientSetupItemKey) => summary.blockers.find((blocker) => blocker.item === item) ?? null;
  const itemError = (item: ClientSetupItemKey) => items[item]?.error ? <p role="alert" className="field-error">{items[item]!.error}</p> : null;
  const busy = (item: ClientSetupItemKey) => Boolean(items[item]?.busy);
  const name = summary.name;

  return <main aria-label="Client Setup">
    <section className="card">
      <button className="text-button" onClick={onBack}>← {name}</button>
      <p className="kicker">Client setup</p><h1>{name}</h1>
      <ul className="checklist setup-checklist" aria-label="Client setup checklist">{CLIENT_SETUP_ITEMS.map(({ key, label }) => {
        const blocker = blockerFor(key);
        return <li key={key}><span className={`check-icon ${blocker ? (blocker.code === "CONVERSION_METRIC_ID_SHARED_WITH_OTHER_CLIENT" ? "unapproved" : "pending") : "approved"}`}>{blocker ? (blocker.code === "CONVERSION_METRIC_ID_SHARED_WITH_OTHER_CLIENT" ? "!" : "○") : "✓"}</span>
          <span><strong>{label}</strong><small>{blocker ? blocker.message : values[key]}</small></span></li>;
      })}</ul>
      <p className="setup-status-line">Setup Status <span className={`setup-status ${status.toLowerCase()}`}>{STATUS_LABEL[status]}</span></p>
      {summary.status === "READY" && <div className="notice success-notice"><p>Client setup complete.</p><button className="primary" onClick={onCreateReport}>Create New Report</button></div>}
    </section>

    {wrongAccount && <section role="alert" className="card notice error-notice" aria-label="Wrong Klaviyo account"><strong>Wrong Klaviyo account</strong><p>Expected:<br /><strong>{wrongAccount.expected}</strong></p><p>Detected:<br /><strong>{wrongAccount.detected}</strong></p><p className="support-copy">Nothing was saved. Switch to {name}'s Klaviyo account and click the Tention toolbar icon again.</p></section>}

    <section className="card" aria-label="Klaviyo Account">
      <h2>Klaviyo Account</h2>
      {accountReady(summary) ? <p><strong>{values.klaviyoAccount}</strong> · <span className="ready">VERIFIED</span><br /><small>Business Review dashboard verified for this account.</small></p>
        : <><p className="support-copy">Open {name}'s Klaviyo account in Chrome and click the Tention Reports extension. The account and its Business Review dashboard are verified automatically.</p>
          <div className="actions"><button disabled={busy("klaviyoAccount")} onClick={() => void verifyAccount()}>{busy("klaviyoAccount") ? "Verifying…" : "Verify Klaviyo Account"}</button></div></>}
      {itemError("klaviyoAccount")}
    </section>

    <section className="card" aria-label="Account settings">
      <h2>Timezone and currency</h2>
      <p className="support-copy">Copy both exactly from {name}'s Klaviyo → Settings → Account. Reports use these for every month.</p>
      <label>Timezone<input list="client-timezones" aria-label="Timezone" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} placeholder="America/New_York" /></label>
      <datalist id="client-timezones">{timeZones.map((zone) => <option key={zone} value={zone} />)}</datalist>
      {timeZone && !isValidIanaTimeZone(timeZone) && <p role="alert" className="field-error">Enter a valid IANA timezone.</p>}
      <div className="actions"><button disabled={busy("timezone") || !isValidIanaTimeZone(timeZone) || timeZone === profile?.timezone} onClick={() => void saveProfileValue("timezone", timeZone)}>Save Timezone</button></div>
      {itemError("timezone")}
      <label>Currency<select aria-label="Currency" value={currency} onChange={(event) => setCurrency(event.target.value)}><option value="">Select ISO currency</option>{currencies.map((code) => <option key={code} value={code}>{code}</option>)}</select></label>
      <div className="actions"><button disabled={busy("currency") || !currency || currency === profile?.currency} onClick={() => void saveProfileValue("currency", currency)}>Save Currency</button></div>
      {itemError("currency")}
    </section>

    <section className="card" aria-label="Conversion Metric">
      <h2>Conversion Metric</h2>
      <p>Metric: <strong>{metricLabel}</strong><br />Status: {has("conversionMetricId", summary) ? <><span className="ready">Verified</span> · Provider Metric ID <strong>{values.conversionMetricId}</strong></> : "Not configured"}</p>
      {blockerFor("conversionMetricId")?.code === "CONVERSION_METRIC_ID_SHARED_WITH_OTHER_CLIENT" && <p role="alert" className="field-error">{blockerFor("conversionMetricId")!.message}</p>}
      {has("conversionMetricId", summary) && !changingMetric ? <div className="actions"><button onClick={() => setChangingMetric(true)}>Change Metric ID</button></div> : <>
        <p className="support-copy">Use the metric ID from this client's own Klaviyo → Analytics → Metrics → {metricLabel} page. Never reuse another client's ID.</p>
        <div className="actions"><button disabled={busy("conversionMetricId")} onClick={() => void verifyMetric()}>{busy("conversionMetricId") ? "Reading…" : "Use Current Klaviyo Page"}</button></div>
        <small>Open the {metricLabel} metric page in {name}'s Klaviyo and click the Tention toolbar icon first.</small>
        <p className="method-divider">OR</p>
        <label>Paste Metric URL<input aria-label="Paste Metric URL" value={metricUrl} onChange={(event) => { setMetricUrl(event.target.value); setPendingMetric(null); }} placeholder={`https://www.klaviyo.com/metric/________/${metricLabel.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`} /></label>
        <div className="actions"><button disabled={!metricUrl.trim() || busy("conversionMetricId")} onClick={reviewMetricUrl}>Save From URL</button></div>
        <p className="method-divider">OR</p>
        <label>Provider Metric ID<input aria-label="Provider Metric ID" value={metricIdInput} onChange={(event) => { setMetricIdInput(event.target.value); setPendingMetric(null); }} placeholder="QuWhQ9" autoComplete="off" /></label>
        <div className="actions"><button disabled={!metricIdInput.trim() || busy("conversionMetricId")} onClick={reviewMetricId}>Save Metric ID</button></div>
      </>}
      {pendingMetric && <div className="notice metric-confirmation" role="group" aria-label="Confirm metric ID">
        {pendingMetric.source === "url" ? <p>Detected Metric:<br /><strong>{metricLabel}</strong></p> : <p>Client:<br /><strong>{name}</strong></p>}
        {pendingMetric.source === "manual" && <p>Metric:<br /><strong>{metricLabel}</strong></p>}
        <p>Provider Metric ID:<br /><strong>{pendingMetric.providerMetricId}</strong></p>
        {pendingMetric.source === "manual" && <p className="support-copy">Confirm that this ID came from {name}'s own Klaviyo account.</p>}
        <div className="actions"><button className="primary" disabled={busy("conversionMetricId")} onClick={() => void saveMetricId(pendingMetric.providerMetricId)}>Confirm & Save</button><button onClick={() => setPendingMetric(null)}>Cancel</button></div>
      </div>}
      {metricNotice && <div role="alert" aria-label={METRIC_ERROR[metricNotice.code].title} className="notice error-notice"><strong>{METRIC_ERROR[metricNotice.code].title}</strong><p>{metricNotice.code === "INVALID_PROVIDER_METRIC_ID" || metricNotice.code === "INVALID_METRIC_URL" ? metricNotice.detail ?? METRIC_ERROR[metricNotice.code].message : METRIC_ERROR[metricNotice.code].message}</p>{metricNotice.code === "AUTO_DETECTION_FAILED" && metricNotice.detail && <small>{metricNotice.detail}</small>}</div>}
      {itemError("conversionMetricId")}
    </section>

    <section className="card" aria-label="Reporting sources">
      <h2>Reporting sources</h2>
      <ul className="checklist">
        <li><span className={`check-icon ${has("businessReview", summary) ? "approved" : "pending"}`}>{has("businessReview", summary) ? "✓" : "○"}</span><span><strong>Business Review</strong><small>{has("businessReview", summary) ? "Verified" : "Verified together with the Klaviyo account."}</small></span></li>
        <li><span className={`check-icon ${has("deliverability", summary) ? "approved" : "pending"}`}>{has("deliverability", summary) ? "✓" : "○"}</span><span><strong>Deliverability</strong><small>{has("deliverability", summary) ? "Verified" : "Open Analytics → Deliverability → Email → Score and click the Tention toolbar icon."}</small></span>{!has("deliverability", summary) && <button disabled={busy("deliverability")} onClick={() => void verifyDeliverability()}>{busy("deliverability") ? "Verifying…" : "Verify Deliverability"}</button>}</li>
        <li><span className={`check-icon ${has("subscriberGrowth", summary) ? "approved" : "pending"}`}>{has("subscriberGrowth", summary) ? "✓" : "○"}</span><span><strong>Subscriber Growth</strong><small>{has("subscriberGrowth", summary) ? `Verified · ${summary.setup.sourceUrls?.subscriberGrowthUrl ?? ""}` : "Open Audience → Profiles → View subscriber growth (any view) and click the Tention toolbar icon."}</small></span></li>
      </ul>
      {itemError("deliverability")}
      {!has("subscriberGrowth", summary) && <div className="growth-setup" aria-label="Subscriber Growth setup">
        <p className="support-copy">Email → Growth does not need to be selected now: every monthly capture selects Email → Growth and the report month itself, and checks the Klaviyo account again first.</p>
        <div className="actions"><button disabled={busy("subscriberGrowth")} onClick={() => void verifySubscriberGrowth()}>{busy("subscriberGrowth") ? "Verifying…" : "Verify Subscriber Growth"}</button><button disabled={busy("subscriberGrowth")} onClick={() => void useCurrentGrowthPage()}>Use Current Subscriber Growth Page</button></div>
        <p className="method-divider">OR</p>
        <label>Subscriber Growth URL<input aria-label="Subscriber Growth URL" value={growthUrlInput} onChange={(event) => setGrowthUrlInput(event.target.value)} placeholder={KLAVIYO_SUBSCRIBER_GROWTH_URL} /></label>
        <div className="actions"><button disabled={!growthUrlInput.trim() || busy("subscriberGrowth")} onClick={() => void saveGrowthUrl()}>Save Subscriber Growth Source</button></div>
        {pendingGrowth && <div className="notice metric-confirmation" role="group" aria-label="Confirm Subscriber Growth source">
          <p>Client:<br /><strong>{name}</strong></p><p>Source:<br /><strong>Subscriber Growth</strong></p><p>URL:<br /><strong>{pendingGrowth.url}</strong></p>
          <div className="actions"><button className="primary" disabled={busy("subscriberGrowth")} onClick={() => void confirmCurrentGrowthPage()}>Confirm & Save</button><button onClick={cancelCurrentGrowthPage}>Cancel</button></div>
        </div>}
        {growthNotice && <div role="alert" aria-label={GROWTH_ERROR[growthNotice.code].title} className="notice error-notice"><strong>{GROWTH_ERROR[growthNotice.code].title}</strong><p>{growthNotice.code === "INVALID_SUBSCRIBER_GROWTH_URL" ? growthNotice.detail ?? GROWTH_ERROR.INVALID_SUBSCRIBER_GROWTH_URL.message : GROWTH_ERROR[growthNotice.code].message}</p>{growthNotice.code === "AUTO_VERIFY_FAILED" && growthNotice.detail && <small>{growthNotice.detail}</small>}</div>}
      </div>}
      {itemError("subscriberGrowth")}
      <p className="support-copy">Optional sections (Signup Form Performance, Welcome Flow Performance, Customer Split) never block setup; configure them under Advanced / Debug if needed.</p>
    </section>

    <details className="card advanced" open={advancedOpen}><summary>Advanced / Debug</summary>
      <p className="support-copy">For exceptional cases only. Normal onboarding is discovery-first.</p>
      <div className="metadata">{summary.blockers.length ? summary.blockers.map((blocker) => <span key={blocker.code}>{blocker.item}<strong>{blocker.code}</strong></span>) : <span>Blockers<strong>none</strong></span>}</div>
      <ClientTargetEditor targets={summary.setup} busy={verifying} error={advancedError} onSave={(input) => void saveAdvanced(input)} onDiscover={() => void verifyAccount()} onUseCurrentPage={() => void verifyAccount()} />
    </details>
  </main>;
}

function ClientDetail({ api, clientId, now, reportSync, onReportDeleted, onBack, onEdit, onAdvanced, onCreateReport, onOpenReport }: { api: ApiClient; clientId: string; now: () => Date; reportSync: ReportSync; onReportDeleted?: ((report: ReportDraft) => void) | undefined; onBack(): void; onEdit(): void; onAdvanced(): void; onCreateReport(): void; onOpenReport(id: string): void }) {
  const [summary, setSummary] = useState<ClientSetupSummary | null>(null);
  const [loadedReports, setReports] = useState<ReportDraft[]>([]);
  // A report removed anywhere in the panel never shows here, even before this page's refetch answers.
  const reports = loadedReports.filter((item) => !reportSync.removedIds.includes(item.id));
  const [error, setError] = useState<string | null>(null);
  // Delete Report: one selected report, confirmed in a dialog first; the client and other months are never touched.
  const [pendingDelete, setPendingDelete] = useState<ReportDraft | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([api.getClientSetup(clientId), api.listReportDrafts({ clientId })])
      .then(([setup, drafts]) => { if (active) { setSummary(setup); setReports(Array.isArray(drafts) ? drafts : []); } })
      .catch(() => { if (active) setError("The client could not be loaded."); });
    return () => { active = false; };
  }, [api, clientId]);
  // Any reconciliation elsewhere (Recent Reports delete, a missing report) refetches this client's reports from the API.
  useEffect(() => {
    if (reportSync.revision === 0) return;
    let active = true;
    void Promise.resolve().then(() => api.listReportDrafts({ clientId })).then((drafts) => { if (active && Array.isArray(drafts)) setReports(drafts); }).catch(() => undefined);
    return () => { active = false; };
  }, [api, clientId, reportSync.revision]);
  const requestDelete = (report: ReportDraft) => {
    setDeleteNotice(null);
    if (report.status === "generating") { setPendingDelete(null); setDeleteError(DELETE_BLOCKED_GENERATING); return; }
    setDeleteError(null); setPendingDelete(report);
  };
  const confirmDelete = async () => {
    const report = pendingDelete;
    if (!report || deleting) return;
    setDeleting(true); setDeleteError(null);
    const label = formatReportMonth(report.reportMonth);
    try {
      const result = await api.deleteClientReport(clientId, report.id);
      setReports((current) => current.filter((item) => item.id !== report.id));
      setPendingDelete(null);
      setDeleteNotice(`${label} report deleted.${result.driveFilesRetained ? " Drive files were not deleted." : ""}`);
      // One reconciliation for the whole panel: Recent Reports and any open report drop it, and lists refetch.
      onReportDeleted?.(report);
      void Promise.resolve().then(() => api.listReportDrafts({ clientId })).then((drafts) => { if (Array.isArray(drafts)) setReports(drafts); }).catch(() => undefined);
    } catch (caught) {
      const code = caught instanceof Error && "code" in caught ? String((caught as { code: unknown }).code) : "";
      setPendingDelete(null);
      setDeleteError(code === "REPORT_DELETE_BLOCKED_GENERATING" ? DELETE_BLOCKED_GENERATING
        : code === "REPORT_NOT_FOUND" ? `${label} report no longer exists.`
        : code === "REPORT_CLIENT_MISMATCH" ? "This report belongs to another client and was not deleted."
        : code === "REPORT_VERSION_CONFLICT" ? `${label} report changed while you were confirming. Nothing was deleted; try again.`
        : `${label} report could not be deleted.`);
      if (code === "REPORT_NOT_FOUND") { setReports((current) => current.filter((item) => item.id !== report.id)); onReportDeleted?.(report); }
    } finally { setDeleting(false); }
  };
  if (!summary) return <section className="card"><button className="text-button" onClick={onBack}>← Clients</button>{error ? <p role="alert" className="field-error">{error}</p> : <p className="loading">Loading client…</p>}</section>;
  const profile = summary.setup.profile;
  const ready = summary.status === "READY";
  const metricLabel = profile?.conversionMetric.label ?? "Placed Order";
  // The three most recent completed months, plus every month that has a report.
  const recentMonths = profile?.timezone ? getCompletedMonthOptions(now(), profile.timezone, 3).map(({ month }) => month) : [];
  const months = [...new Map([...reports.map((report) => report.reportMonth), ...recentMonths].map((month) => [toMonthValue(month), month])).values()]
    .sort((left, right) => toMonthValue(right).localeCompare(toMonthValue(left)));
  const verified = (item: ClientSetupItemKey) => summary.blockers.some((blocker) => blocker.item === item) ? "Not verified" : "Verified";
  return <main aria-label="Client Detail">
    <section className="card">
      <button className="text-button" onClick={onBack}>← Clients</button>
      <h1>{summary.name}</h1>
      <div className="period-preview client-facts">
        <span>Setup<strong className={`setup-status ${summary.status.toLowerCase()}`}>{STATUS_LABEL[summary.status]}</strong></span>
        <span>Klaviyo Account<strong>{summary.setup.businessReview?.accountLabel ?? "Not verified"}</strong></span>
        <span>Timezone<strong>{profile?.timezone ?? "Not configured"}</strong></span>
        <span>Currency<strong>{profile?.currency ?? "Not configured"}</strong></span>
        <span>Conversion Metric<strong>{metricLabel}</strong></span>
        <span>Business Review<strong>{verified("businessReview")}</strong></span>
        <span>Deliverability<strong>{verified("deliverability")}</strong></span>
        <span>Subscriber Growth<strong>{verified("subscriberGrowth")}</strong></span>
      </div>
      {!ready && <div role="alert" className="notice error-notice" aria-label="Client setup incomplete"><strong>Client setup incomplete</strong><p>Missing:</p><ul>{summary.blockers.map((blocker) => <li key={blocker.code}>{missingItemLabel(blocker, metricLabel)}</li>)}</ul></div>}
      <div className="actions">
        <button className="primary" disabled={!ready} onClick={onCreateReport}>Create New Report</button>
        <button onClick={onEdit}>{ready ? "Edit Client Setup" : "Continue Client Setup"}</button>
        <button onClick={onAdvanced}>Advanced / Debug</button>
      </div>
    </section>
    <section className="card" aria-label="Reports"><h2>Reports</h2>
      {months.length === 0 ? <p className="empty">No reports yet.</p> : <ul className="recent-list">{months.map((month) => {
        const report = reports.find((item) => toMonthValue(item.reportMonth) === toMonthValue(month));
        return <li key={toMonthValue(month)}><div className="recent-report"><strong>{formatReportMonth(month)}</strong><span>{report ? reportStatusLabel(report.status) : "Not created"}</span></div>
          {report && <div className="recent-actions"><button onClick={() => onOpenReport(report.id)}>Open Report</button><button className="danger" aria-label={`Delete ${formatReportMonth(report.reportMonth)} report`} disabled={deleting} onClick={() => requestDelete(report)}>Delete Report</button></div>}</li>;
      })}</ul>}
      {deleteNotice && <p role="status" className="notice success-notice">{deleteNotice}</p>}
      {deleteError && <p role="alert" className="notice error-notice">{deleteError}</p>}
      {pendingDelete && <div role="alertdialog" aria-modal="true" aria-labelledby="delete-report-title" className="notice error-notice delete-confirmation">
        <strong id="delete-report-title">Delete {formatReportMonth(pendingDelete.reportMonth)} report?</strong>
        <p>Client:<br /><strong>{summary.name}</strong></p>
        <p>This will remove this report and its stored report data.</p>
        <p>Client setup and other months' reports are not changed. Google Drive files are not deleted.</p>
        <div className="actions"><button autoFocus disabled={deleting} onClick={() => setPendingDelete(null)}>Cancel</button><button className="danger-solid" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "Deleting…" : "Delete Report"}</button></div>
      </div>}
    </section>
  </main>;
}

const DELETE_BLOCKED_GENERATING = "This report is currently generating. Try again after generation finishes.";

function reportStatusLabel(status: ReportDraft["status"]): string {
  return status === "generated" ? "Generated" : status === "auto_validated" ? "Validated" : status === "failed" ? "Failed" : status === "generating" ? "Generating" : "In progress";
}

function CreateMonthlyReport({ api, clientId, now, onBack, onCreated, onOpenReport }: { api: ApiClient; clientId: string; now: () => Date; onBack(): void; onCreated(report: ReportDraft): void; onOpenReport(id: string): void }) {
  const [summary, setSummary] = useState<ClientSetupSummary | null>(null);
  const [reportMonth, setReportMonth] = useState<ReportMonth | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<ClientSetupBlocker[]>([]);
  const [duplicate, setDuplicate] = useState<ReportDraft | null>(null);
  useEffect(() => { void api.getClientSetup(clientId).then(setSummary).catch(() => setError("The client could not be loaded.")); }, [api, clientId]);
  const timeZone = summary?.setup.profile?.timezone ?? null;
  const options = useMemo(() => timeZone ? getCompletedMonthOptions(now(), timeZone, 24) : [], [now, timeZone]);
  useEffect(() => { setReportMonth((selected) => normalizeSelectedMonth(selected, options)); }, [options]);
  const period = reportMonth ? options.find(({ month }) => toMonthValue(month) === toMonthValue(reportMonth))?.period : null;
  if (!summary) return <section className="card"><button className="text-button" onClick={onBack}>← Back</button>{error ? <p role="alert" className="field-error">{error}</p> : <p className="loading">Loading…</p>}</section>;
  const blockers = missing.length ? missing : summary.blockers;
  const ready = summary.status === "READY" && missing.length === 0;

  async function create() {
    if (!reportMonth || !summary) return;
    setBusy(true); setError(null); setDuplicate(null);
    try {
      // The saved client setup is the whole definition: only the month is chosen here.
      const sections = { ...DEFAULT_DRAFT_SECTION_CONFIGURATION, ...(summary.setup.profile?.sections ?? {}) };
      onCreated(await api.createReportDraft({ client: { id: clientId }, reportMonth, sections }));
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "CLIENT_SETUP_INCOMPLETE") setMissing(((caught.details as { blockers?: ClientSetupBlocker[] } | undefined)?.blockers) ?? []);
      else if (caught instanceof ApiError && caught.code === "REPORT_DRAFT_ALREADY_EXISTS") {
        setError(`A ${formatReportMonth(reportMonth)} report already exists for ${summary.name}.`);
        setDuplicate((await api.listReportDrafts({ clientId, year: reportMonth.year, month: reportMonth.month }).catch(() => []))[0] ?? null);
      } else setError(caught instanceof ApiError ? caught.message : "The report could not be created.");
    } finally { setBusy(false); }
  }

  return <section className="card" aria-label="Create Monthly Report">
    <button className="text-button" onClick={onBack}>← {summary.name}</button>
    <p className="kicker">Create monthly report</p>
    <div className="period-preview"><span>Client<strong>{summary.name}</strong></span></div>
    <label>Report Month<select aria-label="Report Month" value={reportMonth ? toMonthValue(reportMonth) : ""} onChange={(event) => setReportMonth(parseMonthValue(event.target.value))} disabled={!options.length}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
    {period && <div className="period-preview" aria-label="Derived reporting periods"><span>Current<strong>{formatCalendarRange(period.startDate, period.endDate)}</strong></span><span>Previous<strong>{formatCalendarRange(period.previousStartDate, period.previousEndDate)}</strong></span></div>}
    {!ready && <div role="alert" className="notice error-notice"><strong>Client setup incomplete</strong><p>Missing:</p><ul>{blockers.map((blocker) => <li key={blocker.code}>{missingItemLabel(blocker, summary.setup.profile?.conversionMetric.label)}</li>)}</ul></div>}
    {error && <div role="alert" className="notice error-notice"><p>{error}</p>{duplicate && <button onClick={() => onOpenReport(duplicate.id)}>Open existing report</button>}</div>}
    <button className="primary" disabled={!ready || busy || !reportMonth} onClick={() => void create()}>{busy ? "Creating…" : "Create & Start Automatic Capture"}</button>
  </section>;
}

