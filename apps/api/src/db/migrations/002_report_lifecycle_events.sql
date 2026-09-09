CREATE TABLE report_lifecycle_events (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES report_drafts(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  report_version INTEGER NOT NULL CHECK (report_version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  metadata JSONB
);

CREATE INDEX report_lifecycle_events_report_order_idx
  ON report_lifecycle_events (report_id, created_at, report_version, id);
