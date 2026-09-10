import { describe, expect, it } from "vitest";
import { getCompletedMonthOptions, normalizeSelectedMonth, toMonthValue } from "./month-options.js";

describe("completed month options", () => {
  it("defaults September 9 in New York to August", () => {
    expect(getCompletedMonthOptions(new Date("2026-09-09T12:00:00Z"), "America/New_York")[0]?.value).toBe("2026-08");
  });
  it("handles the September 1 boundary in Kolkata", () => {
    expect(getCompletedMonthOptions(new Date("2026-08-31T20:00:00Z"), "Asia/Kolkata")[0]?.value).toBe("2026-08");
  });
  it("crosses January into the previous year", () => {
    expect(getCompletedMonthOptions(new Date("2027-01-01T12:00:00Z"), "Asia/Kolkata")[0]?.value).toBe("2026-12");
  });
  it("returns 24 descending completed months without current or future months", () => {
    const options = getCompletedMonthOptions(new Date("2026-09-09T12:00:00Z"), "America/New_York", 24);
    expect(options).toHaveLength(24);
    expect(options[0]?.value).toBe("2026-08");
    expect(options.at(-1)?.value).toBe("2024-09");
    expect(options.map(({ value }) => value)).not.toContain("2026-09");
  });
  it("replaces a selection that becomes incomplete after a timezone change", () => {
    const instant = new Date("2026-08-31T20:00:00Z");
    const india = getCompletedMonthOptions(instant, "Asia/Kolkata");
    const newYork = getCompletedMonthOptions(instant, "America/New_York");
    expect(toMonthValue(normalizeSelectedMonth({ year: 2026, month: 8 }, india)!)).toBe("2026-08");
    expect(toMonthValue(normalizeSelectedMonth({ year: 2026, month: 8 }, newYork)!)).toBe("2026-07");
  });
});
