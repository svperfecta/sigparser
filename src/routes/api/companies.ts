import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { CompanyRepository } from '../../repositories/company.js';
import { ContactRepository } from '../../repositories/contact.js';
import { DomainRepository } from '../../repositories/domain.js';
import { BlacklistService } from '../../services/blacklist.js';
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

/**
 * DELETE /api/companies/:id - Delete company and blacklist its domains
 * This will:
 * 1. Add all company domains to the blacklist
 * 2. Delete all emails for contacts at this company
 * 3. Delete all contacts at this company
 * 4. Delete all domains for this company
 * 5. Delete the company
 */
companies.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const companyRepo = new CompanyRepository(c.env.DB);
  const domainRepo = new DomainRepository(c.env.DB);
  const blacklist = new BlacklistService(c.env.DB);

  // Verify company exists
  const company = await companyRepo.findById(id);
  if (company === null) {
    throw new AppError('Company not found', 'NOT_FOUND', 404);
  }

  // Get domains to blacklist
  const domains = await domainRepo.findByCompanyId(id);

  // Add domains to blacklist
  for (const domain of domains) {
    await blacklist.add(domain.domain, 'manual', 'company-delete');
  }

  // Delete in order: emails -> contacts -> domains -> company
  // Using raw SQL for cascade delete since we don't have cascade constraints
  await c.env.DB.batch([
    // Delete emails for contacts at this company
    c.env.DB.prepare(
      'DELETE FROM emails WHERE contact_id IN (SELECT id FROM contacts WHERE company_id = ?)',
    ).bind(id),
    // Delete contacts
    c.env.DB.prepare('DELETE FROM contacts WHERE company_id = ?').bind(id),
    // Delete domains
    c.env.DB.prepare('DELETE FROM domains WHERE company_id = ?').bind(id),
    // Delete company
    c.env.DB.prepare('DELETE FROM companies WHERE id = ?').bind(id),
  ]);

  return c.json({
    success: true,
    message: `Deleted company and blacklisted ${domains.length} domain(s)`,
    blacklistedDomains: domains.map((d) => d.domain),
  });
});

export default companies;
