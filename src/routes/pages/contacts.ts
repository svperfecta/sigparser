import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { ContactRepository } from '../../repositories/contact.js';
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

const contacts = new Hono<{ Bindings: Env }>();

/**
 * GET /contacts - Contacts list page
 */
contacts.get('/', async (c) => {
  const userEmail = c.get('userEmail') as string | undefined;
  const query = c.req.query();
  const isHtmx = c.req.header('HX-Request') === 'true';

  const repo = new ContactRepository(c.env.DB);
  const pag = parsePagination(query, 'emails_from', [
    'created_at',
    'emails_from',
    'emails_to',
    'last_seen',
    'name',
  ]);

  const search = query.q;
  const companyId = query.companyId;
  const { contacts: results, total } = await repo.list(pag, search, companyId);
  const totalPages = Math.ceil(total / pag.limit);

  const tableRows = results.map((contact) => [
    `<a href="/contacts/${contact.id}" hx-get="/contacts/${contact.id}" hx-target="#main-content" hx-push-url="true">${contact.name ?? '(unnamed)'}</a>`,
    formatNumber(contact.emailsFrom),
    formatNumber(contact.emailsTo),
    formatDate(contact.lastSeen),
  ]);

  const baseUrl = companyId !== undefined ? `/contacts?companyId=${companyId}` : '/contacts';

  const resultsContent =
    results.length > 0
      ? `
        ${dataTable(['Contact', 'Emails From', 'Emails To', 'Last Seen'], tableRows)}
        ${pagination(pag.page, totalPages, baseUrl, '#results')}
      `
      : emptyState('No contacts found', '👥');

  // For HTMX requests targeting #results, return just the results
  if (isHtmx && c.req.header('HX-Target') === 'results') {
    return c.html(resultsContent);
  }

  const content = `
    ${pageHeader('Contacts', `${formatNumber(total)} contacts tracked`)}
    ${searchInput('Search contacts...', baseUrl, '#results')}
    <div id="results">
      ${resultsContent}
    </div>
  `;

  if (isHtmx) {
    return c.html(content);
  }

  return c.html(
    layout(content, { title: 'Contacts - sigparser', userEmail, currentPath: '/contacts' }),
  );
});

/**
 * GET /contacts/:id - Contact detail page
 */
contacts.get('/:id', async (c) => {
  const id = c.req.param('id');
  const userEmail = c.get('userEmail') as string | undefined;
  const isHtmx = c.req.header('HX-Request') === 'true';

  const repo = new ContactRepository(c.env.DB);
  const contact = await repo.findByIdWithDetails(id);

  if (contact === null) {
    const notFound = emptyState('Contact not found', '🔍');
    if (isHtmx) {
      return c.html(notFound);
    }
    return c.html(layout(notFound, { title: 'Not Found - sigparser', userEmail }));
  }

  const emailRows = contact.emails.map((email) => [
    email.email,
    email.nameObserved ?? '—',
    formatNumber(email.emailsFrom),
    formatNumber(email.emailsTo),
    email.isActive ? '✓ Active' : 'Inactive',
  ]);

  const threadRows = contact.recentThreads.slice(0, 5).map((thread) => [
    thread.threadId,
    thread.account === 'work' ? '💼 Work' : '🏠 Personal',
    formatDate(thread.timestamp),
  ]);

  const content = `
    <div class="page-header-with-actions">
      ${pageHeader(contact.name ?? '(Unnamed Contact)')}
      <button
        class="btn btn-danger"
        hx-delete="/api/contacts/${id}"
        hx-confirm="Delete this contact and all their email addresses?"
        hx-target="#main-content"
        hx-swap="innerHTML"
        hx-on::after-request="if(event.detail.successful) { window.location.href = '/contacts'; }">
        Delete Contact
      </button>
    </div>

    <div class="detail-grid">
      <div class="detail-item">
        <span class="detail-label">Company</span>
        <span class="detail-value">
          <a href="/companies/${contact.company.id}" hx-get="/companies/${contact.company.id}" hx-target="#main-content" hx-push-url="true">
            ${contact.company.name ?? '(unnamed)'}
          </a>
        </span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Emails From</span>
        <span class="detail-value">${formatNumber(contact.emailsFrom)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Emails To</span>
        <span class="detail-value">${formatNumber(contact.emailsTo)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">First Seen</span>
        <span class="detail-value">${formatDate(contact.firstSeen)}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">Last Seen</span>
        <span class="detail-value">${formatDate(contact.lastSeen)}</span>
      </div>
    </div>

    ${card(
      emailRows.length > 0
        ? dataTable(['Email', 'Name Observed', 'Emails From', 'Emails To', 'Status'], emailRows)
        : partial(emptyState('No email addresses', '📧')),
      `Email Addresses (${contact.emails.length})`,
    )}

    ${card(
      threadRows.length > 0
        ? dataTable(['Thread ID', 'Account', 'Date'], threadRows)
        : partial(emptyState('No recent threads', '💬')),
      'Recent Threads',
    )}

    <p><a href="/contacts" hx-get="/contacts" hx-target="#main-content" hx-push-url="true">← Back to Contacts</a></p>
  `;

  if (isHtmx) {
    return c.html(content);
  }

  return c.html(
    layout(content, {
      title: `${contact.name ?? 'Contact'} - sigparser`,
      userEmail,
      currentPath: '/contacts',
    }),
  );
});

export default contacts;
