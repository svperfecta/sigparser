-- Add page token for Gmail pagination within a day
ALTER TABLE sync_state ADD COLUMN batch_page_token TEXT;
