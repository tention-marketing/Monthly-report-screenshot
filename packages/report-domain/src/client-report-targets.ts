import {
  clientReportTargetsInputSchema, clientReportTargetsSchema, REPORT_CAPTURE_SPEC_V1,
  reportReadinessSchema, type ClientReportTargets, type ClientReportTargetsInput,
  type ReportCaptureSectionKey, type ReportReadiness, type ReportReadinessSection,
  type SectionConfiguration,
} from "@tention/report-schema";
import { ReportPersistenceError } from "./persistence-error.js";

export interface ClientReportTargetsRepository {
  get(clientId: string): Promise<ClientReportTargets>;
  save(clientId: string, input: ClientReportTargetsInput, now: Date): Promise<ClientReportTargets>;
  /** Every saved client configuration, for client selection. */
  list(): Promise<ClientReportTargets[]>;
}

export function emptyClientReportTargets(clientId: string): ClientReportTargets {
  return clientReportTargetsSchema.parse({ clientId, createdAt: null, updatedAt: null });
}

export function normalizeClientReportTargets(input: unknown): ClientReportTargetsInput {
  return clientReportTargetsInputSchema.parse(input);
}

/** Maps the canonical capture contract to the legacy report-section wire keys. */
const reportSectionByCaptureSection: Readonly<Record<ReportCaptureSectionKey, string>> = {
  executive_summary: "executive_summary", month_comparison: "month_comparison", top_campaigns: "top_campaigns", top_flows: "top_flows",
  campaign_performance: "campaign_performance", campaign_metrics: "campaign_metrics", flow_performance: "flow_performance", flow_metrics: "flow_metrics",
  signup_form_performance: "signup_form", welcome_flow_performance: "welcome_flow", customer_split: "customer_split", deliverability: "deliverability", list_growth: "list_growth",
};
const targetRequirements: Partial<Record<ReportCaptureSectionKey, readonly string[]>> = {
  signup_form_performance: ["signupForms"],
  welcome_flow_performance: ["welcomeFlowListing"],
  customer_split: ["customerSegment", "nonCustomerSegment"],
  deliverability: ["deliverabilityUrl"],
};

export function getReportReadiness(targets: ClientReportTargets, sections: SectionConfiguration): ReportReadiness {
  const result: ReportReadinessSection[] = REPORT_CAPTURE_SPEC_V1.map((spec) => {
    const configuredRequirement = sections[reportSectionByCaptureSection[spec.key]];
    // The nine automated current-product captures are core evidence. Older
    // drafts may still say optional for two of them, but that legacy setting
    // must not make a current report look final-ready.
    const requirement = spec.automationStatus === "auto" ? "required" : configuredRequirement ?? spec.defaultRequirement;
    const required = requirement === "required";
    if (requirement === "disabled") {
      return { sectionKey: spec.key, required: false, status: "not_applicable", reason: "This section is disabled for this report.", requiredTargets: [] };
    }
    const requiredTargets = targetRequirements[spec.key] ?? [];
    const missing = requiredTargets.filter((target) => !isConfiguredTarget(targets, target));
    if (missing.length === 0) {
      if (spec.automationStatus === "manual_required") {
        const sourceUrl = spec.sourceUrlKey ? targets.sourceUrls?.[spec.sourceUrlKey] : undefined;
        return { sectionKey: spec.key, required, status: "manual_required", reason: sourceUrl ? "A source URL is configured, but automatic verification awaits real DOM evidence." : "No source URL is configured; navigate manually until real source evidence is supplied.", requiredTargets: [] };
      }
      if (spec.automationStatus === "manual_by_design") {
        return { sectionKey: spec.key, required, status: "manual_by_design", reason: "Exact comparison-period proof must be confirmed manually when Klaviyo does not expose it.", requiredTargets: [] };
      }
      if (spec.automationStatus === "deferred") {
        return { sectionKey: spec.key, required, status: "deferred", reason: "Automatic source verification is deferred; use the documented manual capture flow.", requiredTargets: [] };
      }
      return { sectionKey: spec.key, required, status: "ready", reason: null, requiredTargets: [] };
    }
    if (required) {
      return { sectionKey: spec.key, required: true, status: "missing_configuration", reason: `Configure ${missing.map(humanize).join(" and ")} before capture.`, requiredTargets: missing };
    }
    return { sectionKey: spec.key, required: false, status: "optional_not_configured", reason: `${missing.map(humanize).join(" and ")} is optional and not configured.`, requiredTargets: missing };
  });
  return reportReadinessSchema.parse({ ready: result.filter(({ required }) => required).every(({ status }) => status !== "missing_configuration"), sections: result });
}

function isConfiguredTarget(targets: ClientReportTargets, target: string): boolean {
  switch (target) {
    case "signupForms": return targets.signupForms?.mode === "all" || Boolean(targets.signupForms && (targets.signupForms.ids.length || targets.signupForms.names.length));
    case "welcomeFlowListing": return Boolean(targets.welcomeFlowListing?.flows.length === 2);
    case "customerSegment": return Boolean(targets.customerSegment?.id || targets.customerSegment?.name);
    case "nonCustomerSegment": return Boolean(targets.nonCustomerSegment?.id || targets.nonCustomerSegment?.name);
    case "deliverabilityUrl": return Boolean(targets.sourceUrls?.deliverabilityUrl);
    case "primaryEmailList": return Boolean(targets.primaryEmailList?.id || targets.primaryEmailList?.name);
    default: return false;
  }
}
function humanize(value: string): string { return value.replace(/([A-Z])/g, " $1").replace(/^./, (letter) => letter.toUpperCase()); }

/** Explicit non-production backing store for local API development and unit tests. */
export class InMemoryClientReportTargetsRepository implements ClientReportTargetsRepository {
  private readonly values = new Map<string, ClientReportTargets>();
  async get(clientId: string): Promise<ClientReportTargets> { return structuredClone(this.values.get(clientId) ?? emptyClientReportTargets(clientId)); }
  async list(): Promise<ClientReportTargets[]> { return [...this.values.values()].map((value) => structuredClone(value)); }
  async save(clientId: string, input: ClientReportTargetsInput, now: Date): Promise<ClientReportTargets> {
    const normalized = normalizeClientReportTargets(input);
    const existing = this.values.get(clientId);
    const oldBusiness = existing?.businessReview;
    const nextBusiness = normalized.businessReview;
    if (oldBusiness?.providerAccountId && nextBusiness?.providerAccountId !== oldBusiness.providerAccountId) {
      throw new ReportPersistenceError("CLIENT_ACCOUNT_BINDING_IMMUTABLE", "The saved Klaviyo account binding cannot be changed implicitly.");
    }
    if (!oldBusiness?.providerAccountId && oldBusiness?.accountLabel && nextBusiness?.accountLabel !== oldBusiness.accountLabel) {
      throw new ReportPersistenceError("CLIENT_ACCOUNT_BINDING_IMMUTABLE", "The saved Klaviyo account binding cannot be changed implicitly.");
    }
    const incomingProviderId = nextBusiness?.providerAccountId;
    if (incomingProviderId && [...this.values.entries()].some(([otherClientId, value]) => otherClientId !== clientId && value.businessReview?.providerAccountId === incomingProviderId)) {
      throw new ReportPersistenceError("CLIENT_ACCOUNT_ALREADY_BOUND", "This Klaviyo account is already bound to another client.");
    }
    const value = clientReportTargetsSchema.parse({ ...normalized, clientId, createdAt: existing?.createdAt ?? now.toISOString(), updatedAt: now.toISOString() });
    this.values.set(clientId, structuredClone(value));
    return structuredClone(value);
  }
}
