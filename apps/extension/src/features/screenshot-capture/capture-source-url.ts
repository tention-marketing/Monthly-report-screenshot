import type { ClientReportTargets, ScreenshotType } from "@tention/report-schema";
import { isCanonicalDashboardScreenshotType } from "../klaviyo-navigation/dashboard-capture.js";

/** Fixed Klaviyo routes. The account is never implied by them: it comes from the
 * toolbar-authorized session and is proven before capture. */
export const KLAVIYO_HOME_URL = "https://www.klaviyo.com/dashboard";
export const KLAVIYO_CAMPAIGNS_LIST_URL = "https://www.klaviyo.com/omnicampaigns?appBarNav=true";
export const KLAVIYO_DELIVERABILITY_SCORE_URL = "https://www.klaviyo.com/analytics/deliverability/email/score";

/** Uses the evidence-backed canonical source for each automatic capture family. */
export function configuredAutomaticCaptureUrl(type: ScreenshotType, targets: ClientReportTargets | null): string | null {
  // Klaviyo Home (`/dashboard`) captures (Executive Summary, Top 5 Flows) share the Overview source.
  if (isCanonicalDashboardScreenshotType(type)) return targets?.sourceUrls?.overviewUrl ?? KLAVIYO_HOME_URL;
  if (type === "top_campaigns") return targets?.sourceUrls?.campaignsUrl ?? KLAVIYO_CAMPAIGNS_LIST_URL;
  if (type === "deliverability") return targets?.sourceUrls?.deliverabilityUrl ?? KLAVIYO_DELIVERABILITY_SCORE_URL;
  // Subscriber Growth, like Business Review, has no fixed route: only the client's saved, discovered source is used.
  if (type === "email_subscriber_growth") return targets?.sourceUrls?.subscriberGrowthUrl ?? null;
  // Business Review is a client-specific dashboard: only a saved, verified target is used.
  return targets?.businessReview?.dashboardUrl ?? null;
}
