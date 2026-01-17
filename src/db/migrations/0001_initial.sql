-- Migration: 0001_initial
-- Description: Initial database schema

-- Companies
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY,
  name TEXT,

  emails_to INTEGER NOT NULL DEFAULT 0,
  emails_from INTEGER NOT NULL DEFAULT 0,
  emails_included INTEGER NOT NULL DEFAULT 0,
  meetings_completed INTEGER NOT NULL DEFAULT 0,
  meetings_upcoming INTEGER NOT NULL DEFAULT 0,

  first_seen TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companies_last_seen ON companies(last_seen);
CREATE INDEX IF NOT EXISTS idx_companies_emails_from ON companies(emails_from);
CREATE INDEX IF NOT EXISTS idx_companies_name ON companies(name);

-- Domains
CREATE TABLE IF NOT EXISTS domains (
  domain TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,

  emails_to INTEGER NOT NULL DEFAULT 0,
  emails_from INTEGER NOT NULL DEFAULT 0,
  emails_included INTEGER NOT NULL DEFAULT 0,
  meetings_completed INTEGER NOT NULL DEFAULT 0,
  meetings_upcoming INTEGER NOT NULL DEFAULT 0,

  first_seen TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_domains_company_id ON domains(company_id);

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT,

  emails_to INTEGER NOT NULL DEFAULT 0,
  emails_from INTEGER NOT NULL DEFAULT 0,
  emails_included INTEGER NOT NULL DEFAULT 0,
  meetings_completed INTEGER NOT NULL DEFAULT 0,
  meetings_upcoming INTEGER NOT NULL DEFAULT 0,

  recent_threads TEXT NOT NULL DEFAULT '[]',

  first_seen TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_contacts_company_id ON contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_last_seen ON contacts(last_seen);
CREATE INDEX IF NOT EXISTS idx_contacts_emails_from ON contacts(emails_from);
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);

-- Emails
CREATE TABLE IF NOT EXISTS emails (
  email TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  name_observed TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,

  emails_to INTEGER NOT NULL DEFAULT 0,
  emails_from INTEGER NOT NULL DEFAULT 0,
  emails_included INTEGER NOT NULL DEFAULT 0,
  meetings_completed INTEGER NOT NULL DEFAULT 0,
  meetings_upcoming INTEGER NOT NULL DEFAULT 0,

  recent_threads TEXT NOT NULL DEFAULT '[]',

  first_seen TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
  FOREIGN KEY (domain) REFERENCES domains(domain) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_emails_contact_id ON emails(contact_id);
CREATE INDEX IF NOT EXISTS idx_emails_domain ON emails(domain);

-- Blacklist
CREATE TABLE IF NOT EXISTS blacklist (
  domain TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blacklist_category ON blacklist(category);

-- Sync State
CREATE TABLE IF NOT EXISTS sync_state (
  account TEXT PRIMARY KEY,
  last_history_id TEXT,
  last_sync TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Processed Messages (deduplication)
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_messages_account ON processed_messages(account);
