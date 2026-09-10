import {
  reportSectionKeySchema, screenshotSectionMapping,
  type ReportDraft, type ReportSectionKey, type ScreenshotType, type SectionRequirement,
} from "@tention/report-schema";

export interface ChecklistItem {
  section: ReportSectionKey;
  label: string;
  requirement: SectionRequirement;
  screenshotType: ScreenshotType | null;
  state: "missing" | "unapproved" | "approved" | "not_required" | "disabled";
}

const labels: Record<ReportSectionKey, string> = {
  executive_summary: "Executive Summary", top_campaigns: "Top Campaigns", top_flows: "Top 5 Flows",
  month_comparison: "Month Comparison", campaign_performance: "Campaign Performance",
  flow_performance: "Flow Performance", signup_form: "Signup Form", welcome_flow: "Welcome Flow",
  customer_split: "Customer Split", deliverability: "Deliverability", campaign_metrics: "Campaign Metrics",
  flow_metrics: "Flow Metrics", list_growth: "List Growth", analysis: "Analysis", next_month_plan: "Next Month Plan",
};
const screenshotBySection = Object.fromEntries(
  Object.entries(screenshotSectionMapping).map(([type, section]) => [section, type]),
) as Partial<Record<ReportSectionKey, ScreenshotType>>;

export function buildReportChecklist(report: ReportDraft): ChecklistItem[] {
  return reportSectionKeySchema.options
    .filter((section) => report.sections[section] !== undefined)
    .map((section) => {
      const requirement = report.sections[section]!;
      const screenshotType = screenshotBySection[section] ?? null;
      if (requirement === "disabled") return { section, label: labels[section], requirement, screenshotType, state: "disabled" };
      if (!screenshotType) return { section, label: labels[section], requirement, screenshotType, state: "not_required" };
      const screenshot = report.screenshots.find(({ type }) => type === screenshotType);
      const state = !screenshot ? "missing" : screenshot.approved ? "approved" : "unapproved";
      return { section, label: labels[section], requirement, screenshotType, state };
    });
}

export function summarizeChecklist(items: readonly ChecklistItem[]) {
  const required = items.filter(({ requirement, screenshotType }) => requirement === "required" && screenshotType !== null);
  return { requiredTotal: required.length, requiredComplete: required.filter(({ state }) => state === "approved").length };
}
