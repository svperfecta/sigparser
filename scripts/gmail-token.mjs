#!/usr/bin/env node
// Mint a Gmail OAuth refresh token for sigparser via a loopback redirect + PKCE.
//
// Usage:
//   node scripts/gmail-token.mjs [--account work|personal] [--login-hint you@example.com] [--port 8765]
//
// Reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from the environment, falling back to .dev.vars.
// Prints the refresh token and the wrangler command to store it. Writes nothing to disk.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Must match the scope configured on the OAuth consent screen (see README / docs/spec.md).
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 5 * 60 * 1000;

function fail(msg) {
  console.error(`\nError: ${msg}\n`);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    account: { type: 'string', default: 'work' },
    'login-hint': { type: 'string' },
    port: { type: 'string', default: '0' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(`Usage: node scripts/gmail-token.mjs [options]

  --account work|personal   Which secret to print the command for (default: work)
  --login-hint <email>      Pre-select the Google account to sign in with
  --port <n>                Fixed loopback port (default: random). Needed only if your
                            OAuth client is a "Web application" with a registered
                            redirect URI like http://127.0.0.1:<n>`);
  process.exit(0);
}

const account = args.account.toLowerCase();
if (account !== 'work' && account !== 'personal') {
  fail(`--account must be "work" or "personal" (got "${args.account}")`);
}
const secretName = `GMAIL_REFRESH_TOKEN_${account.toUpperCase()}`;
const port = Number(args.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail(`invalid --port "${args.port}"`);

// --- Credentials -----------------------------------------------------------

function readDevVars() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  let text;
  try {
    text = readFileSync(join(root, '.dev.vars'), 'utf8');
  } catch {
    return {};
  }
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    vars[m[1]] = value;
  }
  return vars;
}

const devVars = readDevVars();
const clientId = process.env.GOOGLE_CLIENT_ID || devVars.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || devVars.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  fail(
    'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in the environment or in .dev.vars.\n' +
      'Use the SAME client as the deployed Worker: refresh tokens are bound to the client that minted them.',
  );
}

// --- PKCE + state ----------------------------------------------------------

const b64url = (buf) => buf.toString('base64url');
const codeVerifier = b64url(randomBytes(48));
const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
const state = b64url(randomBytes(24));

// --- Loopback server -------------------------------------------------------

function page(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h2>${title}</h2><p>${body}</p></body>`;
}

const result = new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/') {
      res.writeHead(404).end();
      return;
    }
    const send = (status, title, body) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(title, body));
    };
    const error = url.searchParams.get('error');
    if (error) {
      send(400, 'Authorization failed', `Google returned: ${error}. Check the terminal.`);
      reject(new Error(`authorization denied: ${error}`));
    } else if (url.searchParams.get('state') !== state) {
      send(400, 'State mismatch', 'Ignoring this request.');
      return; // keep waiting; could be a stray request
    } else {
      const code = url.searchParams.get('code');
      if (!code) {
        send(400, 'Missing code', 'No authorization code in the redirect.');
        reject(new Error('redirect had no authorization code'));
      } else {
        send(200, 'Done', 'You can close this tab and return to the terminal.');
        resolve({ code, redirectUri: server.redirectUri });
      }
    }
    server.close();
  });

  server.on('error', reject);
  server.listen(port, '127.0.0.1', () => {
    const { port: actualPort } = server.address();
    server.redirectUri = `http://127.0.0.1:${actualPort}`;

    const auth = new URL(AUTH_URL);
    auth.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: server.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(args['login-hint'] ? { login_hint: args['login-hint'] } : {}),
    }).toString();

    console.log(`Minting ${secretName} (client ${clientId.slice(0, 12)}...)`);
    console.log(`Listening on ${server.redirectUri}\n`);
    console.log('Opening your browser. If it does not open, visit:\n');
    console.log(`  ${auth.toString()}\n`);
    if (process.platform === 'darwin') {
      execFile('open', [auth.toString()], (err) => {
        if (err) console.error('(could not open browser automatically; use the URL above)');
      });
    }
  });

  setTimeout(() => {
    server.close();
    reject(new Error('timed out after 5 minutes waiting for the browser redirect'));
  }, TIMEOUT_MS).unref();
});

// --- Exchange --------------------------------------------------------------

const NO_REFRESH_HELP = `Google did not return a refresh_token. To fix:
  1. Revoke sigparser's access at https://myaccount.google.com/permissions
     (signed in as the account you are authorizing), then run this script again.
  2. In Google Cloud Console -> APIs & Services -> OAuth consent screen (Audience),
     make sure Publishing status is "In production". Apps left in "Testing" issue
     refresh tokens that expire after 7 days -- the most likely reason the old
     token stopped working.`;

try {
  const { code, redirectUri } = await result;
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    fail(
      `token exchange failed (HTTP ${resp.status}): ${data.error ?? ''} ${data.error_description ?? ''}`.trim(),
    );
  }
  if (!data.refresh_token) fail(NO_REFRESH_HELP);
  if (typeof data.scope === 'string' && !data.scope.split(' ').includes(SCOPE)) {
    console.warn(`Warning: granted scopes do not include ${SCOPE} (got: ${data.scope})`);
  }

  console.log('Refresh token:\n');
  console.log(`  ${data.refresh_token}\n`);
  console.log('Store it in the Worker (paste the token when prompted):\n');
  console.log(
    `  npx wrangler secret put ${secretName}\n`,
  );
  console.log(
    'Reminder: if the consent screen is still in "Testing", this token will expire in 7 days.',
  );
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
