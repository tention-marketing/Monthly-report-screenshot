import type { ReportDraft } from "@tention/report-schema";
import { buildReportChecklist, type ChecklistItem } from "../report-checklist/checklist.js";

export interface ReportRunnerState {
  required: ChecklistItem[];
  completed: number;
  next: ChecklistItem | null;
  isComplete: boolean;
}

/** The runner deliberately considers only required, screenshot-backed sections. */
export function getReportRunnerState(report: ReportDraft): ReportRunnerState {
  const required = buildReportChecklist(report).filter(({ requirement, screenshotType }) => requirement === "required" && screenshotType !== null);
  const completed = required.filter(({ state }) => state === "approved").length;
  return {
    required,
    completed,
    next: required.find(({ state }) => state !== "approved") ?? null,
    isComplete: completed === required.length,
  };
}
