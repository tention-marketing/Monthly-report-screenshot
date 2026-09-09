import { isValidIanaTimeZone, reportMonthSchema, type ReportMonth, type ReportPeriod } from "@tention/report-schema";

export const TOP_CAMPAIGN_COUNT = 3;
export const TOP_FLOW_COUNT = 5;

export interface CalendarDate { year: number; month: number; day: number }

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
    startDate: getMonthStart(value),
    endDate: getMonthEnd(value),
    previousStartDate: getMonthStart(previous),
    previousEndDate: getMonthEnd(previous),
  };
}

export function getCalendarDateInTimeZone(instant: Date, timeZone: string): CalendarDate {
  if (Number.isNaN(instant.getTime())) throw new Error("instant must be a valid Date");
  if (!isValidIanaTimeZone(timeZone)) throw new Error("timeZone must be a valid IANA timezone");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

export function isCompletedMonthAtInstant(month: ReportMonth, instant: Date, timeZone: string): boolean {
  const local = getCalendarDateInTimeZone(instant, timeZone);
  return isCompletedMonth(month, formatDate(local.year, local.month, local.day));
}

export interface SelectTopItemsOptions<T> {
  items: readonly T[];
  score: (item: T) => number;
  stableId: (item: T) => string;
  limit: number;
}

export function selectTopItems<T>(options: SelectTopItemsOptions<T>): T[] {
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  const scored = options.items.map((item) => {
    const score = options.score(item);
    const stableId = options.stableId(item);
    if (!Number.isFinite(score)) throw new Error(`score for ${stableId} must be finite`);
    return { item, score, stableId };
  });
  return scored
    .sort((left, right) => right.score - left.score || left.stableId.localeCompare(right.stableId))
    .slice(0, options.limit)
    .map(({ item }) => item);
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
