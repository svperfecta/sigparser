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

  // Get the file from the __STATIC_CONTENT binding (Workers Sites)
  const content = await c.env.__STATIC_CONTENT?.get(filename);

  if (content === null || content === undefined) {
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
    headers: { 'Content-Type': contentType },
  });
});

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
app.route('/', dashboardPages);
app.route('/companies', companiesPages);
app.route('/contacts', contactsPages);
app.route('/blacklist', blacklistPages);

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
