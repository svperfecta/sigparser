import { Hono } from 'hono';
// @ts-expect-error - Workers Sites manifest is auto-generated
import manifest from '__STATIC_CONTENT_MANIFEST';
import type { Env } from './types/index.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/security.js';
import { basicAuth } from './middleware/auth.js';
import { createLogger } from './utils/logger.js';
import { GmailService } from './services/gmail.js';
import { SyncService, getSyncStatus } from './services/sync.js';

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
    const assetManifest = JSON.parse(manifest) as Record<string, string>;
    const hashedName = assetManifest[filename];
    const actualFilename = hashedName ?? filename;

    // Get from KV
    const content = await assetNamespace.get(actualFilename, 'arrayBuffer');
    if (content === null) {
      return c.text('Not found', 404);
    }

    // Determine MIME type
    let contentType = 'application/octet-stream';
    if (filename.endsWith('.css')) {
      contentType = 'text/css';
    } else if (filename.endsWith('.js')) {
      contentType = 'application/javascript';
    } else if (filename.endsWith('.html')) {
      contentType = 'text/html';
    } else if (filename.endsWith('.svg')) {
      contentType = 'image/svg+xml';
    }

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
      'SELECT account, last_sync_at, last_history_id FROM sync_state',
    ).all<{ account: string; last_sync_at: string | null; last_history_id: string | null }>();

    const workSync = syncStates.results?.find((s) => s.account === 'work');
    const personalSync = syncStates.results?.find((s) => s.account === 'personal');

    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      sync: {
        work: {
          lastSync: workSync?.last_sync_at ?? null,
          hasHistoryId: workSync?.last_history_id !== null,
        },
        personal: {
          lastSync: personalSync?.last_sync_at ?? null,
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

// Scheduled handler for cron jobs
const scheduled: ExportedHandlerScheduledHandler<Env> = (event, env, ctx) => {
  const logger = createLogger();
  logger.info('Cron job started', { cron: event.cron });

  // Run batch sync for both accounts
  const runSync = async (): Promise<void> => {
    const results = [];

    // Work account
    if (env.GMAIL_REFRESH_TOKEN_WORK !== undefined && env.MY_EMAIL_WORK !== undefined) {
      try {
        const gmail = new GmailService({
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          refreshToken: env.GMAIL_REFRESH_TOKEN_WORK,
        });
        const syncService = new SyncService({
          gmail,
          db: env.DB,
          myEmail: env.MY_EMAIL_WORK,
          account: 'work',
        });

        // Check if we have a history ID (already synced before)
        const status = await getSyncStatus(env.DB);
        const workStatus = status.find((s) => s.account === 'work');

        if (workStatus?.lastHistoryId !== null) {
          // Incremental sync
          const result = await syncService.incrementalSync();
          results.push({ account: 'work', type: 'incremental', ...result });
        } else {
          // Batch sync for initial catch-up (500 messages)
          const result = await syncService.batchSync(500);
          results.push({ account: 'work', type: 'batch', ...result });
        }
      } catch (error) {
        logger.error('Work sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Personal account
    if (env.GMAIL_REFRESH_TOKEN_PERSONAL !== undefined && env.MY_EMAIL_PERSONAL !== undefined) {
      try {
        const gmail = new GmailService({
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
          refreshToken: env.GMAIL_REFRESH_TOKEN_PERSONAL,
        });
        const syncService = new SyncService({
          gmail,
          db: env.DB,
          myEmail: env.MY_EMAIL_PERSONAL,
          account: 'personal',
        });

        const status = await getSyncStatus(env.DB);
        const personalStatus = status.find((s) => s.account === 'personal');

        if (personalStatus?.lastHistoryId !== null) {
          const result = await syncService.incrementalSync();
          results.push({ account: 'personal', type: 'incremental', ...result });
        } else {
          const result = await syncService.batchSync(500);
          results.push({ account: 'personal', type: 'batch', ...result });
        }
      } catch (error) {
        logger.error('Personal sync failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Cron job completed', { results });
  };

  ctx.waitUntil(runSync());
};

export default {
  fetch: app.fetch,
  scheduled,
};
