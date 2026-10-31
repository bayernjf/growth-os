-- 009_outreach_locale.sql (sqlite dialect)
-- T-G3-07: multilingual outreach. Record the locale used to render each
-- draft so the sent language stays traceable across the draft lifecycle,
-- plus the optional HTML rendering of the same draft.

ALTER TABLE outreach_drafts ADD COLUMN locale TEXT NOT NULL DEFAULT 'en';
ALTER TABLE outreach_drafts ADD COLUMN body_html TEXT;
