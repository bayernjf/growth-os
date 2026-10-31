-- 008_lead_imports.sql (sqlite dialect)
-- T-G2-07: generic lead import intake (webhook/CSV/manual). source_ref records
-- the external import origin (e.g. webhook source name, CSV batch id) so an
-- imported lead stays traceable after it enters the existing state machine.

ALTER TABLE leads ADD COLUMN source_ref TEXT;
