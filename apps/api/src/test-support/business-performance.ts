import type { BusinessPerformanceEvidence } from "@tention/report-schema";

/**
 * Business performance summary values exactly as Klaviyo Home rendered them as DOM text (Sep 1–30,
 * 2026). Test evidence only: a report's cover always comes from its own Executive Summary capture.
 */
export const SUMMARY_EVIDENCE: BusinessPerformanceEvidence = {
  totalRevenue: "$584,032.35", totalAttributedRevenue: "$173,849.26", emailAttributedRevenue: "$156,674.44", smsAttributedRevenue: "$17,174.82",
  campaignRevenue: "$56,527.51", flowRevenue: "$117,321.75", visiblePeriodText: "Sep 1, 2026 - Sep 30, 2026",
};
