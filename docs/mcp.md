# sigparser MCP server

`/mcp` exposes the contact database to MCP clients (Claude, bots). Read-only.

## Tools

| Tool | Use |
|------|-----|
| `search_contacts` | By email `domain` (subdomains included) and/or `query`; `two_way_only`; sort by `strength` (reciprocity = min(sent, received)), `last_seen`, `emails_to`, `emails_from` |
| `find_dormant_contacts` | Two-way relationships quiet for `quiet_for_days` (default 365), optionally only those active within `active_within_days` |
| `get_contact` | One contact by `id` or `email` |
| `get_conversation_context` | Reads Gmail **live** for the newest threads with a contact: subject, dates, participants, last messages (quoted history stripped). sigparser stores no message text. |
| `search_companies`, `get_company` | Company lookups |
| `sync_status` | Sync freshness and which mailboxes `get_conversation_context` may read |

Prompts: `reconnect` (one person → summary + draft), `who_to_reconnect_with` (ranked table).

## Auth

OAuth 2.1 via `@cloudflare/workers-oauth-provider` (MCP clients need OAuth). The sign-in at
`/authorize` is one form: the web UI's `AUTH_USERNAME` / `AUTH_PASSWORD`, plus a consent screen
showing which app connects and where its access goes.

- The grant stores a fingerprint of the credentials; every `/mcp` request re-checks it, so
  changing `AUTH_PASSWORD` signs out every connected client.
- Sign-in attempts are counted in D1 (atomic, before the password check): 5 per IP (IPv6 per /64)
  and 20 in total per 15 minutes, then 429. A burst of guesses from many IPs can lock you out
  for up to 15 minutes; that is the trade-off for a single-user app. CSRF cookie + same-origin
  check on the POST.
- Access tokens last 1 hour, refresh tokens 30 days.
- Until both credentials are set, `/mcp` returns 503.

## Setup

1. Apply the migrations (adds `login_attempts`): `npm run db:migrate:remote`
2. Set the credentials (also the web UI login):
   ```bash
   npx wrangler secret put AUTH_USERNAME
   npx wrangler secret put AUTH_PASSWORD
   npx wrangler secret put MY_OTHER_EMAILS   # optional: your old addresses, hidden from results
   npx wrangler secret put MY_ROLES          # optional: employment timeline JSON (below)
   ```
3. Optional: `MCP_GMAIL_ACCOUNTS` (`work` by default; `work,personal` to also read personal mail).
4. Connect a client:
   ```bash
   claude mcp add --transport http sigparser https://sigparser.rocketsciencegg.workers.dev/mcp
   ```
   The first call opens the browser on the sign-in form.

## "Where was I then?" (`MY_ROLES`)

A JSON list of your roles. Contact results get `yourCompanyWhenMet` / `yourCompanyLastTalked`,
and `get_conversation_context` returns `lastTalked { date, subject, yourCompanyThen, lastWriter }`,
so a client can say "You last talked in 2017, when you were at MadGlory, about the Q3 launch."
Role `emails` are also treated as yours (hidden from contact results, matched on threads).

```json
[
  { "company": "Major League Gaming", "emails": ["bcorrigan@majorleaguegaming.com"], "from": "2008-05", "to": "2016-04" },
  { "company": "Rocket Science", "emails": ["brian@rocketscience.gg"], "from": "2022-05" }
]
```

`from` / `to` take `YYYY`, `YYYY-MM` or `YYYY-MM-DD`; leave out `to` for a current role. Roles may overlap.
A thread's company comes from the address you used on it when a role lists that address, else from its date.

## Data caveats

- `last_seen` and the counts come from the sync. If the sync lags, a "dormant" contact may be
  someone you emailed last week. `get_conversation_context` reads Gmail live; trust its dates.
- `recent_threads` in the DB stopped updating on 2026-01-17 (removed for sync speed); the MCP
  does not use it.
