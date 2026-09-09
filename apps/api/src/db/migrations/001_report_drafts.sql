CREATE TABLE report_drafts (
  id UUID PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_timezone TEXT NOT NULL,
  client_currency CHAR(3),
  report_year INTEGER NOT NULL CHECK (report_year BETWEEN 2000 AND 9999),
  report_month INTEGER NOT NULL CHECK (report_month BETWEEN 1 AND 12),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  previous_period_start DATE NOT NULL,
  previous_period_end DATE NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'draft', 'data_fetching', 'data_ready', 'captures_incomplete',
    'ready_for_review', 'approved', 'generating', 'generated', 'failed'
  )),
  sections JSONB NOT NULL,
  screenshots JSONB NOT NULL,
  validation JSONB NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT report_drafts_client_month_unique UNIQUE (client_id, report_year, report_month)
);

CREATE INDEX report_drafts_status_idx ON report_drafts (status);
CREATE INDEX report_drafts_updated_at_idx ON report_drafts (updated_at);
