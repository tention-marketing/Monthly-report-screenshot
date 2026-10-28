CREATE TABLE report_pdf_artifacts (
  id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES report_drafts(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type = 'application/pdf'),
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  sha256 CHAR(64) NOT NULL,
  source_fingerprint CHAR(64) NOT NULL,
  template_version TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT report_pdf_artifacts_report_source_unique UNIQUE (report_id, source_fingerprint)
);

CREATE INDEX report_pdf_artifacts_report_generated_idx
  ON report_pdf_artifacts (report_id, generated_at DESC, id DESC);
