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
  sourceUrl: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  approved: z.boolean(),
  storageLocation: z.string().min(1).nullable(),
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

export const reportLifecycleEventTypeSchema = z.enum([
  "REPORT_CREATED", "START_DATA_FETCH", "DATA_FETCH_SUCCEEDED", "DATA_FETCH_FAILED",
  "MARK_CAPTURES_INCOMPLETE", "SUBMIT_FOR_REVIEW", "APPROVE", "START_GENERATION",
  "GENERATION_SUCCEEDED", "GENERATION_FAILED", "RESET_TO_DRAFT",
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
