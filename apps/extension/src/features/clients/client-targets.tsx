import { useEffect, useState } from "react";
import type { ClientReportTargets, ClientReportTargetsInput, ClientSourceUrls } from "@tention/report-schema";

/** Client configuration helpers shared by client onboarding and the report screen. */

export function ClientTargetEditor({ targets, busy, error, onSave, onDiscover, onUseCurrentPage }: { targets: ClientReportTargets | null; busy: boolean; error: string | null; onSave(input: ClientReportTargetsInput): void; onDiscover(): void; onUseCurrentPage(): void }) {
  const [value, setValue] = useState<ClientReportTargetsInput>(() => targetInput(targets));
  useEffect(() => { setValue(targetInput(targets)); }, [targets]);
  const updateEntity = (key: "customerSegment" | "nonCustomerSegment", field: "id" | "name", next: string) => {
    setValue((current) => ({ ...current, [key]: { ...(current[key] ?? {}), [field]: next } }));
  };
  return <form className="section-config" onSubmit={(event) => { event.preventDefault(); onSave(cleanTargetInput(value)); }}>
    <fieldset disabled={!targets || busy}><legend>Client capture targets</legend>
      <p className="support-copy">Store only stable IDs or clear names. These settings are shared by this client’s reports; they do not navigate or inspect Klaviyo.</p>
      <div className="business-review-target" aria-label="Business Review discovery"><strong>Business Review reporting source</strong><p className="support-copy">{targets?.businessReview?.dashboardUrl ? `Verified for ${targets.businessReview.accountLabel ?? "this client"}. The dashboard address stays internal.` : "Not configured. Tention can discover the existing dashboard from the authenticated Klaviyo account."}</p><div className="actions"><button type="button" disabled={busy} onClick={onDiscover}>{busy ? "Verifying…" : "Discover Business Review"}</button><button type="button" disabled={busy} onClick={onUseCurrentPage}>Use Current Page</button></div></div>
      <details className="advanced-target-fields"><summary>Advanced report targets</summary><p className="support-copy">These stable names/IDs are only needed for ambiguous final-report sections. They are not required to start the automatic capture.</p>
      {sourceUrlFields.map(([key, label]) => <label key={key}>{label}<input aria-label={label} type="url" value={value.sourceUrls?.[key] ?? ""} onChange={(event) => setValue((current) => ({ ...current, sourceUrls: { ...(current.sourceUrls ?? {}), [key]: event.target.value } }))} /></label>)}
      <label>Email Welcome flow listing IDs (comma-separated)<input aria-label="Email Welcome flow listing IDs" value={(value.welcomeFlowListing?.flows ?? []).map(({ id }) => id).join(", ")} onChange={(event) => setValue((current) => ({ ...current, welcomeFlowListing: { mode: "email_welcome_flows", flows: pairTargets(splitTargets(event.target.value), current.welcomeFlowListing?.flows.map(({ name }) => name) ?? []) } }))} /></label>
      <label>Email Welcome flow listing names (comma-separated)<input aria-label="Email Welcome flow listing names" value={(value.welcomeFlowListing?.flows ?? []).map(({ name }) => name).join(", ")} onChange={(event) => setValue((current) => ({ ...current, welcomeFlowListing: { mode: "email_welcome_flows", flows: pairTargets(current.welcomeFlowListing?.flows.map(({ id }) => id) ?? [], splitTargets(event.target.value)) } }))} /></label>
      <label>Customer segment ID<input aria-label="Customer segment ID" value={value.customerSegment?.id ?? ""} onChange={(event) => updateEntity("customerSegment", "id", event.target.value)} /></label>
      <label>Customer segment name<input aria-label="Customer segment name" value={value.customerSegment?.name ?? ""} onChange={(event) => updateEntity("customerSegment", "name", event.target.value)} /></label>
      <label>Non-customer segment ID<input aria-label="Non-customer segment ID" value={value.nonCustomerSegment?.id ?? ""} onChange={(event) => updateEntity("nonCustomerSegment", "id", event.target.value)} /></label>
      <label>Non-customer segment name<input aria-label="Non-customer segment name" value={value.nonCustomerSegment?.name ?? ""} onChange={(event) => updateEntity("nonCustomerSegment", "name", event.target.value)} /></label>
      <label>Signup form scope<select aria-label="Signup form scope" value={value.signupForms?.mode ?? "all"} onChange={(event) => setValue((current) => ({ ...current, signupForms: { ...(current.signupForms ?? { ids: [], names: [] }), mode: event.target.value as "all" | "configured" } }))}><option value="all">All signup forms</option><option value="configured">Configured forms only</option></select></label>
      <label>Signup form IDs (comma-separated)<input aria-label="Signup form IDs" value={(value.signupForms?.ids ?? []).join(", ")} onChange={(event) => setValue((current) => ({ ...current, signupForms: { ...(current.signupForms ?? { mode: "all", names: [] }), ids: splitTargets(event.target.value) } }))} /></label>
      <label>Signup form names (comma-separated)<input aria-label="Signup form names" value={(value.signupForms?.names ?? []).join(", ")} onChange={(event) => setValue((current) => ({ ...current, signupForms: { ...(current.signupForms ?? { mode: "all", ids: [] }), names: splitTargets(event.target.value) } }))} /></label>
      </details>
    </fieldset>
    {error && <p role="alert" className="field-error">{error}</p>}
    <button className="primary" type="submit" disabled={!targets || busy}>{busy ? "Saving…" : "Save Client Targets"}</button>
  </form>;
}

export function targetInput(targets: ClientReportTargets | null): ClientReportTargetsInput {
  return {
    profile: targets?.profile ?? null,
    businessReview: targets?.businessReview ?? null, sourceUrls: targets?.sourceUrls ?? null, primaryEmailList: targets?.primaryEmailList ?? null, primarySmsList: targets?.primarySmsList ?? null,
    welcomeFlow: targets?.welcomeFlow ?? null, welcomeFlowListing: targets?.welcomeFlowListing ?? null, customerSegment: targets?.customerSegment ?? null, nonCustomerSegment: targets?.nonCustomerSegment ?? null,
    signupForms: targets?.signupForms ?? { mode: "all", ids: [], names: [] },
  };
}
function splitTargets(value: string): string[] { return value.split(",").map((item) => item.trim()).filter(Boolean); }
function pairTargets(ids: string[], names: string[]) { return ids.map((id, index) => ({ id, name: names[index] ?? id, channel: "email" as const })); }
export function cleanTargetInput(input: ClientReportTargetsInput): ClientReportTargetsInput {
  const entity = (value: { id?: string | undefined; name?: string | undefined } | null) => {
    const id = value?.id?.trim(); const name = value?.name?.trim();
    return id || name ? { ...(id ? { id } : {}), ...(name ? { name } : {}) } : null;
  };
  const business = input.businessReview;
  const dashboardUrl = business?.dashboardUrl?.trim(); const dashboardId = business?.dashboardId?.trim(); const displayName = business?.displayName?.trim(); const accountLabel = business?.accountLabel?.trim(); const providerAccountId = business?.providerAccountId?.trim();
  const welcomeId = input.welcomeFlow?.id?.trim(); const welcomeName = input.welcomeFlow?.name?.trim(); const aliases = input.welcomeFlow?.aliases ?? [];
  // Every saved source is kept, including ones this form does not show (e.g. the verified Subscriber Growth source);
  // only blank values are dropped.
  const sourceUrls = Object.fromEntries(Object.entries(input.sourceUrls ?? {}).flatMap(([key, value]) => {
    const url = typeof value === "string" ? value.trim() : ""; return url ? [[key, url]] : [];
  })) as ClientSourceUrls;
  return {
    profile: input.profile ?? null,
    businessReview: dashboardUrl || dashboardId || displayName || accountLabel ? { ...(dashboardUrl ? { dashboardUrl } : {}), ...(dashboardId ? { dashboardId } : {}), ...(displayName ? { displayName } : {}), ...(accountLabel ? { accountLabel } : {}), ...(providerAccountId ? { providerAccountId, providerIdentityKind: business?.providerIdentityKind ?? "account" } : {}) } : null,
    sourceUrls: Object.keys(sourceUrls).length ? sourceUrls : null,
    primaryEmailList: entity(input.primaryEmailList), primarySmsList: entity(input.primarySmsList), customerSegment: entity(input.customerSegment), nonCustomerSegment: entity(input.nonCustomerSegment),
    welcomeFlow: welcomeId || welcomeName ? { ...(welcomeId ? { id: welcomeId } : {}), ...(welcomeName ? { name: welcomeName } : {}), aliases } : null,
    welcomeFlowListing: input.welcomeFlowListing,
    signupForms: input.signupForms,
  };
}
const sourceUrlFields = [
  ["overviewUrl", "Overview source URL"], ["campaignsUrl", "Campaigns source URL"], ["topFlowsUrl", "Top Flows source URL"],
  ["signupFormsUrl", "Signup Forms source URL"], ["flowsUrl", "Flows source URL"],
  ["segmentsUrl", "Lists & Segments source URL"], ["deliverabilityUrl", "Deliverability Score source URL"],
] as const satisfies readonly [keyof ClientSourceUrls, string][];

export function supportedTimeZones(): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
  return supportedValuesOf ? supportedValuesOf("timeZone") : ["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Kolkata"];
}

/** ISO 4217 codes the browser knows; the API validates the same list. */
export function supportedCurrencies(): string[] {
  const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "currency") => string[] }).supportedValuesOf;
  return supportedValuesOf ? supportedValuesOf("currency") : ["USD", "CAD", "EUR", "GBP", "AUD"];
}
