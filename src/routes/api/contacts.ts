import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { ContactRepository } from '../../repositories/contact.js';
import { parsePagination, paginationMeta } from '../../utils/pagination.js';
import { AppError } from '../../middleware/error.js';

const contacts = new Hono<{ Bindings: Env }>();

/**
 * GET /api/contacts - List contacts with pagination and search
 */
contacts.get('/', async (c) => {
  const repo = new ContactRepository(c.env.DB);
  const query = c.req.query();

  const pagination = parsePagination(query, 'emails_from', [
    'created_at',
    'emails_from',
    'emails_to',
    'last_seen',
    'name',
  ]);

  const search = query.q;
  const { contacts: results, total } = await repo.list(pagination, search);

  return c.json({
    data: results,
    pagination: paginationMeta(pagination.page, pagination.limit, total),
  });
});

/**
 * GET /api/contacts/:id - Get contact with emails and company
 */
contacts.get('/:id', async (c) => {
  const id = c.req.param('id');
  const repo = new ContactRepository(c.env.DB);

  const contact = await repo.findByIdWithDetails(id);
  if (contact === null) {
    throw new AppError('Contact not found', 'NOT_FOUND', 404);
  }

  return c.json({ data: contact });
});

/**
 * GET /api/contacts/:id/threads - Get recent threads for a contact
 */
contacts.get('/:id/threads', async (c) => {
  const id = c.req.param('id');
  const repo = new ContactRepository(c.env.DB);

  const contact = await repo.findById(id);
  if (contact === null) {
    throw new AppError('Contact not found', 'NOT_FOUND', 404);
  }

  return c.json({ data: contact.recentThreads });
});

export default contacts;
