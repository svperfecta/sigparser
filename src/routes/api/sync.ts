import { Hono } from 'hono';
import type { Env } from '../../types/index.js';
import { getSyncStatus, SyncService, type AccountType } from '../../services/sync.js';
import { GmailService } from '../../services/gmail.js';
import { AppError } from '../../middleware/error.js';
import { createLogger } from '../../utils/logger.js';

const sync = new Hono<{ Bindings: Env }>();

/**
 * GET /api/sync/status - Get sync status for all accounts
 */
sync.get('/status', async (c) => {
  const status = await getSyncStatus(c.env.DB);
  return c.json({ data: status });
});

/**
 * POST /api/sync/trigger - Manually trigger sync
 */
sync.post('/trigger', async (c) => {
  const logger = createLogger();

  interface TriggerBody {
    account?: string;
    full?: boolean;
  }

  const body: TriggerBody = await c.req.json<TriggerBody>().catch(() => ({}));

  const accountInput = body.account ?? 'work';
  const full = body.full ?? false;

  // Validate account
  if (accountInput !== 'work' && accountInput !== 'personal') {
    throw new AppError('Invalid account type', 'VALIDATION_ERROR', 400);
  }
  const account: AccountType = accountInput;

  // Get the appropriate config based on account
  const clientId = c.env.GOOGLE_CLIENT_ID;
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = account === 'work' ? c.env.GMAIL_REFRESH_TOKEN_WORK : c.env.GMAIL_REFRESH_TOKEN_PERSONAL;
  const myEmail = account === 'work' ? c.env.MY_EMAIL_WORK : c.env.MY_EMAIL_PERSONAL;

  if (refreshToken === undefined || myEmail === undefined) {
    throw new AppError(`${account} account is not configured`, 'VALIDATION_ERROR', 400);
  }

  const gmail = new GmailService({
    clientId,
    clientSecret,
    refreshToken,
  });

  const syncService = new SyncService({
    gmail,
    db: c.env.DB,
    kv: c.env.KV,
    myEmail,
    account,
  });

  logger.info('Manual sync triggered', { account, full });

  // Check if account has caught up (batch sync complete)
  const status = await getSyncStatus(c.env.DB);
  const accountStatus = status.find((s) => s.account === account);
  const today = new Date().toISOString().slice(0, 10);

  // hasCaughtUp = true when current processing date is past today
  const hasCaughtUp =
    accountStatus?.batchCurrentDate !== null &&
    accountStatus?.batchCurrentDate !== undefined &&
    accountStatus.batchCurrentDate > today;

  // Run appropriate sync type:
  // - full: process all messages (slow, use sparingly)
  // - incremental: use Gmail history API (fast, for already-synced accounts)
  // - batch: process one day at a time oldest-first (for catch-up)
  let result;
  let syncType: string;

  if (full) {
    result = await syncService.fullSync();
    syncType = 'full';
  } else if (hasCaughtUp) {
    result = await syncService.incrementalSync();
    syncType = 'incremental';
  } else {
    result = await syncService.batchSync();
    syncType = 'batch';
  }

  return c.json({
    success: true,
    account,
    type: syncType,
    result,
  });
});

/**
 * GET /api/sync/test-query - Test Gmail query with timestamp
 * Query params: ?after=UNIX_TIMESTAMP&before=UNIX_TIMESTAMP&limit=5
 */
sync.get('/test-query', async (c) => {
  const afterTimestamp = c.req.query('after');
  const beforeTimestamp = c.req.query('before');
  const limit = parseInt(c.req.query('limit') ?? '5', 10);

  const gmail = new GmailService({
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    refreshToken: c.env.GMAIL_REFRESH_TOKEN_PERSONAL ?? '',
  });

  // Build query using Gmail's after: and before: operators (accept Unix timestamps)
  let query = '';
  if (afterTimestamp !== undefined) {
    query += `after:${afterTimestamp} `;
  }
  if (beforeTimestamp !== undefined) {
    query += `before:${beforeTimestamp}`;
  }

  const result = await gmail.listMessages({
    maxResults: limit,
    q: query.trim() || undefined,
  });

  // Get details of first few messages to see their timestamps
  const messageDetails = [];
  if (result.messages !== undefined) {
    for (const msg of result.messages.slice(0, 3)) {
      const details = await gmail.getMessage(msg.id);
      // Note: Gmail's internalDate is Unix timestamp in milliseconds
      const internalDateMs = parseInt(details.internalDate, 10);
      messageDetails.push({
        id: msg.id,
        internalDateMs,
        dateISO: new Date(internalDateMs).toISOString(),
      });
    }
  }

  return c.json({
    query: query.trim(),
    resultCount: result.messages?.length ?? 0,
    hasMore: result.nextPageToken !== undefined,
    messages: messageDetails,
  });
});

/**
 * GET /api/sync/find-oldest - Find the oldest email in the account
 * Searches backwards from current year to find when emails start
 */
sync.get('/find-oldest', async (c) => {
  const gmail = new GmailService({
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    refreshToken: c.env.GMAIL_REFRESH_TOKEN_PERSONAL ?? '',
  });

  const currentYear = new Date().getFullYear();

  // Find oldest year: go backwards until before:YEAR returns no results
  let oldestYear = currentYear;
  for (let year = currentYear; year >= 1990; year--) {
    const result = await gmail.listMessages({
      maxResults: 1,
      q: `before:${year}/01/01`,
    });

    if (result.messages === undefined || result.messages.length === 0) {
      // No emails before this year, so oldest is this year or later
      oldestYear = year;
      break;
    }
    // Emails exist before this year, keep going back
    oldestYear = year - 1;
  }

  // Find oldest month in that year
  let oldestMonth = 1;
  for (let month = 1; month <= 12; month++) {
    const nextMonth = month === 12 ? `${oldestYear + 1}/01/01` : `${oldestYear}/${String(month + 1).padStart(2, '0')}/01`;
    const result = await gmail.listMessages({
      maxResults: 1,
      q: `after:${oldestYear}/${String(month).padStart(2, '0')}/01 before:${nextMonth}`,
    });

    if (result.messages !== undefined && result.messages.length > 0) {
      oldestMonth = month;
      break;
    }
  }

  // Get the actual oldest email in that month
  const nextMonth = oldestMonth === 12 ? `${oldestYear + 1}/01/01` : `${oldestYear}/${String(oldestMonth + 1).padStart(2, '0')}/01`;
  const finalResult = await gmail.listMessages({
    maxResults: 1,
    q: `after:${oldestYear}/${String(oldestMonth).padStart(2, '0')}/01 before:${nextMonth}`,
  });

  let oldestEmail = null;
  const firstMessage = finalResult.messages?.[0];
  if (firstMessage !== undefined) {
    const details = await gmail.getMessage(firstMessage.id);
    const internalDateMs = parseInt(details.internalDate, 10);
    const emailDate = new Date(internalDateMs);
    const startDate = new Date(internalDateMs - 2 * 24 * 60 * 60 * 1000);
    oldestEmail = {
      id: firstMessage.id,
      dateISO: emailDate.toISOString(),
      suggestedStartDate: startDate.toISOString().slice(0, 10),
    };
  }

  return c.json({
    oldestYear,
    oldestMonth,
    oldestEmail,
  });
});

/**
 * GET /api/sync/search - Search Gmail for specific terms
 * Query params: ?q=activision&account=work&limit=20
 */
sync.get('/search', async (c) => {
  const query = c.req.query('q');
  const account = c.req.query('account') ?? 'work';
  const limit = parseInt(c.req.query('limit') ?? '20', 10);

  if (query === undefined || query === '') {
    throw new AppError('Query parameter q is required', 'VALIDATION_ERROR', 400);
  }

  const refreshToken = account === 'work'
    ? c.env.GMAIL_REFRESH_TOKEN_WORK
    : c.env.GMAIL_REFRESH_TOKEN_PERSONAL;

  if (refreshToken === undefined) {
    throw new AppError(`${account} account is not configured`, 'VALIDATION_ERROR', 400);
  }

  const gmail = new GmailService({
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    refreshToken,
  });

  const result = await gmail.listMessages({
    maxResults: limit,
    q: query,
  });

  // Get details of messages
  const messages = [];
  if (result.messages !== undefined) {
    for (const msg of result.messages.slice(0, limit)) {
      const details = await gmail.getMessage(msg.id);
      const internalDateMs = parseInt(details.internalDate, 10);
      const from = details.payload.headers.find(h => h.name.toLowerCase() === 'from')?.value ?? '';
      const to = details.payload.headers.find(h => h.name.toLowerCase() === 'to')?.value ?? '';
      const subject = details.payload.headers.find(h => h.name.toLowerCase() === 'subject')?.value ?? '';
      messages.push({
        id: msg.id,
        date: new Date(internalDateMs).toISOString(),
        from,
        to: to.substring(0, 100),
        subject: subject.substring(0, 100),
      });
    }
  }

  return c.json({
    query,
    account,
    total: result.messages?.length ?? 0,
    hasMore: result.nextPageToken !== undefined,
    messages,
  });
});

export default sync;
