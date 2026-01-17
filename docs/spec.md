# sigparser: Full Engineering Specification

## Project Overview

sigparser is a self-hosted contact intelligence system that mines email history to build a private relationship database with interaction statistics. It runs entirely on Cloudflare's stack (Workers, D1, KV).

---

## Table of Contents

1. [Repository Structure](#1-repository-structure)
2. [Tech Stack & Dependencies](#2-tech-stack--dependencies)
3. [Coding Standards](#3-coding-standards)
4. [Data Model](#4-data-model)
5. [API Specification](#5-api-specification)
6. [Authentication & Security](#6-authentication--security)
7. [Gmail Integration](#7-gmail-integration)
8. [Sync Engine](#8-sync-engine)
9. [Blacklist System](#9-blacklist-system)
10. [UI Specification](#10-ui-specification)
11. [Testing Requirements](#11-testing-requirements)
12. [CI/CD Pipeline](#12-cicd-pipeline)
13. [Configuration & Secrets](#13-configuration--secrets)
14. [Error Handling](#14-error-handling)
15. [Logging & Observability](#15-logging--observability)

---

## 1. Repository Structure

Single-package architecture with Hono serving both API and HTML pages:

```
sigparser/
├── src/
│   ├── index.ts              # Worker entry + Hono app
│   ├── routes/
│   │   ├── api/              # REST API handlers
│   │   │   ├── companies.ts
│   │   │   ├── contacts.ts
│   │   │   ├── blacklist.ts
│   │   │   └── sync.ts
│   │   └── pages/            # HTMX page handlers
│   │       ├── dashboard.ts
│   │       ├── companies.ts
│   │       ├── contacts.ts
│   │       └── blacklist.ts
│   ├── services/
│   │   ├── gmail.ts
│   │   ├── sync.ts
│   │   └── blacklist.ts
│   ├── repositories/
│   │   ├── company.ts
│   │   ├── contact.ts
│   │   ├── domain.ts
│   │   └── email.ts
│   ├── db/
│   │   ├── schema.sql
│   │   └── migrations/
│   ├── middleware/
│   │   ├── auth.ts           # Cloudflare Access JWT verification
│   │   ├── cors.ts
│   │   └── error.ts
│   ├── templates/            # HTML templates for HTMX
│   │   ├── layout.ts
│   │   ├── components/
│   │   │   ├── table.ts
│   │   │   ├── pagination.ts
│   │   │   ├── stats.ts
│   │   │   └── search.ts
│   │   └── pages/
│   │       ├── dashboard.ts
│   │       ├── companies.ts
│   │       ├── contacts.ts
│   │       └── blacklist.ts
│   ├── types/
│   │   ├── index.ts
│   │   ├── api.ts
│   │   ├── db.ts
│   │   └── gmail.ts
│   └── utils/
│       ├── id.ts
│       ├── date.ts
│       ├── email.ts
│       └── pagination.ts
├── static/
│   ├── styles.css            # Tailwind CSS (pre-built)
│   └── htmx.min.js           # HTMX library
├── test/
│   ├── services/
│   │   ├── sync.test.ts
│   │   └── blacklist.test.ts
│   └── utils/
│       └── email.test.ts
├── scripts/
│   └── seed-blacklist.ts
├── .github/
│   └── workflows/
│       ├── ci.yml            # Lint, typecheck, test
│       └── deploy.yml        # Deploy to production
├── wrangler.toml
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── .eslintrc.cjs
├── .prettierrc
├── .nvmrc
└── README.md
```

---

## 2. Tech Stack & Dependencies

### Runtime
- Node.js 20.x (LTS)
- npm (package manager)

### Backend
```json
{
  "dependencies": {
    "hono": "^4.0.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.0.0",
    "wrangler": "^3.0.0",
    "vitest": "^1.0.0",
    "typescript": "^5.3.0",
    "eslint": "^8.55.0",
    "@typescript-eslint/eslint-plugin": "^6.13.0",
    "@typescript-eslint/parser": "^6.13.0",
    "prettier": "^3.1.0"
  }
}
```

### Frontend
- HTMX for dynamic interactions (served from static/)
- Tailwind CSS for styling (pre-built CSS file)
- No build step for frontend - server-rendered HTML

---

## 3. Coding Standards

### TypeScript Configuration

**tsconfig.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

### ESLint Configuration

**.eslintrc.cjs**
```javascript
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    project: ['./tsconfig.json'],
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/strict-type-checked',
    'plugin:@typescript-eslint/stylistic-type-checked',
    'prettier',
  ],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-function-return-type': 'error',
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/prefer-nullish-coalescing': 'error',
    '@typescript-eslint/strict-boolean-expressions': 'error',
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/await-thenable': 'error',
    '@typescript-eslint/no-misused-promises': 'error',
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'eqeqeq': ['error', 'always'],
    'curly': ['error', 'all'],
  },
  overrides: [
    {
      files: ['**/*.test.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};
```

### Prettier Configuration

**.prettierrc**
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100,
  "bracketSpacing": true,
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

### Naming Conventions

| Item | Convention | Example |
|------|------------|---------|
| Files (all) | camelCase | `companies.ts`, `pagination.ts` |
| Interfaces | PascalCase | `Contact`, `ApiResponse` |
| Types | PascalCase | `PaginationParams` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_THREADS_PER_CONTACT` |
| Functions | camelCase | `fetchContacts` |
| Database columns | snake_case | `first_seen` |
| API routes | kebab-case | `/api/contacts/:id/recent-threads` |
| Environment variables | SCREAMING_SNAKE_CASE | `GMAIL_CLIENT_ID` |

---

## 4. Data Model

### Full Schema (src/db/schema.sql)

```sql
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Companies
CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  name TEXT,

  emails_to INTEGER NOT NULL DEFAULT 0,
  emails_from INTEGER NOT NULL DEFAULT 0,
  emails_included INTEGER NOT NULL DEFAULT 0,
  meetings_completed INTEGER NOT NULL DEFAULT 0,
  meetings_upcoming INTEGER NOT NULL DEFAULT 0,

  first_seen TEXT,  -- ISO date
  last_seen TEXT,   -- ISO date
  created_at TEXT NOT NULL,  -- ISO timestamp
  updated_at TEXT NOT NULL   -- ISO timestamp
);

CREATE INDEX idx_companies_last_seen ON companies(last_seen);
CREATE INDEX idx_companies_emails_from ON companies(emails_from);
CREATE INDEX idx_companies_name ON companies(name);

-- Domains
CREATE TABLE domains (
  domain TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,  -- SQLite boolean

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

CREATE INDEX idx_domains_company_id ON domains(company_id);

-- Contacts
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT,

  emails_to INTEGER NOT NULL DEFAULT 0,
  emails_from INTEGER NOT NULL DEFAULT 0,
  emails_included INTEGER NOT NULL DEFAULT 0,
  meetings_completed INTEGER NOT NULL DEFAULT 0,
  meetings_upcoming INTEGER NOT NULL DEFAULT 0,

  recent_threads TEXT NOT NULL DEFAULT '[]',  -- JSON array

  first_seen TEXT,
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE INDEX idx_contacts_company_id ON contacts(company_id);
CREATE INDEX idx_contacts_last_seen ON contacts(last_seen);
CREATE INDEX idx_contacts_emails_from ON contacts(emails_from);
CREATE INDEX idx_contacts_name ON contacts(name);

-- Emails
CREATE TABLE emails (
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

CREATE INDEX idx_emails_contact_id ON emails(contact_id);
CREATE INDEX idx_emails_domain ON emails(domain);

-- Blacklist
CREATE TABLE blacklist (
  domain TEXT PRIMARY KEY,
  category TEXT NOT NULL,  -- 'spam' | 'personal' | 'transactional' | 'manual'
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_blacklist_category ON blacklist(category);

-- Sync State
CREATE TABLE sync_state (
  account TEXT PRIMARY KEY,  -- 'work' | 'personal'
  last_history_id TEXT,
  last_sync TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Processed Messages (deduplication)
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  processed_at TEXT NOT NULL
);
```

### TypeScript Types (src/types/index.ts)

```typescript
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

export interface BlacklistEntry {
  domain: string;
  category: 'spam' | 'personal' | 'transactional' | 'manual';
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

// === Expanded Response Types (with joins) ===

export interface CompanyWithDomains extends Company {
  domains: Domain[];
  contactCount: number;
}

export interface ContactWithEmails extends Contact {
  emails: Email[];
  company: Company;
}
```

### Constants (src/types/constants.ts)

```typescript
export const MAX_THREADS_PER_CONTACT = 100;

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

export const BLACKLIST_CATEGORIES = ['spam', 'personal', 'transactional', 'manual'] as const;

export const PERSONAL_EMAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'yahoo.com',
  'ymail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'mail.com',
  'protonmail.com',
  'proton.me',
  'fastmail.com',
  'zoho.com',
  'gmx.com',
  'gmx.net',
  'yandex.com',
  'tutanota.com',
  'hey.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'msn.com',
  'hotmail.co.uk',
  'yahoo.co.uk',
  'btinternet.com',
] as const;

export const TRANSACTIONAL_EMAIL_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^mailer-daemon@/i,
  /^notifications?@/i,
  /^notify@/i,
  /^alerts?@/i,
  /^news(letter)?@/i,
  /^support@/i,
  /^info@/i,
  /^sales@/i,
  /^marketing@/i,
  /^hello@/i,
  /^contact@/i,
  /^team@/i,
  /^feedback@/i,
  /^billing@/i,
  /^subscriptions?@/i,
  /^updates?@/i,
] as const;

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;
```

---

## 5. API Specification

### Base URL
- Production: `https://sigparser.yourdomain.com`

### Authentication
All endpoints require valid Cloudflare Access JWT. The JWT is automatically validated via Cloudflare Access.

### Response Format
All API responses are JSON:

**Success:**
```json
{
  "data": { ... },
  "pagination": { ... }  // if applicable
}
```

**Error:**
```json
{
  "error": "Human readable message",
  "code": "MACHINE_READABLE_CODE",
  "details": { ... }  // optional
}
```

### Endpoints

#### Companies

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies` | List companies (paginated) |
| GET | `/api/companies/:id` | Get company with domains |
| GET | `/api/companies/:id/contacts` | List contacts at company |

**GET /api/companies Query Params:**
- `q` (string): Search by name or domain
- `page` (int): Page number (default: 1)
- `limit` (int): Items per page (default: 25, max: 100)
- `sort` (string): Sort field (name, emails_to, emails_from, last_seen)
- `order` (string): asc | desc

#### Contacts

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contacts` | List contacts (paginated) |
| GET | `/api/contacts/:id` | Get contact with emails |
| GET | `/api/contacts/:id/threads` | Get recent threads |

#### Blacklist

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/blacklist` | List all blacklisted domains |
| POST | `/api/blacklist` | Add domain to blacklist |
| DELETE | `/api/blacklist/:domain` | Remove from blacklist |

#### Sync

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/status` | Get sync status for all accounts |
| POST | `/api/sync/trigger` | Manually trigger sync |

---

## 6. Authentication & Security

### Cloudflare Access

Authentication is handled entirely by Cloudflare Access:

1. Configure Cloudflare Access application for sigparser domain
2. Add Google as identity provider
3. Create access policy allowing specific email addresses
4. Cloudflare Access handles OAuth flow, session management, and JWT issuance

### JWT Verification (src/middleware/auth.ts)

```typescript
import { Context, Next } from 'hono';

interface CloudflareAccessJWT {
  email: string;
  sub: string;
  iat: number;
  exp: number;
}

export async function verifyCloudflareAccess(c: Context, next: Next): Promise<Response | void> {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');

  if (!jwt) {
    return c.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, 401);
  }

  // Cloudflare Access validates the JWT automatically
  // The JWT claims are available in the header
  const payload = JSON.parse(
    atob(jwt.split('.')[1] ?? '')
  ) as CloudflareAccessJWT;

  c.set('userEmail', payload.email);

  await next();
}
```

### Security Headers

```typescript
const securityHeaders = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
};
```

---

## 7. Gmail Integration

### Service: src/services/gmail.ts

```typescript
interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;  // Per account
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  payload: {
    headers: Array<{ name: string; value: string }>;
  };
  internalDate: string;
}

interface GmailListResponse {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

interface GmailHistoryResponse {
  history: Array<{
    id: string;
    messagesAdded?: Array<{ message: GmailMessage }>;
  }>;
  historyId: string;
  nextPageToken?: string;
}

class GmailService {
  constructor(private config: GmailConfig) {}

  async refreshAccessToken(): Promise<string>;
  async listMessages(params: { pageToken?: string; maxResults?: number; q?: string }): Promise<GmailListResponse>;
  async getMessage(messageId: string): Promise<GmailMessage>;
  async batchGetMessages(messageIds: string[]): Promise<GmailMessage[]>;
  async getHistory(params: { startHistoryId: string; pageToken?: string }): Promise<GmailHistoryResponse>;
}
```

### Rate Limiting

Gmail API quotas:
- 250 quota units per user per second
- Implement exponential backoff for rate limit errors (429, 500, 503)

---

## 8. Sync Engine

### Service: src/services/sync.ts

```typescript
interface SyncResult {
  messagesProcessed: number;
  contactsCreated: number;
  companiesCreated: number;
  errors: Array<{ messageId: string; error: string }>;
}

class SyncService {
  constructor(
    private gmail: GmailService,
    private db: D1Database,
    private blacklist: BlacklistService,
  ) {}

  async fullSync(account: 'work' | 'personal'): Promise<SyncResult>;
  async incrementalSync(account: 'work' | 'personal'): Promise<SyncResult>;
  async processMessage(message: GmailMessage, account: string): Promise<void>;
}
```

### Sync Algorithm

```
FULL SYNC:
1. Get sync_state for account
2. If last_history_id exists, do incremental sync instead
3. Call gmail.listMessages with pagination
4. For each page:
   a. Batch fetch message metadata
   b. For each message:
      - Check if message_id already processed → skip
      - Parse headers (From, To, Cc, Date)
      - Extract all email addresses
      - For each email (excluding self):
        * Extract domain
        * Check blacklist → skip if matched
        * Upsert domain + company
        * Upsert email + contact
        * Increment stats
        * Add thread to recent_threads (cap at 100)
        * Update timestamps
      - Mark message_id as processed
   c. Update sync_state.last_history_id

INCREMENTAL SYNC:
1. Get sync_state.last_history_id
2. Call gmail.getHistory with startHistoryId
3. Process only messagesAdded events
4. Same message processing as above
5. Update sync_state.last_history_id
```

### Cron Configuration (wrangler.toml)

```toml
[triggers]
crons = ["*/15 * * * *"]  # Every 15 minutes
```

---

## 9. Blacklist System

### Service: src/services/blacklist.ts

```typescript
class BlacklistService {
  constructor(private db: D1Database) {}

  isBlacklisted(email: string): Promise<boolean>;
  isTransactional(email: string): boolean;
  add(domain: string, category: string, source?: string): Promise<void>;
  remove(domain: string): Promise<void>;
  list(category?: string): Promise<BlacklistEntry[]>;
  seedPersonalDomains(): Promise<void>;
}
```

---

## 10. UI Specification

### Tech Stack
- HTMX for dynamic interactions
- Server-rendered HTML templates
- Tailwind CSS (pre-built)

### Routes

| Path | Handler | Description |
|------|---------|-------------|
| `/` | pages/dashboard.ts | Overview stats |
| `/companies` | pages/companies.ts | Paginated company list |
| `/companies/:id` | pages/companies.ts | Company with contacts |
| `/contacts` | pages/contacts.ts | Paginated contact list |
| `/contacts/:id` | pages/contacts.ts | Contact with emails |
| `/blacklist` | pages/blacklist.ts | Manage blacklist |

### HTMX Patterns

**Pagination:**
```html
<div hx-get="/companies?page=2" hx-target="#company-list" hx-swap="innerHTML">
  Next Page
</div>
```

**Search:**
```html
<input type="search"
       name="q"
       hx-get="/companies"
       hx-trigger="input changed delay:300ms"
       hx-target="#company-list">
```

**Delete with confirmation:**
```html
<button hx-delete="/api/blacklist/spam.com"
        hx-confirm="Remove spam.com from blacklist?"
        hx-target="closest tr"
        hx-swap="outerHTML">
  Remove
</button>
```

### Page Layouts

**Dashboard:**
```
┌─────────────────────────────────────────────┐
│ sigparser                             [User]│
├─────────────────────────────────────────────┤
│ ┌─────────┐ ┌─────────┐ ┌─────────┐         │
│ │Companies│ │Contacts │ │ Emails  │         │
│ │   142   │ │  1,847  │ │ 45,231  │         │
│ └─────────┘ └─────────┘ └─────────┘         │
├─────────────────────────────────────────────┤
│ Sync Status                                 │
│ Work: Last sync 5 min ago    [Sync Now]     │
│ Personal: Last sync 5 min ago [Sync Now]    │
├─────────────────────────────────────────────┤
│ Recent Contacts                             │
│ • John Smith (Acme Corp) - 2 hours ago      │
│ • Jane Doe (TechCo) - yesterday             │
└─────────────────────────────────────────────┘
```

**Companies List:**
```
┌─────────────────────────────────────────────────────────────────────┐
│ Companies                                                           │
├─────────────────────────────────────────────────────────────────────┤
│ [ Search companies... ]              Sort: [Last Contact ▼]         │
├─────────────────────────────────────────────────────────────────────┤
│ Name          │ Domains     │ Contacts │ To  │ From │ Last Contact │
├───────────────┼─────────────┼──────────┼─────┼──────┼──────────────┤
│ Acme Corp     │ acme.com    │ 23       │ 150 │ 89   │ Jan 15, 2024 │
│ TechCo        │ techco.io   │ 8        │ 45  │ 32   │ Jan 14, 2024 │
├───────────────────────────────────────────────────────────────────────┤
│                         < 1 2 3 ... 10 >                            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 11. Testing Requirements

### Approach
Test core business logic only. No coverage thresholds enforced.

### What to Test

**Required:**
- `services/sync.ts` - Message processing, stat aggregation
- `services/blacklist.ts` - Pattern matching, domain checks
- `utils/email.ts` - Email parsing, domain extraction

**Optional:**
- Repository layer (simple CRUD)
- API handlers (mostly delegation)

### Test Configuration

**vitest.config.ts**
```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
  },
});
```

### Example Tests

```typescript
// test/utils/email.test.ts
import { describe, it, expect } from 'vitest';
import { parseEmailHeader, extractDomain } from '../../src/utils/email';

describe('parseEmailHeader', () => {
  it('parses simple email', () => {
    expect(parseEmailHeader('john@acme.com')).toEqual([
      { email: 'john@acme.com', name: null, domain: 'acme.com' },
    ]);
  });

  it('parses email with display name', () => {
    expect(parseEmailHeader('John Smith <john@acme.com>')).toEqual([
      { email: 'john@acme.com', name: 'John Smith', domain: 'acme.com' },
    ]);
  });
});
```

---

## 12. CI/CD Pipeline

### GitHub Actions Workflows

**.github/workflows/ci.yml**
```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
```

**.github/workflows/deploy.yml**
```yaml
name: Deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      - run: npm ci
      - run: npm run build

      - name: Deploy to Cloudflare
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}

      - name: Run D1 Migrations
        run: npx wrangler d1 migrations apply sigparser-db --remote
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
```

---

## 13. Configuration & Secrets

### Wrangler Configuration

**wrangler.toml**
```toml
name = "sigparser"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[vars]
ENVIRONMENT = "production"

[[d1_databases]]
binding = "DB"
database_name = "sigparser-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[[kv_namespaces]]
binding = "KV"
id = "xxxxxxxx"

[triggers]
crons = ["*/15 * * * *"]

[site]
bucket = "./static"
```

### Environment Variables

Store in Cloudflare dashboard as secrets:

| Variable | Description |
|----------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN_WORK` | Work account refresh token |
| `GMAIL_REFRESH_TOKEN_PERSONAL` | Personal account refresh token |
| `MY_EMAIL_WORK` | Your work email address |
| `MY_EMAIL_PERSONAL` | Your personal email address |

---

## 14. Error Handling

### API Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid Cloudflare Access JWT |
| `FORBIDDEN` | 403 | User not allowed |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request parameters |
| `RATE_LIMITED` | 429 | Too many requests |
| `GMAIL_API_ERROR` | 502 | Gmail API error |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

### Error Handling Middleware

```typescript
// src/middleware/error.ts
import { Context, Next } from 'hono';
import { ApiError } from '../types';

export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number = 500,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function errorHandler(c: Context, next: Next): Promise<Response> {
  try {
    await next();
  } catch (error) {
    console.error('Unhandled error:', error);

    if (error instanceof AppError) {
      return c.json<ApiError>(
        { error: error.message, code: error.code, details: error.details },
        error.status,
      );
    }

    return c.json<ApiError>(
      { error: 'An unexpected error occurred', code: 'INTERNAL_ERROR' },
      500,
    );
  }
}
```

---

## 15. Logging & Observability

### Structured Logging

```typescript
// src/utils/logger.ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  requestId?: string;
  [key: string]: unknown;
}

export function createLogger(requestId?: string) {
  const log = (level: LogLevel, message: string, data?: Record<string, unknown>): void => {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      requestId,
      ...data,
    };

    if (level === 'error') {
      console.error(JSON.stringify(entry));
    } else {
      console.log(JSON.stringify(entry));
    }
  };

  return {
    debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
    info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
    error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
  };
}
```

---

## Quick Start Commands

```bash
# Initial setup
npm install
cp .dev.vars.example .dev.vars  # Edit with your values

# Development
npm run dev           # Start Worker dev server (port 8787)

# Database
npm run db:migrate    # Run migrations locally
npm run db:seed       # Seed blacklist

# Testing
npm run test          # Run tests

# Code Quality
npm run lint          # ESLint
npm run lint:fix      # ESLint with auto-fix
npm run format        # Prettier
npm run typecheck     # TypeScript check

# Deploy
npm run deploy        # Deploy to Cloudflare
```

---

## Implementation Order

1. **Phase 1: Foundation**
   - Project setup (package.json, tsconfig, wrangler.toml)
   - D1 schema and migrations
   - Basic Hono app structure
   - Cloudflare Access middleware

2. **Phase 2: Core Sync**
   - Gmail service implementation
   - Blacklist service
   - Sync engine (full + incremental)
   - Cron job setup

3. **Phase 3: API Endpoints**
   - Companies REST API
   - Contacts REST API
   - Blacklist management
   - Sync status

4. **Phase 4: UI**
   - HTML templates
   - HTMX integration
   - Dashboard page
   - Companies/Contacts pages
   - Blacklist management page
