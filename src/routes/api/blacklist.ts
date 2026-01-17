import { Hono } from 'hono';
import type { Env, BlacklistCategory } from '../../types/index.js';
import { BlacklistService } from '../../services/blacklist.js';
import { AppError } from '../../middleware/error.js';

const blacklist = new Hono<{ Bindings: Env }>();

/**
 * GET /api/blacklist - List all blacklisted domains
 */
blacklist.get('/', async (c) => {
  const service = new BlacklistService(c.env.DB);
  const query = c.req.query();

  const category = query.category as BlacklistCategory | undefined;
  const entries = await service.list(category);

  return c.json({ data: entries });
});

/**
 * POST /api/blacklist - Add domain to blacklist
 */
blacklist.post('/', async (c) => {
  const body = await c.req.json<{
    domain: string;
    category?: BlacklistCategory;
  }>();

  if (typeof body.domain !== 'string' || body.domain.trim() === '') {
    throw new AppError('Domain is required', 'VALIDATION_ERROR', 400);
  }

  const domain = body.domain.trim().toLowerCase();
  const category = body.category ?? 'manual';

  // Validate category
  const validCategories: BlacklistCategory[] = ['personal', 'transactional', 'spam', 'manual'];
  if (!validCategories.includes(category)) {
    throw new AppError('Invalid category', 'VALIDATION_ERROR', 400);
  }

  const service = new BlacklistService(c.env.DB);
  await service.add(domain, category, 'api');

  return c.json({ success: true, domain, category }, 201);
});

/**
 * DELETE /api/blacklist/:domain - Remove domain from blacklist
 */
blacklist.delete('/:domain', async (c) => {
  const domain = c.req.param('domain').toLowerCase();

  const service = new BlacklistService(c.env.DB);
  const removed = await service.remove(domain);

  if (!removed) {
    throw new AppError('Domain not found in blacklist', 'NOT_FOUND', 404);
  }

  return c.json({ success: true, domain });
});

export default blacklist;
