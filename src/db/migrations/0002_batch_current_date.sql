-- Add batch_current_date to track oldest-first sync progress
ALTER TABLE sync_state ADD COLUMN batch_current_date TEXT;
