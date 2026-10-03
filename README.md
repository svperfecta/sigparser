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

7. Under **Audience** (Publishing status), click **Publish app** so the status is **In production**.

> **Important**: Do not leave the app in "Testing". Google expires refresh tokens issued by Testing-mode apps after **7 days**, which silently kills sync. In production, an unverified app just shows an "unverified app" warning during consent, which is fine for personal use.

### 3. Create OAuth Credentials

1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth client ID**
3. Application type: **Desktop app** (loopback redirects to `http://127.0.0.1:<any port>` work automatically)
   - If you already have a **Web application** client, keep it and instead add the authorized redirect URI `http://127.0.0.1:8765`, then pass `--port 8765` to the token script below.
4. Name: `sigparser`
5. Click **Create**
7. Copy the **Client ID** and **Client Secret**

### 4. Get Gmail Refresh Tokens

Put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars` (or export them), then run once per account:

```bash
just gmail-token --login-hint you@company.com                     # work
just gmail-token --account personal --login-hint you@gmail.com    # personal
# (equivalent: node scripts/gmail-token.mjs ...; add --port 8765 for a Web application client)
```

The script opens the Google consent page in your browser, catches the redirect on a local loopback server (PKCE + state check), prints the refresh token, and prints the `wrangler secret put` command to store it. It writes nothing to disk.

#### Re-minting a Gmail refresh token

If sync starts failing with `invalid_grant` (token revoked or expired):

1. In Google Cloud Console, check the prerequisites: **Gmail API** enabled, OAuth consent screen publishing status **In production** (Testing-mode tokens die after 7 days), and an OAuth client of type **Desktop app** (or a Web client with `http://127.0.0.1:8765` registered as a redirect URI, used with `--port 8765`).
2. Use the **same** client ID/secret the Worker uses. Refresh tokens are bound to the client that minted them; if you create a new client, update `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` too and re-mint tokens for every account.
3. Run `just gmail-token --login-hint you@company.com` and sign in with that account.
4. Run the printed command and paste the token:
   ```bash
   CLOUDFLARE_ACCOUNT_ID=89a1b9fbcf7d0971fcfa1404054964a3 npx wrangler secret put GMAIL_REFRESH_TOKEN_WORK
   ```
5. If the script says no refresh token was returned, revoke sigparser at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and run it again.

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
just dev              # Start dev server
just test             # Run tests
just check            # Format, lint, typecheck, and test
just migrate          # Run local migrations
just migrate-remote   # Run production migrations
just deploy           # Deploy to Cloudflare
just logs             # Tail production logs
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

## MCP server

sigparser exposes a read-only MCP server at `/mcp` for Claude and bots (search by domain, find dormant relationships, last-conversation context). Setup and tools: [docs/mcp.md](docs/mcp.md).
