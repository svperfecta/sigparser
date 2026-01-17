import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { BlacklistService } from '../../services/blacklist.js';
import {
  layout,
  pageHeader,
  card,
  dataTable,
  emptyState,
  formatDate,
  formatNumber,
} from '../../templates/layout.js';

const blacklist = new Hono<{ Bindings: Env }>();

/**
 * GET /blacklist - Blacklist management page
 */
blacklist.get('/', async (c) => {
  const userEmail = c.get('userEmail') as string | undefined;
  const isHtmx = c.req.header('HX-Request') === 'true';

  const service = new BlacklistService(c.env.DB);
  const [entries, counts] = await Promise.all([service.list(), service.getCounts()]);

  const tableRows = entries.map((entry) => [
    entry.domain,
    `<span class="badge badge-${entry.category}">${entry.category}</span>`,
    entry.source ?? '—',
    formatDate(entry.createdAt),
    `<button
       class="btn btn-sm btn-danger"
       hx-delete="/api/blacklist/${entry.domain}"
       hx-confirm="Remove ${entry.domain} from blacklist?"
       hx-target="#blacklist-table"
       hx-swap="outerHTML">
       Remove
     </button>`,
  ]);

  const tableContent =
    entries.length > 0
      ? dataTable(['Domain', 'Category', 'Source', 'Added', 'Actions'], tableRows)
      : emptyState('No blacklisted domains', '✅');

  const content = `
    ${pageHeader('Blacklist', 'Manage domains and emails to exclude from syncing')}

    <div class="stats-grid stats-sm">
      <div class="stat-card">
        <span class="stat-label">Personal</span>
        <span class="stat-value">${formatNumber(counts.personal)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Transactional</span>
        <span class="stat-value">${formatNumber(counts.transactional)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Spam</span>
        <span class="stat-value">${formatNumber(counts.spam)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Manual</span>
        <span class="stat-value">${formatNumber(counts.manual)}</span>
      </div>
    </div>

    ${card(
      `
      <form
        hx-post="/api/blacklist"
        hx-target="#blacklist-table"
        hx-swap="outerHTML"
        hx-on::after-request="this.reset()">
        <div class="form-row">
          <input
            type="text"
            name="domain"
            placeholder="Enter domain to blacklist (e.g., spam.com)"
            class="form-input"
            required>
          <select name="category" class="form-select">
            <option value="manual">Manual</option>
            <option value="spam">Spam</option>
            <option value="personal">Personal</option>
            <option value="transactional">Transactional</option>
          </select>
          <button type="submit" class="btn btn-primary">Add Domain</button>
        </div>
      </form>
      `,
      'Add to Blacklist',
    )}

    ${card(
      `<div id="blacklist-table">${tableContent}</div>`,
      `Blacklisted Domains (${entries.length})`,
    )}

    <div class="card">
      <div class="card-header">
        <h2 class="card-title">Bulk Actions</h2>
      </div>
      <div class="card-body">
        <p>Seed the blacklist with common personal email domains:</p>
        <button
          class="btn btn-secondary"
          hx-post="/api/blacklist/seed"
          hx-swap="none"
          hx-confirm="This will add ~100 common personal email domains to the blacklist. Continue?">
          Seed Personal Domains
        </button>
      </div>
    </div>
  `;

  if (isHtmx) {
    return c.html(content);
  }

  return c.html(
    layout(content, { title: 'Blacklist - sigparser', userEmail, currentPath: '/blacklist' }),
  );
});

export default blacklist;
