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

const MAX_FAILURES = 5;
const FAILURE_WINDOW_SECONDS = 15 * 60;

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

/** True if this client may still try a password (fewer than MAX_FAILURES in the window). */
export async function canAttemptLogin(kv: KVNamespace, clientIp: string): Promise<boolean> {
  const raw = await kv.get(`mcp-login-fail:${clientIp}`);
  return raw === null || Number(raw) < MAX_FAILURES;
}

export async function recordFailedLogin(kv: KVNamespace, clientIp: string): Promise<void> {
  const key = `mcp-login-fail:${clientIp}`;
  const raw = await kv.get(key);
  const count = raw === null ? 1 : Number(raw) + 1;
  await kv.put(key, String(count), { expirationTtl: FAILURE_WINDOW_SECONDS });
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
