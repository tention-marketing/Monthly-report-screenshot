import { describe, expect, it } from "vitest";
import { finalGenerationDataBlockers } from "./index.js";

const draft = (currency: string | null) => ({ client: { id: "club-furniture", name: "Club Furniture", timezone: "America/New_York", currency } });
const profile = (currency: string | null, providerMetricId: string | null, label = "Placed Order") => ({ currency, conversionMetric: { label, providerMetricId } });
const codes = (blockers: ReturnType<typeof finalGenerationDataBlockers>) => blockers.map(({ code }) => code);

describe("final generation data-definition blockers (AGENTS.md §7, §22, §41)", () => {
  it("passes only when the report currency and the conversion metric's provider ID are both configured", () => {
    expect(finalGenerationDataBlockers(draft("USD"), profile("USD", "Xy12Ab"))).toEqual([]);
  });
  it("blocks the Club Furniture Sep 2026 state: currency null and Placed Order without a provider metric ID", () => {
    expect(codes(finalGenerationDataBlockers(draft(null), profile(null, null)))).toEqual(["CURRENCY_NOT_CONFIGURED", "CONVERSION_METRIC_ID_NOT_CONFIGURED"]);
  });
  it("never treats a display label as a metric ID, or a missing profile as configured", () => {
    expect(codes(finalGenerationDataBlockers(draft("USD"), profile("USD", null)))).toEqual(["CONVERSION_METRIC_ID_NOT_CONFIGURED"]);
    expect(codes(finalGenerationDataBlockers(draft("USD"), profile("USD", "   ")))).toEqual(["CONVERSION_METRIC_ID_NOT_CONFIGURED"]);
    expect(codes(finalGenerationDataBlockers(draft("USD"), null))).toEqual(["CONVERSION_METRIC_NOT_CONFIGURED", "CONVERSION_METRIC_ID_NOT_CONFIGURED"]);
  });
  it("rejects a malformed currency and a profile that later disagrees with the report's frozen currency", () => {
    expect(codes(finalGenerationDataBlockers(draft("usd"), profile("USD", "Xy12Ab")))).toEqual(["CURRENCY_NOT_CONFIGURED"]);
    expect(codes(finalGenerationDataBlockers(draft("USD"), profile("CAD", "Xy12Ab")))).toEqual(["CLIENT_CURRENCY_MISMATCH"]);
  });
});
