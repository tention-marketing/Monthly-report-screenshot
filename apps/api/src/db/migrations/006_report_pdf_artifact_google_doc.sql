-- Editable Google Doc copy of a canonical PDF artifact (Drive metadata only; never credentials).
ALTER TABLE report_pdf_artifacts ADD COLUMN google_doc JSONB;
