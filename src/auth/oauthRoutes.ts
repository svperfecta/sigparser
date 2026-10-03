import type { OAuthHelpers, AuthRequest } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
import type { Env } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { allowedEmails, exchangeOidcCode, resolveOidcProvider, type UserProps } from './oidc.js';

/**
 * OAuth endpoints for MCP clients: `/authorize` (302 to Cloudflare Access), `/callback`
 * (GET: verify the ID token, show consent; POST: complete the grant).
 *
 * These are reached outside the main app's Basic auth: the OAuth flow is its own gate.
 * Completing the grant on GET would be a confused deputy, so consent POSTs with a CSRF
 * token bound to a SameSite=Strict cookie.
 */

type OAuthBindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

export const OAUTH_ROUTE_PATHS = ['/authorize', '/callback'];

export const oauthRoutes = new Hono<{ Bindings: OAuthBindings }>();

const CSRF_COOKIE = 'sigparser_consent_csrf';
const STATE_TTL_SECONDS = 300;
const CONSENT_TTL_SECONDS = 600;

const PAGE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

interface PendingAuth {
  oauthReqInfo: AuthRequest;
  codeVerifier: string;
  nonce: string;
}

interface PendingConsent {
  userProps: UserProps;
  oauthReqInfo: AuthRequest;
}

function randomToken(bytes = 32): string {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);
  return base64Url(array);
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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

function shell(title: string, inner: string): string {
  return (
    `<!doctype html><html lang=en><head><meta charset=utf-8>` +
    `<meta name=viewport content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>` +
    `<style>body{min-height:100vh;display:grid;place-items:center;margin:0;padding:16px;font-family:system-ui,sans-serif;background:#f6f7f9;color:#111}` +
    `.card{max-width:420px;padding:28px;background:#fff;border:1px solid #e3e5e8;border-radius:12px}` +
    `h1{font-size:1.3rem;margin:0 0 12px}p{color:#444;line-height:1.5}` +
    `.dest{font-family:ui-monospace,monospace;font-size:12px;word-break:break-all;background:#f1f2f4;padding:8px;border-radius:6px}` +
    `.warn{padding:10px;border-radius:6px;background:#fff6e5;color:#7a4a00;font-size:13px}` +
    `button{display:block;width:100%;margin-top:8px;padding:11px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}` +
    `button.secondary{background:#e3e5e8;color:#111}</style></head><body>${inner}</body></html>`
  );
}

function page(title: string, body: string, status = 200): Response {
  const inner = `<div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></div>`;
  return new Response(shell(title, inner), { status, headers: PAGE_HEADERS });
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

  const provider = resolveOidcProvider(c.env);
  if (provider === null) {
    return page('Not configured', 'MCP sign-in is not configured on this deployment.', 503);
  }

  const codeVerifier = randomToken();
  const state = randomToken(24);
  const nonce = randomToken(24);
  const pending: PendingAuth = { oauthReqInfo, codeVerifier, nonce };
  await c.env.OAUTH_KV.put(`oauth-state:${state}`, JSON.stringify(pending), {
    expirationTtl: STATE_TTL_SECONDS,
  });

  const authUrl = new URL(provider.authorizeUrl);
  authUrl.searchParams.set('client_id', provider.clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', provider.scope);
  authUrl.searchParams.set('redirect_uri', `${new URL(c.req.url).origin}/callback`);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('nonce', nonce);
  authUrl.searchParams.set('code_challenge', await codeChallengeFor(codeVerifier));
  authUrl.searchParams.set('code_challenge_method', 'S256');
  return c.redirect(authUrl.toString());
});

oauthRoutes.get('/callback', async (c) => {
  const logger = createLogger();
  const code = c.req.query('code');
  const state = c.req.query('state');
  const error = c.req.query('error');

  if (error !== undefined) {
    logger.warn('OIDC callback error', { error });
    return page('Sign-in failed', 'Could not complete sign-in. Try connecting again.', 400);
  }
  if (code === undefined || state === undefined) {
    return page('Sign-in failed', 'Missing code or state. Try connecting again.', 400);
  }

  const provider = resolveOidcProvider(c.env);
  if (provider === null) {
    return page('Not configured', 'MCP sign-in is not configured on this deployment.', 503);
  }

  const raw = await c.env.OAUTH_KV.get(`oauth-state:${state}`);
  if (raw === null) {
    return page('Session expired', 'That sign-in is stale. Start connecting again.', 400);
  }
  await c.env.OAUTH_KV.delete(`oauth-state:${state}`);
  const pending = JSON.parse(raw) as PendingAuth;

  const result = await exchangeOidcCode(
    provider,
    code,
    `${new URL(c.req.url).origin}/callback`,
    pending.codeVerifier,
    pending.nonce,
  );
  if ('error' in result) {
    logger.warn('OIDC exchange failed', { error: result.error });
    return page('Sign-in failed', 'Could not complete sign-in. Try connecting again.', 500);
  }

  // Defense in depth: the Access policy should already restrict who can sign in.
  if (!allowedEmails(c.env).includes(result.userProps.email)) {
    logger.warn('MCP sign-in refused for email not in MCP_ALLOWED_EMAILS', {
      email: result.userProps.email,
    });
    return page('Not allowed', 'This account is not allowed to connect to sigparser.', 403);
  }

  const csrf = randomToken(24);
  const consent: PendingConsent = {
    userProps: result.userProps,
    oauthReqInfo: pending.oauthReqInfo,
  };
  await c.env.OAUTH_KV.put(`oauth-consent:${csrf}`, JSON.stringify(consent), {
    expirationTtl: CONSENT_TTL_SECONDS,
  });

  const clientInfo = await c.env.OAUTH_PROVIDER.lookupClient(pending.oauthReqInfo.clientId);
  const clientName = clientInfo?.clientName ?? pending.oauthReqInfo.clientId;
  const inner =
    `<div class="card"><h1>Connect ${escapeHtml(clientName)}?</h1>` +
    `<p>It will act as <strong>${escapeHtml(result.userProps.email)}</strong> and can read your sigparser contacts.</p>` +
    `<p>Access will be sent to:</p><p class="dest">${escapeHtml(pending.oauthReqInfo.redirectUri)}</p>` +
    `<p class="warn">Only continue if you started this yourself.</p>` +
    `<form method="post" action="/callback"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">` +
    `<button name="decision" value="approve">Connect</button>` +
    `<button class="secondary" name="decision" value="deny">Cancel</button></form></div>`;
  return new Response(shell('sigparser · connect an app', inner), {
    headers: {
      ...PAGE_HEADERS,
      'Set-Cookie': `${CSRF_COOKIE}=${csrf}; Path=/callback; HttpOnly; Secure; SameSite=Strict; Max-Age=${CONSENT_TTL_SECONDS}`,
    },
  });
});

oauthRoutes.post('/callback', async (c) => {
  if (isCrossOrigin(c.req.raw)) {
    return page('Blocked', 'Request origin not recognized.', 403);
  }
  const form = await c.req.formData();
  const csrfField = form.get('csrf');
  const csrfCookie = readCookie(c.req.raw, CSRF_COOKIE) ?? '';
  if (
    typeof csrfField !== 'string' ||
    csrfField === '' ||
    !timingSafeEqual(csrfField, csrfCookie)
  ) {
    return page('Session expired', 'That consent form is stale. Start connecting again.', 403);
  }
  const raw = await c.env.OAUTH_KV.get(`oauth-consent:${csrfField}`);
  if (raw === null) {
    return page('Session expired', 'That consent form is stale. Start connecting again.', 403);
  }
  await c.env.OAUTH_KV.delete(`oauth-consent:${csrfField}`);

  if (form.get('decision') !== 'approve') {
    return page('Not connected', 'Nothing was shared. You can close this page.');
  }

  const { userProps, oauthReqInfo } = JSON.parse(raw) as PendingConsent;
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: userProps.sub,
    scope: oauthReqInfo.scope,
    props: userProps,
    metadata: { label: userProps.email },
  });
  return Response.redirect(redirectTo, 302);
});
