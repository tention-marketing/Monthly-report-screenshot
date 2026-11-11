-- Machine-validated automatic captures may generate the final report without a human approval step.
-- Additive only: every existing status stays valid.
ALTER TABLE report_drafts DROP CONSTRAINT report_drafts_status_check;
ALTER TABLE report_drafts ADD CONSTRAINT report_drafts_status_check CHECK (status IN (
  'draft', 'data_fetching', 'data_ready', 'captures_incomplete',
  'ready_for_review', 'approved', 'generating', 'generated', 'failed', 'auto_validated'
));
