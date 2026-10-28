export interface CalendarDateRange {
  startDate: string;
  endDate: string;
}

function displayDate(isoDate: string, day: "numeric" | "2-digit"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day, year: "numeric" }).format(new Date(`${isoDate}T00:00:00.000Z`));
}

export function formatRenderedRange(period: CalendarDateRange): string {
  return `${displayDate(period.startDate, "numeric")} - ${displayDate(period.endDate, "numeric")}`;
}

export function renderedRangesAreExact(lines: readonly string[], current: CalendarDateRange, previous?: CalendarDateRange): boolean {
  const expectedCurrent = formatRenderedRange(current);
  const expectedPrevious = previous ? formatRenderedRange(previous) : null;
  return lines.some((line) => {
    const normalized = line.replace(/\s+/g, " ").trim();
    return normalized.includes(expectedCurrent) && (!expectedPrevious || normalized.includes(expectedPrevious));
  });
}
