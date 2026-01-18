-- Add batch_last_timestamp for Unix timestamp-based sync progress
ALTER TABLE sync_state ADD COLUMN batch_last_timestamp INTEGER;
