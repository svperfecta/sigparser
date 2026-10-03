/**
 * OIDC sign-in for MCP `/authorize`, using a Cloudflare Access for SaaS (OIDC) application
 * as the identity provider. Access handles the actual login (one-time PIN, Google, ...),
 * so sigparser needs no Okta. Same approach as marvin in rocketsciencegg/bots.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../types/index.js';

export interface UserProps {
  email: string;
  name: string;
  sub: string;
}

export interface OidcProvider {
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  issuer: string;
  jwksUri: string;
  scope: string;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(uri);
  if (jwks === undefined) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, jwks);
  }
  return jwks;
}

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** True when every secret the MCP OAuth flow needs is present. */
export function isMcpAuthConfigured(env: Env): boolean {
  return resolveOidcProvider(env) !== null && allowedEmails(env).length > 0;
}

export function resolveOidcProvider(env: Env): OidcProvider | null {
  const { ACCESS_OIDC_CLIENT_ID, ACCESS_OIDC_CLIENT_SECRET, ACCESS_TEAM_DOMAIN } = env;
  if (
    !isSet(ACCESS_OIDC_CLIENT_ID) ||
    !isSet(ACCESS_OIDC_CLIENT_SECRET) ||
    !isSet(ACCESS_TEAM_DOMAIN)
  ) {
    return null;
  }
  const host = ACCESS_TEAM_DOMAIN.includes('.')
    ? ACCESS_TEAM_DOMAIN
    : `${ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
  const base = `https://${host}/cdn-cgi/access/sso/oidc/${ACCESS_OIDC_CLIENT_ID}`;
  return {
    authorizeUrl: `${base}/authorization`,
    tokenUrl: `${base}/token`,
    clientId: ACCESS_OIDC_CLIENT_ID,
    clientSecret: ACCESS_OIDC_CLIENT_SECRET,
    issuer: base,
    jwksUri: `${base}/jwks`,
    scope: 'openid profile email',
  };
}

/** Lower-cased emails allowed to connect MCP clients. Empty means nobody. */
export function allowedEmails(env: Env): string[] {
  return (env.MCP_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
}

/**
 * Exchange an authorization code for a verified identity. jose checks iss/aud/exp via JWKS.
 * Returns `{ error }` rather than throwing so `/callback` can log and show a generic page.
 */
export async function exchangeOidcCode(
  provider: OidcProvider,
  code: string,
  redirectUri: string,
  codeVerifier: string,
  expectedNonce: string,
): Promise<{ userProps: UserProps } | { error: string }> {
  const tokenResponse = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${provider.clientId}:${provider.clientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenResponse.ok) {
    return {
      error: `OIDC token exchange failed: ${tokenResponse.status} ${await tokenResponse.text()}`,
    };
  }
  const tokens: { id_token?: string } = await tokenResponse.json();
  if (tokens.id_token === undefined) {
    return { error: 'OIDC returned no id_token' };
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token, jwksFor(provider.jwksUri), {
      issuer: provider.issuer,
      audience: provider.clientId,
    }));
  } catch (e) {
    return {
      error: `OIDC ID token verification failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Access for SaaS can omit the nonce; enforce it only when present.
  if (typeof payload.nonce === 'string' && payload.nonce !== expectedNonce) {
    return { error: 'OIDC ID token nonce mismatch' };
  }

  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  if (email === '') {
    return { error: 'OIDC ID token had no email' };
  }
  const name = typeof payload.name === 'string' && payload.name !== '' ? payload.name : email;
  const sub = typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : email;
  return { userProps: { email, name, sub } };
}
