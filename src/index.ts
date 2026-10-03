import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { Hono } from 'hono';
// @ts-expect-error - Workers Sites manifest is auto-generated
import manifest from '__STATIC_CONTENT_MANIFEST';
import type { Env } from './types/index.js';
import { MIME_TYPES } from './types/constants.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/security.js';
import { basicAuth } from './middleware/auth.js';
import { createLogger } from './utils/logger.js';
import { GmailService } from './services/gmail.js';
import { SyncService, getSyncStatus } from './services/sync.js';
import { isMcpAuthConfigured } from './auth/oidc.js';
import { OAUTH_ROUTE_PATHS, oauthRoutes } from './auth/oauthRoutes.js';
import { handleMcpRequest } from './mcp/handler.js';

// Import API routes
import companiesRoutes from './routes/api/companies.js';
import contactsRoutes from './routes/api/contacts.js';
import blacklistRoutes from './routes/api/blacklist.js';
import syncRoutes from './routes/api/sync.js';

// Import page routes
import dashboardPages from './routes/pages/dashboard.js';
import companiesPages from './routes/pages/companies.js';
import contactsPages from './routes/pages/contacts.js';
import blacklistPages from './routes/pages/blacklist.js';

// Create app with typed environment
const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', errorHandler);
app.use('*', securityHeaders);

// Request logging middleware
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  const logger = createLogger(requestId);

  logger.info('Request started', {
    method: c.req.method,
    path: c.req.path,
  });

  const start = Date.now();
  await next();
  const duration = Date.now() - start;

  logger.info('Request completed', {
    status: c.res.status,
    duration,
  });
});

// Serve static files with correct MIME types
app.get('/static/:filename', async (c) => {
  const filename = c.req.param('filename');
  const assetNamespace = c.env.__STATIC_CONTENT;

  if (assetNamespace === undefined) {
    return c.text('Static assets not configured', 500);
  }

  try {
    // Parse manifest to find the hashed filename
    // Workers Sites manifest format: { "styles.css": "styles.abc123.css" }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const assetManifest: Record<string, string> = JSON.parse(manifest as string);
    const hashedName = assetManifest[filename];
    const actualFilename = hashedName ?? filename;

    // Get from KV
    const content = await assetNamespace.get(actualFilename, 'arrayBuffer');
    if (content === null) {
      return c.text('Not found', 404);
    }

    // Determine MIME type from extension
    const ext = filename.substring(filename.lastIndexOf('.'));
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return c.text('Not found', 404);
  }
});

// Health check (no auth required) - includes sync status
app.get('/health', async (c) => {
  try {
    // Get last sync times from sync_state table
    const syncStates = await c.env.DB.prepare(
      'SELECT account, last_sync, last_history_id FROM sync_state',
    ).all<{ account: string; last_sync: string | null; last_history_id: string | null }>();

    const workSync = syncStates.results.find((s) => s.account === 'work');
    const personalSync = syncStates.results.find((s) => s.account === 'personal');

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sync: {
        work: {
          lastSync: workSync?.last_sync ?? null,
          hasHistoryId: workSync?.last_history_id !== null,
        },
        personal: {
          lastSync: personalSync?.last_sync ?? null,
          hasHistoryId: personalSync?.last_history_id !== null,
        },
      },
    });
  } catch {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sync: null,
      note: 'Database not initialized',
    });
  }
});

// Auth required for all other routes
app.use('/api/*', basicAuth);
app.use('/*', basicAuth);

// API Routes
app.route('/api/companies', companiesRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/blacklist', blacklistRoutes);
app.route('/api/sync', syncRoutes);

// Page Routes (HTMX)
app.route('/', dashboardPages);
app.route('/companies', companiesPages);
app.route('/contacts', contactsPages);
app.route('/blacklist', blacklistPages);

// === Sync Result Type ===
interface SyncRunResult {
  account: string;
  type: string;
  batches: number;
  messagesProcessed: number;
  elapsedMs: number;
}

// Time limit per account - with parallel execution, can use more of 30s CPU limit
const MAX_RUNTIME_PER_ACCOUNT_MS = 20000;

/**
 * Run sync for a single account with batch looping for catch-up
 */
async function runAccountSync(
  env: Env,
  account: 'work' | 'personal',
  refreshToken: string,
  myEmail: string,
  logger: ReturnType<typeof createLogger>,
): Promise<SyncRunResult | null> {
  const accountStart = Date.now();
  let batchCount = 0;
  let totalMessages = 0;

  try {
    const gmail = new GmailService({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken,
    });
    const syncService = new SyncService({
      gmail,
      db: env.DB,
      kv: env.KV,
      myEmail,
      account,
    });

    // Check if we've caught up (batch sync complete)
    const status = await getSyncStatus(env.DB);
    const accountStatus = status.find((s) => s.account === account);
    const today = new Date().toISOString().slice(0, 10);

    // Caught up = current processing date is past today
    const hasCaughtUp =
      accountStatus?.batchCurrentDate !== null &&
      accountStatus?.batchCurrentDate !== undefined &&
      accountStatus.batchCurrentDate > today;

    if (hasCaughtUp) {
      // Incremental sync for new messages (single run)
      const result = await syncService.incrementalSync();
      return {
        account,
        type: 'incremental',
        batches: 1,
        messagesProcessed: result.messagesProcessed,
        elapsedMs: Date.now() - accountStart,
      };
    }

    // Batch sync loop - process multiple batches until time limit
    let hasMore = true;
    while (hasMore && Date.now() - accountStart < MAX_RUNTIME_PER_ACCOUNT_MS) {
      const result = await syncService.batchSync();
      batchCount++;
      totalMessages += result.messagesProcessed;
      hasMore = result.hasMore;

      // Log progress every 5 batches
      if (batchCount % 5 === 0) {
        logger.info(`${account} sync progress`, {
          batches: batchCount,
          messagesProcessed: totalMessages,
          currentDate: result.currentDate,
          elapsedMs: Date.now() - accountStart,
        });
      }
    }

    return {
      account,
      type: 'batch',
      batches: batchCount,
      messagesProcessed: totalMessages,
      elapsedMs: Date.now() - accountStart,
    };
  } catch (error) {
    logger.error(`${account} sync failed`, {
      error: error instanceof Error ? error.message : String(error),
      batchesCompleted: batchCount,
      messagesProcessed: totalMessages,
    });

    // Return partial progress if any batches completed
    if (batchCount > 0) {
      return {
        account,
        type: 'batch-partial',
        batches: batchCount,
        messagesProcessed: totalMessages,
        elapsedMs: Date.now() - accountStart,
      };
    }
    return null;
  }
}

// Scheduled handler for cron jobs
const scheduled: ExportedHandlerScheduledHandler<Env> = (event, env, ctx) => {
  const logger = createLogger();
  logger.info('Cron job started', { cron: event.cron });

  const runSync = async (): Promise<void> => {
    // Run both accounts in parallel for faster throughput
    const syncPromises: Promise<SyncRunResult | null>[] = [];

    // Work account (credentials are required)
    syncPromises.push(
      runAccountSync(env, 'work', env.GMAIL_REFRESH_TOKEN_WORK, env.MY_EMAIL_WORK, logger),
    );

    // Personal account (credentials are optional)
    if (env.GMAIL_REFRESH_TOKEN_PERSONAL !== undefined && env.MY_EMAIL_PERSONAL !== undefined) {
      syncPromises.push(
        runAccountSync(env, 'personal', env.GMAIL_REFRESH_TOKEN_PERSONAL, env.MY_EMAIL_PERSONAL, logger),
      );
    }

    const results = (await Promise.all(syncPromises)).filter((r): r is SyncRunResult => r !== null);
    logger.info('Cron job completed', { results });
  };

  ctx.waitUntil(runSync());
};

// === MCP surface ===
// OAuthProvider owns /mcp (bearer-token gated), /token, /register and the OAuth metadata
// endpoints. /authorize and /callback run the Cloudflare Access sign-in outside the
// main app's Basic auth; everything else falls through to the Hono app unchanged.
let oauthProvider: OAuthProvider<Env> | undefined;

function getOAuthProvider(publicUrl: string): OAuthProvider<Env> {
  oauthProvider ??= new OAuthProvider<Env>({
    apiRoute: ['/mcp'],
    apiHandler: { fetch: handleMcpRequest },
    defaultHandler: {
      fetch: (request, env, ctx): Response | Promise<Response> =>
        OAUTH_ROUTE_PATHS.includes(new URL(request.url).pathname)
          ? oauthRoutes.fetch(request, env, ctx)
          : app.fetch(request, env, ctx),
    },
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: ['openid', 'profile', 'email'],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 3600,
    resourceMetadata: {
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      resource_name: 'sigparser',
    },
  });
  return oauthProvider;
}

const fetch: ExportedHandlerFetchHandler<Env> = (request, env, ctx) => {
  // Until the Access OIDC app and allowlist are configured, MCP is off: /mcp gets a clear 503
  // and every other request goes straight to the app as before.
  if (isMcpAuthConfigured(env) && env.PUBLIC_URL !== undefined && env.PUBLIC_URL !== '') {
    return getOAuthProvider(env.PUBLIC_URL).fetch(request, env, ctx);
  }
  if (new URL(request.url).pathname.startsWith('/mcp')) {
    return Response.json({ error: 'MCP is unavailable: OAuth is not configured' }, { status: 503 });
  }
  return app.fetch(request, env, ctx);
};

export default {
  fetch,
  scheduled,
};
