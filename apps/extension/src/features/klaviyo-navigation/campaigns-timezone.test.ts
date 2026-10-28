import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { campaignSendDay, isDateInRange } from "./campaigns-capture.js";

const august = { startDate: "2026-08-01", endDate: "2026-08-31" };
/** Machine/browser zones on both sides of UTC, including the extremes (+14, -11). */
const MACHINE_ZONES = ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "Pacific/Pago_Pago"];
const originalTz = process.env.TZ;
afterEach(() => { if (originalTz === undefined) delete process.env.TZ; else process.env.TZ = originalTz; });

/** Runs a check under every machine timezone and proves each switch really took effect. */
function underEveryMachineZone(check: () => void): void {
  const offsets = new Set<number>();
  for (const zone of MACHINE_ZONES) {
    process.env.TZ = zone;
    offsets.add(new Date(2026, 7, 1, 2).getTimezoneOffset());
    check();
  }
  expect(offsets.size).toBe(MACHINE_ZONES.length);
}

describe("Campaigns send day uses the client's Klaviyo calendar day", () => {
  it.each([
    ["Aug 1, 2026 2:00 AM", "2026-08-01", true],
    ["Aug 31, 2026 11:30 PM", "2026-08-31", true],
    ["Jul 31, 2026 11:59 PM", "2026-07-31", false],
    ["Sep 1, 2026 12:01 AM", "2026-09-01", false],
  ])("America/New_York: %s → %s (in August: %s)", (shown, day, inAugust) => underEveryMachineZone(() => {
    expect(campaignSendDay(shown, "America/New_York")).toBe(day);
    expect(isDateInRange(shown, august, "America/New_York")).toBe(inAugust);
  }));

  it.each([
    ["Aug 1, 2026 12:30 AM", "2026-08-01", true],
    ["Aug 31, 2026 11:59 PM", "2026-08-31", true],
    ["Jul 31, 2026 11:45 PM", "2026-07-31", false],
    ["Sep 1, 2026 12:15 AM", "2026-09-01", false],
  ])("Asia/Kolkata: %s → %s (in August: %s)", (shown, day, inAugust) => underEveryMachineZone(() => {
    expect(campaignSendDay(shown, "Asia/Kolkata")).toBe(day);
    expect(isDateInRange(shown, august, "Asia/Kolkata")).toBe(inAugust);
  }));

  it.each([
    ["Aug 1, 2026 2:00 AM", "Europe/London", "2026-08-01"],
    ["Aug 31, 2026 11:59 PM", "America/Los_Angeles", "2026-08-31"],
  ])("%s in %s stays on its displayed day", (shown, zone, day) => underEveryMachineZone(() => expect(campaignSendDay(shown, zone)).toBe(day)));

  it.each([
    ["Aug 1, 2026 2:00 AM UTC", "America/New_York", "2026-07-31"],
    ["Aug 1, 2026 2:00 AM UTC", "Asia/Kolkata", "2026-08-01"],
    ["2026-08-31T23:30:00-04:00", "America/New_York", "2026-08-31"],
    ["2026-08-31T23:30:00-04:00", "Asia/Kolkata", "2026-09-01"],
    ["2026-08-01T03:30:00Z", "America/Los_Angeles", "2026-07-31"],
  ])("an explicit zone (%s) resolves to the %s calendar day", (shown, zone, day) => underEveryMachineZone(() => expect(campaignSendDay(shown, zone)).toBe(day)));

  it.each([
    ["Thu, Aug 14, 2026 at 9:00 AM", "2026-08-14"], ["August 14, 2026", "2026-08-14"], ["Aug. 14th, 2026", "2026-08-14"],
    ["14 Aug 2026, 09:00", "2026-08-14"], ["08/14/2026 9:00 AM", "2026-08-14"], ["2026-08-14", "2026-08-14"],
    ["Feb 29, 2028", "2028-02-29"], ["Feb 29, 2026", null], ["Feb 30, 2026", null], ["", null], [null, null], ["Draft", null], ["Sent recently", null],
  ])("reads displayed date %s as %s", (shown, day) => expect(campaignSendDay(shown, "America/New_York")).toBe(day));

  it("rejects an explicit-zone time when the client timezone is invalid", () => expect(campaignSendDay("2026-08-01T03:30:00Z", "Not/AZone")).toBeNull());

  it("injects the same send-day logic that is unit-tested here", () => {
    // Chrome injects a copy inside prepareCampaignsCaptureDocument; it must stay identical to the exports.
    const source = readFileSync(resolve(process.cwd(), "src/features/klaviyo-navigation/campaigns-capture.ts"), "utf8");
    const block = (from: string) => { const start = source.indexOf(from); return source.slice(start, source.indexOf("\n", source.indexOf("function isDateInRange(", start))); };
    const injected = block("  function campaignSendDay(").replace(/^ {2}/gm, "");
    const exported = block("export function campaignSendDay(").replace(/^export /gm, "");
    expect(injected.startsWith("function campaignSendDay(")).toBe(true);
    expect(injected).toBe(exported);
  });
});
