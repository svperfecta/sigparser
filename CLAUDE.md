# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

sigparser is a self-hosted contact intelligence system that mines email history to build a private relationship database with interaction statistics. It runs entirely on Cloudflare's stack (Workers, D1, KV).

## Tech Stack

- **Runtime**: Node.js 20.x, npm
- **Backend**: Cloudflare Workers with Hono framework, D1 (SQLite), KV
- **Frontend**: HTMX for dynamic interactions, server-rendered HTML, Tailwind CSS (pre-built)
- **Auth**: Cloudflare Access (handles Google OAuth, session management)
- **Testing**: Vitest (core logic only)

## Repository Structure

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
│   │   ├── gmail.ts          # Gmail API client
│   │   ├── sync.ts           # Sync engine
│   │   └── blacklist.ts      # Domain filtering
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
│   │   └── pages/
│   ├── types/
│   └── utils/
├── static/
│   ├── styles.css            # Tailwind CSS (pre-built)
│   └── htmx.min.js
├── test/
│   ├── services/
│   └── utils/
├── scripts/
│   └── seed-blacklist.ts
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── deploy.yml
├── wrangler.toml
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

## Common Commands

```bash
# Development
npm install               # Install dependencies
npm run dev               # Start Worker dev server (port 8787)

# Database
npm run db:migrate        # Run D1 migrations locally
npm run db:seed           # Seed blacklist data

# Testing
npm run test              # Run tests

# Code Quality
npm run lint              # ESLint check
npm run lint:fix          # ESLint with auto-fix
npm run format            # Prettier format
npm run typecheck         # TypeScript check

# Deploy
npm run deploy            # Deploy to Cloudflare (production)
```

## Architecture

### Data Flow
1. Gmail API -> Sync Engine -> D1 Database -> REST API/HTML Pages -> Browser
2. Cron job runs incremental sync every 15 minutes
3. Authentication via Cloudflare Access (Google OAuth)

### Core Entities
- **Company**: Aggregates domains and contacts
- **Domain**: Links to company, tracks email stats per domain
- **Contact**: Person at a company, may have multiple email addresses
- **Email**: Individual email address with interaction stats and recent threads

### Key Services (src/services/)
- `gmail.ts`: Gmail API client with rate limiting and retry logic
- `sync.ts`: Full and incremental sync engine
- `blacklist.ts`: Domain/email filtering (spam, personal, transactional)

---

## Coding Standards

### TypeScript Configuration (STRICT)
- `strict: true`
- `noUncheckedIndexedAccess: true` - Array/object access may be undefined
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `exactOptionalPropertyTypes: true`

### ESLint Rules (ENFORCED)
- `@typescript-eslint/explicit-function-return-type: error` - All functions need return types
- `@typescript-eslint/no-explicit-any: error` - No `any` types allowed
- `@typescript-eslint/strict-boolean-expressions: error` - No truthy/falsy checks
- `@typescript-eslint/no-floating-promises: error` - Must await or void promises
- `no-console: error` (except warn/error) - Use logger utility instead

### Naming Conventions
| Item | Convention | Example |
|------|------------|---------|
| Files | camelCase | `companies.ts`, `pagination.ts` |
| Interfaces | PascalCase | `Contact`, `ApiResponse` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_THREADS_PER_CONTACT` |
| Database columns | snake_case | `first_seen`, `company_id` |
| API routes | kebab-case | `/api/contacts/:id/recent-threads` |
| Environment variables | SCREAMING_SNAKE_CASE | `GMAIL_CLIENT_ID` |

### Code Style (Prettier)
```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "all",
  "printWidth": 100
}
```

---

## Testing Requirements

### Approach
Test core business logic only. No coverage thresholds enforced.

### What to Test
- `services/sync.ts` - Message processing, stat aggregation
- `services/blacklist.ts` - Pattern matching, domain checks
- `utils/email.ts` - Email parsing, domain extraction

### Test Configuration
- `globals: true` for describe/it/expect without imports
- `environment: 'node'`

---

## CI/CD Pipeline

### CI Workflow (`.github/workflows/ci.yml`)
Runs on all PRs and pushes to main:
1. **lint** - ESLint check
2. **typecheck** - TypeScript compilation check
3. **test** - Run tests

### Deploy Workflow (`.github/workflows/deploy.yml`)
Triggered on push to main:
1. Build
2. Deploy to Cloudflare Workers
3. Run D1 migrations

---

## Environment Setup

### Required Environment Variables (Cloudflare Secrets)
| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | Yes |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | Yes |
| `GMAIL_REFRESH_TOKEN_WORK` | Work Gmail account refresh token | Yes |
| `GMAIL_REFRESH_TOKEN_PERSONAL` | Personal Gmail account refresh token | Optional |
| `MY_EMAIL_WORK` | Your work email address | Yes |
| `MY_EMAIL_PERSONAL` | Your personal email address | Optional |

### Cloudflare Access Setup

1. Configure Cloudflare Access application for your domain
2. Add Google as identity provider
3. Create access policy allowing specific email addresses
4. Cloudflare Access handles OAuth flow and session management

### Cloudflare Resources Setup

```bash
# Create D1 database
wrangler d1 create sigparser-db

# Create KV namespace
wrangler kv:namespace create KV

# Note the IDs and update wrangler.toml
```

---

## API Endpoints Reference

### Companies
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/companies` | List companies (paginated) |
| GET | `/api/companies/:id` | Get company with domains |
| GET | `/api/companies/:id/contacts` | List contacts at company |

### Contacts
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/contacts` | List contacts (paginated) |
| GET | `/api/contacts/:id` | Get contact with emails |
| GET | `/api/contacts/:id/threads` | Get recent threads |

### Blacklist
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/blacklist` | List all blacklisted domains |
| POST | `/api/blacklist` | Add domain to blacklist |
| DELETE | `/api/blacklist/:domain` | Remove from blacklist |

### Sync
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/status` | Get sync status for all accounts |
| POST | `/api/sync/trigger` | Manually trigger sync |

### Query Parameters (Pagination)
- `page` (int): Page number (default: 1)
- `limit` (int): Items per page (default: 25, max: 100)
- `sort` (string): Sort field
- `order` (string): asc | desc
- `q` (string): Search query

---

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid Cloudflare Access JWT |
| `FORBIDDEN` | 403 | User not allowed |
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid request parameters |
| `RATE_LIMITED` | 429 | Too many requests |
| `GMAIL_API_ERROR` | 502 | Gmail API error |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

---

## Security Requirements

### Cloudflare Access
Authentication is handled by Cloudflare Access - JWT verification in middleware.

### Security Headers (Required)
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`

# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
