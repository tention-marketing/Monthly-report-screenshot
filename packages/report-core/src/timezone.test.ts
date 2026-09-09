import { describe, expect, it } from "vitest";
import { getCalendarDateInTimeZone, isCompletedMonthAtInstant } from "./index.js";

describe("timezone-local completion", () => {
  it("evaluates the same instant using each client's local calendar date", () => {
    const instant = new Date("2026-08-31T20:00:00Z");
    expect(getCalendarDateInTimeZone(instant, "Asia/Kolkata")).toEqual({ year: 2026, month: 9, day: 1 });
    expect(getCalendarDateInTimeZone(instant, "America/New_York")).toEqual({ year: 2026, month: 8, day: 31 });
    expect(isCompletedMonthAtInstant({ year: 2026, month: 8 }, instant, "Asia/Kolkata")).toBe(true);
    expect(isCompletedMonthAtInstant({ year: 2026, month: 8 }, instant, "America/New_York")).toBe(false);
  });

  it("rejects an invalid timezone", () => {
    expect(() => getCalendarDateInTimeZone(new Date("2026-08-31T20:00:00Z"), "Mars/Olympus_Mons")).toThrow();
  });
});
