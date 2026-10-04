import type { OAuthHelpers, AuthRequest } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import type { Env } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  admitLoginAttempt,
  checkCredentials,
  credentialFingerprint,
  clearLoginAttempts,
  timingSafeEqual,
  type McpGrantProps,
} from './password.js';

/**
 * OAuth sign-in for MCP clients. `/authorize` shows one form that is both the login (the web
 * UI's AUTH_USERNAME / AUTH_PASSWORD) and the consent screen (which app, and where its access
 * goes). The grant completes only on POST, with a CSRF token bound to a SameSite=Strict
 * cookie, from the same origin, and with attempts rate-limited per client (counted in D1 before the check).
 *
 * These routes are reached outside the main app's Basic auth: the form is its own gate.
 */

type OAuthBindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const OAUTH_ROUTE_PATHS = ['/authorize'];

export const oauthRoutes = new Hono<{ Bindings: OAuthBindings }>();

const CSRF_COOKIE = 'sigparser_mcp_login';
const LOGIN_TTL_SECONDS = 600;

// No form-action: browsers apply it to the redirect after the POST, which goes to the client.
const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

interface PendingLogin {
  oauthReqInfo: AuthRequest;
  clientName: string;
}

function randomToken(bytes = 24): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      return value.join('=');
    }
  }
  return undefined;
}

function isCrossOrigin(request: Request): boolean {
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite !== null) {
    return fetchSite !== 'same-origin' && fetchSite !== 'none';
  }
  const origin = request.headers.get('Origin');
  if (origin === null) {
    return false;
  }
  try {
    return new URL(origin).host !== new URL(request.url).host;
  } catch {
    return true;
  }
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

function shell(title: string, inner: string): string {
  return (
    `<!doctype html><html lang=en><head><meta charset=utf-8>` +
    `<meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>body{min-height:100vh;display:grid;place-items:center;margin:0;padding:16px;font-family:system-ui,sans-serif;background:#f6f7f9;color:#111}` +
    `.card{width:100%;max-width:420px;box-sizing:border-box;padding:28px;background:#fff;border:1px solid #e3e5e8;border-radius:12px}` +
    `h1{font-size:1.3rem;margin:0 0 12px}p{color:#444;line-height:1.5}` +
    `.dest{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;background:#f1f2f4;padding:8px;border-radius:6px}` +
    `.warn{padding:10px;border-radius:6px;background:#fff6e5;color:#7a4a00;font-size:13px}` +
    `.error{padding:10px;border-radius:6px;background:#fdecec;color:#8a1c1c;font-size:13px}` +
    `label{display:block;margin-top:12px;font-size:13px;color:#444}` +
    `input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:10px;border:1px solid #d0d3d8;border-radius:8px;font-size:15px}` +
    `button{display:block;width:100%;margin-top:12px;padding:11px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}` +
    `button.secondary{margin-top:8px;background:#e3e5e8;color:#111}</style></head><body>${inner}</body></html>`
  );
}

function page(title: string, body: string, status = 200): Response {
  const inner = `<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div>`;
  return new Response(shell(title, inner), { status, headers: PAGE_HEADERS });
}

function loginForm(pending: PendingLogin, csrf: string, error?: string): Response {
  const inner =
    `<div class="card"><h1>Connect ${escapeHtml(pending.clientName)} to sigparser?</h1>` +
    `<p>It will be able to read your sigparser contacts and recent Gmail conversations.</p>` +
    `<p>Access will be sent to:</p><p class="dest">${escapeHtml(pending.oauthReqInfo.redirectUri)}</p>` +
    `<p class="warn">Only continue if you started this yourself.</p>` +
    (error !== undefined ? `<p class="error">${escapeHtml(error)}</p>` : '') +
    `<form method="post" action="/authorize">` +
    `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<label>Username<input name="username" autocomplete="username" required></label>` +
    `<label>Password<input name="password" type="password" autocomplete="current-password" required></label>` +
    `<button name="decision" value="approve">Sign in and connect</button>` +
    `<button class="secondary" name="decision" value="deny" formnovalidate>Cancel</button>` +
    `</form></div>`;
  return new Response(shell('sigparser · connect an app', inner), {
    status: error !== undefined ? 401 : 200,
    headers: {
      ...PAGE_HEADERS,
      'Set-Cookie': `${CSRF_COOKIE}=${csrf}; Path=/authorize; HttpOnly; Secure; SameSite=Strict; Max-Age=${LOGIN_TTL_SECONDS}`,
    },
  });
}

oauthRoutes.get('/authorize', async (c) => {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch {
    return page(
      'Unknown client',
      'That app is not registered with sigparser. Try connecting again.',
      400,
    );
  }

  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  const pending: PendingLogin = {
    oauthReqInfo,
    clientName: clientInfo?.clientName ?? oauthReqInfo.clientId,
  };
  const csrf = randomToken();
  await c.env.OAUTH_KV.put(`oauth-login:${csrf}`, JSON.stringify(pending), {
    expirationTtl: LOGIN_TTL_SECONDS,
  });
  return loginForm(pending, csrf);
});

oauthRoutes.post('/authorize', async (c) => {
  const logger = createLogger();
  if (isCrossOrigin(c.req.raw)) {
    return page('Blocked', 'Request origin not recognized.', 403);
  }

  const form = await c.req.formData();
  const csrf = form.get('csrf');
  const csrfCookie = readCookie(c.req.raw, CSRF_COOKIE) ?? '';
  if (typeof csrf !== 'string' || csrf === '' || !timingSafeEqual(csrf, csrfCookie)) {
    return page('Session expired', 'That sign-in form is stale. Start connecting again.', 403);
  }
  const raw = await c.env.OAUTH_KV.get(`oauth-login:${csrf}`);
  if (raw === null) {
    return page('Session expired', 'That sign-in form is stale. Start connecting again.', 403);
  }
  const pending = JSON.parse(raw) as PendingLogin;

  if (form.get('decision') !== 'approve') {
    await c.env.OAUTH_KV.delete(`oauth-login:${csrf}`);
    return page('Not connected', 'Nothing was shared. You can close this page.');
  }

  const ip = clientIp(c.req.raw);
  if (!(await admitLoginAttempt(c.env.DB, ip))) {
    logger.warn('MCP sign-in rate limited', { ip });
    return page(
      'Too many attempts',
      'Too many sign-in attempts. Wait 15 minutes and try again.',
      429,
    );
  }

  const username = form.get('username');
  const password = form.get('password');
  if (
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    !(await checkCredentials(c.env, username, password))
  ) {
    logger.warn('MCP sign-in failed', { ip });
    return loginForm(pending, csrf, 'Wrong username or password.');
  }

  const fingerprint = await credentialFingerprint(c.env);
  if (fingerprint === null) {
    return page('Not configured', 'MCP sign-in is not configured on this deployment.', 503);
  }
  await c.env.OAUTH_KV.delete(`oauth-login:${csrf}`);
  await clearLoginAttempts(c.env.DB, ip);

  const props: McpGrantProps = { username, fingerprint };
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.oauthReqInfo,
    userId: username,
    scope: pending.oauthReqInfo.scope,
    props,
    metadata: { label: pending.clientName },
  });
  return Response.redirect(redirectTo, 302);
});
