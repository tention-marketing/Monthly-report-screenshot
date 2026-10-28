import { describe, expect, it } from "vitest";
import {
  getMonthEnd, getMonthStart, getMostRecentlyCompletedMonth,
  getPreviousMonth, getReportPeriod, isCompletedMonth,
} from "./index.js";

describe("calendar month boundaries", () => {
  it.each([
    [{ year: 2026, month: 7 }, "2026-07-01", "2026-07-31"],
    [{ year: 2026, month: 8 }, "2026-08-01", "2026-08-31"],
    [{ year: 2026, month: 9 }, "2026-09-01", "2026-09-30"],
    [{ year: 2026, month: 2 }, "2026-02-01", "2026-02-28"],
    [{ year: 2028, month: 2 }, "2028-02-01", "2028-02-29"],
  ] as const)("resolves %o", (month, start, end) => {
    expect(getMonthStart(month)).toBe(start);
    expect(getMonthEnd(month)).toBe(end);
  });

  it.each([
    [{ year: 2026, month: 8 }, ["2026-08-01", "2026-08-31", "2026-07-01", "2026-07-31"]],
    [{ year: 2026, month: 9 }, ["2026-09-01", "2026-09-30", "2026-08-01", "2026-08-31"]],
    [{ year: 2026, month: 10 }, ["2026-10-01", "2026-10-31", "2026-09-01", "2026-09-30"]],
    [{ year: 2026, month: 2 }, ["2026-02-01", "2026-02-28", "2026-01-01", "2026-01-31"]],
    [{ year: 2028, month: 2 }, ["2028-02-01", "2028-02-29", "2028-01-01", "2028-01-31"]],
    [{ year: 2028, month: 3 }, ["2028-03-01", "2028-03-31", "2028-02-01", "2028-02-29"]],
    [{ year: 2027, month: 1 }, ["2027-01-01", "2027-01-31", "2026-12-01", "2026-12-31"]],
    [{ year: 2026, month: 12 }, ["2026-12-01", "2026-12-31", "2026-11-01", "2026-11-30"]],
  ] as const)("derives the full period and previous month for %o from year and month alone", (month, [startDate, endDate, previousStartDate, previousEndDate]) => {
    expect(getReportPeriod(month)).toEqual({ startDate, endDate, previousStartDate, previousEndDate });
  });

  it("builds current and previous boundaries", () => {
    expect(getReportPeriod({ year: 2026, month: 8 })).toEqual({
      startDate: "2026-08-01", endDate: "2026-08-31",
      previousStartDate: "2026-07-01", previousEndDate: "2026-07-31",
    });
  });
});

describe("previous and completed months", () => {
  it("crosses a year boundary", () => expect(getPreviousMonth({ year: 2026, month: 1 })).toEqual({ year: 2025, month: 12 }));
  it("handles leap-year February", () => expect(getPreviousMonth({ year: 2028, month: 3 })).toEqual({ year: 2028, month: 2 }));
  it.each([
    ["2026-09-09", { year: 2026, month: 8 }],
    ["2026-09-01", { year: 2026, month: 8 }],
    ["2027-01-01", { year: 2026, month: 12 }],
  ] as const)("finds the latest completed month on %s", (today, expected) => {
    expect(getMostRecentlyCompletedMonth(today)).toEqual(expected);
  });
  it("rejects current and future months", () => {
    expect(isCompletedMonth({ year: 2026, month: 8 }, "2026-09-09")).toBe(true);
    expect(isCompletedMonth({ year: 2026, month: 9 }, "2026-09-09")).toBe(false);
    expect(isCompletedMonth({ year: 2026, month: 10 }, "2026-09-09")).toBe(false);
  });
  it.each([0, 13])("rejects invalid month %s", (month) => expect(() => getMonthStart({ year: 2026, month })).toThrow());
  it("rejects a clearly invalid year", () => expect(() => getMonthStart({ year: 0, month: 1 })).toThrow());
  it("rejects invalid today values", () => expect(() => getMostRecentlyCompletedMonth("2026-02-30")).toThrow());
});
