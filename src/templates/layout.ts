/**
 * Base layout template for HTMX pages
 */

export interface LayoutOptions {
  title?: string | undefined;
  userEmail?: string | undefined;
  currentPath?: string | undefined;
}

/**
 * Navigation link items
 */
const navLinks = [
  { href: '/', label: 'Dashboard', icon: '📊' },
  { href: '/companies', label: 'Companies', icon: '🏢' },
  { href: '/contacts', label: 'Contacts', icon: '👥' },
  { href: '/blacklist', label: 'Blacklist', icon: '🚫' },
];

/**
 * Render the main layout with navigation
 */
export function layout(content: string, options: LayoutOptions = {}): string {
  const { title = 'sigparser', userEmail, currentPath = '/' } = options;

  const navHtml = navLinks
    .map(
      (link) => `
      <a href="${link.href}"
         class="nav-link ${currentPath === link.href ? 'active' : ''}"
         hx-get="${link.href}"
         hx-target="#main-content"
         hx-push-url="true">
        <span class="nav-icon">${link.icon}</span>
        <span class="nav-label">${link.label}</span>
      </a>
    `,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/static/styles.css">
  <script src="/static/htmx.min.js"></script>
</head>
<body>
  <div class="app-container">
    <nav class="sidebar">
      <div class="sidebar-header">
        <h1 class="logo">sigparser</h1>
        ${userEmail !== undefined ? `<span class="user-email">${userEmail}</span>` : ''}
      </div>
      <div class="nav-links">
        ${navHtml}
      </div>
    </nav>
    <main id="main-content" class="main-content">
      ${content}
    </main>
  </div>
</body>
</html>`;
}

/**
 * Render just the content portion (for HTMX swaps)
 */
export function partial(content: string): string {
  return content;
}

/**
 * Render a page header
 */
export function pageHeader(title: string, subtitle?: string): string {
  return `
    <div class="page-header">
      <h1 class="page-title">${title}</h1>
      ${subtitle !== undefined ? `<p class="page-subtitle">${subtitle}</p>` : ''}
    </div>
  `;
}

/**
 * Render a card container
 */
export function card(content: string, title?: string): string {
  return `
    <div class="card">
      ${title !== undefined ? `<div class="card-header"><h2 class="card-title">${title}</h2></div>` : ''}
      <div class="card-body">
        ${content}
      </div>
    </div>
  `;
}

/**
 * Render a stat card
 */
export function statCard(label: string, value: string | number, trend?: string): string {
  return `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      ${trend !== undefined ? `<div class="stat-trend">${trend}</div>` : ''}
    </div>
  `;
}

/**
 * Render a data table
 */
export function dataTable(headers: string[], rows: string[][]): string {
  const headerHtml = headers.map((h) => `<th>${h}</th>`).join('');
  const rowsHtml = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`)
    .join('');

  return `
    <div class="table-container">
      <table class="data-table">
        <thead>
          <tr>${headerHtml}</tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

/**
 * Render pagination controls
 */
export function pagination(
  page: number,
  totalPages: number,
  baseUrl: string,
  targetId = '#main-content',
): string {
  if (totalPages <= 1) {
    return '';
  }

  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  return `
    <div class="pagination">
      <button
        class="btn btn-sm ${prevDisabled ? 'disabled' : ''}"
        ${!prevDisabled ? `hx-get="${baseUrl}?page=${page - 1}" hx-target="${targetId}" hx-push-url="true"` : ''}
        ${prevDisabled ? 'disabled' : ''}>
        ← Previous
      </button>
      <span class="pagination-info">Page ${page} of ${totalPages}</span>
      <button
        class="btn btn-sm ${nextDisabled ? 'disabled' : ''}"
        ${!nextDisabled ? `hx-get="${baseUrl}?page=${page + 1}" hx-target="${targetId}" hx-push-url="true"` : ''}
        ${nextDisabled ? 'disabled' : ''}>
        Next →
      </button>
    </div>
  `;
}

/**
 * Render a search input with HTMX
 */
export function searchInput(placeholder: string, targetUrl: string, targetId = '#results'): string {
  return `
    <div class="search-container">
      <input
        type="search"
        name="q"
        placeholder="${placeholder}"
        class="search-input"
        hx-get="${targetUrl}"
        hx-trigger="keyup changed delay:300ms, search"
        hx-target="${targetId}"
        hx-push-url="true">
    </div>
  `;
}

/**
 * Render an empty state message
 */
export function emptyState(message: string, icon = '📭'): string {
  return `
    <div class="empty-state">
      <span class="empty-icon">${icon}</span>
      <p class="empty-message">${message}</p>
    </div>
  `;
}

/**
 * Render a loading spinner
 */
export function loading(): string {
  return `
    <div class="loading">
      <div class="spinner"></div>
      <span>Loading...</span>
    </div>
  `;
}

/**
 * Format a date for display
 */
export function formatDate(dateStr: string | null): string {
  if (dateStr === null) {
    return '—';
  }
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Format a number for display
 */
export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num);
}
