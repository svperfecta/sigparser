import type { Context, Next } from 'hono';

declare module 'hono' {
  interface ContextVariableMap {
    userEmail: string;
    requestId: string;
  }
}

/**
 * Basic auth middleware
 * Uses AUTH_USERNAME and AUTH_PASSWORD from environment (defaults to admin/admin for dev)
 */
export async function basicAuth(c: Context, next: Next): Promise<Response | void> {
  // Skip auth for static files and health check
  const path = c.req.path;
  if (path.startsWith('/static/') || path === '/health') {
    await next();
    return;
  }

  // Development bypass - skip auth when running locally
  const host = c.req.header('Host') ?? '';
  if (host.includes('localhost')) {
    c.set('userEmail', 'dev@localhost');
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization');

  if (authHeader === undefined || !authHeader.startsWith('Basic ')) {
    return new Response('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="sigparser"',
      },
    });
  }

  try {
    const base64Credentials = authHeader.slice(6);
    const credentials = atob(base64Credentials);
    const [username, password] = credentials.split(':');

    // Get credentials from environment or use defaults
    const env = c.env as { AUTH_USERNAME?: string; AUTH_PASSWORD?: string };
    const expectedUsername = env.AUTH_USERNAME ?? 'admin';
    const expectedPassword = env.AUTH_PASSWORD ?? 'admin';

    if (username !== expectedUsername || password !== expectedPassword) {
      return new Response('Invalid credentials', {
        status: 401,
        headers: {
          'WWW-Authenticate': 'Basic realm="sigparser"',
        },
      });
    }

    c.set('userEmail', username);
  } catch {
    return new Response('Invalid authorization header', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="sigparser"',
      },
    });
  }

  await next();
}
