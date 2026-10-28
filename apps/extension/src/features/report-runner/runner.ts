import type { ReportDraft } from "@tention/report-schema";
import { buildReportChecklist, type ChecklistItem } from "../report-checklist/checklist.js";

/** Capture Klaviyo Home evidence first (Executive Summary, Top 5 Flows), then reuse that toolbar-authorized tab for Business Review. */
const runnerSectionOrder = [
  "executive_summary", "top_flows", "top_campaigns", "month_comparison",
  "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability",
] as const;
const automaticCaptureTypes = new Set([
  "overview", "top_campaigns", "top_flows", "month_comparison",
  "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability",
]);

export interface ReportRunnerState {
  required: ChecklistItem[];
  completed: number;
  next: ChecklistItem | null;
  isComplete: boolean;
}

/** The runner deliberately considers only required, screenshot-backed sections. */
export function getReportRunnerState(report: ReportDraft): ReportRunnerState {
  const required = buildReportChecklist(report)
    .filter(({ requirement, screenshotType }) => requirement === "required" && screenshotType !== null)
    .sort((left, right) => runnerIndex(left.section) - runnerIndex(right.section));
  const completed = required.filter(({ state }) => state === "approved").length;
  return {
    required,
    completed,
    next: required.find(({ state }) => state !== "approved") ?? null,
    isComplete: completed === required.length,
  };
}

/** Fresh automatic runs intentionally recapture every supported automatic slot,
 * independently of approval state and of unrelated required manual targets. */
export function getAutomaticCapturePlan(report: ReportDraft): ChecklistItem[] {
  return buildReportChecklist(report)
    .filter(({ screenshotType }) => screenshotType !== null && automaticCaptureTypes.has(screenshotType))
    .sort((left, right) => runnerIndex(left.section) - runnerIndex(right.section));
}

function runnerIndex(section: ChecklistItem["section"]): number {
  const index = runnerSectionOrder.indexOf(section as typeof runnerSectionOrder[number]);
  return index === -1 ? runnerSectionOrder.length + 1 : index;
}
