import { Hono } from 'hono';
import type { Env } from './types/index.js';
import { errorHandler } from './middleware/error.js';
import { securityHeaders } from './middleware/security.js';
import { verifyCloudflareAccess } from './middleware/auth.js';
import { createLogger } from './utils/logger.js';

// Import API routes
import companiesRoutes from './routes/api/companies.js';
import contactsRoutes from './routes/api/contacts.js';
import blacklistRoutes from './routes/api/blacklist.js';
import syncRoutes from './routes/api/sync.js';

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
app.route('/api/companies', companiesRoutes);
app.route('/api/contacts', contactsRoutes);
app.route('/api/blacklist', blacklistRoutes);
app.route('/api/sync', syncRoutes);

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
