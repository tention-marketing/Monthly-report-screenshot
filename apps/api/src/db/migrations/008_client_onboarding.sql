-- Client onboarding (additive only).
-- 1. Report-time copy of the client's conversion metric and verified Klaviyo account. Written once when the report is
--    created and never updated, so a later client-profile change cannot alter an existing report. NULL on reports
--    created before onboarding existed; those keep reading the live client profile exactly as before.
ALTER TABLE report_drafts ADD COLUMN client_setup_snapshot JSONB;

-- 2. A Klaviyo metric ID belongs to exactly one client's account; a second client can never save the same one.
CREATE UNIQUE INDEX client_report_targets_conversion_metric_uidx
  ON client_report_targets ((targets #>> '{profile,conversionMetric,providerMetricId}'))
  WHERE targets #>> '{profile,conversionMetric,providerMetricId}' IS NOT NULL;
