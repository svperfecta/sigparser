# sigparser

A self-hosted contact intelligence system that mines your email history to build a private relationship database with interaction statistics. Runs entirely on Cloudflare's stack (Workers, D1, KV).

## Features

- **Contact tracking**: Automatically extracts contacts from email headers
- **Company intelligence**: Groups contacts by domain/company
- **Interaction stats**: Tracks emails sent, received, and CC'd
- **Dual account support**: Sync both work and personal Gmail accounts
- **Blacklist management**: Filter out spam, personal, and transactional emails
- **Privacy-first**: Your data stays in your Cloudflare account

## Quick Start

### Prerequisites

- Node.js 20+
- A Cloudflare account
- Gmail account(s) with API access

### Local Development

```bash
# Install dependencies
npm install

# Copy and fill in your secrets
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your actual values

# Run database migrations (local)
npx wrangler d1 execute sigparser-db --local --file=src/db/migrations/0001_initial.sql

# Start dev server
npm run dev

# Open http://localhost:8787
```

> **Note**: `.dev.vars` is automatically loaded by wrangler and gitignored.

### Deploy to Production

```bash
# Run database migrations (production)
npx wrangler d1 execute sigparser-db --remote --file=src/db/migrations/0001_initial.sql

# Set secrets (see "Getting API Keys" below)
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN_WORK
npx wrangler secret put MY_EMAIL_WORK

# Deploy
npm run deploy
```

---

## Getting API Keys

### 1. Google Cloud Console Setup

> **Important**: Use a **personal Google account** (not Google Workspace) to create this project. This allows you to add both Workspace and personal Gmail accounts as test users under one OAuth app.

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Make sure you're signed in with your **personal Google account**
3. Create a new project (e.g., `sigparser`)
4. Enable the **Gmail API**:
   - Navigate to **APIs & Services → Library**
   - Search for "Gmail API"
   - Click **Enable**

### 2. Configure OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** user type (required to support multiple account types)
3. Fill in the required fields:
   - App name: `sigparser`
   - User support email: your email
   - Developer contact: your email
4. Add scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
5. Add **all** your email addresses as test users:
   - Your work email (e.g., `you@company.com`)
   - Your personal Gmail (e.g., `you@gmail.com`)
6. Save

> **Note**: The app stays in "Testing" mode, so only the emails you explicitly add can authorize. This is fine for personal use.

### 3. Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Web application**
4. Name: `sigparser`
5. Authorized redirect URIs:
   - `https://developers.google.com/oauthplayground` (for getting refresh token)
6. Click **Create**
7. Copy the **Client ID** and **Client Secret**

### 4. Get Gmail Refresh Tokens

> **Repeat this process for each Gmail account** you want to sync (work and personal).

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/)
2. Click the **gear icon** (top right) → Check "Use your own OAuth credentials"
3. Enter your **Client ID** and **Client Secret**
4. In the left panel, find **Gmail API v1** and select:
   - `https://www.googleapis.com/auth/gmail.readonly`
5. Click **Authorize APIs**
6. Sign in with the Gmail account you want to sync
7. Click **Exchange authorization code for tokens**
8. Copy the **Refresh token** → save as `GMAIL_REFRESH_TOKEN_WORK` or `GMAIL_REFRESH_TOKEN_PERSONAL`

**For your second account**: Sign out of Google, return to step 1, and sign in with your other account.

### 5. Set Cloudflare Secrets

```bash
# Required secrets
npx wrangler secret put GOOGLE_CLIENT_ID
# Paste your Client ID

npx wrangler secret put GOOGLE_CLIENT_SECRET
# Paste your Client Secret

npx wrangler secret put GMAIL_REFRESH_TOKEN_WORK
# Paste the refresh token for your work account

npx wrangler secret put MY_EMAIL_WORK
# Enter your work email address (e.g., you@company.com)

# Optional: For personal account
npx wrangler secret put GMAIL_REFRESH_TOKEN_PERSONAL
npx wrangler secret put MY_EMAIL_PERSONAL
```

### 6. Set Up Authentication

sigparser uses basic authentication. Set your credentials:

```bash
npx wrangler secret put AUTH_USERNAME
# Enter your desired username

npx wrangler secret put AUTH_PASSWORD
# Enter a strong password
```

Your browser will prompt for credentials when accessing the app.

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth client secret |
| `GMAIL_REFRESH_TOKEN_WORK` | Yes | Refresh token for work Gmail |
| `MY_EMAIL_WORK` | Yes | Your work email address |
| `GMAIL_REFRESH_TOKEN_PERSONAL` | No | Refresh token for personal Gmail |
| `MY_EMAIL_PERSONAL` | No | Your personal email address |
| `AUTH_USERNAME` | Yes | Basic auth username |
| `AUTH_PASSWORD` | Yes | Basic auth password |

---

## Architecture

```
Gmail API → Sync Engine → D1 Database → REST API → HTMX Frontend
     ↑                         ↓
  Cron (15 min)          Cloudflare Access
```

### Data Model

- **Company**: Aggregates domains and contacts
- **Domain**: Links to company, tracks stats per domain
- **Contact**: Person at a company, may have multiple emails
- **Email**: Individual email address with interaction stats

### Tech Stack

- **Runtime**: Cloudflare Workers
- **Framework**: Hono
- **Database**: Cloudflare D1 (SQLite)
- **Frontend**: HTMX + server-rendered HTML
- **Auth**: Cloudflare Access

---

## API Endpoints

### Companies
- `GET /api/companies` - List companies (paginated)
- `GET /api/companies/:id` - Get company with domains
- `GET /api/companies/:id/contacts` - List contacts at company

### Contacts
- `GET /api/contacts` - List contacts (paginated)
- `GET /api/contacts/:id` - Get contact with emails
- `GET /api/contacts/:id/threads` - Get recent threads

### Blacklist
- `GET /api/blacklist` - List blacklisted domains
- `POST /api/blacklist` - Add domain to blacklist
- `DELETE /api/blacklist/:domain` - Remove from blacklist
- `POST /api/blacklist/seed` - Seed personal email domains

### Sync
- `GET /api/sync/status` - Get sync status
- `POST /api/sync/trigger` - Manually trigger sync

---

## Development

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint

# Build
npm run build
```

---

## Security

- **Read-only Gmail access**: Only `gmail.readonly` scope - cannot modify your email
- **Cloudflare Access**: Enterprise-grade authentication
- **No passwords**: OAuth tokens stored as Cloudflare secrets
- **Your infrastructure**: Data never leaves your Cloudflare account

---

## License

MIT
