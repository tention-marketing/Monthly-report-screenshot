import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCampaignPeriodText, visibleCampaignPeriodText } from "./campaigns-capture.js";

/** The verifier before this fix, kept verbatim to prove the live chip text defeated it. */
function legacyVisibleCampaignPeriodText(values: readonly string[], period: { startDate: string; endDate: string }): boolean {
  const format = (iso: string, options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(new Date(`${iso}T00:00:00.000Z`)).toLocaleLowerCase();
  const normalized = values.join(" ").replace(/\s+/g, " ").toLocaleLowerCase();
  const both = (start: string, end: string) => normalized.includes(start) && normalized.includes(end);
  const withYear = { month: "short", day: "numeric", year: "numeric" } as const;
  const numeric = { month: "2-digit", day: "2-digit", year: "numeric" } as const;
  return both(format(period.startDate, withYear), format(period.endDate, withYear))
    || both(format(period.startDate, numeric), format(period.endDate, numeric))
    || new RegExp(`${format(period.startDate, { month: "short", day: "numeric" })}\\s*[–-]\\s*${format(period.endDate, withYear)}`).test(normalized);
}

const august = { startDate: "2026-08-01", endDate: "2026-08-31" };

describe("Campaigns date filter period parsing", () => {
  it("parses Klaviyo's live compact chip text, which the previous verifier rejected", () => {
    expect(legacyVisibleCampaignPeriodText(["August 1 – 31, 2026"], august)).toBe(false);
    expect(parseCampaignPeriodText("August 1 – 31, 2026")).toEqual(august);
    expect(visibleCampaignPeriodText(["August 1 – 31, 2026"], august)).toBe(true);
  });

  it.each([
    ["September 1 – 30, 2026", "2026-09-01", "2026-09-30"],
    ["December 1 – 31, 2026", "2026-12-01", "2026-12-31"],
    ["January 1 – 31, 2027", "2027-01-01", "2027-01-31"],
    ["February 1 – 28, 2027", "2027-02-01", "2027-02-28"],
    ["February 1 – 29, 2028", "2028-02-01", "2028-02-29"],
    ["Aug 1, 2026 – Aug 31, 2026", "2026-08-01", "2026-08-31"],
    ["August 1, 2026 - August 31, 2026", "2026-08-01", "2026-08-31"],
    ["Aug 1 – Aug 31, 2026", "2026-08-01", "2026-08-31"],
    ["August 1 - 31, 2026", "2026-08-01", "2026-08-31"],
    ["Sept. 1 — 30, 2026", "2026-09-01", "2026-09-30"],
    ["08/01/2026 – 08/31/2026", "2026-08-01", "2026-08-31"],
    ["2026-08-01 to 2026-08-31", "2026-08-01", "2026-08-31"],
    ["Dec 1, 2026 – Jan 31, 2027", "2026-12-01", "2027-01-31"],
  ])("%s → %s … %s", (shown, startDate, endDate) => {
    expect(parseCampaignPeriodText(shown)).toEqual({ startDate, endDate });
    expect(visibleCampaignPeriodText([shown], { startDate, endDate })).toBe(true);
  });

  it.each([
    ["August 1 – 30, 2026", { startDate: "2026-08-01", endDate: "2026-08-30" }],
    ["August 2 – 31, 2026", { startDate: "2026-08-02", endDate: "2026-08-31" }],
    ["July 1 – 31, 2026", { startDate: "2026-07-01", endDate: "2026-07-31" }],
    ["August 1 – 31, 2025", { startDate: "2025-08-01", endDate: "2025-08-31" }],
  ])("a different range (%s) fails an August 1–31, 2026 report", (shown, parsed) => {
    expect(parseCampaignPeriodText(shown)).toEqual(parsed);
    expect(visibleCampaignPeriodText([shown], august)).toBe(false);
  });

  it.each(["Last 30 days", "This month", "Review performance See what drove results in the last 30 days.", "Aug 1, 2026", "February 1 – 30, 2026", "August 31 – 1, 2026", "August 1 – 310, 2026", "", null])("is not a proven range: %s", (shown) => {
    expect(parseCampaignPeriodText(shown)).toBeNull();
    expect(visibleCampaignPeriodText([shown ?? ""], august)).toBe(false);
  });

  it("never pieces a range together from separate dates (such as campaign send dates)", () => {
    expect(visibleCampaignPeriodText(["Sent Aug 1, 2026 9:00 AM", "Sent Aug 31, 2026 4:00 PM"], august)).toBe(false);
    expect(visibleCampaignPeriodText(["Sent Aug 1, 2026 9:00 AM Sent Aug 31, 2026 4:00 PM"], august)).toBe(false);
  });

  it("injects the same period parser that is unit-tested here", () => {
    const source = readFileSync(resolve(process.cwd(), "src/features/klaviyo-navigation/campaigns-capture.ts"), "utf8");
    // Both copies run from the parser through visibleCampaignPeriodText, up to compareDescDate.
    const block = (from: string) => { const start = source.indexOf(from); return source.slice(start, source.indexOf("function compareDescDate(", start)).trimEnd(); };
    const exported = block("export function parseCampaignPeriodText(").replace(/^export /gm, "");
    const injected = block("      function parseCampaignPeriodText(").replace(/^ {6}/gm, "");
    expect(injected.startsWith("function parseCampaignPeriodText(")).toBe(true);
    expect(injected).toBe(exported);
  });
});
