import { describe, expect, it } from "vitest";
import { formatRenderedRange, renderedRangesAreExact } from "./period-evidence.js";

describe("rendered calendar period evidence", () => {
  it("formats leap-year February using exact calendar dates", () => {
    expect(formatRenderedRange({ startDate: "2024-02-01", endDate: "2024-02-29" })).toBe("Feb 1, 2024 - Feb 29, 2024");
  });

  it("requires exact current and immediately previous ranges on one rendered line", () => {
    const current = { startDate: "2026-08-01", endDate: "2026-08-31" };
    const previous = { startDate: "2026-07-01", endDate: "2026-07-31" };
    expect(renderedRangesAreExact(["Aug 1, 2026 - Aug 31, 2026 compared to Jul 1, 2026 - Jul 31, 2026"], current, previous)).toBe(true);
    expect(renderedRangesAreExact(["Aug 1, 2026 - Aug 31, 2026 compared to previous period"], current, previous)).toBe(false);
    expect(renderedRangesAreExact(["Aug 1, 2026 - Aug 31, 2026", "Jul 1, 2026 - Jul 31, 2026"], current, previous)).toBe(false);
    expect(renderedRangesAreExact(["Aug 1, 2026 - Aug 31, 2026 compared to Jun 1, 2026 - Jun 30, 2026"], current, previous)).toBe(false);
  });
});
