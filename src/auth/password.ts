import type { Env } from '../types/index.js';

/**
 * MCP sign-in with the same AUTH_USERNAME / AUTH_PASSWORD as the web UI.
 *
 * A grant stores a fingerprint of the credentials it was approved with, and every /mcp request
 * re-checks it, so changing the password signs out every connected client.
 */

export interface McpGrantProps {
  username: string;
  fingerprint: string;
}

const MAX_ATTEMPTS_PER_CLIENT = 5;
// sigparser has one user, so a global cap is the real brute-force bound: rotating IPs does not help.
const MAX_ATTEMPTS_GLOBAL = 20;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function isSet(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

/** True when the web UI credentials exist; MCP is off (503) without them. */
export function isMcpAuthConfigured(env: Env): boolean {
  return isSet(env.AUTH_USERNAME) && isSet(env.AUTH_PASSWORD);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Fingerprint of the current credentials, or null when they are not configured. */
export async function credentialFingerprint(env: Env): Promise<string | null> {
  if (!isSet(env.AUTH_USERNAME) || !isSet(env.AUTH_PASSWORD)) {
    return null;
  }
  return sha256Hex(`sigparser-mcp\u0000${env.AUTH_USERNAME}\u0000${env.AUTH_PASSWORD}`);
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Compare submitted credentials with the configured ones. Hashing both sides first keeps the
 * comparison constant-time regardless of input length.
 */
export async function checkCredentials(
  env: Env,
  username: string,
  password: string,
): Promise<boolean> {
  if (!isSet(env.AUTH_USERNAME) || !isSet(env.AUTH_PASSWORD)) {
    return false;
  }
  const [givenUser, givenPass, wantUser, wantPass] = await Promise.all([
    sha256Hex(username),
    sha256Hex(password),
    sha256Hex(env.AUTH_USERNAME),
    sha256Hex(env.AUTH_PASSWORD),
  ]);
  // Evaluate both so timing does not reveal which half was wrong.
  const userOk = timingSafeEqual(givenUser, wantUser);
  const passOk = timingSafeEqual(givenPass, wantPass);
  return userOk && passOk;
}

/**
 * Rate-limit key for a client IP. IPv6 is grouped by /64, since one host can hold a whole /64.
 */
export function clientKey(ip: string): string {
  if (!ip.includes(':')) {
    return `ip:${ip}`;
  }
  const groups = ip.split('::')[0]?.split(':') ?? [];
  return `ip6:${groups.slice(0, 4).join(':')}`;
}

/** Atomically count one attempt against `key` and return the count in the current window. */
async function countAttempt(db: D1Database, key: string, now: number): Promise<number> {
  const windowStart = now - ATTEMPT_WINDOW_MS;
  const row = await db
    .prepare(
      `INSERT INTO login_attempts (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
       RETURNING count`,
    )
    .bind(key, now, windowStart)
    .first<{ count: number }>();
  return row?.count ?? Number.POSITIVE_INFINITY;
}

/**
 * Count a sign-in attempt BEFORE the password is checked, per client and globally, and say
 * whether it may proceed. Counting first means a burst of parallel guesses cannot slip past.
 */
export async function admitLoginAttempt(
  db: D1Database,
  clientIp: string,
  now = Date.now(),
): Promise<boolean> {
  const [perClient, global] = await Promise.all([
    countAttempt(db, clientKey(clientIp), now),
    countAttempt(db, 'global', now),
  ]);
  return perClient <= MAX_ATTEMPTS_PER_CLIENT && global <= MAX_ATTEMPTS_GLOBAL;
}

/** After a successful sign-in, clear that client's counter (the global one keeps its window). */
export async function clearLoginAttempts(db: D1Database, clientIp: string): Promise<void> {
  await db.prepare('DELETE FROM login_attempts WHERE key = ?').bind(clientKey(clientIp)).run();
}

/** Grant props from ctx.props, if they have the expected shape. */
export function grantPropsOf(ctx: ExecutionContext): McpGrantProps | null {
  const props = (ctx as ExecutionContext & { props?: unknown }).props;
  if (typeof props !== 'object' || props === null) {
    return null;
  }
  const { username, fingerprint } = props as Partial<McpGrantProps>;
  return typeof username === 'string' && typeof fingerprint === 'string'
    ? { username, fingerprint }
    : null;
}
