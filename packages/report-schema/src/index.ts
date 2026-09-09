import { z } from "zod";

export const reportMonthSchema = z.object({
  year: z.number().int().min(2000).max(9999),
  month: z.number().int().min(1).max(12),
});
export type ReportMonth = z.infer<typeof reportMonthSchema>;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const previousReportPeriodSchema = z.object({
  month: reportMonthSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
});
export type PreviousReportPeriod = z.infer<typeof previousReportPeriodSchema>;

export const reportPeriodSchema = z.object({
  month: reportMonthSchema,
  startDate: isoDateSchema,
  endDate: isoDateSchema,
  previousStartDate: isoDateSchema,
  previousEndDate: isoDateSchema,
});
export type ReportPeriod = z.infer<typeof reportPeriodSchema>;

export const clientSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1).nullable(),
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
  message: z.string().min(1),
  field: z.string().min(1).nullable(),
});
export type ReportValidationIssue = z.infer<typeof reportValidationIssueSchema>;

export const reportValidationStateSchema = z.object({
  status: z.enum(["pending", "valid", "invalid"]),
  errors: z.array(reportValidationIssueSchema),
  warnings: z.array(reportValidationIssueSchema),
});
export type ReportValidationState = z.infer<typeof reportValidationStateSchema>;

export const reportDraftSchema = z.object({
  id: z.string().min(1),
  client: clientSummarySchema,
  period: reportPeriodSchema,
  status: reportStatusSchema,
  screenshots: z.array(screenshotRecordSchema),
  validation: reportValidationStateSchema,
});
export type ReportDraft = z.infer<typeof reportDraftSchema>;
