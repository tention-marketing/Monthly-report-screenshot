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

export const clientSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1).refine(isValidIanaTimeZone, "Expected a valid IANA timezone"),
  currency: z.string().length(3).nullable(),
});
export type ClientSummary = z.infer<typeof clientSummarySchema>;

export const reportStatusSchema = z.enum([
  "draft", "data_fetching", "data_ready", "captures_incomplete",
  "ready_for_review", "approved", "generating", "generated", "failed",
]);
export type ReportStatus = z.infer<typeof reportStatusSchema>;

export const screenshotTypeSchema = z.enum([
  "overview", "top_campaigns", "top_flows", "month_comparison",
  "campaign_performance", "flow_performance", "signup_form", "welcome_flow",
  "customer_split", "deliverability", "campaign_metrics", "flow_metrics", "list_growth",
]);
export type ScreenshotType = z.infer<typeof screenshotTypeSchema>;

export const reportCaptureSectionKeySchema = z.enum([
  "executive_summary", "month_comparison", "top_campaigns", "top_flows", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "signup_form_performance", "welcome_flow_performance", "customer_split", "deliverability", "list_growth",
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
});
export type ScreenshotSourceProof = z.infer<typeof screenshotSourceProofSchema>;

export const captureNavigationModeSchema = z.enum(["direct_configured_url", "shared_dashboard_semantic_tab", "configured_entity"]);
export type CaptureNavigationMode = z.infer<typeof captureNavigationModeSchema>;
export const captureAutomationStatusSchema = z.enum(["auto", "manual_required", "manual_by_design", "deferred"]);
export type CaptureAutomationStatus = z.infer<typeof captureAutomationStatusSchema>;
export const clientSourceUrlKeySchema = z.enum(["overviewUrl", "campaignsUrl", "topFlowsUrl", "businessReviewUrl", "signupFormsUrl", "flowsUrl", "segmentsUrl", "deliverabilityUrl", "listGrowthUrl"]);
export type ClientSourceUrlKey = z.infer<typeof clientSourceUrlKeySchema>;

export interface ReportCaptureSpec { key: ReportCaptureSectionKey; screenshotType: ScreenshotType; title: string; sourceFamily: string; semanticCard: string; semanticTab: string; datePolicy: CaptureDatePolicy; sourceIdentity: string; defaultRequirement: "required" | "optional"; navigationMode: CaptureNavigationMode; automationStatus: CaptureAutomationStatus; sourceUrlKey?: ClientSourceUrlKey; }
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
] as const;
/** Legacy-only parsing contract. It deliberately is not in the current product specification. */
const LEGACY_LIST_GROWTH_CAPTURE_SPEC: ReportCaptureSpec = {
  key: "list_growth", screenshotType: "list_growth", title: "List Growth", sourceFamily: "list", semanticCard: "configured-primary-list", semanticTab: "growth", datePolicy: "EXACT_MONTH", sourceIdentity: "list|configured-primary-list|growth", defaultRequirement: "optional", navigationMode: "configured_entity", automationStatus: "deferred", sourceUrlKey: "listGrowthUrl",
};
export const reportCaptureSpecByScreenshotType: Readonly<Record<ScreenshotType, ReportCaptureSpec>> = {
  ...Object.fromEntries(REPORT_CAPTURE_SPEC_V1.map((spec) => [spec.screenshotType, spec])),
  list_growth: LEGACY_LIST_GROWTH_CAPTURE_SPEC,
} as Record<ScreenshotType, ReportCaptureSpec>;
export function createScreenshotSourceProof(type: ScreenshotType, period: ReportPeriod, listing?: { scope: "all_forms" | "email_welcome_flows"; entities?: Array<{ id: string; name: string; channel: "email" }> }, campaigns: ScreenshotSourceProof["campaigns"] = null): ScreenshotSourceProof {
  const spec = reportCaptureSpecByScreenshotType[type];
  const expectedPeriod = spec.datePolicy === "EXACT_MONTH" ? { startDate: period.startDate, endDate: period.endDate }
    : spec.datePolicy === "PREVIOUS_MONTH_COMPARISON" ? { startDate: period.startDate, endDate: period.endDate, comparisonStartDate: period.previousStartDate, comparisonEndDate: period.previousEndDate } : null;
  return { captureSpecVersion: REPORT_CAPTURE_SPEC_VERSION, sectionKey: spec.key, sourceFamily: spec.sourceFamily, semanticCard: spec.semanticCard, semanticTab: spec.semanticTab, sourceIdentity: spec.sourceIdentity, datePolicy: spec.datePolicy, expectedPeriod, observedPeriod: expectedPeriod, configuredEntityId: null, configuredEntityName: null, listingScope: listing?.scope ?? null, configuredEntities: listing?.entities ?? [], semanticEvidence: type === "deliverability" ? ["deliverability-score", "based-on-last-30-days", "score-gauge", "rate-table"] : [], campaigns: type === "top_campaigns" ? campaigns : null };
}
export function matchesReportCaptureSpec(type: ScreenshotType, proof: ScreenshotSourceProof | null | undefined): boolean {
  const spec = reportCaptureSpecByScreenshotType[type];
  const listingMatches = type === "signup_form" ? proof?.listingScope === "all_forms" && proof.configuredEntities.length === 0
    : type === "welcome_flow" ? proof?.listingScope === "email_welcome_flows" && proof.configuredEntities.length === 2 && new Set(proof.configuredEntities.map(({ id }) => id)).size === 2
      : true;
  const deliverabilityEvidence = ["deliverability-score", "based-on-last-30-days", "score-gauge", "rate-table"] as const;
  const deliverabilityEvidenceMatches = type !== "deliverability" || deliverabilityEvidence.every((item) => proof?.semanticEvidence.includes(item));
  return Boolean(proof && listingMatches && deliverabilityEvidenceMatches && proof.captureSpecVersion === REPORT_CAPTURE_SPEC_VERSION && proof.sectionKey === spec.key && proof.sourceIdentity === spec.sourceIdentity && proof.sourceFamily === spec.sourceFamily && proof.semanticCard === spec.semanticCard && proof.semanticTab === spec.semanticTab && proof.datePolicy === spec.datePolicy);
}

export const reportSectionKeySchema = z.enum([
  "executive_summary", "top_campaigns", "top_flows", "month_comparison",
  "campaign_performance", "flow_performance", "signup_form", "welcome_flow",
  "customer_split", "deliverability", "campaign_metrics", "flow_metrics", "list_growth",
  "analysis", "next_month_plan",
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
}).strict().superRefine((value, context) => {
  if (Object.values(value).every((url) => !url)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Provide at least one source URL." });
});
export type ClientSourceUrls = z.infer<typeof clientSourceUrlsSchema>;

/**
 * One-time canonical client configuration. Every monthly report copies its
 * name, timezone, and currency from here; nothing is re-entered per report.
 * The verified Klaviyo account identity lives on `businessReview`.
 */
export const clientProfileSchema = z.object({
  name: z.string().trim().min(1),
  timezone: z.string().min(1).refine(isValidIanaTimeZone, "Expected a valid IANA timezone"),
  currency: z.string().length(3).nullable().default(null),
  conversionMetric: z.object({
    label: z.string().trim().min(1).default("Placed Order"),
    providerMetricId: z.string().trim().min(1).nullable().default(null),
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
};

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
});
export type ScreenshotRecord = z.infer<typeof screenshotRecordSchema>;

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

export const reportPdfArtifactSchema = z.object({
  id: z.string().uuid(), reportId: z.string().uuid(), storageKey: z.string().min(1),
  mimeType: z.literal("application/pdf"), byteSize: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest"),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest"),
  templateVersion: z.string().min(1), generatedAt: z.string().datetime({ offset: true }),
});
export type ReportPdfArtifact = z.infer<typeof reportPdfArtifactSchema>;

export const reportGenerationResultSchema = z.object({ report: reportDraftSchema, artifact: reportPdfArtifactSchema });
export type ReportGenerationResult = z.infer<typeof reportGenerationResultSchema>;

export const reportLifecycleEventTypeSchema = z.enum([
  "REPORT_CREATED", "START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "DATA_FETCH_FAILED",
  "MARK_CAPTURES_INCOMPLETE", "SUBMIT_FOR_REVIEW", "APPROVE", "START_GENERATION",
  "GENERATION_SUCCEEDED", "GENERATION_FAILED", "RESET_TO_DRAFT",
  "MIGRATE_LEGACY_GENERATED_CAPTURE_REVIEW",
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
