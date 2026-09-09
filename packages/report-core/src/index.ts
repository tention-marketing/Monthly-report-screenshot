import { reportMonthSchema, type ReportMonth, type ReportPeriod } from "@tention/report-schema";

function validated(month: ReportMonth): ReportMonth {
  return reportMonthSchema.parse(month);
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function getMonthStart(month: ReportMonth): string {
  const value = validated(month);
  return formatDate(value.year, value.month, 1);
}

export function getMonthEnd(month: ReportMonth): string {
  const value = validated(month);
  const lastDay = new Date(Date.UTC(value.year, value.month, 0)).getUTCDate();
  return formatDate(value.year, value.month, lastDay);
}

export function getPreviousMonth(month: ReportMonth): ReportMonth {
  const value = validated(month);
  return value.month === 1
    ? { year: value.year - 1, month: 12 }
    : { year: value.year, month: value.month - 1 };
}

export function getReportPeriod(month: ReportMonth): ReportPeriod {
  const value = validated(month);
  const previous = getPreviousMonth(value);
  return {
    month: value,
    startDate: getMonthStart(value),
    endDate: getMonthEnd(value),
    previousStartDate: getMonthStart(previous),
    previousEndDate: getMonthEnd(previous),
  };
}

export function getMostRecentlyCompletedMonth(today: string): ReportMonth {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!match) throw new Error("today must use YYYY-MM-DD format");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error("today must be a valid calendar date");
  }
  return getPreviousMonth({ year, month });
}

export function isCompletedMonth(month: ReportMonth, today: string): boolean {
  const value = validated(month);
  const latest = getMostRecentlyCompletedMonth(today);
  return value.year < latest.year || (value.year === latest.year && value.month <= latest.month);
}
