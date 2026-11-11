import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPORT_CAPTURE_SPEC_V1 } from "@tention/report-schema";
import type { PeriodEntryApi } from "./period-entry-contract.js";

// Installed by src/test/setup.ts exactly as chrome.scripting installs it in the page.
const helper = () => (globalThis as unknown as { __tentionPeriodEntry: PeriodEntryApi }).__tentionPeriodEntry;
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("shared Klaviyo period entry helper", () => {
  it.each([
    ["Apr 01, 2026", "2026-04-01"], ["Apr 1, 2026", "2026-04-01"], ["April 30, 2026", "2026-04-30"], ["Sept 30, 2026", "2026-09-30"],
    ["04/01/2026", "2026-04-01"], ["2028-02-29", "2028-02-29"], ["Time period", null], ["", null],
  ])("reads the field value %j as %j", (value, iso) => { expect(helper().parseDisplayedDate(value)).toBe(iso); });

  it("writes a date in the format the field already shows", () => {
    const input = (value: string, placeholder = "") => Object.assign(document.createElement("input"), { value, placeholder });
    expect(helper().formatLike(input("Sep 01, 2026"), "2026-04-01")).toBe("Apr 01, 2026");
    expect(helper().formatLike(input("Sep 1, 2026"), "2026-04-01")).toBe("Apr 1, 2026");
    expect(helper().formatLike(input("", "mm/dd/yyyy"), "2026-04-01")).toBe("04/01/2026");
  });

  it("enters the end first when the new start lies after the range shown, and reports success only for exact values", async () => {
    document.body.innerHTML = `<input id="s" value="Apr 01, 2026" /><input id="e" value="Apr 30, 2026" />`;
    const fields = () => ({ start: document.getElementById("s") as HTMLInputElement, end: document.getElementById("e") as HTMLInputElement });
    const result = await helper().enterDateRange({ fields, startDate: "2026-10-01", endDate: "2026-10-31" });
    // No calendar on this page: the calendar strategy reports why, then plain fields take the dates (end first).
    expect(result).toMatchObject({ ok: true, strategy: "set-value", observed: ["Oct 01, 2026", "Oct 31, 2026"], calendar: { failure: "No calendar opened from the date-range control." },
      attempts: [expect.objectContaining({ strategy: "calendar", matched: false }), expect.objectContaining({ strategy: "set-value", order: "end-first", matched: true })] });
  });

  it("never reports success when the fields do not hold the report dates", async () => {
    document.body.innerHTML = `<input id="s" value="Sep 01, 2026" readonly /><input id="e" value="Sep 30, 2026" />`;
    const start = document.getElementById("s") as HTMLInputElement;
    start.addEventListener("input", () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(start, "Sep 01, 2026"); });
    const result = await helper().enterDateRange({ fields: () => ({ start, end: document.getElementById("e") as HTMLInputElement }), startDate: "2026-04-01", endDate: "2026-04-30" });
    expect(result.ok).toBe(false);
    expect(result.observed?.[0]).toBe("Sep 01, 2026");
    expect(result.reason).toMatch(/Apply was not clicked/);
  });

  it("is loaded before every period-setting adapter, and is self-contained so chrome.scripting can inject it as a file", () => {
    for (const service of ["dashboard-navigation-service.ts", "business-review-navigation-service.ts", "campaigns-navigation-service.ts", "subscriber-growth-navigation-service.ts"]) expect(read(`../${service}`)).toContain("await injectPeriodEntry(");
    const source = read("./period-entry.ts");
    expect(source).not.toMatch(/^\s*(?:import|export)\s/m);
  });

  it("leaves Deliverability on its approved rolling-30-day contract: no monthly dates are forced onto it", () => {
    expect(REPORT_CAPTURE_SPEC_V1.find(({ screenshotType }) => screenshotType === "deliverability")?.datePolicy).toBe("ROLLING_30_DAY");
    expect(read("../deliverability-score-navigation-service.ts")).not.toContain("injectPeriodEntry");
    expect(read("../deliverability-score-capture.ts")).not.toContain("__tentionPeriodEntry");
  });
});
