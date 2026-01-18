import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { layout, pageHeader, card, statCard } from '../../templates/layout.js';
import { getSyncStatus } from '../../services/sync.js';

const dashboard = new Hono<{ Bindings: Env }>();

/**
 * GET / - Dashboard page
 */
dashboard.get('/', async (c) => {
  const userEmail = c.get('userEmail') as string | undefined;

  // Get stats from database
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [syncStatus, companyCount, contactCount, emailCount, newContacts24h, newCompanies24h] =
    await Promise.all([
      getSyncStatus(c.env.DB),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM companies').first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM contacts').first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM emails').first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM contacts WHERE created_at >= ?')
        .bind(oneDayAgo)
        .first<{ count: number }>(),
      c.env.DB.prepare('SELECT COUNT(*) as count FROM companies WHERE created_at >= ?')
        .bind(oneDayAgo)
        .first<{ count: number }>(),
    ]);

  const workSync = syncStatus.find((s) => s.account === 'work');
  const personalSync = syncStatus.find((s) => s.account === 'personal');

  const formatLastRun = (lastSync: string | null): string => {
    if (lastSync === null) {
      return 'Never';
    }
    const date = new Date(lastSync);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  /**
   * Format the batch progress for display
   * Shows current date being processed and whether there are more pages
   */
  const formatBatchProgress = (
    batchDate: string | null,
    batchPageToken: string | null,
  ): string => {
    if (batchDate === null) {
      return 'Not started';
    }
    const today = new Date().toISOString().slice(0, 10);
    if (batchDate > today) {
      return '✓ Caught up!';
    }
    // Show date and page indicator
    const hasMorePages = batchPageToken !== null;
    return hasMorePages ? `${batchDate} (paging...)` : batchDate;
  };

  // Find most recent sync time
  const lastSyncTime = [workSync?.lastSync, personalSync?.lastSync]
    .filter((t): t is string => t !== null && t !== undefined)
    .sort()
    .reverse()[0];

  const formatLastSync = (lastSync: string | undefined): string => {
    if (lastSync === undefined) {
      return 'Never';
    }
    const date = new Date(lastSync);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  };

  const content = `
    ${pageHeader('Dashboard', 'Your contact intelligence at a glance')}

    <div class="stats-grid">
      ${statCard('Last Sync', formatLastSync(lastSyncTime))}
      ${statCard('New Contacts (24h)', newContacts24h?.count ?? 0)}
      ${statCard('New Companies (24h)', newCompanies24h?.count ?? 0)}
    </div>

    <div class="stats-grid" style="margin-top: 1rem;">
      ${statCard('Total Companies', companyCount?.count ?? 0)}
      ${statCard('Total Contacts', contactCount?.count ?? 0)}
      ${statCard('Email Addresses', emailCount?.count ?? 0)}
    </div>

    <div class="grid grid-2">
      ${card(
        `
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 1rem;">
          <thead>
            <tr style="text-align: left; border-bottom: 1px solid #e5e7eb;">
              <th style="padding: 0.5rem 0;">Account</th>
              <th style="padding: 0.5rem 0;">Last Run</th>
              <th style="padding: 0.5rem 0;">Processing Date</th>
              <th style="padding: 0.5rem 0;"></th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="padding: 0.5rem 0;">Work</td>
              <td style="padding: 0.5rem 0;">${formatLastRun(workSync?.lastSync ?? null)}</td>
              <td style="padding: 0.5rem 0;">${formatBatchProgress(workSync?.batchCurrentDate ?? null, workSync?.batchPageToken ?? null)}</td>
              <td style="padding: 0.5rem 0;">
                <button
                  class="btn btn-sm"
                  hx-post="/api/sync/trigger"
                  hx-vals='{"account": "work"}'
                  hx-swap="none"
                  hx-indicator="#sync-indicator">
                  Sync
                </button>
              </td>
            </tr>
            <tr>
              <td style="padding: 0.5rem 0;">Personal</td>
              <td style="padding: 0.5rem 0;">${formatLastRun(personalSync?.lastSync ?? null)}</td>
              <td style="padding: 0.5rem 0;">${formatBatchProgress(personalSync?.batchCurrentDate ?? null, personalSync?.batchPageToken ?? null)}</td>
              <td style="padding: 0.5rem 0;">
                <button
                  class="btn btn-sm"
                  hx-post="/api/sync/trigger"
                  hx-vals='{"account": "personal"}'
                  hx-swap="none"
                  hx-indicator="#sync-indicator">
                  Sync
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div id="sync-indicator" class="htmx-indicator">Syncing...</div>
        <p style="margin-top: 0.5rem; font-size: 0.875rem; color: #666;">
          ⚡ Cron runs every minute during catch-up. Change to 15min after.
        </p>
        `,
        'Sync Status',
      )}

      ${card(
        `
        <ul class="quick-links">
          <li><a href="/companies" hx-get="/companies" hx-target="#main-content" hx-push-url="true">View All Companies →</a></li>
          <li><a href="/contacts" hx-get="/contacts" hx-target="#main-content" hx-push-url="true">View All Contacts →</a></li>
          <li><a href="/blacklist" hx-get="/blacklist" hx-target="#main-content" hx-push-url="true">Manage Blacklist →</a></li>
        </ul>
        `,
        'Quick Links',
      )}
    </div>
  `;

  // Check if this is an HTMX request (partial update)
  const isHtmx = c.req.header('HX-Request') === 'true';
  if (isHtmx) {
    return c.html(content);
  }

  return c.html(layout(content, { title: 'Dashboard - sigparser', userEmail, currentPath: '/' }));
});

export default dashboard;
