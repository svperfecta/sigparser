// === Environment Types ===

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  __STATIC_CONTENT?: KVNamespace;
  __STATIC_CONTENT_MANIFEST?: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN_WORK: string;
  GMAIL_REFRESH_TOKEN_PERSONAL?: string;
  MY_EMAIL_WORK: string;
  MY_EMAIL_PERSONAL?: string;
  ENVIRONMENT: string;
}

// === Base Types ===

export interface Timestamps {
  firstSeen: string | null;
  lastSeen: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Stats {
  emailsTo: number;
  emailsFrom: number;
  emailsIncluded: number;
  meetingsCompleted: number;
  meetingsUpcoming: number;
}

export interface ThreadReference {
  threadId: string;
  account: 'work' | 'personal';
  timestamp: string;
}

// === Domain Entities ===

export interface Company extends Stats, Timestamps {
  id: string;
  name: string | null;
}

export interface Domain extends Stats, Timestamps {
  domain: string;
  companyId: string;
  isPrimary: boolean;
}

export interface Contact extends Stats, Timestamps {
  id: string;
  companyId: string;
  name: string | null;
  recentThreads: ThreadReference[];
}

export interface Email extends Stats, Timestamps {
  email: string;
  contactId: string;
  domain: string;
  nameObserved: string | null;
  isActive: boolean;
  recentThreads: ThreadReference[];
}

export type BlacklistCategory = 'spam' | 'personal' | 'transactional' | 'manual';

export interface BlacklistEntry {
  domain: string;
  category: BlacklistCategory;
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SyncState {
  account: 'work' | 'personal';
  lastHistoryId: string | null;
  lastSync: string | null;
  createdAt: string;
  updatedAt: string;
}

// === API Types ===

export interface PaginationParams {
  page: number;
  limit: number;
  sort?: string;
  order?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}

// === Expanded Response Types ===

export interface CompanyWithDomains extends Company {
  domains: Domain[];
  contactCount: number;
}

export interface ContactWithEmails extends Contact {
  emails: Email[];
  company: Company;
}

// === Database Row Types ===

export interface CompanyRow {
  id: string;
  name: string | null;
  emails_to: number;
  emails_from: number;
  emails_included: number;
  meetings_completed: number;
  meetings_upcoming: number;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export interface DomainRow {
  domain: string;
  company_id: string;
  is_primary: number;
  emails_to: number;
  emails_from: number;
  emails_included: number;
  meetings_completed: number;
  meetings_upcoming: number;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactRow {
  id: string;
  company_id: string;
  name: string | null;
  emails_to: number;
  emails_from: number;
  emails_included: number;
  meetings_completed: number;
  meetings_upcoming: number;
  recent_threads: string;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailRow {
  email: string;
  contact_id: string;
  domain: string;
  name_observed: string | null;
  is_active: number;
  emails_to: number;
  emails_from: number;
  emails_included: number;
  meetings_completed: number;
  meetings_upcoming: number;
  recent_threads: string;
  first_seen: string | null;
  last_seen: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlacklistRow {
  domain: string;
  category: string;
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncStateRow {
  account: string;
  last_history_id: string | null;
  last_sync: string | null;
  created_at: string;
  updated_at: string;
}
