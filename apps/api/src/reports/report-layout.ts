import type { ReportSectionKey } from "@tention/report-schema";

/**
 * The PDF information architecture. This intentionally does not express
 * capture navigation or provider source identity; see REPORT_CAPTURE_SPEC_V1
 * for that separate contract.
 */
export const REPORT_LAYOUT_VERSION = "tention-monthly-v1" as const;

export type ReportLayoutPageKey =
  | "summary" | "flows_and_comparison" | "campaigns_and_flows"
  | "supporting_performance" | "campaign_metrics" | "flow_metrics_and_analysis"
  | "analysis_continuation" | "subscriber_growth";
export type ReportLayoutSlotKey =
  | "headline_metrics" | "executive_summary" | "top_campaigns" | "top_flows"
  | "month_comparison" | "campaign_performance" | "flow_performance"
  | "signup_form" | "welcome_flow" | "customer_split" | "deliverability"
  | "campaign_metrics" | "flow_metrics" | "analysis" | "next_month_plan" | "email_subscriber_growth";
export type ReportLayoutContentType = "headline_metrics" | "screenshot" | "text";
export type ReportLayoutSize = "full" | "half" | "quarter";
export type ReportLayoutPagination = "fixed" | "flow" | "flow_continuation";

export interface ReportLayoutSlot {
  key: ReportLayoutSlotKey;
  sectionKey?: ReportSectionKey;
  contentType: ReportLayoutContentType;
  title: string;
  required: boolean;
  preferredSize: ReportLayoutSize;
  pagination: ReportLayoutPagination;
}

export interface ReportLayoutPage {
  key: ReportLayoutPageKey;
  canonicalPage: number;
  title: string;
  pagination: "fixed" | "flow_continuation";
  slots: readonly ReportLayoutSlot[];
}

export interface ReportLayout {
  version: typeof REPORT_LAYOUT_VERSION;
  pages: readonly ReportLayoutPage[];
}

export const REPORT_LAYOUT_V1: ReportLayout = {
  version: REPORT_LAYOUT_VERSION,
  pages: [
    {
      key: "summary", canonicalPage: 1, title: "Summary", pagination: "fixed",
      slots: [
        { key: "headline_metrics", contentType: "headline_metrics", title: "Headline metrics", required: false, preferredSize: "full", pagination: "fixed" },
        { key: "executive_summary", sectionKey: "executive_summary", contentType: "screenshot", title: "Overview", required: true, preferredSize: "half", pagination: "fixed" },
        { key: "top_campaigns", sectionKey: "top_campaigns", contentType: "screenshot", title: "Top 5 Campaigns", required: true, preferredSize: "half", pagination: "fixed" },
      ],
    },
    {
      key: "flows_and_comparison", canonicalPage: 2, title: "Top Flows and Comparison to Previous Month", pagination: "fixed",
      slots: [
        { key: "top_flows", sectionKey: "top_flows", contentType: "screenshot", title: "Top Flows", required: true, preferredSize: "half", pagination: "fixed" },
        { key: "month_comparison", sectionKey: "month_comparison", contentType: "screenshot", title: "Comparison to Previous Month", required: true, preferredSize: "half", pagination: "fixed" },
      ],
    },
    {
      key: "campaigns_and_flows", canonicalPage: 3, title: "Campaigns and Flows", pagination: "fixed",
      slots: [
        { key: "campaign_performance", sectionKey: "campaign_performance", contentType: "screenshot", title: "Campaigns", required: false, preferredSize: "half", pagination: "fixed" },
        { key: "flow_performance", sectionKey: "flow_performance", contentType: "screenshot", title: "Flows", required: false, preferredSize: "half", pagination: "fixed" },
      ],
    },
    {
      key: "supporting_performance", canonicalPage: 4, title: "Supporting Performance", pagination: "fixed",
      slots: [
        { key: "signup_form", sectionKey: "signup_form", contentType: "screenshot", title: "Sign Up Form Performance", required: false, preferredSize: "quarter", pagination: "fixed" },
        { key: "welcome_flow", sectionKey: "welcome_flow", contentType: "screenshot", title: "Welcome Flow Performance", required: false, preferredSize: "quarter", pagination: "fixed" },
        { key: "customer_split", sectionKey: "customer_split", contentType: "screenshot", title: "Customers vs Non Customers", required: false, preferredSize: "quarter", pagination: "fixed" },
        { key: "deliverability", sectionKey: "deliverability", contentType: "screenshot", title: "Deliverability Score", required: true, preferredSize: "quarter", pagination: "fixed" },
      ],
    },
    {
      key: "campaign_metrics", canonicalPage: 5, title: "Metric Performance - Campaigns", pagination: "fixed",
      slots: [
        { key: "campaign_metrics", sectionKey: "campaign_metrics", contentType: "screenshot", title: "Metric Performance - Campaigns", required: true, preferredSize: "full", pagination: "fixed" },
      ],
    },
    {
      key: "flow_metrics_and_analysis", canonicalPage: 6, title: "Metric Performance - Flows", pagination: "fixed",
      slots: [
        { key: "flow_metrics", sectionKey: "flow_metrics", contentType: "screenshot", title: "Metric Performance - Flows", required: true, preferredSize: "full", pagination: "fixed" },
        { key: "analysis", sectionKey: "analysis", contentType: "text", title: "Analysis", required: false, preferredSize: "full", pagination: "flow" },
      ],
    },
    {
      key: "analysis_continuation", canonicalPage: 7, title: "Analysis", pagination: "flow_continuation",
      slots: [
        { key: "analysis", sectionKey: "analysis", contentType: "text", title: "Analysis", required: false, preferredSize: "full", pagination: "flow_continuation" },
      ],
    },
    // Section 10, appended so pages 1–7 keep their numbers; rendered only for a report that includes Subscriber Growth.
    {
      key: "subscriber_growth", canonicalPage: 8, title: "Subscriber Growth", pagination: "fixed",
      slots: [
        { key: "email_subscriber_growth", sectionKey: "email_subscriber_growth", contentType: "screenshot", title: "Subscriber Growth - Email", required: true, preferredSize: "full", pagination: "fixed" },
      ],
    },
  ],
};

export const reportLayoutPageByKey: Readonly<Record<ReportLayoutPageKey, ReportLayoutPage>> = Object.fromEntries(
  REPORT_LAYOUT_V1.pages.map((page) => [page.key, page]),
) as Record<ReportLayoutPageKey, ReportLayoutPage>;
