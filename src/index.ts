import { Hono } from 'hono';
import type { Env } from './types/index.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/security.js';
import { verifyCloudflareAccess } from './middleware/auth.js';
import { createLogger } from './utils/logger.js';

// Create app with typed environment
const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use('*', errorHandler);
app.use('*', securityHeaders);

// Request logging middleware
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
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

// Serve static files from KV (configured in wrangler.toml [site])
// Static files are automatically served by Cloudflare Workers Sites

// Health check (no auth required)
app.get('/health', (c) => {
  return c.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth required for all other routes
app.use('/api/*', verifyCloudflareAccess);
app.use('/*', verifyCloudflareAccess);

// API Routes
app.get('/api/companies', (c) => {
  // TODO: Implement companies list
  return c.json({ data: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 } });
});

app.get('/api/companies/:id', (c) => {
  const id = c.req.param('id');
  // TODO: Implement company detail
  return c.json({ data: { id } });
});

app.get('/api/contacts', (c) => {
  // TODO: Implement contacts list
  return c.json({ data: [], pagination: { page: 1, limit: 25, total: 0, totalPages: 0 } });
});

app.get('/api/contacts/:id', (c) => {
  const id = c.req.param('id');
  // TODO: Implement contact detail
  return c.json({ data: { id } });
});

app.get('/api/blacklist', (c) => {
  // TODO: Implement blacklist list
  return c.json({ data: [] });
});

app.post('/api/blacklist', (c) => {
  // TODO: Implement blacklist add
  return c.json({ success: true });
});

app.delete('/api/blacklist/:domain', (c) => {
  const domain = c.req.param('domain');
  // TODO: Implement blacklist remove
  return c.json({ success: true, domain });
});

app.get('/api/sync/status', (c) => {
  // TODO: Implement sync status
  return c.json({
    data: [
      { account: 'work', lastSync: null, lastHistoryId: null },
      { account: 'personal', lastSync: null, lastHistoryId: null },
    ],
  });
});

app.post('/api/sync/trigger', (c) => {
  // TODO: Implement sync trigger
  return c.json({ success: true, message: 'Sync triggered' });
});

// Page Routes (HTMX)
app.get('/', (c) => {
  // TODO: Implement dashboard page
  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>sigparser</title>
      <link rel="stylesheet" href="/static/styles.css">
      <script src="/static/htmx.min.js"></script>
    </head>
    <body>
      <div class="container">
        <h1>sigparser</h1>
        <p>Dashboard coming soon...</p>
        <p>User: ${c.get('userEmail')}</p>
      </div>
    </body>
    </html>
  `);
});

app.get('/companies', (c) => {
  // TODO: Implement companies page
  return c.html('<h1>Companies</h1><p>Coming soon...</p>');
});

app.get('/contacts', (c) => {
  // TODO: Implement contacts page
  return c.html('<h1>Contacts</h1><p>Coming soon...</p>');
});

app.get('/blacklist', (c) => {
  // TODO: Implement blacklist page
  return c.html('<h1>Blacklist</h1><p>Coming soon...</p>');
});

// Scheduled handler for cron jobs
const scheduled: ExportedHandlerScheduledHandler<Env> = (event, _env, _ctx) => {
  const logger = createLogger();
  logger.info('Cron job started', { cron: event.cron });

  // TODO: Implement incremental sync
  // _ctx.waitUntil(
  //   Promise.all([
  //     syncService.incrementalSync('work'),
  //     syncService.incrementalSync('personal'),
  //   ])
  // );

  logger.info('Cron job completed');
};

export default {
  fetch: app.fetch,
  scheduled,
};
