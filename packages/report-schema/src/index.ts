import { z } from "zod";

export const reportMonthSchema = z.object({
  year: z.number().int().min(2000).max(9999),
  month: z.number().int().min(1).max(12),
});
export type ReportMonth = z.infer<typeof reportMonthSchema>;

export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const previousReportPeriodSchema = z.object({
  month: reportMonthSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
});
export type PreviousReportPeriod = z.infer<typeof previousReportPeriodSchema>;

export const reportPeriodSchema = z.object({
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  previousStartDate: isoDateSchema,
  previousEndDate: isoDateSchema,
});
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;

/** The conversion metric a report was calculated with: display label plus the account-specific Klaviyo metric ID. */
export const conversionMetricSnapshotSchema = z.object({
  label: z.string().trim().min(1),
  providerMetricId: z.string().trim().min(1),
}).strict();
export type ConversionMetricSnapshot = z.infer<typeof conversionMetricSnapshotSchema>;
/** The verified Klaviyo account a report was created for. */
export const klaviyoAccountSnapshotSchema = z.object({
  accountLabel: z.string().trim().min(1),
  providerAccountId: z.string().trim().min(1).nullable(),
}).strict();
export type KlaviyoAccountSnapshot = z.infer<typeof klaviyoAccountSnapshotSchema>;

export const clientSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1).refine(isValidIanaTimeZone, "Expected a valid IANA timezone"),
  currency: z.string().length(3).nullable(),
  /**
   * Report-time copies of the client setup (AGENTS.md §23): a later change to the client profile never changes an
   * existing report. Absent on reports created before client onboarding existed; those still read the live profile.
   */
  conversionMetric: conversionMetricSnapshotSchema.nullable().optional(),
  klaviyoAccount: klaviyoAccountSnapshotSchema.nullable().optional(),
});
export type ClientSummary = z.infer<typeof clientSummarySchema>;

export const reportStatusSchema = z.enum([
  "draft", "data_fetching", "data_ready", "captures_incomplete",
  "ready_for_review", "approved", "generating", "generated", "failed",
  // Every automatic capture passed backend machine validation; no human approval is implied.
  "auto_validated",
]);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const screenshotTypeSchema = z.enum([
  "overview", "top_campaigns", "top_flows", "month_comparison",
  "campaign_performance", "flow_performance", "signup_form", "welcome_flow",
  "customer_split", "deliverability", "campaign_metrics", "flow_metrics", "list_growth",
  "email_subscriber_growth",
]);
export type ScreenshotType = z.infer<typeof screenshotTypeSchema>;

export const reportCaptureSectionKeySchema = z.enum([
  "executive_summary", "month_comparison", "top_campaigns", "top_flows", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "signup_form_performance", "welcome_flow_performance", "customer_split", "deliverability", "list_growth",
  "email_subscriber_growth",
]);
export type ReportCaptureSectionKey = z.infer<typeof reportCaptureSectionKeySchema>;
export const REPORT_CAPTURE_SPEC_VERSION = "1" as const;
/** Top Campaigns shows min(5, eligible Sent campaigns) ranked by Placed Order revenue; never padded. */
export const TOP_CAMPAIGNS_LIMIT = 5;
/** Top Flows shows min(5, usable flows); never padded. */
export const TOP_FLOWS_LIMIT = 5;
export const captureDatePolicySchema = z.enum(["EXACT_MONTH", "PREVIOUS_MONTH_COMPARISON", "ROLLING_30_DAY", "STATIC_ENTITY_VIEW"]);
export type CaptureDatePolicy = z.infer<typeof captureDatePolicySchema>;
export const capturePeriodProofSchema = z.object({ startDate: isoDateSchema, endDate: isoDateSchema, comparisonStartDate: isoDateSchema.optional(), comparisonEndDate: isoDateSchema.optional() });
export type CapturePeriodProof = z.infer<typeof capturePeriodProofSchema>;
/** Exact whole-number subscriber counts read from Klaviyo's Subscriber growth → Email → Growth view; never compact text. */
export const subscriberGrowthEvidenceSchema = z.object({
  channel: z.literal("email"), view: z.literal("growth"),
  emailSubscribers: z.number().int().nonnegative(), newSubscribers: z.number().int().nonnegative(), exclusions: z.number().int().nonnegative(),
  /** Klaviyo's own previous-period change labels, kept as displayed text (never parsed into calculations); null when not shown. */
  changes: z.object({ emailSubscribers: z.string().min(1).nullable(), newSubscribers: z.string().min(1).nullable(), exclusions: z.string().min(1).nullable() }).strict(),
  charts: z.object({ subscriberGrowthLine: z.literal(true), newSubscribersExclusionsBar: z.literal(true) }).strict(),
  visiblePeriodText: z.string().min(1),
}).strict();
export type SubscriberGrowthEvidence = z.infer<typeof subscriberGrowthEvidenceSchema>;
/** A money value exactly as Klaviyo rendered it ("$584,032.35"); parsed later against the report's own currency. */
const renderedMoneySchema = z.string().min(1).max(40);
/**
 * Read-only DOM text from Klaviyo Home → Business performance summary, read by the Executive Summary adapter only after
 * the card itself showed the exact report month. Never OCR, never compact text; parsed and checked by
 * `verifyBusinessPerformance` against the report's configured currency.
 */
export const businessPerformanceEvidenceSchema = z.object({
  totalRevenue: renderedMoneySchema,
  /** Total attributed revenue (Campaigns + Flows); null only if Klaviyo did not render it. */
  totalAttributedRevenue: renderedMoneySchema.nullable(),
  emailAttributedRevenue: renderedMoneySchema,
  /** Text message channel; null when Klaviyo shows no SMS value (e.g. a set-up link). */
  smsAttributedRevenue: renderedMoneySchema.nullable(),
  campaignRevenue: renderedMoneySchema,
  flowRevenue: renderedMoneySchema,
  /** The period text painted on the card itself when the values were read. */
  visiblePeriodText: z.string().min(1).max(120),
}).strict();
export type BusinessPerformanceEvidence = z.infer<typeof businessPerformanceEvidenceSchema>;
export const screenshotSourceProofSchema = z.object({
  captureSpecVersion: z.literal(REPORT_CAPTURE_SPEC_VERSION), sectionKey: reportCaptureSectionKeySchema, sourceFamily: z.string().min(1), semanticCard: z.string().min(1), semanticTab: z.string().min(1), sourceIdentity: z.string().min(1), datePolicy: captureDatePolicySchema,
  expectedPeriod: capturePeriodProofSchema.nullable(), observedPeriod: capturePeriodProofSchema.nullable(), configuredEntityId: z.string().min(1).nullable(), configuredEntityName: z.string().min(1).nullable(),
  listingScope: z.enum(["all_forms", "email_welcome_flows"]).nullable().default(null),
  configuredEntities: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), channel: z.literal("email") }).strict()).default([]),
  semanticEvidence: z.array(z.enum(["deliverability-score", "based-on-last-30-days", "score-gauge", "rate-table"])).default([]),
  /** Read-only evidence emitted by the canonical Campaigns-list adapter. */
  campaigns: z.object({
    accountIdentity: z.string().min(1), clientTimezone: z.string().min(1), visibleMetricLabel: z.string().min(1),
    rankingMethod: z.enum(["klaviyo-native-sort", "complete-result-set"]), eligibleRowCount: z.number().int().nonnegative(), includedRowCount: z.number().int().nonnegative(),
    rows: z.array(z.object({ name: z.string().min(1), /** Channel as Klaviyo labels it; null when its icon carries no accessible name. */ type: z.string().min(1).nullable(), status: z.literal("Sent"), sendDate: isoDateSchema.nullable(), openRate: z.string().nullable(), clickRate: z.string().nullable(), placedOrderValue: z.number().nonnegative() }).strict()),
  }).nullable().default(null),
  /**
   * Read-only evidence emitted by the Subscriber Growth adapter (Section 10). Absent on every other section's proof,
   * so proofs created before Section 10 existed parse and serialize exactly as before.
   */
  subscriberGrowth: subscriberGrowthEvidenceSchema.optional(),
  /** Executive Summary only: the Business performance summary values behind the report cover. Absent on older captures. */
  businessPerformance: businessPerformanceEvidenceSchema.optional(),
});
export type ScreenshotSourceProof = z.infer<typeof screenshotSourceProofSchema>;

export const captureNavigationModeSchema = z.enum(["direct_configured_url", "shared_dashboard_semantic_tab", "configured_entity"]);
export type CaptureNavigationMode = z.infer<typeof captureNavigationModeSchema>;
export const captureAutomationStatusSchema = z.enum(["auto", "manual_required", "manual_by_design", "deferred"]);
export type CaptureAutomationStatus = z.infer<typeof captureAutomationStatusSchema>;
export const clientSourceUrlKeySchema = z.enum(["overviewUrl", "campaignsUrl", "topFlowsUrl", "businessReviewUrl", "signupFormsUrl", "flowsUrl", "segmentsUrl", "deliverabilityUrl", "listGrowthUrl", "subscriberGrowthUrl"]);
export type ClientSourceUrlKey = z.infer<typeof clientSourceUrlKeySchema>;

export interface ReportCaptureSpec {
  key: ReportCaptureSectionKey; screenshotType: ScreenshotType; title: string; sourceFamily: string; semanticCard: string; semanticTab: string; datePolicy: CaptureDatePolicy; sourceIdentity: string; defaultRequirement: "required" | "optional"; navigationMode: CaptureNavigationMode; automationStatus: CaptureAutomationStatus; sourceUrlKey?: ClientSourceUrlKey;
  /**
   * Added after the frozen nine-section core: part of a report only when that report's own section configuration
   * lists it, so every existing nine-section report keeps exactly its nine sections.
   */
  reportOptIn?: true;
}
export const REPORT_CAPTURE_SPEC_V1: readonly ReportCaptureSpec[] = [
  { key: "executive_summary", screenshotType: "overview", title: "Executive Summary", sourceFamily: "klaviyo-home", semanticCard: "business-performance-summary", semanticTab: "default", datePolicy: "EXACT_MONTH", sourceIdentity: "klaviyo-home|business-performance-summary|default", defaultRequirement: "required", navigationMode: "direct_configured_url", automationStatus: "auto", sourceUrlKey: "overviewUrl" },
  { key: "month_comparison", screenshotType: "month_comparison", title: "Month Comparison", sourceFamily: "business-review", semanticCard: "growth-overview", semanticTab: "message-type-breakdown|previous-period", datePolicy: "PREVIOUS_MONTH_COMPARISON", sourceIdentity: "business-review|growth-overview|message-type-breakdown|previous-period", defaultRequirement: "required", navigationMode: "shared_dashboard_semantic_tab", automationStatus: "auto", sourceUrlKey: "businessReviewUrl" },
  { key: "top_campaigns", screenshotType: "top_campaigns", title: "Top 5 Campaigns", sourceFamily: "klaviyo-campaigns", semanticCard: "campaign-list", semanticTab: "placed-order-revenue-desc", datePolicy: "EXACT_MONTH", sourceIdentity: "klaviyo-campaigns|campaign-list|placed-order-revenue-desc", defaultRequirement: "required", navigationMode: "direct_configured_url", automationStatus: "auto", sourceUrlKey: "campaignsUrl" },
  { key: "top_flows", screenshotType: "top_flows", title: "Top 5 Flows", sourceFamily: "klaviyo-home", semanticCard: "top-performing-flows", semanticTab: "default", datePolicy: "EXACT_MONTH", sourceIdentity: "klaviyo-home|top-performing-flows|default", defaultRequirement: "required", navigationMode: "direct_configured_url", automationStatus: "auto", sourceUrlKey: "overviewUrl" },
  { key: "campaign_performance", screenshotType: "campaign_performance", title: "Campaign Performance", sourceFamily: "business-review", semanticCard: "campaign-performance", semanticTab: "overview", datePolicy: "EXACT_MONTH", sourceIdentity: "business-review|campaign-performance|overview", defaultRequirement: "required", navigationMode: "shared_dashboard_semantic_tab", automationStatus: "auto", sourceUrlKey: "businessReviewUrl" },
  { key: "campaign_metrics", screenshotType: "campaign_metrics", title: "Campaign Metrics", sourceFamily: "business-review", semanticCard: "campaign-performance", semanticTab: "metrics", datePolicy: "EXACT_MONTH", sourceIdentity: "business-review|campaign-performance|metrics", defaultRequirement: "required", navigationMode: "shared_dashboard_semantic_tab", automationStatus: "auto", sourceUrlKey: "businessReviewUrl" },
  { key: "flow_performance", screenshotType: "flow_performance", title: "Flow Performance", sourceFamily: "business-review", semanticCard: "flow-performance", semanticTab: "overview", datePolicy: "EXACT_MONTH", sourceIdentity: "business-review|flow-performance|overview", defaultRequirement: "required", navigationMode: "shared_dashboard_semantic_tab", automationStatus: "auto", sourceUrlKey: "businessReviewUrl" },
  { key: "flow_metrics", screenshotType: "flow_metrics", title: "Flow Metrics", sourceFamily: "business-review", semanticCard: "flow-performance", semanticTab: "metrics", datePolicy: "EXACT_MONTH", sourceIdentity: "business-review|flow-performance|metrics", defaultRequirement: "required", navigationMode: "shared_dashboard_semantic_tab", automationStatus: "auto", sourceUrlKey: "businessReviewUrl" },
  { key: "signup_form_performance", screenshotType: "signup_form", title: "Signup Form Performance", sourceFamily: "signup-forms", semanticCard: "listing", semanticTab: "all-forms", datePolicy: "ROLLING_30_DAY", sourceIdentity: "signup-forms|listing|all-forms", defaultRequirement: "optional", navigationMode: "direct_configured_url", automationStatus: "manual_required", sourceUrlKey: "signupFormsUrl" },
  { key: "welcome_flow_performance", screenshotType: "welcome_flow", title: "Welcome Flow Performance", sourceFamily: "flows", semanticCard: "listing", semanticTab: "email-welcome-rows", datePolicy: "ROLLING_30_DAY", sourceIdentity: "flows|listing|email-welcome-rows", defaultRequirement: "optional", navigationMode: "direct_configured_url", automationStatus: "manual_required", sourceUrlKey: "flowsUrl" },
  { key: "customer_split", screenshotType: "customer_split", title: "Customers vs Non-Customers", sourceFamily: "segments", semanticCard: "configured-customer-split", semanticTab: "overview", datePolicy: "STATIC_ENTITY_VIEW", sourceIdentity: "segments|configured-customer-split|overview", defaultRequirement: "optional", navigationMode: "configured_entity", automationStatus: "deferred", sourceUrlKey: "segmentsUrl" },
  { key: "deliverability", screenshotType: "deliverability", title: "Deliverability Score", sourceFamily: "klaviyo-deliverability", semanticCard: "deliverability-score", semanticTab: "email", datePolicy: "ROLLING_30_DAY", sourceIdentity: "klaviyo-deliverability|deliverability-score|email", defaultRequirement: "required", navigationMode: "direct_configured_url", automationStatus: "auto", sourceUrlKey: "deliverabilityUrl" },
  // Section 10: Audience → Profiles → View subscriber growth → Email → Growth. A new section, not the retired List Growth.
  { key: "email_subscriber_growth", screenshotType: "email_subscriber_growth", title: "Subscriber Growth", sourceFamily: "klaviyo-subscriber-growth", semanticCard: "email", semanticTab: "growth", datePolicy: "EXACT_MONTH", sourceIdentity: "klaviyo-subscriber-growth|email|growth", defaultRequirement: "required", navigationMode: "direct_configured_url", automationStatus: "auto", sourceUrlKey: "subscriberGrowthUrl", reportOptIn: true },
] as const;
/** Legacy-only parsing contract. It deliberately is not in the current product specification. */
const LEGACY_LIST_GROWTH_CAPTURE_SPEC: ReportCaptureSpec = {
  key: "list_growth", screenshotType: "list_growth", title: "List Growth", sourceFamily: "list", semanticCard: "configured-primary-list", semanticTab: "growth", datePolicy: "EXACT_MONTH", sourceIdentity: "list|configured-primary-list|growth", defaultRequirement: "optional", navigationMode: "configured_entity", automationStatus: "deferred", sourceUrlKey: "listGrowthUrl",
};
export const reportCaptureSpecByScreenshotType: Readonly<Record<ScreenshotType, ReportCaptureSpec>> = {
  ...Object.fromEntries(REPORT_CAPTURE_SPEC_V1.map((spec) => [spec.screenshotType, spec])),
  list_growth: LEGACY_LIST_GROWTH_CAPTURE_SPEC,
} as Record<ScreenshotType, ReportCaptureSpec>;
export function createScreenshotSourceProof(type: ScreenshotType, period: ReportPeriod, listing?: { scope: "all_forms" | "email_welcome_flows"; entities?: Array<{ id: string; name: string; channel: "email" }> }, campaigns: ScreenshotSourceProof["campaigns"] = null, subscriberGrowth: SubscriberGrowthEvidence | null = null, businessPerformance: BusinessPerformanceEvidence | null = null): ScreenshotSourceProof {
  const spec = reportCaptureSpecByScreenshotType[type];
  const expectedPeriod = spec.datePolicy === "EXACT_MONTH" ? { startDate: period.startDate, endDate: period.endDate }
    : spec.datePolicy === "PREVIOUS_MONTH_COMPARISON" ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate } : null;
  return { captureSpecVersion: REPORT_CAPTURE_SPEC_VERSION, sectionKey: spec.key, sourceFamily: spec.sourceFamily, semanticCard: spec.semanticCard, semanticTab: spec.semanticTab, sourceIdentity: spec.sourceIdentity, datePolicy: spec.datePolicy, expectedPeriod, observedPeriod: expectedPeriod, configuredEntityId: null, configuredEntityName: null, listingScope: listing?.scope ?? null, configuredEntities: listing?.entities ?? [], semanticEvidence: type === "deliverability" ? ["deliverability-score", "based-on-last-30-days", "score-gauge", "rate-table"] : [], campaigns: type === "top_campaigns" ? campaigns : null, ...(type === "email_subscriber_growth" && subscriberGrowth ? { subscriberGrowth } : {}), ...(type === "overview" && businessPerformance ? { businessPerformance } : {}) };
}
export function matchesReportCaptureSpec(type: ScreenshotType, proof: ScreenshotSourceProof | null | undefined): boolean {
  const spec = reportCaptureSpecByScreenshotType[type];
  const listingMatches = type === "signup_form" ? proof?.listingScope === "all_forms" && proof.configuredEntities.length === 0
    : type === "welcome_flow" ? proof?.listingScope === "email_welcome_flows" && proof.configuredEntities.length === 2 && new Set(proof.configuredEntities.map(({ id }) => id)).size === 2
      : true;
  const deliverabilityEvidence = ["deliverability-score", "based-on-last-30-days", "score-gauge", "rate-table"] as const;
  const deliverabilityEvidenceMatches = type !== "deliverability" || deliverabilityEvidence.every((item) => proof?.semanticEvidence.includes(item));
  // Subscriber Growth evidence belongs to Section 10 alone: required there, and never carried by another section's proof.
  const subscriberGrowthEvidenceMatches = type === "email_subscriber_growth" ? subscriberGrowthEvidenceSchema.safeParse(proof?.subscriberGrowth).success : proof?.subscriberGrowth === undefined;
  // Business performance values belong to the Executive Summary alone; optional there (older captures), well-formed when present.
  const businessPerformanceMatches = type === "overview" ? proof?.businessPerformance === undefined || businessPerformanceEvidenceSchema.safeParse(proof.businessPerformance).success : proof?.businessPerformance === undefined;
  return Boolean(proof && listingMatches && deliverabilityEvidenceMatches && subscriberGrowthEvidenceMatches && businessPerformanceMatches && proof.captureSpecVersion === REPORT_CAPTURE_SPEC_VERSION && proof.sectionKey === spec.key && proof.sourceIdentity === spec.sourceIdentity && proof.sourceFamily === spec.sourceFamily && proof.semanticCard === spec.semanticCard && proof.semanticTab === spec.semanticTab && proof.datePolicy === spec.datePolicy);
}

export const reportSectionKeySchema = z.enum([
  "executive_summary", "top_campaigns", "top_flows", "month_comparison",
  "campaign_performance", "flow_performance", "signup_form", "welcome_flow",
  "customer_split", "deliverability", "campaign_metrics", "flow_metrics", "list_growth",
  "analysis", "next_month_plan", "email_subscriber_growth",
]);
export type ReportSectionKey = z.infer<typeof reportSectionKeySchema>;

export const sectionRequirementSchema = z.enum(["required", "optional", "disabled"]);
export type SectionRequirement = z.infer<typeof sectionRequirementSchema>;

export const sectionConfigurationSchema = z.record(z.string(), sectionRequirementSchema);
export type SectionConfiguration = z.infer<typeof sectionConfigurationSchema>;

const targetValueSchema = z.string().trim().min(1);
const klaviyoHttpsUrlSchema = z.string().trim().url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "https:" || (url.hostname !== "klaviyo.com" && !url.hostname.endsWith(".klaviyo.com")) || url.username || url.password) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Source URL must be an HTTPS Klaviyo URL without credentials." });
  }
});
const targetValuesSchema = z.array(z.string()).default([]).transform((values) => {
  const seen = new Set<string>();
  return values.reduce<string[]>((normalized, value) => {
    const trimmed = value.trim();
    const key = trimmed.toLocaleLowerCase();
    if (trimmed && !seen.has(key)) { seen.add(key); normalized.push(trimmed); }
    return normalized;
  }, []);
});
const entityTargetFields = { id: targetValueSchema.optional(), name: targetValueSchema.optional() };
export const entityTargetSchema = z.object(entityTargetFields).strict().superRefine((value, context) => {
  if (!value.id && !value.name) context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide a target ID or name." });
});
export type EntityTarget = z.infer<typeof entityTargetSchema>;

export const businessReviewTargetSchema = z.object({
  dashboardUrl: klaviyoHttpsUrlSchema.optional(),
  dashboardId: targetValueSchema.optional(),
  displayName: targetValueSchema.optional(),
  /** Visible Klaviyo account label verified against the selected client at discovery time. */
  accountLabel: targetValueSchema.optional(),
  /** Stable provider identity read from Klaviyo's explicit account context when exposed; never user-entered. */
  providerAccountId: targetValueSchema.optional(),
  providerIdentityKind: z.enum(["account", "workspace", "organization"]).optional(),
}).strict().superRefine((value, context) => {
  if (!value.dashboardUrl && !value.dashboardId && !value.displayName) context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide a Business Review URL, ID, or display name." });
});
export type BusinessReviewTarget = z.infer<typeof businessReviewTargetSchema>;

export const welcomeFlowTargetSchema = z.object({ ...entityTargetFields, aliases: targetValuesSchema.default([]) }).strict()
  .superRefine((value, context) => {
    if (!value.id && !value.name) context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide a target ID or name." });
  }).transform((value) => ({
    ...value,
    aliases: value.aliases.filter((alias) => alias.toLocaleLowerCase() !== value.name?.toLocaleLowerCase()),
  }));
export type WelcomeFlowTarget = z.infer<typeof welcomeFlowTargetSchema>;

export const signupFormsTargetSchema = z.object({
  mode: z.enum(["all", "configured"]),
  ids: targetValuesSchema.default([]),
  names: targetValuesSchema.default([]),
}).strict().superRefine((value, context) => {
  if (value.mode === "configured" && value.ids.length === 0 && value.names.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Configured sign-up forms require at least one ID or name." });
  }
});
export type SignupFormsTarget = z.infer<typeof signupFormsTargetSchema>;
export const welcomeFlowListingTargetSchema = z.object({
  mode: z.literal("email_welcome_flows"),
  flows: z.array(z.object({ id: targetValueSchema, name: targetValueSchema, channel: z.literal("email") }).strict()).length(2),
}).strict().superRefine((value, context) => {
  const ids = value.flows.map(({ id }) => id);
  if (new Set(ids).size !== 2) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Email Welcome listing scope requires two distinct flow IDs." });
  }
});
export type WelcomeFlowListingTarget = z.infer<typeof welcomeFlowListingTargetSchema>;

export const clientSourceUrlsSchema = z.object({
  overviewUrl: klaviyoHttpsUrlSchema.optional(), campaignsUrl: klaviyoHttpsUrlSchema.optional(), topFlowsUrl: klaviyoHttpsUrlSchema.optional(),
  businessReviewUrl: klaviyoHttpsUrlSchema.optional(), signupFormsUrl: klaviyoHttpsUrlSchema.optional(), flowsUrl: klaviyoHttpsUrlSchema.optional(),
  segmentsUrl: klaviyoHttpsUrlSchema.optional(), deliverabilityUrl: klaviyoHttpsUrlSchema.optional(), listGrowthUrl: klaviyoHttpsUrlSchema.optional(),
  /** The Klaviyo "Subscriber growth" page (Audience → Profiles → View subscriber growth), copied from the address bar. */
  subscriberGrowthUrl: klaviyoHttpsUrlSchema.optional(),
}).strict().superRefine((value, context) => {
  if (Object.values(value).every((url) => !url)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one source URL." });
});
export type ClientSourceUrls = z.infer<typeof clientSourceUrlsSchema>;

/**
 * Klaviyo renders an account as its avatar initials followed by its name ("AC Acme Home"), and a
 * page reader that takes the control's text gets both. The display name is the account name without those initials.
 * Only a prefix that equals the name's own first letters is removed, so a real acronym ("ABC Widgets") is kept.
 */
export function klaviyoAccountDisplayName(label: string): string {
  const text = label.replace(/\s+/g, " ").trim();
  const match = /^([A-Z]{2,3}) (.+)$/.exec(text);
  if (!match) return text;
  const [, initials, name] = match;
  const letters = name!.replace(/[^A-Za-z]/g, "").slice(0, initials!.length).toUpperCase();
  return letters === initials ? name!.trim() : text;
}
/** Two labels name the same Klaviyo account once avatar initials, case and punctuation are ignored. */
export function sameKlaviyoAccountIdentity(left: string | null | undefined, right: string | null | undefined): boolean {
  const key = (value: string) => klaviyoAccountDisplayName(value).toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
  return Boolean(left?.trim() && right?.trim()) && key(left!) === key(right!);
}

/** A Klaviyo provider metric ID as it appears in /metric/<ID>/…: letters and digits only (e.g. "QuWhQ9"). */
export const PROVIDER_METRIC_ID_PATTERN = /^[A-Za-z0-9]{4,32}$/;
export type MetricIdParseResult =
  | { ok: true; providerMetricId: string }
  | { ok: false; code: "INVALID_PROVIDER_METRIC_ID" | "INVALID_METRIC_URL"; message: string };
const INVALID_ID_MESSAGE = "Enter only the Klaviyo metric ID, not the full URL.";

/** Manual entry: trimmed, no spaces, no URL, letters and digits only. Never guessed or completed. */
export function parseProviderMetricId(raw: string): MetricIdParseResult {
  const value = raw.trim();
  if (!value) return { ok: false, code: "INVALID_PROVIDER_METRIC_ID", message: "Enter the Klaviyo metric ID." };
  if (/[/:.]/.test(value) || /klaviyo/i.test(value)) return { ok: false, code: "INVALID_PROVIDER_METRIC_ID", message: INVALID_ID_MESSAGE };
  if (/\s/.test(value)) return { ok: false, code: "INVALID_PROVIDER_METRIC_ID", message: "A Klaviyo metric ID has no spaces." };
  if (!PROVIDER_METRIC_ID_PATTERN.test(value)) return { ok: false, code: "INVALID_PROVIDER_METRIC_ID", message: "A Klaviyo metric ID contains only letters and digits (for example QuWhQ9)." };
  return { ok: true, providerMetricId: value };
}

/** "Placed Order" → "placed-order", the slug Klaviyo puts after the metric ID. */
export function klaviyoMetricSlug(label: string): string {
  return label.trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * A pasted Klaviyo metric page URL (https://www.klaviyo.com/metric/<ID>/<slug>, any query): only the pathname is read,
 * and the slug must name the configured metric, so another metric's page is never taken for it.
 */
export function parseKlaviyoMetricUrl(raw: string, label = "Placed Order"): MetricIdParseResult {
  const invalid = { ok: false as const, code: "INVALID_METRIC_URL" as const, message: `Paste a Klaviyo ${label} URL such as /metric/<id>/${klaviyoMetricSlug(label)}.` };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return invalid; }
  if (url.protocol !== "https:" || !["www.klaviyo.com", "klaviyo.com"].includes(url.hostname)) return invalid;
  const match = /^\/metric\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
  if (!match || !PROVIDER_METRIC_ID_PATTERN.test(match[1]!) || match[2]!.toLocaleLowerCase() !== klaviyoMetricSlug(label)) return invalid;
  return { ok: true, providerMetricId: match[1]! };
}

/**
 * One-time canonical client configuration. Every monthly report copies its
 * name, timezone, and currency from here; nothing is re-entered per report.
 * The verified Klaviyo account identity lives on `businessReview`.
 */
export const clientProfileSchema = z.object({
  name: z.string().trim().min(1),
  /** Null only while a newly added client is still being set up; a READY client always has one. */
  timezone: z.string().min(1).refine(isValidIanaTimeZone, "Expected a valid IANA timezone").nullable(),
  currency: z.string().length(3).nullable().default(null),
  conversionMetric: z.object({
    label: z.string().trim().min(1).default("Placed Order"),
    providerMetricId: z.string().trim().regex(PROVIDER_METRIC_ID_PATTERN, "Enter only the Klaviyo metric ID, not the full URL.").nullable().default(null),
  }).strict().default({}),
  /** Enabled report sections; null means the product defaults. */
  sections: sectionConfigurationSchema.nullable().default(null),
}).strict();
export type ClientProfile = z.infer<typeof clientProfileSchema>;

const clientReportTargetsShape = z.object({
  profile: clientProfileSchema.nullable().default(null),
  businessReview: businessReviewTargetSchema.nullable().default(null),
  sourceUrls: clientSourceUrlsSchema.nullable().default(null),
  primaryEmailList: entityTargetSchema.nullable().default(null),
  primarySmsList: entityTargetSchema.nullable().default(null),
  welcomeFlow: welcomeFlowTargetSchema.nullable().default(null),
  welcomeFlowListing: welcomeFlowListingTargetSchema.nullable().default(null),
  customerSegment: entityTargetSchema.nullable().default(null),
  nonCustomerSegment: entityTargetSchema.nullable().default(null),
  signupForms: signupFormsTargetSchema.nullable().default(null),
}).strict();
function validateClientTargetRelationships(value: z.infer<typeof clientReportTargetsShape>, context: z.RefinementCtx) {
  const customer = value.customerSegment;
  const nonCustomer = value.nonCustomerSegment;
  if (customer?.id && nonCustomer?.id && customer.id === nonCustomer.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nonCustomerSegment", "id"], message: "Customer and non-customer segment IDs must differ." });
  }
  if (!customer?.id && !nonCustomer?.id && customer?.name && nonCustomer?.name && customer.name.toLocaleLowerCase() === nonCustomer.name.toLocaleLowerCase()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["nonCustomerSegment", "name"], message: "Customer and non-customer segment names must differ." });
  }
}
export const clientReportTargetsInputSchema = clientReportTargetsShape.superRefine(validateClientTargetRelationships);
export type ClientReportTargetsInput = z.infer<typeof clientReportTargetsInputSchema>;
export const clientReportTargetsSchema = clientReportTargetsShape.extend({
  clientId: z.string().trim().min(1),
  createdAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }).nullable(),
}).superRefine(validateClientTargetRelationships);
export type ClientReportTargets = z.infer<typeof clientReportTargetsSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Client onboarding: one shared definition of "this client is set up". The API computes the status with it, the
// extension displays it; neither re-implements the rules.

/** The standalone Email Deliverability Score route the Deliverability capture adapter requires. */
export const KLAVIYO_DELIVERABILITY_SCORE_PATH = "/analytics/deliverability/email/score";
/** Audience → Profiles → View subscriber growth. The capture itself selects Email → Growth and the report month. */
export const KLAVIYO_SUBSCRIBER_GROWTH_PATH = "/people/subscribers";
export const KLAVIYO_SUBSCRIBER_GROWTH_URL = `https://www.klaviyo.com${KLAVIYO_SUBSCRIBER_GROWTH_PATH}`;

/**
 * A Subscriber Growth source address (pasted, or read from the authorized tab), reduced to the stable route: https on
 * klaviyo.com, exactly /people/subscribers, with any query, hash or trailing slash removed. Anything else is refused.
 */
export function parseSubscriberGrowthSourceUrl(raw: string): { ok: true; url: string } | { ok: false; code: "INVALID_SUBSCRIBER_GROWTH_URL"; message: string } {
  const invalid = { ok: false as const, code: "INVALID_SUBSCRIBER_GROWTH_URL" as const, message: `Paste the Klaviyo Subscriber Growth URL, such as ${KLAVIYO_SUBSCRIBER_GROWTH_URL}.` };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return invalid; }
  if (url.protocol !== "https:" || !["www.klaviyo.com", "klaviyo.com"].includes(url.hostname) || url.pathname.replace(/\/+$/, "") !== KLAVIYO_SUBSCRIBER_GROWTH_PATH) return invalid;
  return { ok: true, url: KLAVIYO_SUBSCRIBER_GROWTH_URL };
}

export type ClientSetupBlockerCode =
  | "CLIENT_NAME_NOT_CONFIGURED" | "KLAVIYO_ACCOUNT_NOT_VERIFIED" | "TIMEZONE_NOT_CONFIGURED" | "CURRENCY_NOT_CONFIGURED"
  | "CONVERSION_METRIC_NOT_CONFIGURED" | "CONVERSION_METRIC_ID_NOT_CONFIGURED" | "CONVERSION_METRIC_ID_SHARED_WITH_OTHER_CLIENT"
  | "BUSINESS_REVIEW_SOURCE_NOT_VERIFIED" | "DELIVERABILITY_SOURCE_NOT_VERIFIED" | "SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED";
export interface ClientSetupBlocker { code: ClientSetupBlockerCode; item: ClientSetupItemKey; message: string }
/** The required setup checklist, in display order. Optional sections (signup forms, welcome flow, customer split) are deliberately absent. */
export const CLIENT_SETUP_ITEMS = [
  { key: "clientName", label: "Client Name" },
  { key: "klaviyoAccount", label: "Klaviyo Account" },
  { key: "timezone", label: "Timezone" },
  { key: "currency", label: "Currency" },
  { key: "conversionMetric", label: "Conversion Metric" },
  { key: "conversionMetricId", label: "Metric ID" },
  { key: "businessReview", label: "Business Review" },
  { key: "deliverability", label: "Deliverability" },
  { key: "subscriberGrowth", label: "Subscriber Growth" },
] as const;
export type ClientSetupItemKey = typeof CLIENT_SETUP_ITEMS[number]["key"];
/** INCOMPLETE/READY/ERROR are computed by the API; VERIFYING is the extension's transient state while it inspects Klaviyo. */
export const clientSetupStatusSchema = z.enum(["INCOMPLETE", "VERIFYING", "READY", "ERROR"]);
export type ClientSetupStatus = z.infer<typeof clientSetupStatusSchema>;

function isIsoCurrency(code: string): boolean {
  if (!/^[A-Z]{3}$/.test(code)) return false;
  const supported = (Intl as typeof Intl & { supportedValuesOf?: (key: "currency") => string[] }).supportedValuesOf?.("currency");
  return supported ? supported.includes(code) : true;
}
function urlPath(value: string | undefined | null): string | null {
  if (!value) return null;
  try { const url = new URL(value); return url.origin === "https://www.klaviyo.com" ? url.pathname.replace(/\/$/, "") : null; } catch { return null; }
}

/**
 * Every required configuration item that is missing or invalid, in checklist order. An empty list means READY.
 * `otherClients` lets the caller prove that this client's provider metric ID is not another client's (Klaviyo metric
 * IDs are account-specific, so a shared one can only be a copy).
 */
export function clientSetupBlockers(targets: Pick<ClientReportTargets, "clientId" | "profile" | "businessReview" | "sourceUrls">, otherClients: ReadonlyArray<Pick<ClientReportTargets, "clientId" | "profile">> = []): ClientSetupBlocker[] {
  const blockers: ClientSetupBlocker[] = [];
  const add = (code: ClientSetupBlockerCode, item: ClientSetupItemKey, message: string) => blockers.push({ code, item, message });
  const profile = targets.profile;
  const account = targets.businessReview;
  if (!profile?.name?.trim()) add("CLIENT_NAME_NOT_CONFIGURED", "clientName", "The client name is not saved.");
  if (!account?.accountLabel?.trim() && !account?.providerAccountId?.trim()) add("KLAVIYO_ACCOUNT_NOT_VERIFIED", "klaviyoAccount", "The client's Klaviyo account has not been verified.");
  if (!profile?.timezone || !isValidIanaTimeZone(profile.timezone)) add("TIMEZONE_NOT_CONFIGURED", "timezone", "The client's timezone is not configured.");
  if (!profile?.currency || !isIsoCurrency(profile.currency)) add("CURRENCY_NOT_CONFIGURED", "currency", "The client's ISO currency code is not configured.");
  if (!profile?.conversionMetric?.label?.trim()) add("CONVERSION_METRIC_NOT_CONFIGURED", "conversionMetric", "The conversion metric is not configured.");
  const metricId = profile?.conversionMetric?.providerMetricId?.trim();
  if (!metricId) add("CONVERSION_METRIC_ID_NOT_CONFIGURED", "conversionMetricId", "The Klaviyo metric ID of the conversion metric is not configured.");
  else if (otherClients.some((other) => other.clientId !== targets.clientId && other.profile?.conversionMetric?.providerMetricId?.trim() === metricId)) {
    add("CONVERSION_METRIC_ID_SHARED_WITH_OTHER_CLIENT", "conversionMetricId", "This Klaviyo metric ID is saved on another client. Each client needs the metric ID from its own Klaviyo account.");
  }
  const dashboardPath = urlPath(account?.dashboardUrl);
  if (!dashboardPath || !/^\/analytics\/dashboards\/[^/]+$/.test(dashboardPath)) add("BUSINESS_REVIEW_SOURCE_NOT_VERIFIED", "businessReview", "The Business Review dashboard has not been verified.");
  if (urlPath(targets.sourceUrls?.deliverabilityUrl) !== KLAVIYO_DELIVERABILITY_SCORE_PATH) add("DELIVERABILITY_SOURCE_NOT_VERIFIED", "deliverability", "The Deliverability → Email → Score source has not been verified.");
  if (urlPath(targets.sourceUrls?.subscriberGrowthUrl) !== KLAVIYO_SUBSCRIBER_GROWTH_PATH) add("SUBSCRIBER_GROWTH_SOURCE_NOT_VERIFIED", "subscriberGrowth", "The Subscriber Growth source has not been verified.");
  return blockers;
}

/** READY only when nothing blocks; a metric ID copied from another client is an ERROR, not merely incomplete. */
export function clientSetupStatus(blockers: readonly Pick<ClientSetupBlocker, "code">[]): Exclude<ClientSetupStatus, "VERIFYING"> {
  if (blockers.some(({ code }) => code === "CONVERSION_METRIC_ID_SHARED_WITH_OTHER_CLIENT")) return "ERROR";
  return blockers.length ? "INCOMPLETE" : "READY";
}

export const clientSetupSummarySchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  status: clientSetupStatusSchema.exclude(["VERIFYING"]),
  blockers: z.array(z.object({ code: z.string().min(1), item: z.string().min(1), message: z.string().min(1) }).strict()),
  setup: clientReportTargetsSchema,
}).strict();
export type ClientSetupSummary = Omit<z.infer<typeof clientSetupSummarySchema>, "blockers"> & { blockers: ClientSetupBlocker[] };

/**
 * The client configuration frozen onto a new monthly report. Only called for a READY client, so every value exists;
 * anything missing throws rather than freezing a partial definition.
 */
export function clientReportSnapshot(targets: Pick<ClientReportTargets, "clientId" | "profile" | "businessReview">): { id: string; name: string; timezone: string; currency: string; conversionMetric: ConversionMetricSnapshot; klaviyoAccount: KlaviyoAccountSnapshot } {
  const profile = targets.profile; const account = targets.businessReview;
  const metricId = profile?.conversionMetric.providerMetricId?.trim();
  const label = account?.accountLabel?.trim() || account?.providerAccountId?.trim();
  if (!profile?.timezone || !profile.currency || !metricId || !label) throw new Error("Client setup is incomplete; a report snapshot cannot be taken.");
  return {
    id: targets.clientId, name: profile.name, timezone: profile.timezone, currency: profile.currency,
    conversionMetric: { label: profile.conversionMetric.label, providerMetricId: metricId },
    klaviyoAccount: { accountLabel: label, providerAccountId: account?.providerAccountId?.trim() || null },
  };
}

export const reportReadinessStatusSchema = z.enum(["ready", "missing_configuration", "optional_not_configured", "not_applicable", "manual_required", "manual_by_design", "deferred"]);
export type ReportReadinessStatus = z.infer<typeof reportReadinessStatusSchema>;
export const reportReadinessSectionSchema = z.object({
  sectionKey: reportCaptureSectionKeySchema,
  status: reportReadinessStatusSchema,
  required: z.boolean(),
  reason: z.string().min(1).nullable(),
  requiredTargets: z.array(z.string()).default([]),
});
export type ReportReadinessSection = z.infer<typeof reportReadinessSectionSchema>;
export const reportReadinessSchema = z.object({ ready: z.boolean(), sections: z.array(reportReadinessSectionSchema) });
export type ReportReadiness = z.infer<typeof reportReadinessSchema>;

export const screenshotSectionMapping: Readonly<Record<ScreenshotType, ReportSectionKey>> = {
  overview: "executive_summary",
  top_campaigns: "top_campaigns",
  top_flows: "top_flows",
  month_comparison: "month_comparison",
  campaign_performance: "campaign_performance",
  flow_performance: "flow_performance",
  signup_form: "signup_form",
  welcome_flow: "welcome_flow",
  customer_split: "customer_split",
  deliverability: "deliverability",
  campaign_metrics: "campaign_metrics",
  flow_metrics: "flow_metrics",
  list_growth: "list_growth",
  email_subscriber_growth: "email_subscriber_growth",
};

/**
 * The automatic capture sections a report includes, in specification order: the frozen nine-section core always,
 * plus each later automatic section (`reportOptIn`) only when the report's own section configuration enables it.
 */
export function automaticCaptureTypesForSections(sections: SectionConfiguration): ScreenshotType[] {
  return REPORT_CAPTURE_SPEC_V1.filter((spec) => spec.automationStatus === "auto"
    && (!spec.reportOptIn || (sections[screenshotSectionMapping[spec.screenshotType]] !== undefined && sections[screenshotSectionMapping[spec.screenshotType]] !== "disabled")))
    .map((spec) => spec.screenshotType);
}

export const screenshotRecordSchema = z.object({
  id: z.string().min(1),
  clientId: z.string().min(1),
  reportMonth: reportMonthSchema,
  type: screenshotTypeSchema,
  capturedAt: z.string().datetime({ offset: true }),
  sourceUrl: z.string().url().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  approved: z.boolean(),
  storageKey: z.string().min(1).nullable().default(null),
  mimeType: z.literal("image/png").nullable().default(null),
  byteSize: z.number().int().positive().nullable().default(null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest").nullable().default(null),
  captureOrigin: z.enum(["extension_manual", "live_acceptance_import"]).optional(),
  approvedAt: z.string().datetime({ offset: true }).nullable().default(null),
  periodConfirmed: z.boolean().default(false),
  sourceProof: screenshotSourceProofSchema.nullable().default(null),
  /**
   * When the backend machine-validated this automatic capture (stored bytes, hash, dimensions, client, month, period
   * and source proof). Separate from `approved`/`approvedAt`, which only ever record a human approval.
   */
  automatedValidatedAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type ScreenshotRecord = z.infer<typeof screenshotRecordSchema>;

/**
 * A capture may appear in the final report when a human approved it, or when it is an automatic capture the backend
 * machine-validated. Human approval and machine validation stay separate facts on the record.
 */
export function isAcceptedCapture(screenshot: Pick<ScreenshotRecord, "approved" | "captureOrigin" | "automatedValidatedAt">): boolean {
  return screenshot.approved || (screenshot.captureOrigin === "live_acceptance_import" && Boolean(screenshot.automatedValidatedAt));
}

export const reportValidationIssueSchema = z.object({
  code: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  field: z.string().min(1).optional(),
  section: reportSectionKeySchema.optional(),
  screenshotType: screenshotTypeSchema.optional(),
});
export type ReportValidationIssue = z.infer<typeof reportValidationIssueSchema>;

export const reportValidationStateSchema = z.object({
  status: z.enum(["pending", "valid", "invalid"]),
  errors: z.array(reportValidationIssueSchema),
  warnings: z.array(reportValidationIssueSchema),
});
export type ReportValidationState = z.infer<typeof reportValidationStateSchema>;

export const reportDraftSchema = z.object({
  id: z.string().uuid(),
  client: clientSummarySchema,
  reportMonth: reportMonthSchema,
  period: reportPeriodSchema,
  status: reportStatusSchema,
  sections: sectionConfigurationSchema,
  screenshots: z.array(screenshotRecordSchema),
  validation: reportValidationStateSchema,
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type ReportDraft = z.infer<typeof reportDraftSchema>;

export const screenshotUploadAcknowledgementSchema = z.object({
  reportId: z.string().uuid(),
  screenshotType: screenshotTypeSchema,
  screenshotRecordId: z.string().min(1),
  approvalStatus: z.enum(["approved", "pending_review"]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest"),
  sourceProofAccepted: z.literal(true),
  report: reportDraftSchema,
}).strict();
export type ScreenshotUploadAcknowledgement = z.infer<typeof screenshotUploadAcknowledgementSchema>;

/**
 * Google Drive archive copy of a canonical PDF artifact. Drive is delivery only: the artifact's own storage stays
 * canonical. No credential or token is ever part of this record.
 */
export const reportPdfDriveDeliverySchema = z.object({
  driveUploadStatus: z.enum(["uploaded", "failed"]),
  driveFileName: z.string().min(1),
  driveFileId: z.string().min(1).nullable(),
  driveFolderId: z.string().min(1).nullable(),
  driveWebViewLink: z.string().url().nullable(),
  driveUploadedAt: z.string().datetime({ offset: true }).nullable(),
  driveUploadAction: z.enum(["created", "updated"]).nullable(),
  driveErrorCode: z.string().min(1).nullable(),
  driveAttemptedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReportPdfDriveDelivery = z.infer<typeof reportPdfDriveDeliverySchema>;

/**
 * Editable Google Doc copy built from the same approved report model as a canonical PDF artifact. The PDF stays the
 * locked canonical record; the Doc is the working/client copy. No credential or token is ever part of this record.
 */
export const reportGoogleDocSchema = z.object({
  googleDocStatus: z.enum(["synced", "failed"]),
  googleDocName: z.string().min(1),
  googleDocId: z.string().min(1).nullable(),
  googleDocFolderId: z.string().min(1).nullable(),
  googleDocWebViewLink: z.string().url().nullable(),
  googleDocUpdatedAt: z.string().datetime({ offset: true }).nullable(),
  /** Drive's version of the Doc right after Tention wrote it; a later mismatch means someone edited it in Drive. */
  googleDocVersion: z.string().min(1).nullable(),
  /**
   * Drive's modifiedTime right after Tention wrote the Doc. Edits are detected by this, not by `version`: Drive bumps
   * `version` for invisible server-side processing too, which made unedited Docs look edited.
   */
  googleDocModifiedTime: z.string().datetime({ offset: true }).nullable().optional(),
  /** How the Doc is known to be Tention's: this report's own record, Tention's marker on the Doc, or an explicit adoption. */
  googleDocManagedBy: z.enum(["created", "record", "marker", "adopted"]).nullable().optional(),
  /**
   * A same-named Doc found in the month folder that Tention could not prove was its own: never overwritten, but shown
   * so it can be opened and, explicitly, adopted.
   */
  googleDocCandidateId: z.string().min(1).nullable().optional(),
  googleDocCandidateWebViewLink: z.string().url().nullable().optional(),
  googleDocAction: z.enum(["created", "updated"]).nullable(),
  googleDocErrorCode: z.string().min(1).nullable(),
  googleDocAttemptedAt: z.string().datetime({ offset: true }),
}).strict();
export type ReportGoogleDoc = z.infer<typeof reportGoogleDocSchema>;

export const reportPdfArtifactSchema = z.object({
  id: z.string().uuid(), reportId: z.string().uuid(), storageKey: z.string().min(1),
  mimeType: z.literal("application/pdf"), byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest"),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest"),
  templateVersion: z.string().min(1), generatedAt: z.string().datetime({ offset: true }),
  /** Absent until a Drive delivery has been attempted for this artifact. */
  driveDelivery: reportPdfDriveDeliverySchema.optional(),
  /** Absent until an editable Google Doc copy has been attempted for this artifact. */
  googleDoc: reportGoogleDocSchema.optional(),
});
export type ReportPdfArtifact = z.infer<typeof reportPdfArtifactSchema>;

export const reportGenerationResultSchema = z.object({ report: reportDraftSchema, artifact: reportPdfArtifactSchema });
export type ReportGenerationResult = z.infer<typeof reportGenerationResultSchema>;

export const reportLifecycleEventTypeSchema = z.enum([
  "REPORT_CREATED", "START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "DATA_FETCH_FAILED",
  "MARK_CAPTURES_INCOMPLETE", "SUBMIT_FOR_REVIEW", "APPROVE", "START_GENERATION",
  "GENERATION_SUCCEEDED", "GENERATION_FAILED", "RESET_TO_DRAFT",
  "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW", "AUTO_VALIDATE",
]);
export type ReportLifecycleEventType = z.infer<typeof reportLifecycleEventTypeSchema>;

export const reportLifecycleEventSchema = z.object({
  id: z.string().uuid(),
  reportId: z.string().uuid(),
  eventType: reportLifecycleEventTypeSchema,
  fromStatus: reportStatusSchema.nullable(),
  toStatus: reportStatusSchema,
  reportVersion: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), z.unknown()).nullable(),
});
export type ReportLifecycleEvent = z.infer<typeof reportLifecycleEventSchema>;

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

export type FinalGenerationBlockerCode = "CURRENCY_NOT_CONFIGURED" | "CLIENT_CURRENCY_MISMATCH" | "CONVERSION_METRIC_NOT_CONFIGURED" | "CONVERSION_METRIC_ID_NOT_CONFIGURED";
export interface FinalGenerationBlocker { code: FinalGenerationBlockerCode; field: string; message: string }
/** The client-profile fields final generation depends on (see ClientProfile in @tention/report-schema). */
export interface FinalGenerationClientProfile { currency: string | null; conversionMetric: { label: string; providerMetricId: string | null } }

/**
 * Data-definition fields a client-facing report may not be generated without (AGENTS.md §7, §22, §41). They are never
 * guessed: a currency symbol in a screenshot is not a currency, and a metric display label is not a provider metric ID.
 * The report's currency is the one frozen on the draft from the client profile; a profile that later disagrees with it
 * blocks rather than silently changing the report.
 */
export function finalGenerationDataBlockers(draft: { client: Pick<ReportDraft["client"], "currency" | "conversionMetric"> }, profile: FinalGenerationClientProfile | null): FinalGenerationBlocker[] {
  const blockers: FinalGenerationBlocker[] = [];
  const currency = draft.client.currency;
  // A report created through client onboarding carries its own conversion metric and currency: later profile edits
  // apply to new reports only and neither block nor change this one (AGENTS.md §23).
  const snapshot = draft.client.conversionMetric ?? null;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) blockers.push({ code: "CURRENCY_NOT_CONFIGURED", field: "client.currency", message: "Currency is not configured for this report. Confirm the client's ISO currency code (for example USD) before generating." });
  else if (!snapshot && profile?.currency && profile.currency !== currency) blockers.push({ code: "CLIENT_CURRENCY_MISMATCH", field: "client.currency", message: `This report was created in ${currency}, but the client is now configured in ${profile.currency}.` });
  if (snapshot) return blockers;
  if (!profile?.conversionMetric?.label?.trim()) blockers.push({ code: "CONVERSION_METRIC_NOT_CONFIGURED", field: "profile.conversionMetric.label", message: "The conversion metric is not configured for this client." });
  if (!profile?.conversionMetric?.providerMetricId?.trim()) blockers.push({ code: "CONVERSION_METRIC_ID_NOT_CONFIGURED", field: "profile.conversionMetric.providerMetricId", message: `The Klaviyo metric ID for "${profile?.conversionMetric?.label?.trim() || "the conversion metric"}" is not configured. A display name is not enough to identify the metric.` });
  return blockers;
}

// ---------------------------------------------------------------------------------------------------------------------
// Report cover: Business performance summary values, verified against the report's own currency, period and client.
// Money is exact: integer minor units parsed from the rendered digits, never floating-point arithmetic.
// ---------------------------------------------------------------------------------------------------------------------

export type CoverMetricKey = "totalRevenue" | "emailAttributedRevenue" | "campaignRevenue" | "flowRevenue";
export const COVER_METRICS: ReadonlyArray<{ key: CoverMetricKey; label: string }> = [
  { key: "totalRevenue", label: "Total Revenue" },
  { key: "emailAttributedRevenue", label: "Email Attributed Revenue" },
  { key: "campaignRevenue", label: "Revenue from Campaigns" },
  { key: "flowRevenue", label: "Revenue from Flows" },
];
export interface ParsedMoney { raw: string; /** Exact decimal string, e.g. "584032.35". */ amount: string; /** Integer minor units (cents for USD). */ minor: number; currency: string }
export type CoverIssueCode = "COVER_METRIC_MISSING" | "COVER_METRIC_MALFORMED" | "COVER_CURRENCY_MISMATCH" | "COVER_CURRENCY_NOT_CONFIGURED" | "COVER_METRICS_INCONSISTENT" | "COVER_SOURCE_NOT_VERIFIED";
export interface CoverIssue { code: CoverIssueCode; metric: string | null; message: string }
export interface VerifiedCover {
  currency: string; reportMonthLabel: string;
  metrics: Record<CoverMetricKey, ParsedMoney & { label: string; formatted: string }>;
  totalAttributedRevenue: ParsedMoney | null; smsAttributedRevenue: ParsedMoney | null;
  period: { startDate: string; endDate: string }; capturedAt: string; screenshotId: string; sha256: string | null;
}
export type CoverResult = { ok: true; cover: VerifiedCover } | { ok: false; issues: CoverIssue[] };

const fractionDigits = (currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
/** Symbols Klaviyo may paint for the configured currency: its ISO code, its en-US symbol, or its narrow symbol. */
function acceptedSymbols(currency: string): Set<string> {
  const symbol = (display: "symbol" | "narrowSymbol") => new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: display }).formatToParts(1).find(({ type }) => type === "currency")?.value ?? "";
  return new Set([currency, symbol("symbol"), symbol("narrowSymbol")].filter(Boolean));
}

/** Parses Klaviyo's rendered money ("$584,032.35", "-$12.00", "€1,234.50") for `currency`; compact or foreign values fail. */
export function parseRenderedMoney(raw: string, currency: string): { ok: true; value: ParsedMoney } | { ok: false; code: "COVER_METRIC_MALFORMED" | "COVER_CURRENCY_MISMATCH"; message: string } {
  const text = raw.replace(/ /g, " ").trim();
  const match = text.match(/^(-|−)?\s*([^\d\s.,-]*)\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([^\d\s.,-]*)$/);
  if (!match) return { ok: false, code: "COVER_METRIC_MALFORMED", message: `"${raw}" is not an exact money value.` };
  const [, sign, prefix, whole, fraction = "", suffix] = match;
  const symbol = (prefix || suffix || "").trim();
  if ((prefix && suffix) || !symbol) return { ok: false, code: "COVER_METRIC_MALFORMED", message: `"${raw}" does not carry exactly one currency symbol.` };
  if (!acceptedSymbols(currency).has(symbol)) return { ok: false, code: "COVER_CURRENCY_MISMATCH", message: `"${raw}" is not in the report currency ${currency}.` };
  const digits = fractionDigits(currency);
  if (fraction.length > digits) return { ok: false, code: "COVER_METRIC_MALFORMED", message: `"${raw}" has more decimals than ${currency} allows.` };
  const integer = whole!.replace(/,/g, "");
  const minorText = `${integer}${fraction.padEnd(digits, "0")}`.replace(/^0+(?=\d)/, "");
  const minor = Number(minorText) * (sign ? -1 : 1);
  if (!Number.isSafeInteger(minor)) return { ok: false, code: "COVER_METRIC_MALFORMED", message: `"${raw}" is out of range.` };
  const amount = `${sign ? "-" : ""}${integer.replace(/^0+(?=\d)/, "")}${digits ? `.${fraction.padEnd(digits, "0")}` : ""}`;
  return { ok: true, value: { raw, amount, minor, currency } };
}

/** Formats an exact decimal amount in the report currency ("USD" → "$584,032.35"); the decimal string is never rounded. */
export function formatCoverMoney(amount: string, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount as unknown as number);
}

/** Verifies one capture's Business performance values: every cover metric present, exact, in `currency`, and consistent. */
export function verifyBusinessPerformance(evidence: BusinessPerformanceEvidence | null | undefined, currency: string | null): { ok: true; values: Record<CoverMetricKey, ParsedMoney>; totalAttributedRevenue: ParsedMoney | null; smsAttributedRevenue: ParsedMoney | null } | { ok: false; issues: CoverIssue[] } {
  const issues: CoverIssue[] = [];
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return { ok: false, issues: [{ code: "COVER_CURRENCY_NOT_CONFIGURED", metric: null, message: "The report currency is not configured, so the cover values cannot be verified." }] };
  if (!evidence) return { ok: false, issues: COVER_METRICS.map(({ label }) => ({ code: "COVER_METRIC_MISSING" as const, metric: label, message: `${label} was not captured from the Business performance summary.` })) };
  const read = (raw: string | null, label: string, required: boolean): ParsedMoney | null => {
    if (raw === null) { if (required) issues.push({ code: "COVER_METRIC_MISSING", metric: label, message: `${label} was not found on the Business performance summary.` }); return null; }
    const parsed = parseRenderedMoney(raw, currency);
    if (!parsed.ok) { issues.push({ code: parsed.code, metric: label, message: `${label}: ${parsed.message}` }); return null; }
    return parsed.value;
  };
  const values = Object.fromEntries(COVER_METRICS.map(({ key, label }) => [key, read(evidence[key], label, true)])) as Record<CoverMetricKey, ParsedMoney | null>;
  const totalAttributedRevenue = read(evidence.totalAttributedRevenue, "Total Attributed Revenue", false);
  const smsAttributedRevenue = read(evidence.smsAttributedRevenue, "Text Message Attributed Revenue", false);
  // Each value is rounded to the minor unit as rendered, so a sum may differ from the rendered total by one minor unit.
  if (values.campaignRevenue && values.flowRevenue && totalAttributedRevenue && Math.abs(values.campaignRevenue.minor + values.flowRevenue.minor - totalAttributedRevenue.minor) > 1) {
    issues.push({ code: "COVER_METRICS_INCONSISTENT", metric: "Revenue from Campaigns + Revenue from Flows", message: `Campaigns ${values.campaignRevenue.raw} + Flows ${values.flowRevenue.raw} does not equal Attributed revenue ${totalAttributedRevenue.raw}.` });
  }
  if (values.emailAttributedRevenue && totalAttributedRevenue && values.emailAttributedRevenue.minor > totalAttributedRevenue.minor + 1) {
    issues.push({ code: "COVER_METRICS_INCONSISTENT", metric: "Email Attributed Revenue", message: `Email ${values.emailAttributedRevenue.raw} exceeds total Attributed revenue ${totalAttributedRevenue.raw}; it may be the total rather than the Email channel.` });
  }
  if (values.emailAttributedRevenue && smsAttributedRevenue && totalAttributedRevenue && values.emailAttributedRevenue.minor + smsAttributedRevenue.minor > totalAttributedRevenue.minor + 1) {
    issues.push({ code: "COVER_METRICS_INCONSISTENT", metric: "Email Attributed Revenue", message: `Email ${values.emailAttributedRevenue.raw} + Text message ${smsAttributedRevenue.raw} exceeds total Attributed revenue ${totalAttributedRevenue.raw}.` });
  }
  if (issues.length) return { ok: false, issues };
  return { ok: true, values: values as Record<CoverMetricKey, ParsedMoney>, totalAttributedRevenue, smsAttributedRevenue };
}

/**
 * The cover for a report: values only from this report's own accepted Executive Summary capture (same client, same
 * report month, exact period proof), in the report's configured currency. Never from another capture, never OCR.
 */
export function reportCover(report: Pick<ReportDraft, "client" | "reportMonth" | "period" | "screenshots">): CoverResult {
  const shots = report.screenshots.filter(({ type }) => type === "overview");
  const shot = shots.length === 1 ? shots[0]! : null;
  const source = (message: string): CoverResult => ({ ok: false, issues: [{ code: "COVER_SOURCE_NOT_VERIFIED", metric: null, message }] });
  if (!shot) return source(shots.length ? "More than one Executive Summary capture exists." : "The Executive Summary has not been captured.");
  if (shot.clientId !== report.client.id) return source("The Executive Summary capture belongs to another client.");
  if (shot.reportMonth.year !== report.reportMonth.year || shot.reportMonth.month !== report.reportMonth.month) return source("The Executive Summary capture belongs to another report month.");
  if (!isAcceptedCapture(shot) && shot.captureOrigin !== "live_acceptance_import") return source("The Executive Summary capture is neither approved nor a verified automatic capture.");
  const proof = shot.sourceProof;
  const exact = { startDate: report.period.startDate, endDate: report.period.endDate };
  if (!shot.periodConfirmed || !proof || !matchesReportCaptureSpec("overview", proof) || JSON.stringify(proof.observedPeriod) !== JSON.stringify(exact) || JSON.stringify(proof.expectedPeriod) !== JSON.stringify(exact)) {
    return source(`The Executive Summary capture is not verified for ${exact.startDate} – ${exact.endDate}.`);
  }
  const verified = verifyBusinessPerformance(proof.businessPerformance, report.client.currency);
  if (!verified.ok) return verified;
  const currency = report.client.currency!;
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(report.reportMonth.year, report.reportMonth.month - 1, 1)));
  const metrics = Object.fromEntries(COVER_METRICS.map(({ key, label }) => [key, { ...verified.values[key], label, formatted: formatCoverMoney(verified.values[key].amount, currency) }])) as VerifiedCover["metrics"];
  return { ok: true, cover: { currency, reportMonthLabel: monthLabel, metrics, totalAttributedRevenue: verified.totalAttributedRevenue, smsAttributedRevenue: verified.smsAttributedRevenue, period: exact, capturedAt: shot.capturedAt, screenshotId: shot.id, sha256: shot.sha256 } };
}
