import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from '../types/index.js';
import { credentialFingerprint, grantPropsOf, timingSafeEqual } from '../auth/password.js';
import { createMcpServer } from './server.js';

/**
 * The `/mcp` request handler. MCP v2 is stateless, so `createMcpHandler` takes a factory
 * and builds a fresh server per request. Only reached through OAuthProvider, which has
 * already validated the bearer token.
 *
 * Every request also checks that the grant was approved with the credentials that are
 * configured now, so changing AUTH_PASSWORD signs out every connected client.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const props = grantPropsOf(ctx);
  const current = await credentialFingerprint(env);
  if (props === null || current === null || !timingSafeEqual(props.fingerprint, current)) {
    return Response.json(
      { error: 'forbidden', message: 'Sign in to sigparser again' },
      { status: 403 },
    );
  }
  return createMcpHandler(() => createMcpServer(env))(request, env, ctx);
}
