import type { SectionConfiguration } from "@tention/report-schema";

export const DEFAULT_DRAFT_SECTION_CONFIGURATION: Readonly<SectionConfiguration> = {
  executive_summary: "required",
  top_campaigns: "required",
  top_flows: "required",
  month_comparison: "required",
  campaign_performance: "required",
  flow_performance: "required",
  signup_form: "optional",
  welcome_flow: "optional",
  customer_split: "optional",
  deliverability: "required",
  campaign_metrics: "required",
  flow_metrics: "required",
  analysis: "optional",
  next_month_plan: "optional",
  // Section 10. New drafts include it; drafts created before it keep their nine sections until it is enabled explicitly.
  email_subscriber_growth: "required",
};
