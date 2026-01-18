-- Add indexes for dashboard "new in 24h" queries
CREATE INDEX IF NOT EXISTS idx_contacts_created_at ON contacts(created_at);
CREATE INDEX IF NOT EXISTS idx_companies_created_at ON companies(created_at);
