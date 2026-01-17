import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { CompanyRepository } from '../../repositories/company.js';
import { ContactRepository } from '../../repositories/contact.js';
import { DomainRepository } from '../../repositories/domain.js';
import { parsePagination } from '../../utils/pagination.js';
import {
  layout,
  partial,
  pageHeader,
  card,
  dataTable,
  pagination,
  searchInput,
  emptyState,
  formatDate,
  formatNumber,
} from '../../templates/layout.js';

const companies = new Hono<{ Bindings: Env }>();

/**
 * GET /companies - Companies list page
 */
companies.get('/', async (c) => {
  const userEmail = c.get('userEmail') as string | undefined;
  const query = c.req.query();
  const isHtmx = c.req.header('HX-Request') === 'true';

  const repo = new CompanyRepository(c.env.DB);
  const pag = parsePagination(query, 'emails_from', [
    'created_at',
    'emails_from',
    'emails_to',
    'last_seen',
    'name',
  ]);

  const search = query.q;
  const { companies: results, total } = await repo.list(pag, search);
  const totalPages = Math.ceil(total / pag.limit);

  const tableRows = results.map((company) => [
    `<a href="/companies/${company.id}" hx-get="/companies/${company.id}" hx-target="#main-content" hx-push-url="true">${company.name ?? '(unnamed)'}</a>`,
    formatNumber(company.emailsFrom),
    formatNumber(company.emailsTo),
    formatDate(company.lastSeen),
  ]);

  const resultsContent =
    results.length > 0
      ? `
        ${dataTable(['Company', 'Emails From', 'Emails To', 'Last Seen'], tableRows)}
        ${pagination(pag.page, totalPages, '/companies', '#results')}
      `
      : emptyState('No companies found', '🏢');

  // For HTMX requests targeting #results, return just the results
  if (isHtmx && c.req.header('HX-Target') === 'results') {
    return c.html(resultsContent);
  }

  const content = `
    ${pageHeader('Companies', `${formatNumber(total)} companies tracked`)}
    ${searchInput('Search companies...', '/companies', '#results')}
    <div id="results">
      ${resultsContent}
    </div>
  `;

  if (isHtmx) {
    return c.html(content);
  }

  return c.html(
    layout(content, { title: 'Companies - sigparser', userEmail, currentPath: '/companies' }),
  );
});

/**
 * GET /companies/:id - Company detail page
 */
companies.get('/:id', async (c) => {
  const id = c.req.param('id');
  const userEmail = c.get('userEmail') as string | undefined;
  const isHtmx = c.req.header('HX-Request') === 'true';

  const companyRepo = new CompanyRepository(c.env.DB);
  const contactRepo = new ContactRepository(c.env.DB);
  const domainRepo = new DomainRepository(c.env.DB);

  const company = await companyRepo.findById(id);
  if (company === null) {
    const notFound = emptyState('Company not found', '🔍');
    if (isHtmx) {
      return c.html(notFound);
    }
    return c.html(layout(notFound, { title: 'Not Found - sigparser', userEmail }));
  }

  const [domains, contactsResult] = await Promise.all([
    domainRepo.findByCompanyId(id),
    contactRepo.list(parsePagination({}, 'emails_from', ['emails_from']), undefined, id),
  ]);

  const domainRows = domains.map((d) => [
    d.domain,
    d.isPrimary ? '✓ Primary' : '',
    formatNumber(d.emailsFrom),
    formatNumber(d.emailsTo),
  ]);

  const contactRows = contactsResult.contacts.slice(0, 10).map((contact) => [
    `<a href="/contacts/${contact.id}" hx-get="/contacts/${contact.id}" hx-target="#main-content" hx-push-url="true">${contact.name ?? '(unnamed)'}</a>`,
    formatNumber(contact.emailsFrom),
    formatNumber(contact.emailsTo),
    formatDate(contact.lastSeen),
  ]);

  const content = `
    ${pageHeader(company.name ?? '(Unnamed Company)')}

    <div class="detail-grid">
      <div class="detail-item">
        <span class="detail-label">Emails From</span>
        <span class="detail-value">${formatNumber(company.emailsFrom)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Emails To</span>
        <span class="detail-value">${formatNumber(company.emailsTo)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">First Seen</span>
        <span class="detail-value">${formatDate(company.firstSeen)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Last Seen</span>
        <span class="detail-value">${formatDate(company.lastSeen)}</span>
      </div>
    </div>

    ${card(
      domains.length > 0
        ? dataTable(['Domain', 'Primary', 'Emails From', 'Emails To'], domainRows)
        : partial(emptyState('No domains', '🌐')),
      `Domains (${domains.length})`,
    )}

    ${card(
      contactRows.length > 0
        ? `
          ${dataTable(['Contact', 'Emails From', 'Emails To', 'Last Seen'], contactRows)}
          ${contactsResult.total > 10 ? `<p class="more-link"><a href="/contacts?companyId=${id}" hx-get="/contacts?companyId=${id}" hx-target="#main-content" hx-push-url="true">View all ${contactsResult.total} contacts →</a></p>` : ''}
        `
        : partial(emptyState('No contacts', '👥')),
      `Contacts (${contactsResult.total})`,
    )}

    <p><a href="/companies" hx-get="/companies" hx-target="#main-content" hx-push-url="true">← Back to Companies</a></p>
  `;

  if (isHtmx) {
    return c.html(content);
  }

  return c.html(
    layout(content, {
      title: `${company.name ?? 'Company'} - sigparser`,
      userEmail,
      currentPath: '/companies',
    }),
  );
});

export default companies;
