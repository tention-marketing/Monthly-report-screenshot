import {
  getCalendarDateInTimeZone, getPreviousMonth, getReportPeriod, isCompletedMonthAtInstant,
} from "@tention/report-core";
import type { ReportMonth, ReportPeriod } from "@tention/report-schema";

export interface MonthOption { month: ReportMonth; value: string; label: string; period: ReportPeriod }

export function getCompletedMonthOptions(now: Date, timeZone: string, count = 24): MonthOption[] {
  if (!Number.isInteger(count) || count <= 0) throw new Error("count must be a positive integer");
  const localDate = getCalendarDateInTimeZone(now, timeZone);
  let month = getPreviousMonth({ year: localDate.year, month: localDate.month });
  const options: MonthOption[] = [];
  for (let index = 0; index < count; index += 1) {
    options.push({ month, value: toMonthValue(month), label: formatReportMonth(month), period: getReportPeriod(month) });
    month = getPreviousMonth(month);
  }
  return options;
}

export function normalizeSelectedMonth(selected: ReportMonth | null, options: readonly MonthOption[]): ReportMonth | null {
  if (options.length === 0) return null;
  if (selected && options.some(({ month }) => sameMonth(month, selected))) return selected;
  return options[0]?.month ?? null;
}

export function isMonthCompletedForTimeZone(month: ReportMonth, now: Date, timeZone: string): boolean {
  return isCompletedMonthAtInstant(month, now, timeZone);
}

export function toMonthValue(month: ReportMonth): string {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

export function parseMonthValue(value: string): ReportMonth {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Expected YYYY-MM month value");
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function formatReportMonth(month: ReportMonth): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(Date.UTC(month.year, month.month - 1, 1)));
}

export function formatCalendarRange(startDate: string, endDate: string, includeYear = true): string {
  const start = calendarParts(startDate);
  const end = calendarParts(endDate);
  const formatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: includeYear ? "numeric" : undefined, timeZone: "UTC" });
  return `${formatter.format(start)} – ${formatter.format(end)}`;
}

function calendarParts(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day));
}
function sameMonth(left: ReportMonth, right: ReportMonth): boolean { return left.year === right.year && left.month === right.month; }
