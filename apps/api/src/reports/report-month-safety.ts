import { getReportPeriod } from "@tention/report-core";
import type { ReportDraft, ReportMonth } from "@tention/report-schema";
import { driveFileName, driveMonthFolderName, googleDocName } from "../delivery/google-drive-delivery.js";

export class ReportMonthMismatchError extends Error {
  readonly code = "REPORT_MONTH_MISMATCH";
  constructor(readonly mismatches: string[]) {
    super(`The report month is inconsistent: ${mismatches.join("; ")}. Nothing was generated, uploaded or synced.`);
    this.name = "ReportMonthMismatchError";
  }
}

/** The canonical final PDF download name; its month is checked against the report like every other name. */
export function finalPdfFilename(draft: Pick<ReportDraft, "client" | "reportMonth">): string {
  const name = draft.client.name.normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Client";
  return `${name}-${driveMonthFolderName(draft.reportMonth.month)}-${draft.reportMonth.year}-Monthly-Report.pdf`;
}

/**
 * Fails closed before final generation or any Drive/Doc write unless every place the month appears agrees: the month
 * the user saw in the panel, the stored report month and periods, every screenshot, the PDF filename, the Drive
 * year/month folders and file name, and the Google Doc title.
 */
export function assertReportMonthConsistent(draft: ReportDraft, displayedMonth?: ReportMonth): void {
  const month = draft.reportMonth;
  const monthName = driveMonthFolderName(month.month);
  const label = `${monthName} ${month.year}`;
  const mismatches: string[] = [];
  if (displayedMonth && (displayedMonth.year !== month.year || displayedMonth.month !== month.month)) mismatches.push(`the panel shows ${displayedMonth.year}-${String(displayedMonth.month).padStart(2, "0")} but the report is ${label}`);
  const period = getReportPeriod(month);
  if (draft.period.startDate !== period.startDate || draft.period.endDate !== period.endDate || draft.period.previousStartDate !== period.previousStartDate || draft.period.previousEndDate !== period.previousEndDate) mismatches.push(`the stored reporting periods do not match ${label}`);
  for (const screenshot of draft.screenshots) {
    if (screenshot.reportMonth.year !== month.year || screenshot.reportMonth.month !== month.month) mismatches.push(`the ${screenshot.type} screenshot belongs to ${screenshot.reportMonth.year}-${String(screenshot.reportMonth.month).padStart(2, "0")}`);
    if (screenshot.clientId !== draft.client.id) mismatches.push(`the ${screenshot.type} screenshot belongs to another client`);
  }
  if (!finalPdfFilename(draft).endsWith(`-${monthName}-${month.year}-Monthly-Report.pdf`)) mismatches.push("the PDF filename does not name the report month");
  if (!driveFileName(draft).endsWith(` - ${label}.pdf`)) mismatches.push("the Drive PDF name does not name the report month");
  if (!googleDocName(draft).endsWith(` - ${label}`)) mismatches.push("the Google Doc title does not name the report month");
  if (monthName !== new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" }).format(new Date(`${period.startDate}T12:00:00Z`))) mismatches.push("the Drive month folder does not match the reporting period");
  if (mismatches.length) throw new ReportMonthMismatchError(mismatches);
}
