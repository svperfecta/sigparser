-- Track page number within a day for display purposes
ALTER TABLE sync_state ADD COLUMN batch_page_number INTEGER DEFAULT 0;
