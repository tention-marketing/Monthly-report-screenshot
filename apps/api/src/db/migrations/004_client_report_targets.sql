CREATE TABLE client_report_targets (
  client_id TEXT PRIMARY KEY,
  targets JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX client_report_targets_klaviyo_account_uidx
  ON client_report_targets ((targets #>> '{businessReview,providerAccountId}') )
  WHERE targets #>> '{businessReview,providerAccountId}' IS NOT NULL;
