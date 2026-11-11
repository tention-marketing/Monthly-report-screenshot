-- Google Drive archive copy of a canonical PDF artifact (delivery metadata only; never credentials).
ALTER TABLE report_pdf_artifacts ADD COLUMN drive_delivery JSONB;
