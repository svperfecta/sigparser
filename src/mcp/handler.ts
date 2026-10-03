import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from '../types/index.js';
import { allowedEmails } from '../auth/oidc.js';
import { createMcpServer } from './server.js';

/** Email of the grant OAuthProvider validated, from `ctx.props` (set at /callback). */
function grantEmail(ctx: ExecutionContext): string | null {
  const props = (ctx as ExecutionContext & { props?: unknown }).props;
  if (typeof props !== 'object' || props === null || !('email' in props)) {
    return null;
  }
  return typeof props.email === 'string' ? props.email.toLowerCase() : null;
}

/**
 * The `/mcp` request handler. MCP v2 is stateless, so `createMcpHandler` takes a factory
 * and builds a fresh server per request. Only reached through OAuthProvider, which has
 * already validated the bearer token.
 *
 * The allowlist is checked again on every request, not only at sign-in, so removing an
 * address from MCP_ALLOWED_EMAILS cuts off its existing tokens immediately.
 */
export function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const email = grantEmail(ctx);
  if (email === null || !allowedEmails(env).includes(email)) {
    return Promise.resolve(
      Response.json(
        { error: 'forbidden', message: 'This account may not use sigparser MCP' },
        { status: 403 },
      ),
    );
  }
  return createMcpHandler(() => createMcpServer(env))(request, env, ctx);
}
