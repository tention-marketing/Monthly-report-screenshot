import { describe, expect, it } from "vitest";
import { renderPartialReviewHtml, LIVE_PARTIAL_SECTION_TYPES } from "./dev-partial-review.js";
import { REPORT_LAYOUT_V1 } from "./report-layout.js";

describe("development partial review HTML", () => {
  it("uses the latest live-verified development capture set", () => {
    expect(LIVE_PARTIAL_SECTION_TYPES).toEqual(["overview", "month_comparison", "top_campaigns", "top_flows", "campaign_performance", "campaign_metrics", "flow_performance", "flow_metrics", "deliverability"]);
  });

  it("keeps the canonical layout contract unchanged while marking absent slots", () => {
    const before = JSON.stringify(REPORT_LAYOUT_V1);
    const html = renderPartialReviewHtml("<html><head><style></style></head><body><section class=\"report-page page-summary\"></section><section class=\"report-page page-flows_and_comparison\"><div class=\"visuals half\"><article>flows</article></div></section><section class=\"report-page page-campaigns_and_flows\"></section><section class=\"report-page page-campaign_metrics\"></section><section class=\"report-page page-flow_metrics_and_analysis\"></section></body></html>", {
      clientName: "AutoLEDTech.com", reportMonthLabel: "August 2026", pages: [],
    } as never);
    expect(JSON.stringify(REPORT_LAYOUT_V1)).toBe(before);
    expect(html).toContain("DEVELOPMENT REVIEW — INCOMPLETE REPORT");
    expect(html).toContain('data-layout-slot="month_comparison"');
    expect(html).toContain('data-layout-slot="deliverability"');
    expect(html).not.toContain('data-layout-slot="list_growth"');
    expect(html.match(/Not yet captured/g)).toHaveLength(5);
    expect(html).toContain("position:absolute;top:1mm");
    expect(html.indexOf("page-supporting_performance")).toBeLessThan(html.indexOf("page-campaign_metrics"));
    expect(html.indexOf("page-campaign_metrics")).toBeLessThan(html.indexOf("page-flow_metrics_and_analysis"));
    expect(html).not.toContain("page-list_growth_and_next_month_plan");
  });

  it("does not overlay a missing placeholder on a captured comparison slot", () => {
    const html = renderPartialReviewHtml("<html><head><style></style></head><body><section class=\"report-page page-flows_and_comparison\"><div class=\"visuals half\"><article>verified comparison capture</article></div></section></body></html>", {
      clientName: "AutoLEDTech.com", reportMonthLabel: "August 2026", pages: [{ key: "flows_and_comparison", sections: [{ layoutSlotKey: "month_comparison" }] }],
    } as never);
    const comparisonPage = html.match(/<section class="report-page page-flows_and_comparison">[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(comparisonPage).toContain("verified comparison capture");
    expect(comparisonPage).not.toContain("Not yet captured");
  });
});
