import { describe, expect, it } from "vitest";
import {
  clientSummarySchema, reportMonthSchema, reportSectionKeySchema,
  sectionConfigurationSchema, sectionRequirementSchema,
} from "./index.js";

describe("shared report schemas", () => {
  it.each(["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Kolkata"])(
    "accepts IANA timezone %s", (timezone) => {
      expect(clientSummarySchema.safeParse({ id: "c1", name: "Client", timezone, currency: null }).success).toBe(true);
    },
  );
  it("rejects an invalid timezone", () => {
    expect(clientSummarySchema.safeParse({ id: "c1", name: "Client", timezone: "Mars/Base", currency: null }).success).toBe(false);
  });
  it.each([0, 13])("rejects invalid report month %s", (month) => {
    expect(reportMonthSchema.safeParse({ year: 2026, month }).success).toBe(false);
  });
  it("rejects a clearly invalid year", () => expect(reportMonthSchema.safeParse({ year: 0, month: 1 }).success).toBe(false));
  it("defines stable section requirements", () => expect(sectionRequirementSchema.options).toEqual(["required", "optional", "disabled"]));
  it("supports per-report partial section configuration", () => {
    expect(sectionConfigurationSchema.parse({ executive_summary: "required", analysis: "disabled" })).toEqual({ executive_summary: "required", analysis: "disabled" });
    expect(reportSectionKeySchema.options).toHaveLength(15);
  });
});
