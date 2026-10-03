import { createMcpHandler } from 'agents/mcp/server';
import type { Env } from '../types/index.js';
import { createMcpServer } from './server.js';

/**
 * The `/mcp` request handler. MCP v2 is stateless, so `createMcpHandler` takes a factory
 * and builds a fresh server per request. Only reached through OAuthProvider, which has
 * already validated the bearer token.
 */
export function handleMcpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return createMcpHandler(() => createMcpServer(env))(request, env, ctx);
}
