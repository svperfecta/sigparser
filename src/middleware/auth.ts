import type { Context, Next } from 'hono';
import { UnauthorizedError } from './error.js';

interface CloudflareAccessJWT {
  email: string;
  sub: string;
  iat: number;
  exp: number;
}

declare module 'hono' {
  interface ContextVariableMap {
    userEmail: string;
  }
}

export async function verifyCloudflareAccess(c: Context, next: Next): Promise<Response | undefined> {
  const jwt = c.req.header('Cf-Access-Jwt-Assertion');

  if (jwt === undefined || jwt === '') {
    throw new UnauthorizedError('Missing Cloudflare Access JWT');
  }

  try {
    // Cloudflare Access validates the JWT automatically at the edge
    // We just need to extract the claims from the payload
    const parts = jwt.split('.');
    const payloadPart = parts[1];
    if (payloadPart === undefined) {
      throw new UnauthorizedError('Invalid JWT format');
    }

    const payload = JSON.parse(atob(payloadPart)) as CloudflareAccessJWT;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      throw new UnauthorizedError('JWT has expired');
    }

    c.set('userEmail', payload.email);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      throw error;
    }
    throw new UnauthorizedError('Invalid JWT');
  }

  await next();
  return undefined;
}
