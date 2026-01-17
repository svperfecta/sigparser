import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { CompanyRepository } from '../../repositories/company.js';
import { ContactRepository } from '../../repositories/contact.js';
import { DomainRepository } from '../../repositories/domain.js';
import { parsePagination, paginationMeta } from '../../utils/pagination.js';
import { AppError } from '../../middleware/error.js';

const companies = new Hono<{ Bindings: Env }>();

/**
 * GET /api/companies - List companies with pagination and search
 */
companies.get('/', async (c) => {
  const repo = new CompanyRepository(c.env.DB);
  const query = c.req.query();

  const pagination = parsePagination(query, 'emails_from', [
    'created_at',
    'emails_from',
    'emails_to',
    'last_seen',
    'name',
  ]);

  const search = query.q;
  const { companies: results, total } = await repo.list(pagination, search);

  return c.json({
    data: results,
    pagination: paginationMeta(pagination.page, pagination.limit, total),
  });
});

/**
 * GET /api/companies/:id - Get company with domains
 */
companies.get('/:id', async (c) => {
  const id = c.req.param('id');
  const repo = new CompanyRepository(c.env.DB);
  const domainRepo = new DomainRepository(c.env.DB);

  const company = await repo.findById(id);
  if (company === null) {
    throw new AppError('Company not found', 'NOT_FOUND', 404);
  }

  const domains = await domainRepo.findByCompanyId(id);

  return c.json({
    data: {
      ...company,
      domains,
    },
  });
});

/**
 * GET /api/companies/:id/contacts - List contacts at a company
 */
companies.get('/:id/contacts', async (c) => {
  const companyId = c.req.param('id');
  const companyRepo = new CompanyRepository(c.env.DB);
  const contactRepo = new ContactRepository(c.env.DB);

  // Verify company exists
  const company = await companyRepo.findById(companyId);
  if (company === null) {
    throw new AppError('Company not found', 'NOT_FOUND', 404);
  }

  const query = c.req.query();
  const pagination = parsePagination(query, 'emails_from', [
    'created_at',
    'emails_from',
    'emails_to',
    'last_seen',
    'name',
  ]);

  const { contacts, total } = await contactRepo.list(pagination, undefined, companyId);

  return c.json({
    data: contacts,
    pagination: paginationMeta(pagination.page, pagination.limit, total),
  });
});

export default companies;
